import type { Actor } from '../../shared/application/contracts.js';
import type { FirmwareArtifact } from '../repositories/firmware-repository.js';

export interface FirmwareBuildRequest {
  jobId: string;
  uploadId: string;
  actor: Actor;
}

export interface FirmwareBuildResult {
  artifact: FirmwareArtifact;
  stagedOutputId: string;
  log: readonly string[];
}

/** Adapter contract for bounded build progress and a validated image result. */
export interface FirmwareBuildExecutor {
  execute(request: FirmwareBuildRequest, reportProgress: (line: string) => void): Promise<FirmwareBuildResult>;
  dispose?(): Promise<void>;
}
