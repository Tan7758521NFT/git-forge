// gitutil.ts — git object model, pkt-line framing, packfile build/parse.
// Standard library only. No git binary anywhere.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
// Fixed author/committer timestamp for objects the server itself creates
// (contents PUT commits, squash merges). Deterministic across live/replay.
export const FIXED_TS = 1735689600; // 2025-01-01T00:00:00Z
export const SERVER_IDENT = 'Forge <forge@make.fun>';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const TYPE_NUM: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const NUM_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Object(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isValidOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

// ---------------------------------------------------------------- pkt-line
export function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const out = Buffer.alloc(len);
  out.write(len.toString(16).padStart(4, '0'), 0, 'ascii');
  payload.copy(out, 4);
  return out;
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface PktLine {
  kind: 'flush' | 'delim' | 'data';
  data: Buffer; // for data lines: payload without the 4-byte length
}

/** Parse a whole pkt-line stream into lines. Stops at end of buffer. */
export function parsePktLines(buf: Buffer): PktLine[] {
  const lines: PktLine[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.toString('ascii', off, off + 4);
    const len = Number.parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      lines.push({ kind: 'flush', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      lines.push({ kind: 'delim', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    lines.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return lines;
}

/** Split a pkt-line stream at the first flush: returns [linesBeforeFlush, offsetAfterFlush]. */
export function splitAtFlush(buf: Buffer): { lines: PktLine[]; rest: Buffer } {
  const lines: PktLine[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.toString('ascii', off, off + 4);
    const len = Number.parseInt(lenHex, 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) {
      off += 4;
      return { lines, rest: buf.subarray(off) };
    }
    if (len === 1) {
      lines.push({ kind: 'delim', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    lines.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { lines, rest: buf.subarray(off) };
}

/** Wrap raw bytes into sideband band-1 pkt-lines (max 65515 data bytes each). */
export function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  while (off < data.length) {
    const chunk = data.subarray(off, Math.min(data.length, off + 65515));
    const frame = Buffer.alloc(chunk.length + 1);
    frame[0] = 1;
    chunk.copy(frame, 1);
    parts.push(pkt(frame));
    off += chunk.length;
  }
  if (data.length === 0) {
    // A zero-length sideband stream still needs at least one frame? No:
    // an empty report is just a flush. Caller appends FLUSH.
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits
export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildCommit(
  tree: string,
  parents: string[],
  message: string,
  author: string = SERVER_IDENT,
  committer: string = SERVER_IDENT,
  ts: number = FIXED_TS,
): Buffer {
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${author} ${ts} +0000\n`;
  s += `committer ${committer} ${ts} +0000\n`;
  s += `\n${message}`;
  return Buffer.from(s, 'utf8');
}

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  const info: TagInfo = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) info.tag = line.slice(4);
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

export function buildTag(
  object: string,
  type: ObjectType,
  tag: string,
  message: string,
  tagger: string = SERVER_IDENT,
  ts: number = FIXED_TS,
): Buffer {
  const s = `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger} ${ts} +0000\n\n${message}`;
  return Buffer.from(s, 'utf8');
}

// ---------------------------------------------------------------- trees
export interface TreeEntry {
  mode: string; // '100644' file, '40000' dir
  name: string;
  oid: string;
}

export function gitSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const mode = data.toString('ascii', off, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    gitSortKey(a) < gitSortKey(b) ? -1 : gitSortKey(a) > gitSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Build nested trees from a flat path->blob map. Returns the root tree oid and
 * every new tree object created (caller stores them).
 */
export function buildTreesFromFiles(
  files: Map<string, { mode: string; oid: string }>,
): { rootOid: string; trees: Map<string, GitObject> } {
  const trees = new Map<string, GitObject>();
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, f] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], f);
  }
  function build(node: Node): string {
    const entries: TreeEntry[] = [];
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, child] of node.dirs) {
      const childOid = build(child);
      entries.push({ mode: '40000', name, oid: childOid });
    }
    const data = buildTree(entries);
    const oid = sha1Object('tree', data);
    trees.set(oid, { type: 'tree', data });
    return oid;
  }
  const rootOid = build(root);
  return { rootOid, trees };
}

// ---------------------------------------------------------------- packs
/** Build a pack (version 2, no deltas) for the given object ids. */
export function buildPack(oids: string[], getObject: (oid: string) => GitObject | undefined): Buffer {
  const sorted = [...new Set(oids)].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const oid of sorted) {
    const obj = getObject(oid);
    if (!obj) continue;
    const typeNum = TYPE_NUM[obj.type];
    const data = obj.data;
    const headerBytes: number[] = [];
    let size = data.length;
    let first = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headerBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface ParsedPack {
  objects: Map<string, GitObject>;
  count: number;
}

/** Find the length of the zlib stream at the start of buf (expected output size). */
function zlibStreamLength(buf: Buffer, expectedSize: number): number {
  // A zlib stream is at most ~11 bytes of overhead over its input for the sizes
  // we see (stored-block overhead is ~5 bytes per 64 KiB); +64 is a safe cap.
  let hi = Math.min(buf.length, expectedSize + 64);
  let lo = 1;
  // Binary search: truncated streams throw; any length >= true length works.
  const search = (top: number): number => {
    let l = 1;
    let h = top;
    while (l < h) {
      const mid = (l + h) >> 1;
      try {
        const out = inflateSync(buf.subarray(0, mid));
        if (out.length === expectedSize) h = mid;
        else l = mid + 1;
      } catch {
        l = mid + 1;
      }
    }
    return l;
  };
  let found = search(hi);
  try {
    const out = inflateSync(buf.subarray(0, found));
    if (out.length === expectedSize) return found;
  } catch {
    // Fall through to the full-buffer search below.
  }
  if (hi < buf.length) {
    found = search(buf.length);
    const out = inflateSync(buf.subarray(0, found));
    if (out.length !== expectedSize) throw new Error('pack: zlib stream length mismatch');
    return found;
  }
  throw new Error('pack: zlib stream length mismatch');
}

/** Parse a packfile. Throws on bad header/trailer/count. Delta objects are resolved. */
export function parsePack(buf: Buffer): ParsedPack {
  if (buf.length < 32) throw new Error('pack: too short');
  if (buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack: bad magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: unsupported version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(actual)) throw new Error('pack: bad trailer checksum');
  const objects = new Map<string, GitObject>();
  // Header-start offset -> oid, for OFS_DELTA bases. A delta's base always
  // precedes it in the pack, so a single in-order pass resolves everything.
  const posToOid = new Map<number, string>();
  let off = 12;
  const end = buf.length - 20;
  for (let i = 0; i < count; i += 1) {
    if (off >= end) throw new Error('pack: truncated');
    const headerStart = off;
    let byte = buf[off];
    off += 1;
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off];
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      // OFS_DELTA: base offset (negative-offset varint) from this header start.
      let b = buf[off];
      off += 1;
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[off];
        off += 1;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const basePos = headerStart - baseOff;
      const zlen = zlibStreamLength(buf.subarray(off, end), size);
      const data = inflateSync(buf.subarray(off, off + zlen));
      off += zlen;
      const baseOid = posToOid.get(basePos);
      const base = baseOid ? objects.get(baseOid) : undefined;
      if (!base) throw new Error('pack: delta base not found');
      const resolved = applyDelta(base.data, data);
      const oid = sha1Object(base.type, resolved);
      objects.set(oid, { type: base.type, data: resolved });
      posToOid.set(headerStart, oid);
    } else if (typeNum === 7) {
      // REF_DELTA: 20-byte base oid
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const zlen = zlibStreamLength(buf.subarray(off, end), size);
      const data = inflateSync(buf.subarray(off, off + zlen));
      off += zlen;
      const base = objects.get(baseOid);
      if (!base) throw new Error('pack: delta base not found');
      const resolved = applyDelta(base.data, data);
      const oid = sha1Object(base.type, resolved);
      objects.set(oid, { type: base.type, data: resolved });
      posToOid.set(headerStart, oid);
    } else {
      const type = NUM_TYPE[typeNum];
      if (!type) throw new Error(`pack: unknown object type ${typeNum}`);
      const zlen = zlibStreamLength(buf.subarray(off, end), size);
      const data = inflateSync(buf.subarray(off, off + zlen));
      off += zlen;
      const oid = sha1Object(type, data);
      objects.set(oid, { type, data });
      posToOid.set(headerStart, oid);
    }
  }
  return { objects, count };
}

/** Apply a git delta (base + delta) -> result. Delta format: src size, dst size, ops. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  function readVarint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off];
      off += 1;
      result |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return result;
  }
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('pack: delta source size mismatch');
  const out = Buffer.alloc(dstSize);
  let outOff = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      // copy from base
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) { cpOff = delta[off]; off += 1; }
      if (op & 0x02) { cpOff |= delta[off] << 8; off += 1; }
      if (op & 0x04) { cpOff |= delta[off] << 16; off += 1; }
      if (op & 0x08) { cpOff |= delta[off] << 24; off += 1; }
      if (op & 0x10) { cpSize = delta[off]; off += 1; }
      if (op & 0x20) { cpSize |= delta[off] << 8; off += 1; }
      if (op & 0x40) { cpSize |= delta[off] << 16; off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, outOff, cpOff, cpOff + cpSize);
      outOff += cpSize;
    } else if (op !== 0) {
      // insert literal
      delta.copy(out, outOff, off, off + op);
      off += op;
      outOff += op;
    } else {
      throw new Error('pack: delta opcode 0');
    }
  }
  if (outOff !== dstSize) throw new Error('pack: delta output size mismatch');
  return out;
}
