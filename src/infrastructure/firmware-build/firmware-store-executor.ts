import { FirmwareError, type FirmwareStore } from '../../edge/firmware.js';
import type { FirmwareBuildExecutor, FirmwareBuildResult, FirmwareBuildRequest } from '../../modules/firmware/application/firmware-build-executor.js';
import type { FirmwareBuildWorker } from './firmware-build-worker-client.js';
import { FirmwareBuildWorkerClient } from './firmware-build-worker-client.js';

/** Executes uploads in the isolated worker, then promotes verified output locally. */
export class FirmwareStoreExecutor implements FirmwareBuildExecutor {
  private readonly worker: FirmwareBuildWorker;

  constructor(private readonly store: FirmwareStore, worker?: FirmwareBuildWorker) {
    this.worker = worker ?? new FirmwareBuildWorkerClient();
  }

  async execute(request: FirmwareBuildRequest, reportProgress: (line: string) => void): Promise<FirmwareBuildResult> {
    const workspace = this.store.buildWorkspace(request.uploadId);
    const result = await this.worker.build(workspace, reportProgress);
    if (result.exitCode !== 0) throw withLog(new FirmwareError(`build failed (pio exit ${result.exitCode})`), result.log);
    if (!result.artifact) throw withLog(new FirmwareError('the build worker returned no firmware image'), result.log);
    const built = this.store.completeBuild(request.uploadId, request.actor.id, result.log, result.artifact);
    return {
      artifact: { id: built.id, sha256: built.sha256, size: built.size, version: built.version },
      stagedOutputId: built.id,
      log: built.log,
    };
  }

  async dispose(): Promise<void> {
    await this.worker.dispose();
  }
}

function withLog(error: Error, log: string[]): Error & { log: string[] } {
  return Object.assign(error, { log });
}
