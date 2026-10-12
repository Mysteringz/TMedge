/**
 * A published TMsense release: what module 07 writes to a board.
 *
 * The firmware comes from one place, the releases of the TMsense repository on
 * GitHub, and nowhere else -- not a file somebody picked, not a build on the
 * machine that happens to be in front of the board. A release is three images
 * and a manifest (`tmflash-manifest.json`) that names each by size and
 * SHA-256, written by TMsense's `tools/release_manifest.py`. This file is the
 * reader of that manifest; change the two together.
 *
 * A browser cannot fetch a GitHub release itself (the download host sends no
 * CORS header, and the console's CSP allows only this origin), so the edge
 * fetches and checks it and the page asks the edge. Both ends use this file.
 */

/** The one repository firmware is taken from. */
export const TMSENSE_REPOSITORY = 'Mysteringz/TMsense';
export const RELEASE_MANIFEST = 'tmflash-manifest.json';
export const RELEASE_BOARD = 'heltec_wifi_lora_32_V3';

export const RELEASE_FILES = ['bootloader.bin', 'partitions.bin', 'firmware.bin'] as const;
export type ReleaseFileName = typeof RELEASE_FILES[number];
// The most each can be on this board: the bootloader ends before the
// partition table at 0x8000, the table is one 0xC00 block, an OTA slot of the
// 8 MB layout is 0x330000. Refused before the bytes are held in memory.
export const RELEASE_FILE_LIMITS: Readonly<Record<ReleaseFileName, number>> = {
  'bootloader.bin': 0x8000, 'partitions.bin': 0xc00, 'firmware.bin': 0x330000,
};
export const RELEASE_MANIFEST_LIMIT = 16 * 1024;

export interface ReleaseFile { name: ReleaseFileName; size: number; sha256: string }

export interface ReleaseManifest {
  /** What a node flashed with it reports, e.g. `tmsense-1.5`. */
  version: string;
  /** The GitHub release, derived from the version: `v1.5`. */
  tag: string;
  /** The commit of TMsense it was built from. */
  commit: string;
  files: ReleaseFile[];
}

export interface PublishedRelease extends ReleaseManifest {
  repository: string;
  /** When the edge last confirmed with GitHub that this is the latest release. */
  checkedAt: number;
}

/**
 * Why there is nothing to flash. `none`: the repository has published no
 * release. `unreachable`: GitHub did not answer. `invalid`: it answered with
 * something that is not a complete, self-consistent TMsense release.
 */
export class ReleaseUnavailable extends Error {
  constructor(readonly reason: 'none' | 'unreachable' | 'invalid', message: string) { super(message); }
}

const isName = (value: unknown): value is ReleaseFileName => RELEASE_FILES.some((name) => name === value);
const invalid = (what: string): ReleaseUnavailable => new ReleaseUnavailable('invalid', `the release manifest ${what}`);

/** Reads `tmflash-manifest.json`, refusing anything it does not fully understand. */
export function parseManifest(text: string): ReleaseManifest {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw invalid('is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid('is not an object');
  const manifest = raw as Record<string, unknown>;
  // A format this reader was not written for is not guessed at.
  if (manifest.format !== 1) throw invalid('is in a format this console does not read');
  if (manifest.project !== 'TMsense') throw invalid('is not for TMsense');
  if (manifest.board !== RELEASE_BOARD) throw invalid(`is for a board other than ${RELEASE_BOARD}`);
  const { version, tag, commit, files } = manifest;
  if (typeof version !== 'string' || !/^tmsense-\d+\.\d+(\.\d+)?$/.test(version) || version.length > 12) throw invalid('has no TMsense version');
  // The tag is the version, restated: a release cannot be named after one image and carry another.
  if (tag !== `v${version.slice('tmsense-'.length)}`) throw invalid('names a tag that is not its version');
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw invalid('does not say which commit it was built from');
  if (!Array.isArray(files) || files.length !== RELEASE_FILES.length) throw invalid('does not list exactly the three images');
  const listed = files.map((entry: unknown): ReleaseFile => {
    if (typeof entry !== 'object' || entry === null) throw invalid('lists a file that is not an object');
    const { name, size, sha256 } = entry as Record<string, unknown>;
    if (!isName(name)) throw invalid('lists a file this console does not flash');
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > RELEASE_FILE_LIMITS[name]) throw invalid(`gives ${name} a size this board has no room for`);
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw invalid(`gives no SHA-256 for ${name}`);
    return { name, size, sha256 };
  });
  for (const name of RELEASE_FILES) if (listed.filter((file) => file.name === name).length !== 1) throw invalid(`does not list ${name} exactly once`);
  return { version, tag, commit, files: RELEASE_FILES.map((name) => listed.find((file) => file.name === name)).filter((file): file is ReleaseFile => !!file) };
}
