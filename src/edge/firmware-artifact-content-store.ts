import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FirmwareArtifactContentStorage } from '../modules/firmware/repositories/firmware-repository.js';

export class FirmwareArtifactIntegrityError extends Error {
  constructor() {
    super('firmware artifact identity does not match its content');
    this.name = 'FirmwareArtifactIntegrityError';
  }
}

/** Stores immutable firmware bytes separately from mutable build/job metadata. */
export class FirmwareArtifactContentStore implements FirmwareArtifactContentStorage {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  promote(id: string, sha256: string, bytes: Buffer): void {
    assertArtifactIdentity(id, sha256, bytes);
    if (this.read(id, sha256, bytes.length)?.equals(bytes)) return;
    const temp = join(this.directory, `.${id}.${randomUUID()}.tmp`);
    writeFileSync(temp, bytes, { flag: 'wx' });
    this.linkContent(temp, join(this.directory, `${id}.bin`), id, sha256, bytes);
  }

  read(id: string, sha256: string, size: number): Buffer | null {
    if (!isId(id)) return null;
    try {
      const bytes = readFileSync(join(this.directory, `${id}.bin`));
      return bytes.length === size && digest(bytes) === sha256 ? bytes : null;
    } catch {
      return null;
    }
  }

  remove(id: string): boolean {
    if (!isId(id)) return false;
    const path = join(this.directory, `${id}.bin`);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  list(): Array<{ id: string; modifiedAt: number; size: number }> {
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{16}\.bin$/.test(entry.name))
      .map((entry) => artifactFile(this.directory, entry.name));
  }

  listStaging(): Array<{ name: string; id: string; modifiedAt: number; size: number }> {
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\.[a-f0-9]{16}\.[a-f0-9-]+\.tmp$/.test(entry.name))
      .map((entry) => ({ name: entry.name, id: entry.name.split('.')[1] ?? '', ...fileStats(this.directory, entry.name) }));
  }

  removeStaging(name: string): boolean {
    if (!/^\.[a-f0-9]{16}\.[a-f0-9-]+\.tmp$/.test(name)) return false;
    rmSync(join(this.directory, name), { force: true });
    return true;
  }

  private linkContent(temp: string, dest: string, id: string, sha256: string, bytes: Buffer): void {
    try {
      linkSync(temp, dest);
    } catch (error) {
      if (!existsSync(dest) || !this.read(id, sha256, bytes.length)?.equals(bytes)) throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  }
}

function assertArtifactIdentity(id: string, sha256: string, bytes: Buffer): void {
  if (!isId(id) || digest(bytes) !== sha256 || sha256.slice(0, 16) !== id) {
    throw new FirmwareArtifactIntegrityError();
  }
}

function artifactFile(directory: string, name: string): { id: string; modifiedAt: number; size: number } {
  return { id: name.slice(0, 16), ...fileStats(directory, name) };
}

function fileStats(directory: string, name: string): { modifiedAt: number; size: number } {
  const stat = statSync(join(directory, name));
  return { modifiedAt: stat.mtimeMs, size: stat.size };
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isId(id: string): boolean {
  return /^[a-f0-9]{16}$/.test(id);
}
