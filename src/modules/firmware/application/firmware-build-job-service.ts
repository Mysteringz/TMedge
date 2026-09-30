import type { Actor } from '../../shared/application/contracts.js';

/** The HTTP adapter may accept work and poll status, but never executes builds. */
export interface FirmwareBuildJobService {
  start(uploadId: string, actor: Actor): boolean;
  status(): unknown;
}
