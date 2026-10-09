import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AlgoAuth } from '../src/algo/auth.js';
import type { TrainJob } from '../src/algo/train/store.js';
import { RuntimeNotificationQueries } from '../src/infrastructure/algo-admin/runtime-notification-queries.js';
import { ReadNotifications } from '../src/modules/algo-admin/use-cases/read-notifications.js';
import { createNotificationRouter } from '../src/modules/algo-admin/controllers/notification-controller.js';
import { NOTIFICATION_WINDOW_MS, type NotificationCandidate } from '../src/modules/algo-admin/domain/operation-notification.js';
import { principal } from '../src/modules/algo-admin/domain/permissions.js';

function job(user: string, status: TrainJob['status'], at: number): TrainJob {
  return { id: `${user}-${status}`, user, status, updatedAt: at, createdAt: at, submittedAt: at, startedAt: null, endedAt: status === 'UNKNOWN' || status === 'SUBMIT_FAILED' ? null : at,
    lastPolledAt: null, slurmJobId: null, remoteDir: 'PRIVATE', exitCode: null, slurmState: null, elapsedSeconds: null, node: 'PRIVATE', message: 'PRIVATE', sbatch: 'PRIVATE',
    code: { kind: 'py', filename: 'PRIVATE', bytes: 1, sha256: 'PRIVATE', unpackedBytes: 1, fileCount: 1, py: [] },
    spec: { name: `${user} work`, partition: 'cpu', cpusPerTask: 1, memGb: 1, gpus: 0, timeLimit: '1:00:00', modules: [], condaEnv: null, entrypoint: 'PRIVATE', args: [], env: {}, notifyEmail: false } };
}
const event = (id: string, at: number): NotificationCandidate => ({ id, kind: 'training', resourceId: id, label: id, outcome: 'Completed', occurredAt: at, windowAt: at, href: '/train' });

test('full training adapter enforces owner, outcome labels/privacy and stable polling/missing-time IDs', async () => {
  const statuses = ['COMPLETED', 'FAILED', 'TIMEOUT', 'OUT_OF_MEMORY', 'SUBMIT_FAILED', 'CANCELLED', 'UNKNOWN'] as const;
  const jobs = statuses.map((status) => job('alice', status, 100)); jobs.push(job('bob', 'FAILED', 100), job('alice', 'RUNNING', 100));
  let owner = '';
  const queries = new RuntimeNotificationQueries((name) => { owner = name; return jobs; }, { current: () => null, history: () => [] });
  const first = queries.training('alice')!; assert.equal(owner, 'alice'); assert.equal(first.length, 7);
  assert.deepEqual(first.map((item) => item.outcome), ['Completed', 'Failed', 'Timed out', 'Out of memory', 'Submission failed', 'Cancelled', 'Unknown']);
  assert.ok(!JSON.stringify(first).includes('PRIVATE')); assert.ok(!JSON.stringify(first).includes('bob'));
  jobs.find((row) => row.status === 'UNKNOWN')!.updatedAt = 200;
  jobs.find((row) => row.status === 'COMPLETED')!.updatedAt = 200;
  assert.deepEqual(queries.training('alice')!.map((row) => row.id), first.map((row) => row.id));
  const completed = jobs[0]!; completed.endedAt = null;
  const missingTime = queries.training('alice')![0]!; assert.equal(missingTime.occurredAt, null);
  completed.updatedAt = 300; assert.equal(queries.training('alice')![0]!.id, missingTime.id);
});

test('firmware retained current/history has truthful stopped/failed/uncertain outcomes and stable transition IDs', () => {
  const rollout = { id: 'rollout', version: 'v1', stage: 'done', startedAt: 90, finishedAt: 100, nodes: [{ uid: 'node', label: 'pilot', state: 'confirmed', updatedAt: 100, address: 'PRIVATE' }], note: 'PRIVATE', startedBy: 'console' };
  const history = [rollout]; let current: unknown = null;
  const queries = new RuntimeNotificationQueries(() => [], { current: () => current, history: () => history });
  assert.equal(queries.firmware()[0]!.outcome, 'Completed'); assert.ok(!JSON.stringify(queries.firmware()).includes('PRIVATE'));
  rollout.nodes[0]!.state = 'failed'; assert.equal(queries.firmware()[0]!.outcome, 'Failed');
  rollout.stage = 'stopped'; rollout.nodes[0]!.state = 'skipped'; assert.equal(queries.firmware()[0]!.outcome, 'Stopped');
  current = { ...rollout, id: 'interrupted', recoveryState: 'interrupted' }; assert.equal(queries.firmware()[0]!.outcome, 'Uncertain');
  current = { ...rollout, id: 'active', stage: 'pilot', finishedAt: null, nodes: [{ uid: 'node', label: 'pilot', state: 'failed', updatedAt: 110, outcomeUncertain: true }] };
  assert.ok(queries.firmware().some((item) => item.resourceId === 'active:node' && item.outcome === 'Uncertain' && item.occurredAt === 110));
});

test('window100 bound, deterministic dedup, source failure and permission gates never query forbidden sources', async () => {
  const now = NOTIFICATION_WINDOW_MS + 1000;
  let firmwareCalls = 0;
  const rows = Array.from({ length: 120 }, (_, index) => event(String(index), now - index));
  rows.push(event('expired', 0), event('future', now + 1), event('nan', Number.NaN), rows[0]!);
  const queries = { training: () => rows, firmware: () => { firmwareCalls++; throw new Error('PRIVATE'); } };
  const useCase = new ReadNotifications(queries, () => now), actor = principal('alice', 'admin'); actor.capabilities = ['algo.read', 'training.read'];
  const result = await useCase.execute(actor); assert.equal(result.items.length, 100); assert.equal(result.items[0]!.id, '0'); assert.equal(firmwareCalls, 0); assert.equal(result.sources.firmware, 'forbidden');
  const failed = await useCase.execute(principal('alice', 'viewer')); assert.equal(failed.sources.firmware, 'unavailable'); assert.equal(failed.items.length, 100); assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
  assert.deepEqual((await useCase.execute(actor)).items.map((row) => row.id), result.items.map((row) => row.id));
});

test('HTTP snapshot is authenticated/owner-only and revocation during read prevents publication', async () => {
  let actor: ReturnType<typeof principal> | null = principal('alice', 'admin');
  let release: (() => void) | null = null, held = false, queriedOwner = '';
  const read = new ReadNotifications({ training: async (owner) => { queriedOwner = owner; if (held) await new Promise<void>((resolve) => { release = resolve; }); return [event(owner, 100)]; }, firmware: () => [] }, () => 100);
  const auth = { principalOf: () => actor } as Pick<AlgoAuth, 'principalOf'>;
  const app = express(); app.use('/api/admin/notifications', createNotificationRouter(auth as AlgoAuth, read));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/notifications?owner=bob`;
  try {
    const response = await fetch(url); assert.equal(response.status, 200); assert.equal(queriedOwner, 'alice');
    actor = null; const denied = await fetch(url); assert.equal(denied.status, 401); assert.equal((await denied.json() as { error: { code: string } }).error.code, 'UNAUTHENTICATED');
    actor = principal('alice', 'viewer'); held = true; const pending = fetch(url);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    actor = null; (release as () => void)(); assert.equal((await pending).status, 401);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
