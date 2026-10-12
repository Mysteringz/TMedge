import { createHash } from 'node:crypto';
import { planFlash } from '../../shared/flasher/images.js';
import {
  parseManifest, ReleaseUnavailable, RELEASE_FILE_LIMITS, RELEASE_MANIFEST, RELEASE_MANIFEST_LIMIT, TMSENSE_REPOSITORY,
  type PublishedRelease, type ReleaseFileName,
} from '../../shared/flasher/release.js';

/** What the web flasher's routes need: the release on offer, and its bytes. */
export interface PublishedReleaseSource {
  latest(): Promise<PublishedRelease>;
  bytes(tag: string, name: string): Buffer | null;
}

// A person who has just published a release should not wait long to flash it;
// a page left open should not make this edge ask GitHub every few seconds.
const FRESH_MS = 60_000;
// After a failure, the next asker gets the same answer for a moment rather
// than another round trip to a server that just did not answer.
const RETRY_MS = 15_000;
const DEADLINE_MS = 30_000;
const MAX_REDIRECTS = 5;

/**
 * The latest release of the TMsense repository, fetched from GitHub by the
 * edge, checked, and held in memory.
 *
 * It is read without a token: the repository is public, and a credential the
 * edge does not hold cannot leak. Only github.com and GitHub's own download
 * hosts are ever contacted, over https, and a redirect anywhere else ends the
 * fetch. Every file must match the size and SHA-256 its manifest gives, and
 * the three together must make a flash plan (`planFlash`): an ESP32-S3
 * bootloader, a partition table whose checksum holds, and an application that
 * says it is the TMsense version the release claims. A release that fails any
 * of that is not offered at all, because the page writes what this returns to
 * boards without a person reading it first.
 */
export class GitHubReleaseSource implements PublishedReleaseSource {
  private current: { release: PublishedRelease; files: Map<ReleaseFileName, Buffer> } | null = null;
  private failure: { at: number; error: ReleaseUnavailable } | null = null;
  private checking: Promise<PublishedRelease> | null = null;

