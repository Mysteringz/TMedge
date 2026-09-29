import type { FirmwareStore } from '../../edge/firmware.js';
import type { FirmwareBuildExecutor, FirmwareBuildResult, FirmwareBuildRequest } from '../../modules/firmware/application/firmware-build-executor.js';
import type { Actor } from '../../modules/shared/application/contracts.js';

/** Adapts the current file-backed build executor to the application contract. */
export class FirmwareStoreExecutor implements FirmwareBuildExecutor {
  constructor(private readonly store: FirmwareStore) {}

  /** Runs the current file-backed PlatformIO executor for one accepted job. */
  async execute(request: FirmwareBuildRequest, reportProgress: (line: string) => void): Promise<FirmwareBuildResult> {
    const built = await this.store.build(request.uploadId, request.actor.id, reportProgress);
    return {
      artifact: { id: built.id, sha256: built.sha256, size: built.size, version: built.version },
      stagedOutputId: built.id,
      log: built.log,
    };
  }
}
