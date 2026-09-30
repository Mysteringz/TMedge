/**
 * Firmware builds, from an uploaded PlatformIO project.
 *
 * The console uploads the TMsense folder file by file; this compiles it with
 * PlatformIO's `tmflash` environment -- the release build, which deliberately
 * bakes in no Wi-Fi password or key -- and keeps the resulting image with its
 * SHA-256. Nodes are only ever told a hash, so the image's identity is the
 * hash and nothing else.
 *
 * Builds are kept on disk so a rollout survives a restart of the edge, and
 * the old image stays available to roll back to.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { FirmwareArtifactFiles } from '../modules/firmware/repositories/firmware-repository.js';

export type BuildState = 'uploading' | 'building' | 'ready' | 'failed';

export interface FirmwareBuild {
  /** First 16 hex of the image SHA-256; how nodes and gateways name it. */
  id: string;
  sha256: string;
  size: number;
  /** TM_FW_VERSION from the uploaded include/tm_config.h. */
  version: string;
  state: BuildState;
  uploadedBy: string;
  uploadedAt: number;
  builtAt: number | null;
  files: number;
  sourceBytes: number;
  error?: string;
  /** Tail of the build output, for the console. */
  log: string[];
}

export interface FirmwareLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxArtifactBytes: number;
}

const DEFAULTS: FirmwareLimits = {
  maxFiles: 800,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxArtifactBytes: 8 * 1024 * 1024,
};

export class FirmwareError extends Error {}

/**
 * Where an uploaded path may land. A project is a tree of ordinary files; a
 * path that climbs out of it, or is absolute, is not a mistake worth
 * tolerating on a machine that then runs a compiler over the result.
 */
export function safeRelativePath(path: string): string {
  const cleaned = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) throw new FirmwareError(`absolute path: ${path}`);
  const norm = normalize(cleaned);
  if (norm.split(/[\\/]/).some((part) => part === '..')) throw new FirmwareError(`path escapes the project: ${path}`);
  if (norm.includes('\0')) throw new FirmwareError('path contains a null byte');
  // .pio and .git are build output and history: never needed, often huge.
  if (/(^|[\\/])(\.pio|\.git|node_modules)([\\/]|$)/.test(norm)) throw new FirmwareError(`not part of a project: ${path}`);
  return norm;
}

interface Upload {
  id: string;
  dir: string;
  by: string;
  files: number;
  bytes: number;
  startedAt: number;
}

export class FirmwareStore implements FirmwareArtifactFiles {
  private readonly uploads = new Map<string, Upload>();
  private readonly builds = new Map<string, FirmwareBuild>();
  private readonly limits: FirmwareLimits;
  private readonly now: () => number;

  constructor(
    private readonly dir: string,
    private readonly opts: { limits?: Partial<FirmwareLimits>; now?: () => number; log?: (m: string) => void } = {},
  ) {
    this.limits = { ...DEFAULTS, ...opts.limits };
    this.now = opts.now ?? Date.now;
    mkdirSync(join(this.dir, 'builds'), { recursive: true });
    mkdirSync(join(this.dir, 'uploads'), { recursive: true });
    this.loadBuilds();
  }

