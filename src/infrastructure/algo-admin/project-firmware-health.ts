import type { FirmwareNodeHealth, FirmwareSummary, RolloutHealth } from '../../modules/algo-admin/domain/operational-health.js';
import { healthTimestamp, healthText as text, InvalidHealthObservation } from './health-observation-values.js';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidHealthObservation('Invalid firmware observation');
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidHealthObservation('Invalid firmware time');
  return value;
}
function projectNode(value: unknown): FirmwareNodeHealth {
  const node = record(value);
  return { uid: text(node.uid), label: text(node.label), state: text(node.state),
    percent: Math.max(0, Math.min(100, number(node.percent))), updatedAt: healthTimestamp(node.updatedAt), outcomeUncertain: node.outcomeUncertain === true };
}
function projectRollout(value: unknown): RolloutHealth {
  const rollout = record(value);
  if (!Array.isArray(rollout.nodes)) throw new InvalidHealthObservation('Invalid rollout nodes');
  const nodes = rollout.nodes.map(projectNode);
  nodes.sort((a, b) => Number(b.outcomeUncertain || b.state === 'failed') - Number(a.outcomeUncertain || a.state === 'failed'));
  return { id: text(rollout.id), version: text(rollout.version), stage: text(rollout.stage), startedAt: healthTimestamp(rollout.startedAt),
    finishedAt: rollout.finishedAt == null ? null : healthTimestamp(rollout.finishedAt), interrupted: rollout.recoveryState === 'interrupted',
    total: nodes.length, failed: nodes.filter((n) => n.state === 'failed').length, uncertain: nodes.filter((n) => n.outcomeUncertain).length,
    confirmed: nodes.filter((n) => n.state === 'confirmed').length, rows: nodes.slice(0, 20) };
}
/** Explicit allowlist avoids exposing worker logs, addresses, command arguments or errors. */
export function projectFirmware(buildValue: unknown, current: unknown, history: unknown[]): FirmwareSummary {
  const build = buildValue === null ? null : record(buildValue);
  const rollout = current ?? history.slice().sort((a, b) => healthTimestamp(record(b).startedAt) - healthTimestamp(record(a).startedAt))[0] ?? null;
  const failed = !!build && (typeof build.error === 'string' || ['failed', 'interrupted'].includes(String(build.lifecycle)));
  return { build: { state: build ? failed ? 'failed' : 'building' : 'idle', startedAt: build ? healthTimestamp(build.startedAt) : null },
    rollout: rollout === null ? null : projectRollout(rollout) };
}
