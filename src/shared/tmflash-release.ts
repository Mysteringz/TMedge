/** The manifest published beside each portable TMflash DMG. */
export const TMFLASH_REPOSITORY = 'Mysteringz/TMflash';
export const TMFLASH_MANIFEST = 'tmflash-app.json';
export const TMFLASH_MAX_BYTES = 128 * 1024 * 1024;

export interface TMflashRelease {
  format: 1;
  project: 'TMflash';
  version: string;
  tag: string;
  commit: string;
  sourceModified: false;
  filename: string;
  size: number;
  sha256: string;
  minimumMacOS: string;
  architectures: ['arm64', 'x86_64'];
  firmware: string;
  notarized: boolean;
  builtAt: string;
}
export interface HostedTMflashRelease extends TMflashRelease {
  repository: typeof TMFLASH_REPOSITORY;
  checkedAt: number;
  stale: boolean;
}
export class TMflashUnavailable extends Error {
  constructor(readonly reason: 'none' | 'unreachable' | 'invalid', message: string) { super(message); }
}

export function parseTMflashRelease(text: string): TMflashRelease {
  const invalid = () => new TMflashUnavailable('invalid', 'The latest TMflash release has an invalid download manifest.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw invalid(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const m = raw as Record<string, unknown>;
  const exact = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && value.match(pattern)?.[0] === value;
  if (m.format !== 1 || m.project !== 'TMflash' || m.sourceModified !== false
    || !exact(m.version, /^\d+\.\d+\.\d+$/) || m.version.length > 20
    || !exact(m.commit, /^[0-9a-f]{40}$/)
    || m.tag !== `build-${m.commit}` || m.filename !== `TMflash-${m.version}-universal.dmg`
    || typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size < 512 || m.size > TMFLASH_MAX_BYTES
    || !exact(m.sha256, /^[0-9a-f]{64}$/)
    || !exact(m.minimumMacOS, /^\d{1,2}\.\d{1,2}$/)
    || !Array.isArray(m.architectures) || m.architectures.length !== 2 || m.architectures[0] !== 'arm64' || m.architectures[1] !== 'x86_64'
    || !exact(m.firmware, /^tmsense-\d+\.\d+(\.\d+)?$/) || m.firmware.length > 12
    || typeof m.notarized !== 'boolean' || typeof m.builtAt !== 'string' || m.builtAt.length > 40 || !Number.isFinite(Date.parse(m.builtAt))) throw invalid();
  return {
    format: 1, project: 'TMflash', sourceModified: false, version: m.version, tag: String(m.tag), commit: m.commit,
    filename: String(m.filename), size: m.size, sha256: m.sha256, minimumMacOS: m.minimumMacOS,
    architectures: ['arm64', 'x86_64'], firmware: m.firmware, notarized: m.notarized, builtAt: m.builtAt,
  };
}

export const tmflashDownloadPath = (release: Pick<TMflashRelease, 'tag' | 'filename'>): string =>
  `/api/tmflash-download/files/${encodeURIComponent(release.tag)}/${encodeURIComponent(release.filename)}`;

export function parseHostedTMflashRelease(raw: unknown): HostedTMflashRelease {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The console returned an invalid TMflash release.');
  const m = raw as Record<string, unknown>;
  const release = parseTMflashRelease(JSON.stringify(raw));
  if (m.repository !== TMFLASH_REPOSITORY || typeof m.checkedAt !== 'number' || !Number.isFinite(m.checkedAt) || m.checkedAt < 0 || typeof m.stale !== 'boolean') {
    throw new Error('The console returned invalid TMflash download details.');
  }
  return { ...release, repository: TMFLASH_REPOSITORY, checkedAt: m.checkedAt, stale: m.stale };
}
