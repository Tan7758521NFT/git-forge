// gitproto.ts — git smart HTTP: info/refs, upload-pack (v0 + v2), receive-pack (v0).
import {
  DELIM,
  FLUSH,
  ZERO_OID,
  buildPack,
  parsePack,
  parsePktLines,
  parseTag,
  pkt,
  sideband,
  splitAtFlush,
  type GitObject,
} from './gitutil.ts';
import { type Repo } from './store.ts';

const AGENT = 'forge/1.0.0';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function err(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function commitTimestamp(info: { committer: string }): number {
  const m = / (\d+) [+-]\d{4}$/.exec(info.committer);
  return m ? Number(m[1]) : 0;
}

// ------------------------------------------------------------ advertisements
function refLinesV0(repo: Repo, capabilities: string): Buffer {
  const parts: Buffer[] = [];
  const headOid = repo.headOid() ?? ZERO_OID;
  const refs = repo.allRefs();
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    parts.push(pkt(`${headOid} HEAD\0${capabilities}\n`));
    for (const r of refs) parts.push(pkt(`${r.oid} ${r.name}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertiseUploadPackV0(repo: Repo): Buffer {
  const caps = 'side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=' + AGENT;
  return Buffer.concat([pkt('# service=git-upload-pack\n'), FLUSH, refLinesV0(repo, caps)]);
}

function advertiseReceivePackV0(repo: Repo): Buffer {
  const caps = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;
  return Buffer.concat([pkt('# service=git-receive-pack\n'), FLUSH, refLinesV0(repo, caps)]);
}

function advertiseUploadPackV2(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ------------------------------------------------------------ info/refs
export function handleInfoRefs(
  repo: Repo | null,
  service: string,
  gitProtocol: string,
): GitResponse {
  if (!repo) return err(404, 'Repository not found');
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return ok('application/x-git-upload-pack-advertisement', advertiseUploadPackV2());
    }
    return ok('application/x-git-upload-pack-advertisement', advertiseUploadPackV0(repo));
  }
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', advertiseReceivePackV0(repo));
  }
  return err(400, `Unknown service ${service}`);
}

// ------------------------------------------------------------ fetch set computation
export interface FetchParams {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

export interface SendSet {
  objects: Set<string>;
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

function resolveToCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') {
    const target = parseTag(obj.data).object;
    const t = repo.objects.get(target);
    return t && t.type === 'commit' ? target : null;
  }
  return null;
}

export function computeSendSet(repo: Repo, params: FetchParams): SendSet {
  const wantCommits = new Set<string>();
  const wantTags = new Set<string>();
  for (const w of params.wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'commit') wantCommits.add(w);
    else if (obj.type === 'tag') {
      wantTags.add(w);
      const target = parseTag(obj.data).object;
      const t = repo.objects.get(target);
      if (t && t.type === 'commit') wantCommits.add(target);
    }
  }
  // Wanted commits, with depth / since limits.
  const wanted = new Set<string>();
  const seenDepth = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [...wantCommits].map((oid) => ({ oid, depth: 0 }));
  while (queue.length > 0) {
    const item = queue.shift()!;
    const prev = seenDepth.get(item.oid);
    if (prev !== undefined && prev <= item.depth) continue;
    seenDepth.set(item.oid, item.depth);
    const info = repo.commitInfo(item.oid);
    if (!info) continue;
    if (params.deepenSince !== null && commitTimestamp(info) < params.deepenSince) continue;
    wanted.add(item.oid);
    if (params.deepen !== null && item.depth + 1 >= params.deepen) continue;
    for (const p of info.parents) queue.push({ oid: p, depth: item.depth + 1 });
  }
  // Full closure of wants (for ACK decisions).
  const wantedFull = new Set<string>();
  {
    const stack = [...wantCommits];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (wantedFull.has(oid)) continue;
      const info = repo.commitInfo(oid);
      if (!info) continue;
      wantedFull.add(oid);
      for (const p of info.parents) stack.push(p);
    }
  }
  // Have closure; traversal stops at the client's shallow boundaries.
  const shallowSet = new Set(params.shallow);
  const haveCommits = new Set<string>();
  const haveObjects = new Set<string>();
  const haveStarts: string[] = [];
  for (const h of [...params.haves, ...params.deepenNot]) {
    const c = resolveToCommit(repo, h);
    if (c) haveStarts.push(c);
    const obj = repo.objects.get(h);
    if (obj && obj.type === 'tag') haveObjects.add(h);
  }
  for (const start of haveStarts) {
    const stack = [start];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (haveCommits.has(oid)) continue;
      const info = repo.commitInfo(oid);
      if (!info) continue;
      haveCommits.add(oid);
      repo.collectCommitObjects(oid, haveObjects);
      if (shallowSet.has(oid)) continue;
      for (const p of info.parents) stack.push(p);
    }
  }
  // Send set.
  const sendCommits = new Set<string>();
  for (const c of wanted) if (!haveCommits.has(c)) sendCommits.add(c);
  const objects = new Set<string>();
  for (const c of sendCommits) repo.collectCommitObjects(c, objects);
  for (const t of wantTags) {
    if (haveObjects.has(t)) continue;
    objects.add(t);
    const target = parseTag(repo.objects.get(t)!.data).object;
    const tObj = repo.objects.get(target);
    if (tObj && (tObj.type === 'tree' || tObj.type === 'blob')) objects.add(target);
  }
  for (const o of haveObjects) objects.delete(o);
  // Shallow info.
  const shallow: string[] = [];
  for (const c of sendCommits) {
    const info = repo.commitInfo(c);
    if (!info) continue;
    const parents = info.parents;
    if (parents.some((p) => !sendCommits.has(p) && !haveCommits.has(p))) shallow.push(c);
  }
  const unshallow: string[] = [];
  for (const c of shallowSet) {
    const info = repo.commitInfo(c);
    if (!info) continue;
    const parents = info.parents;
    if (parents.every((p) => sendCommits.has(p) || haveCommits.has(p))) unshallow.push(c);
  }
  let ack: string | null = null;
  for (const h of params.haves) {
    const c = resolveToCommit(repo, h);
    if (c && wantedFull.has(c)) {
      ack = c;
      break;
    }
  }
  return { objects, shallow, unshallow, ack };
}

// ------------------------------------------------------------ ls-refs (v2)
function handleLsRefs(repo: Repo, lines: ReturnType<typeof parsePktLines>): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const line of lines) {
    if (line.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (line.kind !== 'data' || !pastDelim) continue;
    const text = line.data.toString('utf8').trimEnd();
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const headOid = repo.headOid();
  const include = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (headOid && include('HEAD')) {
    let row = `${headOid} HEAD`;
    if (symrefs) row += ' symref-target:refs/heads/main';
    parts.push(pkt(`${row}\n`));
  }
  for (const r of repo.allRefs()) {
    if (!include(r.name)) continue;
    let row = `${r.oid} ${r.name}`;
    if (peel && r.name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(r.oid);
      if (obj && obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        if (repo.objects.get(target)?.type === 'commit') row += ` peeled:${target}`;
      }
    }
    parts.push(pkt(`${row}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ fetch (v2 + v0)
function fetchResponse(repo: Repo, params: FetchParams, v2: boolean): Buffer {
  const set = computeSendSet(repo, params);
  const pack = buildPack([...set.objects], (oid) => repo.objects.get(oid));
  if (v2) {
    const parts: Buffer[] = [];
    parts.push(pkt('acknowledgments\n'));
    parts.push(pkt(set.ack ? `ACK ${set.ack}\n` : 'NAK\n'));
    parts.push(FLUSH);
    if (set.shallow.length > 0 || set.unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const s of set.shallow) parts.push(pkt(`shallow ${s}\n`));
      for (const s of set.unshallow) parts.push(pkt(`unshallow ${s}\n`));
      parts.push(FLUSH);
    }
    parts.push(pkt('packfile\n'));
    parts.push(sideband(pack));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const parts: Buffer[] = [];
  parts.push(pkt(set.ack ? `ACK ${set.ack}\n` : 'NAK\n'));
  for (const s of set.shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of set.unshallow) parts.push(pkt(`unshallow ${s}\n`));
  parts.push(sideband(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function parseFetchLines(lines: ReturnType<typeof parsePktLines>): FetchParams {
  const params: FetchParams = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] };
  let phase = 0; // 0 = want phase, 1 = have phase
  for (const line of lines) {
    if (line.kind === 'flush') {
      phase = 1;
      continue;
    }
    if (line.kind !== 'data') continue;
    const text = line.data.toString('utf8').trimEnd();
    if (text.startsWith('want ')) params.wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) params.haves.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('shallow ')) params.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) params.deepen = Number(text.slice(7).trim());
    else if (text.startsWith('deepen-since ')) params.deepenSince = Number(text.slice(13).trim());
    else if (text.startsWith('deepen-not ')) params.deepenNot.push(text.slice(11).trim());
  }
  return params;
}

export function handleUploadPack(repo: Repo | null, body: Buffer): GitResponse {
  if (!repo) return err(404, 'Repository not found');
  const lines = parsePktLines(body);
  const first = lines.find((l) => l.kind === 'data');
  const firstText = first ? first.data.toString('utf8') : '';
  if (firstText.startsWith('command=')) {
    // Protocol v2.
    const command = firstText.trimEnd().slice('command='.length);
    if (command === 'ls-refs') {
      return ok('application/x-git-upload-pack-result', handleLsRefs(repo, lines));
    }
    if (command === 'fetch') {
      const params: FetchParams = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] };
      let pastDelim = false;
      for (const line of lines) {
        if (line.kind === 'delim') {
          pastDelim = true;
          continue;
        }
        if (line.kind !== 'data' || !pastDelim) continue;
        const text = line.data.toString('utf8').trimEnd();
        if (text.startsWith('want ')) params.wants.push(text.slice(5).split(' ')[0]);
        else if (text.startsWith('have ')) params.haves.push(text.slice(5).split(' ')[0]);
        else if (text.startsWith('shallow ')) params.shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) params.deepen = Number(text.slice(7).trim());
        else if (text.startsWith('deepen-since ')) params.deepenSince = Number(text.slice(13).trim());
        else if (text.startsWith('deepen-not ')) params.deepenNot.push(text.slice(11).trim());
      }
      return ok('application/x-git-upload-pack-result', fetchResponse(repo, params, true));
    }
    return err(400, `Unknown v2 command ${command}`);
  }
  // Protocol v0.
  const params = parseFetchLines(lines);
  return ok('application/x-git-upload-pack-result', fetchResponse(repo, params, false));
}

