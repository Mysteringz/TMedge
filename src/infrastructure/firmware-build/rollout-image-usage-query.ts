import type { ImageInUseQuery } from '../../modules/firmware/repositories/firmware-repository.js';

interface CurrentRolloutReader {
  current(): { buildId: string; stage: string } | null;
}

/** Keeps rollout knowledge out of the artifact storage adapter. */
export class RolloutImageUsageQuery implements ImageInUseQuery {
  constructor(private readonly rollouts: CurrentRolloutReader) {}

  /** Returns true while the matching image belongs to a non-terminal rollout. */
  isImageInUse(imageId: string): boolean {
    const current = this.rollouts.current();
    return current?.buildId === imageId && current.stage !== 'done' && current.stage !== 'stopped';
  }
}
