import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTMflashRelease, TMFLASH_MANIFEST, TMFLASH_MAX_BYTES, TMFLASH_REPOSITORY, TMflashUnavailable,
  type HostedTMflashRelease, type TMflashRelease } from '../../shared/tmflash-release.js';

export interface TMflashReleaseSource {
  latest(): Promise<HostedTMflashRelease>;
  file(tag: string, filename: string): string | null;
}
const FRESH_MS = 60_000, RETRY_MS = 15_000, DEADLINE_MS = 120_000;
const MANIFEST_LIMIT = 16 * 1024;

/** A verified DMG on disk, rather than a large buffer per browser download.
 * The cache lives outside deployment releases, so app updates need no deploy
 * and a temporary GitHub outage does not discard a previously checked build.
 */
export class GitHubTMflashSource implements TMflashReleaseSource {
  private current: HostedTMflashRelease | null = null;
  private readonly files = new Map<string, string>();
  private restoring: Promise<void> | null = null;
  private checking: Promise<HostedTMflashRelease> | null = null;
  private failure: { at: number; error: TMflashUnavailable } | null = null;

  constructor(private readonly directory: string, private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now) {}

  async latest(): Promise<HostedTMflashRelease> {
    this.restoring ??= this.restore();
    await this.restoring;
    if (this.current && this.now() - this.current.checkedAt < FRESH_MS) return this.current;
    if (this.failure && this.now() - this.failure.at < RETRY_MS) {
      if (this.current) return { ...this.current, stale: true };
      throw this.failure.error;
    }
    this.checking ??= this.check().finally(() => { this.checking = null; });
    return this.checking;
  }

  file(tag: string, filename: string): string | null { return this.files.get(`${tag}/${filename}`) ?? null; }
  private path(release: TMflashRelease): string { return join(this.directory, `asset-${release.sha256}.dmg`); }

  private async restore(): Promise<void> {
    try {
      for (const name of await readdir(this.directory)) {
        // An interrupted process cannot run its finally block. Remove only
        // our expired staging files, leaving an active downloader alone.
        if (/^(download|pointer)-[0-9a-f-]{36}\.tmp$/.test(name)
          && Date.now() - (await stat(join(this.directory, name))).mtimeMs > DEADLINE_MS * 2) {
          await unlink(join(this.directory, name)).catch(() => undefined);
        }
      }
    } catch { /* The cache need not exist before its first request. */ }
    try {
      const pointer = join(this.directory, 'current.json');
      if ((await stat(pointer)).size > MANIFEST_LIMIT) return;
      const text = await readFile(pointer, 'utf8');
      const release = parseTMflashRelease(text);
      const raw: unknown = JSON.parse(text);
      const checkedAt = raw && typeof raw === 'object' && 'checkedAt' in raw && typeof raw.checkedAt === 'number' ? raw.checkedAt : 0;
      if (!Number.isFinite(checkedAt) || checkedAt > this.now()) return;
      await this.verifyFile(this.path(release), release);
      this.current = { ...release, repository: TMFLASH_REPOSITORY, checkedAt, stale: false };
      this.files.set(`${release.tag}/${release.filename}`, this.path(release));
    } catch { /* An absent or damaged cache is fetched again, never offered unchecked. */ }
  }

