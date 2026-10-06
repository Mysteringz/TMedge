/**
 * Reading a .zip somebody uploaded, without trusting any of it
 * (HANDOVER.md §6.2: no absolute paths, no "..", no symlinks, at most 5,000
 * entries and 1 GB unpacked).
 *
 * Written here rather than shelling out to unzip or adding a dependency:
 * the server's runtime deps are express and ws, and the checks are the
 * point. The archive is read twice -- once to judge every entry from the
 * central directory before a byte is written, once to extract -- and the
 * extraction trusts nothing it was told: each entry is metered against its
 * declared size and CRC as it inflates, so a header that lies about a zip
 * bomb's size stops it at that size.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';

export class ZipError extends Error {}

export interface ZipLimits {
  maxEntries: number;
  maxUnpackedBytes: number;
}

export interface ZipEntry {
  /** Relative, "/"-separated, no "." or ".." segments, no trailing slash. */
  path: string;
  dir: boolean;
  /** Mac archive litter (__MACOSX/, .DS_Store): counted, never extracted. */
  skip: boolean;
  method: 0 | 8;
  crc: number;
  compressedSize: number;
  size: number;
  dataOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const MAX_CENTRAL_BYTES = 16 * 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  if (bytesRead !== len) throw new ZipError('the archive is truncated');
  return buf;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** An entry's name as a safe relative path, or a ZipError saying why not. */
function cleanName(raw: Buffer): { path: string; dir: boolean } {
  let name: string;
  try { name = utf8.decode(raw); } catch { throw new ZipError('an entry name is not valid UTF-8'); }
  const shown = JSON.stringify(name.slice(0, 120));
  if (name.length === 0 || name.length > 512) throw new ZipError(`entry ${shown}: empty or overlong name`);
  // Backslash is a separator to Windows tools: "..\\x" is traversal there.
  if (/[\x00-\x1f\x7f\\]/.test(name)) throw new ZipError(`entry ${shown}: control characters or backslashes in the name`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ZipError(`entry ${shown}: absolute path`);
  const dir = name.endsWith('/');
  const segs = (dir ? name.slice(0, -1) : name).split('/');
  if (segs.some((s) => s === '..')) throw new ZipError(`entry ${shown}: ".." in the path`);
  if (segs.some((s) => s === '' || s === '.')) throw new ZipError(`entry ${shown}: empty or "." path segment`);
  if (segs.length > 32) throw new ZipError(`entry ${shown}: nested deeper than 32 directories`);
  return { path: segs.join('/'), dir };
}

/** zlib.crc32 arrived in Node 20.15 / 22.2; package.json still admits older 20s. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer, prev: number): number {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, prev);
  let c = ~prev;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Judges every entry from the central directory. Throws ZipError for the
 * first thing wrong; returns the entries in archive order otherwise.
 */
export async function readZip(path: string, limits: ZipLimits): Promise<{ entries: ZipEntry[]; unpackedBytes: number }> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    if (size < 22) throw new ZipError('not a zip archive');
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let at = -1;
    // The end record is the last thing in the file, followed only by its comment.
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { at = i; break; }
    }
    if (at < 0) throw new ZipError('not a zip archive (no end-of-directory record)');
    const eocdPos = size - tailLen + at;
    const total = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdOffset = tail.readUInt32LE(at + 16);
    if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0 || tail.readUInt16LE(at + 8) !== total) {
      throw new ZipError('split (multi-part) archives are not supported');
    }
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff ||
        (eocdPos >= 20 && (await readAt(fh, eocdPos - 20, 4)).readUInt32LE(0) === ZIP64_LOCATOR)) {
      throw new ZipError('ZIP64 archives are not supported');
    }
    if (total > limits.maxEntries) throw new ZipError(`more than ${limits.maxEntries} entries`);
    if (cdOffset + cdSize > eocdPos || cdSize > MAX_CENTRAL_BYTES) throw new ZipError('corrupt archive (central directory out of range)');

    const cd = await readAt(fh, cdOffset, cdSize);
    const entries: (ZipEntry & { localOffset: number; rawName: Buffer })[] = [];
    let unpackedBytes = 0;
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) throw new ZipError('corrupt archive (central directory)');
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const diskStart = cd.readUInt16LE(p + 34);
      const external = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ZipError('corrupt archive (central directory)');
      const rawName = Buffer.from(cd.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (diskStart !== 0) throw new ZipError('split (multi-part) archives are not supported');
      if (compressedSize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported');

      const { path: name, dir: slash } = cleanName(rawName);
      const shown = JSON.stringify(name.slice(0, 120));
      // Bit 0: encrypted; bit 6: strong encryption.
      if (flags & 0x41) throw new ZipError(`entry ${shown}: encrypted entries are not supported`);
      if (method !== 0 && method !== 8) throw new ZipError(`entry ${shown}: compression method ${method} is not supported (use deflate)`);
      let dir = slash;
      // Unix-made archives carry the file type in the high half of the attributes.
      if (madeBy >> 8 === 3) {
        const type = (external >>> 16) & S_IFMT;
        if (type === S_IFLNK) throw new ZipError(`entry ${shown}: symbolic links are not allowed`);
        if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) throw new ZipError(`entry ${shown}: only files and directories are allowed`);
        if (type === S_IFDIR) dir = true;
        if (type === S_IFREG && slash) throw new ZipError(`entry ${shown}: a file named like a directory`);
      }
      if (dir && usize !== 0) throw new ZipError(`entry ${shown}: a directory with contents`);
      unpackedBytes += usize;
      if (unpackedBytes > limits.maxUnpackedBytes) {
        throw new ZipError(`unpacks to more than ${Math.round(limits.maxUnpackedBytes / 1048576)} MB`);
      }
      const skip = name === '__MACOSX' || name.startsWith('__MACOSX/') || name === '.DS_Store' || name.endsWith('/.DS_Store');
      entries.push({ path: name, dir, skip, method, crc, compressedSize, size: usize, dataOffset: 0, localOffset, rawName });
    }
    if (p !== cd.length) throw new ZipError('corrupt archive (central directory length)');

    // One name, one entry: a duplicate, or a file where another entry needs a
    // directory, would make extraction order decide what lands on disk.
    const files = new Set<string>();
    const dirs = new Set<string>();
    for (const e of entries) {
      if (e.skip) continue;
      if (files.has(e.path) || (!e.dir && dirs.has(e.path))) throw new ZipError(`entry ${JSON.stringify(e.path)} appears twice`);
      if (e.dir) dirs.add(e.path); else files.add(e.path);
      const segs = e.path.split('/');
      for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
    }
    for (const f of files) if (dirs.has(f)) throw new ZipError(`entry ${JSON.stringify(f)} is both a file and a directory`);

    // Each entry's bytes must be its own: overlapping entries are how a small
    // archive claims many large files from the same compressed data.
    const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
    let end = 0;
    for (const e of byOffset) {
      if (e.localOffset < end) throw new ZipError(`entry ${JSON.stringify(e.path)} overlaps another`);
      const local = await readAt(fh, e.localOffset, 30);
      if (local.readUInt32LE(0) !== LOCAL) throw new ZipError(`entry ${JSON.stringify(e.path)}: bad local header`);
      if (local.readUInt16LE(8) !== e.method || (local.readUInt16LE(6) & 0x41)) throw new ZipError(`entry ${JSON.stringify(e.path)}: local header disagrees with the directory`);
      const nameLen = local.readUInt16LE(26);
      const extraLen = local.readUInt16LE(28);
      // The name a lenient tool would use must be the name we checked.
      if (!(await readAt(fh, e.localOffset + 30, nameLen)).equals(e.rawName)) {
        throw new ZipError(`entry ${JSON.stringify(e.path)}: local name disagrees with the directory`);
      }
      e.dataOffset = e.localOffset + 30 + nameLen + extraLen;
      end = e.dataOffset + e.compressedSize;
      if (end > cdOffset) throw new ZipError(`entry ${JSON.stringify(e.path)}: data runs past the archive`);
    }
    return {
      entries: entries.map(({ localOffset: _l, rawName: _r, ...e }) => e),
      unpackedBytes,
    };
  } finally {
    await fh.close();
  }
}