// ------------------------------------------------------------ receive-pack (v0)
export function handleReceivePack(repo: Repo | null, body: Buffer): GitResponse {
  if (!repo) return err(404, 'Repository not found');
  const { lines, rest } = splitAtFlush(body);
  const commands: { old: string; next: string; ref: string }[] = [];
  // The first command line carries the client's capabilities after a NUL:
  // `<old> <new> <ref>\0report-status side-band-64k ofs-delta agent=...`.
  // The NUL and everything after it are NOT part of the ref name.
  let clientSideband = false;
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.data.toString('utf8').trimEnd();
    const nul = text.indexOf('\0');
    const beforeNul = nul === -1 ? text : text.slice(0, nul);
    if (nul !== -1) {
      const caps = text.slice(nul + 1).split(' ');
      if (caps.includes('side-band-64k')) clientSideband = true;
    }
    const parts = beforeNul.split(' ');
    if (parts.length >= 3) commands.push({ old: parts[0], next: parts[1], ref: parts[2] });
  }
  // Unpack first: even a rejected push stores its objects.
  if (rest.length > 0) {
    try {
      const parsed = parsePack(rest);
      for (const [oid, obj] of parsed.objects) repo.objects.set(oid, obj);
    } catch {
      // A bad pack still gets a report; the client checks unpack ok separately.
      const report = [pkt('unpack bad pack\n')];
      for (const c of commands) report.push(pkt(`ng ${c.ref} unpack failed\n`));
      report.push(FLUSH);
      const reportBytes = Buffer.concat(report);
      const bodyOut = clientSideband ? Buffer.concat([sideband(reportBytes), FLUSH]) : reportBytes;
      return ok('application/x-git-receive-pack-result', bodyOut);
    }
  }
  const report: Buffer[] = [pkt('unpack ok\n')];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let problem: string | null = null;
    if (cmd.old === ZERO_OID) {
      // Create.
      if (current !== undefined) problem = 'non-fast-forward';
      else if (!repo.objects.has(cmd.next)) problem = 'object not found';
    } else if (cmd.next === ZERO_OID) {
      // Delete.
      if (current === undefined || current !== cmd.old) problem = 'non-fast-forward';
    } else {
      // Update.
      if (current === undefined || current !== cmd.old) problem = 'non-fast-forward';
      else if (!repo.objects.has(cmd.next)) problem = 'object not found';
      else if (!repo.isDescendant(cmd.next, cmd.old)) problem = 'non-fast-forward';
    }
    if (problem !== null) {
      report.push(pkt(`ng ${cmd.ref} ${problem}\n`));
      continue;
    }
    if (cmd.next === ZERO_OID) repo.refs.delete(cmd.ref);
    else repo.refs.set(cmd.ref, cmd.next);
    report.push(pkt(`ok ${cmd.ref}\n`));
  }
  report.push(FLUSH);
  const reportBytes = Buffer.concat(report);
  // With side-band-64k the report-status stream is pkt-lined inside band 1;
  // without it the body is the report-status pkt-line stream directly.
  const bodyOut = clientSideband ? Buffer.concat([sideband(reportBytes), FLUSH]) : reportBytes;
  return ok('application/x-git-receive-pack-result', bodyOut);
}

// Re-export for tests.
export { DELIM };