  private async check(): Promise<HostedTMflashRelease> {
    try {
      const signal = AbortSignal.timeout(DEADLINE_MS);
      const base = `https://github.com/${TMFLASH_REPOSITORY}/releases`;
      const response = await this.get(`${base}/latest/download/${TMFLASH_MANIFEST}`, signal);
      if (!response) throw new TMflashUnavailable('none', 'The first portable TMflash release has not been published yet.');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new TMflashUnavailable('unreachable', 'GitHub returned no release manifest.');
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > MANIFEST_LIMIT) throw new TMflashUnavailable('invalid', 'The TMflash release manifest is too large.');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const release = parseTMflashRelease(Buffer.concat(chunks).toString('utf8'));
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = this.path(release);
      if (!this.current || this.current.sha256 !== release.sha256) {
        // A file left by an interrupted publication is useful only if it
        // passes the same complete checks as a fresh network download.
        let cached = false;
        try { await this.verifyFile(path, release); cached = true; } catch { /* download below */ }
        if (!cached) await this.download(`${base}/download/${release.tag}/${release.filename}`, path, release, signal);
      }
      const hosted: HostedTMflashRelease = { ...release, repository: TMFLASH_REPOSITORY, checkedAt: this.now(), stale: false };
      const temporary = join(this.directory, `pointer-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(hosted), { mode: 0o600, flag: 'wx' });
        await rename(temporary, join(this.directory, 'current.json'));
      } finally { await unlink(temporary).catch(() => undefined); }
      this.current = hosted;
      this.failure = null;
      this.files.delete(`${release.tag}/${release.filename}`);
      this.files.set(`${release.tag}/${release.filename}`, path);
      // Keep one previous build so a click on a page just refreshed by
      // another user still downloads the file that page actually showed.
      while (this.files.size > 2) {
        const first = this.files.keys().next().value;
        if (first === undefined) break;
        this.files.delete(first);
      }
      const keep = new Set(this.files.values());
      for (const name of await readdir(this.directory)) {
        if (/^asset-[0-9a-f]{64}\.dmg$/.test(name) && !keep.has(join(this.directory, name))) {
          await unlink(join(this.directory, name)).catch(() => undefined);
        }
      }
      return hosted;
    } catch (error) {
      const known = error instanceof TMflashUnavailable ? error : new TMflashUnavailable('unreachable', 'The latest TMflash download could not be prepared. Try again shortly.');
      this.failure = { at: this.now(), error: known };
      if (known.reason === 'unreachable' && this.current) return { ...this.current, stale: true };
      this.current = null;
      this.files.clear();
      await unlink(join(this.directory, 'current.json')).catch(() => undefined);
      throw known;
    }
  }

  private async download(url: string, path: string, release: TMflashRelease, signal: AbortSignal): Promise<void> {
    const response = await this.get(url, signal);
    const reader = response?.body?.getReader();
    if (!reader) throw new TMflashUnavailable('invalid', 'The latest TMflash release is missing its DMG.');
    const temporary = join(this.directory, `download-${randomUUID()}.tmp`);
    const output = await open(temporary, 'wx', 0o600);
    const digest = createHash('sha256');
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > release.size || bytes > TMFLASH_MAX_BYTES) throw new TMflashUnavailable('invalid', 'The TMflash DMG exceeds its declared size.');
        digest.update(chunk.value);
        await output.writeFile(chunk.value);
      }
      if (bytes !== release.size || digest.digest('hex') !== release.sha256) {
        throw new TMflashUnavailable('invalid', 'The TMflash DMG failed its size or SHA-256 check.');
      }
      await output.close();
      await this.verifyTrailer(temporary);
      await rename(temporary, path);
    } finally {
      await reader.cancel().catch(() => undefined);
      await output.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async verifyFile(path: string, release: TMflashRelease): Promise<void> {
    if ((await stat(path)).size !== release.size) throw new Error('cached size differs');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
    if (digest.digest('hex') !== release.sha256) throw new Error('cached hash differs');
    await this.verifyTrailer(path);
  }
  private async verifyTrailer(path: string): Promise<void> {
    const file = await open(path, 'r');
    try {
      const size = (await file.stat()).size;
      const header = Buffer.alloc(4);
      const { bytesRead } = await file.read(header, 0, 4, size - 512);
      if (bytesRead !== 4 || header.toString('ascii') !== 'koly') throw new TMflashUnavailable('invalid', 'The TMflash download is not a macOS disk image.');
    } finally { await file.close(); }
  }

  /** Follow every redirect ourselves: no credential and no non-GitHub host. */
  private async get(url: string, signal: AbortSignal): Promise<Response | null> {
    let target = new URL(url);
    for (let hop = 0; hop <= 5; hop++) {
      if (target.protocol !== 'https:' || target.username || target.password || target.port
        || !(target.hostname === 'github.com' || target.hostname.endsWith('.githubusercontent.com'))) {
        throw new TMflashUnavailable('invalid', 'GitHub pointed the TMflash download outside GitHub.');
      }
      const response = await this.fetcher(target, { redirect: 'manual', signal,
        headers: { accept: 'application/octet-stream', 'user-agent': 'TMedge-TMflash-download' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new TMflashUnavailable('unreachable', 'GitHub returned an incomplete redirect.');
        try { target = new URL(location, target); } catch { throw new TMflashUnavailable('invalid', 'GitHub returned an invalid download address.'); }
        continue;
      }
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new TMflashUnavailable('unreachable', 'GitHub is temporarily unavailable for the TMflash download.'); }
      return response;
    }
    throw new TMflashUnavailable('unreachable', 'GitHub redirected the TMflash download too many times.');
  }
}
