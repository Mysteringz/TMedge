import type { Actor } from '../../shared/application/contracts.js';
import type { FirmwareArtifact } from './firmware-repository.js';

export type FirmwareBuildLifecycle = 'accepted' | 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface FirmwareBuildJobRecord {
  id: string;
  uploadId: string;
  actor: Actor;
  lifecycle: FirmwareBuildLifecycle;
  startedAt: number;
  finishedAt: number | null;
  artifact: FirmwareArtifact | null;
  log: readonly string[];
  error: string | null;
}

/** Async metadata persistence and restart reconciliation; image bytes stay file-backed. */
export interface FirmwareBuildJobRepository {
  create(job: FirmwareBuildJobRecord): Promise<void>;
  save(job: FirmwareBuildJobRecord): Promise<void>;
  get(jobId: string): Promise<FirmwareBuildJobRecord | null>;
  list(): Promise<FirmwareBuildJobRecord[]>;
  markActiveInterrupted(at: number): Promise<FirmwareBuildJobRecord[]>;
}
