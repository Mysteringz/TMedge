import type { RolloutService } from '../../rollouts/application/rollout-service.js';
import type { RolloutTarget } from '../../rollouts/domain/rollout-target.js';

/** Validates the rollout transport input before starting the existing state machine. */
export class StartFirmwareRollout {
  constructor(private readonly rollouts: RolloutService) {}

  async execute(input: unknown, actor: string): Promise<unknown> {
    const body = record(input);
    if (typeof body.buildId !== 'string' || !body.buildId || !body.target) {
      throw new Error('buildId and target are required');
    }
    const target = parseTarget(body.target);
    return await this.rollouts.start(body.buildId, target, actor);
  }
}

function parseTarget(value: unknown): RolloutTarget {
  const target = record(value);
  if (target.kind === 'all') return { kind: 'all' };
  if (target.kind === 'node' && typeof target.uid === 'string' && target.uid.length > 0) {
    return { kind: 'node', uid: target.uid };
  }
  if (target.kind === 'floor' && typeof target.floorId === 'string' && target.floorId.length > 0) {
    return { kind: 'floor', floorId: target.floorId };
  }
  throw new Error('target must be all, node with uid, or floor with floorId');
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
