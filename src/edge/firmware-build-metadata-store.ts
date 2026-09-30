import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FirmwareArtifactContentStorage } from '../modules/firmware/repositories/firmware-repository.js';
import type { FirmwareBuild } from './firmware.js';

export interface FirmwareBuildMetadataStorage {
  load(): FirmwareBuild[];
  save(build: FirmwareBuild): void;
  remove(id: string): void;
}

/** Persists build metadata independently from content-addressed image bytes. */
export class FirmwareBuildMetadataStore implements FirmwareBuildMetadataStorage {
  constructor(private readonly directory: string, private readonly content: FirmwareArtifactContentStorage) {
    mkdirSync(directory, { recursive: true });
  }

  load(): FirmwareBuild[] {
    const builds: FirmwareBuild[] = [];
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) this.loadEntry(entry.name, entry.isDirectory(), builds);
    return builds;
  }

  save(build: FirmwareBuild): void {
    const path = join(this.directory, `${build.id}.json`);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(build, null, 2), { flag: 'wx' });
    this.replaceManifest(temp, path);
  }

  remove(id: string): void {
    if (!isId(id)) return;
    rmSync(join(this.directory, `${id}.json`), { force: true });
    rmSync(join(this.directory, id), { recursive: true, force: true });
  }

  private loadEntry(name: string, isDirectory: boolean, builds: FirmwareBuild[]): void {
    if (isDirectory && isId(name)) return this.migrateLegacy(name, builds);
    if (!isDirectory && isId(name.replace(/\.json$/, '')) && name.endsWith('.json')) this.loadManifest(name, builds);
  }

  private loadManifest(name: string, builds: FirmwareBuild[]): void {
    try {
      const build = JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as FirmwareBuild;
      if (!validBuild(build) || `${build.id}.json` !== name) return;
      if (build.state === 'building' || build.state === 'uploading') build.state = 'failed';
      if (build.state === 'ready' && !this.content.read(build.id, build.sha256, build.size)) {
        build.state = 'failed';
        build.error = 'stored image is missing or failed SHA-256 verification';
      }
      builds.push(build);
    } catch {
      // A corrupt manifest is never advertised as a usable image.
    }
  }

  private migrateLegacy(id: string, builds: FirmwareBuild[]): void {
    const directory = join(this.directory, id);
    try {
      const build = JSON.parse(readFileSync(join(directory, 'build.json'), 'utf8')) as FirmwareBuild;
      const bytes = readFileSync(join(directory, 'firmware.bin'));
      if (!validBuild(build) || build.id !== id || !matches(build, bytes)) return;
      this.content.promote(id, build.sha256, bytes);
      this.save(build);
      builds.push(build);
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Leave old data untouched unless both new copies have been committed.
    }
  }

  private replaceManifest(temp: string, path: string): void {
    try {
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

function validBuild(value: FirmwareBuild): boolean {
  return Boolean(value && isId(value.id) && /^[a-f0-9]{64}$/.test(value.sha256)
    && value.sha256.slice(0, 16) === value.id && Number.isSafeInteger(value.size) && value.size > 0
    && ['uploading', 'building', 'ready', 'failed'].includes(value.state)
    && typeof value.version === 'string' && typeof value.uploadedAt === 'number'
    && typeof value.uploadedBy === 'string' && Array.isArray(value.log)
    && value.log.every((line) => typeof line === 'string'));
}

function matches(build: FirmwareBuild, bytes: Buffer): boolean {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return build.size === bytes.length && build.sha256 === hash;
}

function isId(id: string): boolean {
  return /^[a-f0-9]{16}$/.test(id);
}