/** Passes bytes through, stopping at the declared size and keeping a CRC. */
class Meter extends Transform {
  bytes = 0;
  crc = 0;
  constructor(private readonly max: number, private readonly what: string) { super(); }
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.max) return done(new ZipError(`entry ${this.what}: inflates past its declared size`));
    this.crc = crc32(chunk, this.crc);
    done(null, chunk);
  }
}

/**
 * Writes the entries readZip accepted under `dest`, which must not exist
 * yet. Files are created exclusively (never through anything already
 * there) and readable only by this service.
 */
export async function extractZip(path: string, dest: string, entries: readonly ZipEntry[]): Promise<void> {
  const root = resolve(dest);
  await mkdir(root, { mode: 0o700 });
  for (const e of entries) {
    if (e.skip) continue;
    const target = resolve(root, ...e.path.split('/'));
    // Already guaranteed by cleanName; checked again because it is the whole point.
    if (!target.startsWith(root + sep)) throw new ZipError(`entry ${JSON.stringify(e.path)} escapes the destination`);
    if (e.dir) { await mkdir(target, { recursive: true, mode: 0o700 }); continue; }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const out = createWriteStream(target, { flags: 'wx', mode: 0o600 });
    const meter = new Meter(e.size, JSON.stringify(e.path));
    if (e.compressedSize === 0) {
      out.end();
      await new Promise<void>((ok, fail) => { out.once('finish', ok); out.once('error', fail); });
    } else {
      const src = createReadStream(path, { start: e.dataOffset, end: e.dataOffset + e.compressedSize - 1 });
      try {
        if (e.method === 8) await pipeline(src, zlib.createInflateRaw(), meter, out);
        else await pipeline(src, meter, out);
      } catch (err) {
        if (err instanceof ZipError) throw err;
        throw new ZipError(`entry ${JSON.stringify(e.path)}: ${(err as Error).message}`);
      }
    }
    if (meter.bytes !== e.size) throw new ZipError(`entry ${JSON.stringify(e.path)}: size disagrees with the directory`);
    if ((meter.crc >>> 0) !== e.crc) throw new ZipError(`entry ${JSON.stringify(e.path)}: CRC mismatch (corrupt archive)`);
  }
}