  private loadBuilds(): void {
    for (const id of readdirSync(join(this.dir, 'builds'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      try {
        const meta = JSON.parse(readFileSync(join(this.dir, 'builds', id, 'build.json'), 'utf8')) as FirmwareBuild;
        // A build that was still running when the edge stopped is not a build.
        if (meta.state === 'building' || meta.state === 'uploading') meta.state = 'failed';
        this.builds.set(meta.id, meta);
      } catch {
        /* a half-written build directory is ignored */
      }
    }
  }

  list(): FirmwareBuild[] {
    return [...this.builds.values()].sort((a, b) => (b.builtAt ?? b.uploadedAt) - (a.builtAt ?? a.uploadedAt));
  }

  get(id: string): FirmwareBuild | null {
    return this.builds.get(id) ?? null;
  }

  /** The image itself, for a gateway or a direct download. */
  bytes(id: string): Buffer | null {
    const b = this.builds.get(id);
    if (!b || b.state !== 'ready') return null;
    try {
      return readFileSync(join(this.dir, 'builds', id, 'firmware.bin'));
    } catch {
      return null;
    }
  }

  // --- upload ---------------------------------------------------------------

  startUpload(by: string): string {
    const id = `up-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = join(this.dir, 'uploads', id);
    mkdirSync(dir, { recursive: true });
    this.uploads.set(id, { id, dir, by, files: 0, bytes: 0, startedAt: this.now() });
    return id;
  }

  addFile(uploadId: string, path: string, bytes: Buffer): void {
    const up = this.uploads.get(uploadId);
    if (!up) throw new FirmwareError('no such upload');
    if (up.files >= this.limits.maxFiles) throw new FirmwareError(`more than ${this.limits.maxFiles} files`);
    if (bytes.length > this.limits.maxFileBytes) throw new FirmwareError(`${path} is larger than ${this.limits.maxFileBytes} bytes`);
    if (up.bytes + bytes.length > this.limits.maxTotalBytes) throw new FirmwareError('upload is too large');
    const rel = safeRelativePath(path);
    const full = join(up.dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    up.files += 1;
    up.bytes += bytes.length;
  }

  /**
   * The uploaded tree may be the project itself or a folder containing it
   * (a browser sends "TMsense/platformio.ini"). Find the project root.
   */
  private projectRoot(dir: string): string {
    if (existsSync(join(dir, 'platformio.ini'))) return dir;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const inner = join(dir, e.name);
      if (existsSync(join(inner, 'platformio.ini'))) return inner;
    }
    throw new FirmwareError('no platformio.ini in the uploaded folder');
  }

  private versionOf(root: string): string {
    try {
      const header = readFileInside(root, join(root, 'include', 'tm_config.h')).toString('utf8');
      return /#define\s+TM_FW_VERSION\s+"([^"]+)"/.exec(header)?.[1] ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // --- build ----------------------------------------------------------------

  /** Returns a validated project directory for the isolated build service. */
  buildWorkspace(uploadId: string): string {
    const up = this.uploads.get(uploadId);
    if (!up) throw new FirmwareError('no such upload');
    const uploadRoot = realpathSync(up.dir);
    const root = realpathSync(this.projectRoot(up.dir));
    if (!isInside(uploadRoot, root)) throw new FirmwareError('the project root escaped its upload directory');
    const ini = readFileInside(root, join(root, 'platformio.ini')).toString('utf8');
    if (!ini.includes('[env:tmflash]')) {
      throw new FirmwareError('the project has no [env:tmflash] environment (the release build with no baked-in secrets)');
    }
    return root;
  }

  /** Validates and promotes the worker's staged firmware image. */
  completeBuild(uploadId: string, by: string, log: readonly string[], bytes: Buffer): FirmwareBuild {
    const up = this.uploads.get(uploadId);
    if (!up) throw new FirmwareError('no such upload');
    const root = this.buildWorkspace(uploadId);
    if (bytes.length === 0 || bytes.length > this.limits.maxArtifactBytes) {
      throw new FirmwareError(`the build output size must be between 1 and ${this.limits.maxArtifactBytes} bytes`);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = sha256.slice(0, 16);

    const dest = join(this.dir, 'builds', id);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'firmware.bin'), bytes);
    const build: FirmwareBuild = {
      id,
      sha256,
      size: bytes.length,
      version: this.versionOf(root),
      state: 'ready',
      uploadedBy: by || up.by,
      uploadedAt: up.startedAt,
      builtAt: this.now(),
      files: up.files,
      sourceBytes: up.bytes,
      log: log.slice(-60),
    };
    writeFileSync(join(dest, 'build.json'), JSON.stringify(build, null, 2));
    this.builds.set(id, build);
    // The sources have done their job; the image and its log are what matter.
    rmSync(up.dir, { recursive: true, force: true });
    this.uploads.delete(uploadId);
    this.opts.log?.(`firmware: built ${build.version} ${id} (${bytes.length} bytes)`);
    return build;
  }

  /** Throw away an upload that was never built. */
  discard(uploadId: string): void {
    const up = this.uploads.get(uploadId);
    if (!up) return;
    rmSync(up.dir, { recursive: true, force: true });
    this.uploads.delete(uploadId);
  }

  /** Uploads left behind by an abandoned browser tab. */
  sweep(olderThanMs = 3600_000): void {
    for (const up of this.uploads.values()) {
      if (this.now() - up.startedAt > olderThanMs) this.discard(up.id);
    }
  }

  /** Total bytes of stored images, for the console's housekeeping line. */
  diskBytes(): number {
    let total = 0;
    for (const id of this.builds.keys()) {
      try {
        total += statSync(join(this.dir, 'builds', id, 'firmware.bin')).size;
      } catch {
        /* gone */
      }
    }
    return total;
  }

  /** Forget a build and delete its image. */
  remove(id: string): boolean {
    if (!this.builds.delete(id)) return false;
    rmSync(join(this.dir, 'builds', id), { recursive: true, force: true });
    return true;
  }
}

export const pathSeparator = sep;

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function readFileInside(root: string, file: string): Buffer {
  const realRoot = realpathSync(root);
  const realFile = realpathSync(file);
  if (!isInside(realRoot, realFile)) throw new FirmwareError('a project file escaped its workspace');
  return readFileSync(realFile);
}
