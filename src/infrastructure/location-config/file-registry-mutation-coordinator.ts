import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncFileDescriptor } from '../../shared/directory-sync.js';
import type { RegistryMutationCoordinator } from '../../modules/location-config/repositories/location-storage.js';
import { RegistryMutationQuarantinedError } from '../../modules/location-config/domain/location-records.js';

/**
 * Serializes all in-process mutations and gives the edge process exclusive
 * writer ownership of NODES_CONFIG for its lifetime. The lock file is outside
 * releases next to the persistent registry.
 */
export class FileRegistryMutationCoordinator implements RegistryMutationCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private descriptor: number | null = null;
  private token: string | null = null;
  private durabilityRecovery: (() => void) | null = null;
  private quarantined = false;

  constructor(private readonly nodesPath: string) {}

  acquireProcessOwnership(): void {
    if (this.descriptor !== null) return;
    const lockPath = `${this.nodesPath}.writer.lock`;
    const token = randomUUID();
    let descriptor: number | null = null;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() })}\n`);
      syncFileDescriptor(descriptor);
      this.descriptor = descriptor;
      this.token = token;
    } catch (error) {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { /* preserve original failure */ }
        try { unlinkSync(lockPath); } catch { /* preserve original failure */ }
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        let owner = 'unknown process';
        try {
          const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
          if (isObject(parsed) && Number.isInteger(parsed.pid)) owner = `process ${parsed.pid}`;
        } catch { /* the lock remains fail-closed when its owner record is damaged */ }
        throw new Error(`NODES_CONFIG is already owned by ${owner}; verify that no edge process is running before removing ${lockPath}.`);
      }
      throw error;
    }
  }

  async withMutationLock<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const prior = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      this.assertHealthy();
      if (this.durabilityRecovery) {
        try {
          this.durabilityRecovery();
          this.durabilityRecovery = null;
        } catch {
          throw new RegistryMutationQuarantinedError();
        }
      }
      return await operation();
    }
    finally { release(); }
  }

  assertHealthy(): void {
    if (this.quarantined) throw new RegistryMutationQuarantinedError();
  }

  quarantine(_reason: unknown): void {
    this.quarantined = true;
  }

  latchDurabilityRecovery(recover: () => void): void {
    this.durabilityRecovery = recover;
  }

  close(): void {
    if (this.descriptor === null) return;
    const descriptor = this.descriptor;
    const lockPath = `${this.nodesPath}.writer.lock`;
    let ownsPath = false;
    try {
      const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
      ownsPath = isObject(parsed) && parsed.token === this.token && parsed.pid === process.pid;
    } catch { /* do not remove an unknown lock record */ }
    closeSync(descriptor);
    this.descriptor = null;
    this.token = null;
    if (ownsPath && existsSync(lockPath)) unlinkSync(lockPath);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
