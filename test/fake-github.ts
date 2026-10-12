/**
 * GitHub's release downloads, as far as the edge can tell, and a TMsense
 * release to put behind them.
 *
 * The real thing answers `releases/latest/download/<file>` with a redirect to
 * the tagged URL, and that with a redirect to a signed URL on a download
 * host; this does the same, so the code under test follows the hops it will
 * follow in production. It records every URL asked for: "only GitHub was
 * contacted" is then a claim about requests, not about intentions.
 */
import { createHash } from 'node:crypto';

export interface FakeRelease { tag: string; files: Record<string, Buffer> }

/** A portable app release: a small UDIF-shaped file for transport tests. */
export function tmflashRelease(version = '1.5.0', commit = 'a'.repeat(40)): FakeRelease {
  const dmg = Buffer.alloc(4096, 0x51);
  dmg.write(version, 0);
  dmg.write('koly', dmg.length - 512);
  const filename = `TMflash-${version}-universal.dmg`, tag = `build-${commit}`;
  const manifest = {
    format: 1, project: 'TMflash', version, tag, commit, sourceModified: false, filename,
    size: dmg.length, sha256: createHash('sha256').update(dmg).digest('hex'), minimumMacOS: '14.0',
    architectures: ['arm64', 'x86_64'], firmware: 'tmsense-1.8', notarized: false, builtAt: '2026-10-12T12:00:00.000Z',
  };
  return { tag, files: { [filename]: dmg, 'tmflash-app.json': Buffer.from(JSON.stringify(manifest)) } };
}

export function partitionTable(entries: [label: string, type: number, subtype: number, offset: number, size: number][] = [
  ['nvs', 1, 2, 0x9000, 0x5000], ['otadata', 1, 0, 0xe000, 0x2000],
  ['app0', 0, 0x10, 0x10000, 0x330000], ['app1', 0, 0x11, 0x340000, 0x330000],
]): Buffer {
  const out = Buffer.alloc(0xc00, 0xff);
  entries.forEach(([label, type, subtype, offset, size], index) => {
    const at = index * 32;
    out.fill(0, at, at + 32);
    out.writeUInt16LE(0x50aa, at); out[at + 2] = type; out[at + 3] = subtype;
    out.writeUInt32LE(offset, at + 4); out.writeUInt32LE(size, at + 8); out.write(label, at + 12, 'latin1');
  });
  const at = entries.length * 32;
  out.writeUInt16LE(0xebeb, at);
  createHash('md5').update(out.subarray(0, at)).digest().copy(out, at + 16);
  return out;
}

/** An ESP32 image header (DIO, 8 MB, 80 MHz, as PlatformIO builds for this board) over bytes that are not constant. */
export function espImage(bytes: number, seed: number, text = '', chip = 9): Buffer {
  const out = Buffer.alloc(bytes);
  // Not constant, so a block written to the wrong place cannot pass for the right one.
  for (let i = 0; i < bytes; i++) out[i] = (i * 7 + (i >> 9) * seed + seed) & 0xff;
  out[0] = 0xe9; out[2] = 0x02; out[3] = 0x3f; out.writeUInt16LE(chip, 12);
  out.write(text, 0x400, 'latin1');
  return out;
}

/** The manifest TMsense's tools/release_manifest.py writes for these files. */
export function manifestFor(version: string, images: Record<string, Buffer>, changes: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    format: 1, project: 'TMsense', board: 'heltec_wifi_lora_32_V3', version, tag: `v${version.replace('tmsense-', '')}`,
    commit: 'f193c8370d3a5eb27d40135290a0ce428c551a94',
    files: ['bootloader.bin', 'partitions.bin', 'firmware.bin'].map((name) => {
      const data = images[name] ?? Buffer.alloc(0);
      return { name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    }),
    ...changes,
  }, null, 2));
}

/** A complete release of `version`, as CI would publish it. */
export function tmsenseRelease(version = 'tmsense-1.6', applicationBytes = 180_000): FakeRelease {
  const images: Record<string, Buffer> = {
    'bootloader.bin': espImage(15104, 3),
    'partitions.bin': partitionTable(),
    'firmware.bin': espImage(applicationBytes, 11, `=== TMsense %s ===\0${version}\0`),
  };
  return { tag: `v${version.replace('tmsense-', '')}`, files: { ...images, 'tmflash-manifest.json': manifestFor(version, images) } };
}

export class FakeGitHub {
  /** What the repository's latest release is; null when it has published none. */
  latest: FakeRelease | null = null;
  /** The network is gone: every request fails as a dropped connection does. */
  down = false;
  /** Where the tagged download redirects to, when a test wants it to leave GitHub. */
  redirectTo: ((name: string) => string) | null = null;
  readonly asked: string[] = [];

  constructor(readonly repository = 'Mysteringz/TMsense') {}

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    this.asked.push(url.href);
    if (this.down) throw new TypeError('fetch failed');
    // The edge follows redirects itself; a fetch that followed them for it would hide where they led.
    if (init?.redirect !== 'manual') throw new Error('the release fetch must follow redirects by hand');
    const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
    const base = `/${this.repository}/releases`;
    if (url.hostname === 'github.com' && url.pathname.startsWith(`${base}/latest/download/`)) {
      const name = url.pathname.slice(`${base}/latest/download/`.length);
      if (!this.latest) return new Response('Not Found', { status: 404 });
      return redirect(`https://github.com${base}/download/${this.latest.tag}/${name}`);
    }
    if (url.hostname === 'github.com' && url.pathname.startsWith(`${base}/download/`)) {
      const [tag, name] = url.pathname.slice(`${base}/download/`.length).split('/');
      if (!this.latest || tag !== this.latest.tag || !name || !this.latest.files[name]) return new Response('Not Found', { status: 404 });
      return redirect(this.redirectTo?.(name) ?? `https://release-assets.githubusercontent.com/github-production-release-asset/1/${tag}/${name}?sig=test`);
    }
    if (url.hostname === 'release-assets.githubusercontent.com') {
      const [tag, name] = url.pathname.split('/').slice(-2);
      const bytes = this.latest && tag === this.latest.tag && name ? this.latest.files[name] : undefined;
      if (!bytes) return new Response('Not Found', { status: 404 });
      return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    throw new Error(`the test's GitHub was asked for ${url.href}, which is not GitHub`);
  };
}
