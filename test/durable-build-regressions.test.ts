import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DurableFirmwareBuildJobService } from '../src/modules/firmware/application/durable-firmware-build-job-service.js';
import type { FirmwareBuildResult } from '../src/modules/firmware/application/firmware-build-executor.js';
import type { FirmwareBuildJobRecord, FirmwareBuildJobRepository } from '../src/modules/firmware/repositories/firmware-build-job-repository.js';
import { boundedFirmwareBuildLog } from '../src/modules/firmware/domain/firmware-build-log.js';

const actor = { id: 'regression-operator', kind: 'console' as const };
const artifact = { id: 'a'.repeat(16), sha256: 'a'.repeat(64), size: 10, version: '1.0.0' };
const result: FirmwareBuildResult = { artifact, stagedOutputId: artifact.id, log: [] };
const artifacts = { save: async () => {}, get: async () => artifact, list: async () => [], delete: async () => {} };

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function memoryRepository(initial: FirmwareBuildJobRecord[] = []) {
  const rows = new Map(initial.map((row) => [row.id, row]));
  const repository: FirmwareBuildJobRepository = {
    create: async (job) => { rows.set(job.id, job); },
    save: async (job) => { rows.set(job.id, job); },
    get: async (id) => rows.get(id) ?? null,
    list: async () => [...rows.values()].reverse(),
    markActiveInterrupted: async () => [],
  };
  return { rows, repository };
}

test('overlapping requests accept exactly one build while database acceptance is pending', async () => {
  const { repository } = memoryRepository();
  const acceptance = deferred<void>();
  const execution = deferred<FirmwareBuildResult>();
  let creates = 0;
  let executions = 0;
  repository.create = async () => { creates += 1; await acceptance.promise; };
  const service = new DurableFirmwareBuildJobService({ repository, artifacts,
    executor: { execute: () => { executions += 1; return execution.promise; } } });
  try {
    const first = service.start('first', actor);
    assert.equal(await service.start('overlap', actor), false);
    acceptance.resolve();
    assert.equal(await first, true);
    assert.equal(await service.start('while-running', actor), false);
    assert.equal(creates, 1);
    assert.equal(executions, 1);
    execution.resolve(result);
    await service.whenIdle();
    assert.equal(await service.status(), null);
  } finally { acceptance.resolve(); execution.resolve(result); await service.dispose(); }
});

test('failed acceptance releases the reservation and a later request can build', async () => {
  const { repository, rows } = memoryRepository();
  let attempts = 0;
  let executions = 0;
  repository.create = async (job) => {
    if (++attempts === 1) throw new Error('acceptance unavailable');
    rows.set(job.id, job);
  };
  const service = new DurableFirmwareBuildJobService({ repository, artifacts,
    executor: { execute: async () => { executions += 1; return result; } } });
  try {
    await assert.rejects(service.start('first', actor), /acceptance unavailable/);
    assert.equal(await service.start('retry', actor), true);
    await service.whenIdle();
    assert.equal(executions, 1);
    assert.equal(await service.status(), null);
  } finally { await service.dispose(); }
});

test('shutdown prevents a worker from starting after delayed acceptance completes', async () => {
  const { repository } = memoryRepository();
  const acceptance = deferred<void>();
  let executions = 0;
  repository.create = async () => { await acceptance.promise; };
  const service = new DurableFirmwareBuildJobService({ repository, artifacts,
    executor: { execute: async () => { executions += 1; return result; } } });
  const pending = service.start('pending-at-shutdown', actor);
  const rejected = assert.rejects(pending, /service is stopping/);
  await service.dispose();
  acceptance.resolve();
  await rejected;
  assert.equal(executions, 0);
});

test('lost acceptance acknowledgement reconciles and still excludes overlapping work', async () => {
  const { repository, rows } = memoryRepository();
  const acknowledgement = deferred<void>();
  let executions = 0;
  repository.create = async (job) => {
    rows.set(job.id, job);
    await acknowledgement.promise;
    throw new Error('acknowledgement lost');
  };
  const service = new DurableFirmwareBuildJobService({ repository, artifacts,
    executor: { execute: async () => { executions += 1; return result; } } });
  try {
    const accepted = service.start('first', actor);
    assert.equal(await service.start('overlap', actor), false);
    acknowledgement.resolve();
    assert.equal(await accepted, true);
    await service.whenIdle();
    assert.equal(executions, 1);
    assert.equal([...rows.values()][0]?.lifecycle, 'succeeded');
  } finally { acknowledgement.resolve(); await service.dispose(); }
});

test('timer-triggered progress failure is handled while the worker is still running', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { repository, rows } = memoryRepository();
  const execution = deferred<FirmwareBuildResult>();
  const progressFailed = deferred<void>();
  let first = true;
  repository.save = async (job) => {
    if (job.lifecycle === 'running' && job.log.length && first) {
      first = false;
      progressFailed.resolve();
      throw new Error('timed database outage');
    }
    rows.set(job.id, job);
  };
  let calls = 0;
  const service = new DurableFirmwareBuildJobService({ repository, artifacts,
    executor: { execute: async (_request, progress) => {
      progress('compiler progress');
      return ++calls === 1 ? execution.promise : result;
    } } });
  try {
    await service.start('first', actor);
    context.mock.timers.tick(1000);
    await progressFailed.promise;
    // Yield through an event-loop turn so an unhandled timer rejection fails the test.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await service.status() as { lifecycle: string }).lifecycle, 'running');
    execution.resolve(result);
    await assert.rejects(service.whenIdle(), /timed database outage/);
    assert.equal((await service.status() as { lifecycle: string }).lifecycle, 'failed');
    await service.start('retry', actor);
    await service.whenIdle();
    assert.equal(await service.status(), null);
  } finally { execution.resolve(result); context.mock.timers.reset(); await service.dispose(); }
});

test('restored successful build history does not disable a new build', async () => {
  const completed: FirmwareBuildJobRecord = {
    id: 'completed', uploadId: 'old', actor, lifecycle: 'succeeded', startedAt: 1, finishedAt: 2,
    artifact, log: ['done'], error: null,
  };
  const { repository } = memoryRepository([completed]);
  const service = new DurableFirmwareBuildJobService({ repository, artifacts,
    executor: { execute: async () => result } });
  try {
    await service.initialize();
    assert.equal(await service.status(), null);
    assert.equal((await service.operationalStatus()).latestLifecycle, 'succeeded');
    assert.equal(await service.start('next', actor), true);
    await service.whenIdle();
    assert.equal(await service.status(), null);
  } finally { await service.dispose(); }
});

test('bounded terminal logs reconcile after a lost PostgreSQL save acknowledgement', async () => {
  const { repository, rows } = memoryRepository();
  let activations = 0;
  repository.save = async (job) => {
    rows.set(job.id, { ...job, log: boundedFirmwareBuildLog(job.log) });
    if (job.lifecycle === 'succeeded') throw new Error('terminal acknowledgement lost');
  };
  const service = new DurableFirmwareBuildJobService({ repository, artifacts,
    executor: { execute: async () => ({ ...result, log: Array.from({ length: 33 }, () => 'x'.repeat(3968)) }) },
    activateArtifact: () => { activations += 1; } });
  try {
    await service.start('boundary-log', actor);
    await service.whenIdle();
    assert.equal(activations, 1);
    assert.equal([...rows.values()][0]?.log.length, 32);
    assert.equal(await service.status(), null);
    assert.equal((await service.operationalStatus()).latestLifecycle, 'succeeded');
  } finally { await service.dispose(); }
});
