import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';

export interface ArchiveLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface ProjectTarArchive {
  stream: Readable;
  contentLength: number;
}

interface ArchiveFile {
  path: string;
  bytes: number;
}

/** Streams a regular-file-only ustar archive without buffering the project. */
export async function projectTarStream(rootPath: string, limits: ArchiveLimits): Promise<ProjectTarArchive> {
  const root = await realpath(rootPath);
  const files = await collectFiles(root, limits);
  const contentLength = files.reduce((total, file) => total + 512 + file.bytes + ((512 - (file.bytes % 512)) % 512), 1024);
  return { stream: Readable.from(makeArchive(root, files)), contentLength };
}

async function collectFiles(root: string, limits: ArchiveLimits): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error('project contains a symbolic link');
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!metadata.isFile()) throw new Error('project contains a non-regular file');
      const path = relative(root, absolute).split(sep).join('/');
      assertSafePath(path);
      if (metadata.size > limits.maxFileBytes) throw new Error('project file exceeds the configured size limit');
      totalBytes += metadata.size;
      if (totalBytes > limits.maxTotalBytes) throw new Error('project exceeds the configured total size limit');
      files.push({ path, bytes: metadata.size });
      if (files.length > limits.maxFiles) throw new Error('project contains too many files');
    }
  }
  await visit(root);
  return files;
}

async function* makeArchive(root: string, files: readonly ArchiveFile[]): AsyncGenerator<Buffer> {
  for (const file of files) {
    const content = await readFile(join(root, file.path));
    if (content.length !== file.bytes) throw new Error('project changed while it was being archived');
    yield tarHeader(file.path, content.length);
    yield content;
    const paddingBytes = (512 - (content.length % 512)) % 512;
    if (paddingBytes > 0) yield Buffer.alloc(paddingBytes);
  }
  yield Buffer.alloc(1024);
}

function tarHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  const separator = path.lastIndexOf('/');
  const name = separator >= 0 ? path.slice(separator + 1) : path;
  const prefix = separator >= 0 ? path.slice(0, separator) : '';
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('project path is too long to archive');
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, '');
  writeString(header, 297, 32, '');
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value, offset, length, 'utf8');
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function assertSafePath(path: string): void {
  if (!path || isAbsolute(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('project contains an unsafe file path');
  }
  if (/(^|\/)(\.pio|\.git|node_modules)(\/|$)/.test(path)) throw new Error('project contains a forbidden generated directory');
}
