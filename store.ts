// store.ts — one in-memory store shared by git, REST, GraphQL and MCP.
import {
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTreesFromFiles,
  buildTree,
  parseCommit,
  parseTag,
  parseTree,
  sha1Object,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './gitutil.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[]; // label names
  createdSeq: number;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export class Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>(); // refname -> oid
  issues = new Map<number, Issue>();
  issueSeq = 0;
  comments = new Map<number, IssueComment[]>(); // issue number -> comments
  commentSeq = 0;
  pulls = new Map<number, Pull>();
  pullSeq = 0;
  labels = new Map<string, Label>();
  createdSeq: number;

  constructor(id: number, name: string, description: string, isPrivate: boolean, createdSeq: number) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdSeq = createdSeq;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: ObjectType, data: Buffer): string {
    const oid = sha1Object(type, data);
    this.objects.set(oid, { type, data });
    return oid;
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  headOid(): string | undefined {
    return this.refs.get(`refs/heads/${this.defaultBranch}`);
  }

  /** All refs, sorted: HEAD is not stored here; callers add it. */
  allRefs(): { name: string; oid: string }[] {
    const out: { name: string; oid: string }[] = [];
    for (const [name, oid] of this.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Walk a commit's ancestry (including itself), first-parent and all parents. */
  commitAncestors(start: string): Set<string> {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return seen;
  }

  /** Is `desc` a descendant of (or equal to) `anc`? */
  isDescendant(desc: string, anc: string): boolean {
    if (desc === anc) return true;
    return this.commitAncestors(desc).has(anc);
  }

  /** First common ancestor of a and b (best merge-base approximation for linear histories). */
  mergeBase(a: string, b: string): string | null {
    const ancA = this.commitAncestors(a);
    const stack = [b];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      seen.add(oid);
      if (ancA.has(oid)) return oid;
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return null;
  }

  /** Flat file map of a tree: path -> {mode, oid}. */
  flattenTree(treeOid: string, out = new Map<string, { mode: string; oid: string }>(), prefix = ''): Map<string, { mode: string; oid: string }> {
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') this.flattenTree(e.oid, out, path);
      else out.set(path, { mode: e.mode, oid: e.oid });
    }
    return out;
  }

  /** Tree oid of a commit. */
  treeOf(commitOid: string): string {
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return '';
    return parseCommit(obj.data).tree;
  }

  /** All objects reachable from a commit (commit + its tree + blobs), recursively. */
  collectCommitObjects(commitOid: string, out: Set<string>): void {
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return;
    if (out.has(commitOid)) return;
    out.add(commitOid);
    const treeOid = parseCommit(obj.data).tree;
    this.collectTreeObjects(treeOid, out);
  }

  collectTreeObjects(treeOid: string, out: Set<string>): void {
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    if (out.has(treeOid)) return;
    out.add(treeOid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') this.collectTreeObjects(e.oid, out);
      else out.add(e.oid);
    }
  }

  /** Create a commit on a branch from a flat file map; returns the commit oid. */
  commitFiles(branch: string, files: Map<string, { mode: string; oid: string }>, message: string): string {
    const { rootOid, trees } = buildTreesFromFiles(files);
    for (const [oid, obj] of trees) this.objects.set(oid, obj);
    const parent = this.refs.get(`refs/heads/${branch}`);
    const parents = parent ? [parent] : [];
    const data = buildCommit(rootOid, parents, message);
    const oid = this.putObject('commit', data);
    this.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }
}

export class Store {
  reposByName = new Map<string, Repo>();
  reposById = new Map<number, Repo>();
  nextRepoId = 5000;
  viewerLogin: string | null = null;
  private seq = 0;

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Learn the viewer login from the first owner segment seen, then validate. */
  resolveOwner(owner: string): string | null {
    if (this.viewerLogin === null) this.viewerLogin = owner;
    return this.viewerLogin === owner ? owner : null;
  }

  findRepo(owner: string, name: string): Repo | null {
    if (this.resolveOwner(owner) === null) return null;
    return this.reposByName.get(name) ?? null;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.reposByName.has(name)) return null;
    const repo = new Repo(this.nextRepoId, name, description, isPrivate, this.nextSeq());
    this.nextRepoId += 1;
    this.reposByName.set(name, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  listRepos(): Repo[] {
    return [...this.reposByName.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ------------------------------------------------------------ issues
  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): { issue: Issue | null; error: string | null } {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return { issue: null, error: `Label '${name}' does not exist` };
    }
    repo.issueSeq += 1;
    const issue: Issue = {
      id: repo.id * 100000 + repo.issueSeq,
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      createdSeq: this.nextSeq(),
    };
    repo.issues.set(issue.number, issue);
    return { issue, error: null };
  }

  // ------------------------------------------------------------ pulls
  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): { pull: Pull | null; error: string | null } {
    const headTip = repo.refs.get(`refs/heads/${headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headTip) return { pull: null, error: `Head branch '${headRef}' does not exist` };
    if (!baseTip) return { pull: null, error: `Base branch '${baseRef}' does not exist` };
    for (const p of repo.pulls.values()) {
      if (p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef) {
        return { pull: null, error: 'A pull request already exists for these branches' };
      }
    }
    repo.pullSeq += 1;
    const pull: Pull = {
      id: repo.id * 100000 + repo.pullSeq,
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    repo.pulls.set(pull.number, pull);
    return { pull, error: null };
  }

  /** Three-way merge check. Returns the merged tree oid, or null on conflict. */
  mergeCheck(repo: Repo, pull: Pull): { conflict: boolean; treeOid: string | null } {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = repo.mergeBase(headTip, baseTip);
    const ancestorTree = base ? repo.treeOf(base) : '';
    const headFiles = repo.flattenTree(repo.treeOf(headTip));
    const baseFiles = repo.flattenTree(repo.treeOf(baseTip));
    const ancestorFiles = ancestorTree === '' ? new Map<string, { mode: string; oid: string }>() : repo.flattenTree(ancestorTree);
    const changedByHead = diffMaps(ancestorFiles, headFiles);
    const changedByBase = diffMaps(ancestorFiles, baseFiles);
    for (const [path, change] of changedByHead) {
      const baseChange = changedByBase.get(path);
      if (baseChange && baseChange.newOid !== change.newOid) return { conflict: true, treeOid: null };
    }
    // Apply head's changes onto the base tip's tree.
    const merged = new Map(baseFiles);
    for (const [path, change] of changedByHead) {
      if (change.newOid === null) merged.delete(path);
      else merged.set(path, { mode: change.mode ?? '100644', oid: change.newOid });
    }
    const { rootOid, trees } = buildTreesFromFiles(merged);
    for (const [oid, obj] of trees) repo.objects.set(oid, obj);
    return { conflict: false, treeOid: rootOid };
  }

  /** Squash-merge a pull request. Returns {ok, sha, error, status}. */
  mergePull(repo: Repo, pull: Pull): { ok: boolean; sha: string | null; error: string | null; status: number } {
    if (pull.state !== 'open') return { ok: false, sha: null, error: 'Pull request is not open', status: 422 };
    const check = this.mergeCheck(repo, pull);
    if (check.conflict || check.treeOid === null) {
      return { ok: false, sha: null, error: 'Merge conflict', status: 405 };
    }
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n`;
    const data = buildCommit(check.treeOid, [baseTip], message);
    const sha = repo.putObject('commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = '2025-01-01T00:00:00Z';
    pull.mergeCommitSha = sha;
    return { ok: true, sha, error: null, status: 200 };
  }

  /** Is this pull mergeable right now (open and conflict-free)? */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'MERGEABLE';
    return this.mergeCheck(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
  }
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  mode: string | null;
}

/** Diff two flat file maps (ancestor -> descendant). */
export function diffMaps(
  from: Map<string, { mode: string; oid: string }>,
  to: Map<string, { mode: string; oid: string }>,
): Map<string, FileChange> {
  const out = new Map<string, FileChange>();
  for (const [path, f] of to) {
    const old = from.get(path);
    if (!old) out.set(path, { path, status: 'added', oldOid: null, newOid: f.oid, mode: f.mode });
    else if (old.oid !== f.oid) out.set(path, { path, status: 'modified', oldOid: old.oid, newOid: f.oid, mode: f.mode });
  }
  for (const [path, f] of from) {
    if (!to.has(path)) out.set(path, { path, status: 'removed', oldOid: f.oid, newOid: null, mode: f.mode });
  }
  return out;
}

/** Count lines in a buffer (git style: number of '\n', plus one for a trailing partial line). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}

/** Line diff between two buffers: returns {additions, deletions} via LCS on lines. */
export function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = oldData.length === 0 ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData.length === 0 ? [] : newData.toString('utf8').split('\n');
  // Trim the trailing empty element produced by a final newline.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const m = oldLines.length;
  const n = newLines.length;
  // LCS dynamic programming; files here are <= 4 KiB so this is cheap.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: n - lcs, deletions: m - lcs };
}

/** Resolve a ref-ish (branch name or oid) to a commit oid, for ?ref= handling. */
export function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (!ref) return repo.headOid() ?? null;
  const branchTip = repo.refs.get(`refs/heads/${ref}`);
  if (branchTip) return branchTip;
  const tagTip = repo.refs.get(`refs/tags/${ref}`);
  if (tagTip) {
    const obj = repo.objects.get(tagTip);
    if (obj && obj.type === 'tag') return parseTag(obj.data).object;
    return tagTip;
  }
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** Opaque global ids (never a plain database id or number). */
export function encodeGlobalId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; id: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!m) return null;
    return { kind: m[1], id: Number(m[2]) };
  } catch {
    return null;
  }
}

export { buildTree, parseTree, type TreeEntry };
