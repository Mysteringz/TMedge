import type { RolloutTarget } from '../domain/rollout-target.js';

/** Application boundary for the existing rollout lifecycle. */
export interface RolloutService {
  current(): unknown;
  history(): unknown[];
  start(buildId: string, target: RolloutTarget, actor: string): unknown;
  cancel(actor: string): void;
}