  constructor(
    private readonly repository: string = TMSENSE_REPOSITORY,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repository)) throw new Error('the firmware repository must be a GitHub <owner>/<name>');
  }

  async latest(): Promise<PublishedRelease> {
    const at = this.now();
    if (this.current && at - this.current.release.checkedAt < FRESH_MS) return this.current.release;
    if (this.failure && at - this.failure.at < RETRY_MS) {
      if (this.current) return this.current.release;
      throw this.failure.error;
    }
    // One fetch however many pages are open.
    this.checking ??= this.check().finally(() => { this.checking = null; });
    return this.checking;
  }

  bytes(tag: string, name: string): Buffer | null {
    if (!this.current || this.current.release.tag !== tag) return null;
    return this.current.files.get(name as ReleaseFileName) ?? null;
  }

  private async check(): Promise<PublishedRelease> {
    try {
      const release = await this.fetchLatest(AbortSignal.timeout(DEADLINE_MS));
      this.failure = null;
      return release;
    } catch (error) {
      const known = error instanceof ReleaseUnavailable ? error : new ReleaseUnavailable('unreachable', 'GitHub could not be reached for the TMsense release');
      this.failure = { at: this.now(), error: known };
      // GitHub being away does not un-publish what was already checked. A
      // latest release that is missing or broken does: the newest thing the
      // repository offers is then not something to flash, and an older one
      // must not pass for it.
      if (known.reason === 'unreachable' && this.current) return this.current.release;
      this.current = null;
      throw known;
    }
  }

  private async fetchLatest(signal: AbortSignal): Promise<PublishedRelease> {
    const base = `https://github.com/${this.repository}/releases`;
    const listing = await this.get(`${base}/latest/download/${RELEASE_MANIFEST}`, RELEASE_MANIFEST_LIMIT, signal);
    if (!listing) throw new ReleaseUnavailable('none', 'the TMsense repository has not published a release with flashable images yet');
    const manifest = parseManifest(listing.toString('utf8'));
    const held = this.current;
    if (held && held.release.tag === manifest.tag && manifest.files.every((file) => held.release.files.some((known) => known.name === file.name && known.sha256 === file.sha256))) {
      held.release = { ...held.release, checkedAt: this.now() };
      return held.release;
    }
    const files = new Map<ReleaseFileName, Buffer>();
    for (const file of manifest.files) {
      const bytes = await this.get(`${base}/download/${encodeURIComponent(manifest.tag)}/${file.name}`, RELEASE_FILE_LIMITS[file.name], signal);
      if (!bytes) throw new ReleaseUnavailable('invalid', `release ${manifest.tag} has no ${file.name}`);
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new ReleaseUnavailable('invalid', `${file.name} in release ${manifest.tag} is not the file its manifest describes`);
      }
      files.set(file.name, bytes);
    }
    const part = (name: ReleaseFileName): Buffer => {
      const bytes = files.get(name);
      if (!bytes) throw new ReleaseUnavailable('invalid', `release ${manifest.tag} has no ${name}`);
      return bytes;
    };
    let version: string;
    try {
      version = planFlash({ bootloader: part('bootloader.bin'), partitions: part('partitions.bin'), application: part('firmware.bin') }).version;
    } catch (error) {
      throw new ReleaseUnavailable('invalid', `release ${manifest.tag} cannot be flashed: ${error instanceof Error ? error.message : 'its images do not fit this board'}`);
    }
    if (version !== manifest.version) throw new ReleaseUnavailable('invalid', `release ${manifest.tag} says it is ${manifest.version}, but its firmware reports ${version}`);
    const release: PublishedRelease = { ...manifest, repository: this.repository, checkedAt: this.now() };
    this.current = { release, files };
    return release;
  }

  /** One file, following redirects by hand so each hop can be refused. null: GitHub has no such file. */
  private async get(url: string, limit: number, signal: AbortSignal): Promise<Buffer | null> {
    let target = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (target.protocol !== 'https:' || !(target.hostname === 'github.com' || target.hostname.endsWith('.githubusercontent.com')) || target.username || target.password) {
        throw new ReleaseUnavailable('invalid', 'GitHub pointed the download somewhere that is not GitHub');
      }
      let response: Response;
      try {
        response = await this.fetcher(target, { redirect: 'manual', signal, headers: { accept: 'application/octet-stream', 'user-agent': 'TMedge-web-flasher' } });
      } catch {
        throw new ReleaseUnavailable('unreachable', 'GitHub could not be reached for the TMsense release');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        try { await response.body?.cancel(); } catch { /* already closed */ }
        if (!location) throw new ReleaseUnavailable('unreachable', 'GitHub answered with a redirect to nowhere');
        try { target = new URL(location, target); } catch { throw new ReleaseUnavailable('invalid', 'GitHub pointed the download somewhere that is not GitHub'); }
        continue;
      }
      if (response.status === 404) {
        try { await response.body?.cancel(); } catch { /* already closed */ }
        return null;
      }
      if (!response.ok || !response.body) {
        try { await response.body?.cancel(); } catch { /* already closed */ }
        throw new ReleaseUnavailable('unreachable', `GitHub answered HTTP ${response.status} for the TMsense release`);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.length;
          // Counted as it arrives: a Content-Length is only what the sender says.
          if (total > limit) throw new ReleaseUnavailable('invalid', 'a release file is larger than anything this board could hold');
          chunks.push(chunk.value);
        }
      } catch (error) {
        try { await reader.cancel(); } catch { /* already closed */ }
        if (error instanceof ReleaseUnavailable) throw error;
        throw new ReleaseUnavailable('unreachable', 'the download from GitHub stopped part-way');
      }
      return Buffer.concat(chunks);
    }
    throw new ReleaseUnavailable('unreachable', 'GitHub redirected the download too many times');
  }
}
