import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FirmwareBuildJobRecord, FirmwareBuildJobRepository } from '../src/modules/firmware/repositories/firmware-build-job-repository.js';
import { DurableFirmwareBuildJobService } from '../src/modules/firmware/application/durable-firmware-build-job-service.js';

const actor = { id: 'operator-1', kind: 'console' as const };
const artifact = { id: 'a'.repeat(16), sha256: 'a'.repeat(64), size: 10, version: '1.0.0' };

test('a build is durably accepted before its worker starts', async () => {
  const events: string[] = [];
  const rows = new Map<string, FirmwareBuildJobRecord>();
  const repository: FirmwareBuildJobRepository = {
    create: async (job) => { events.push('accepted'); rows.set(job.id, job); },
    save: async (job) => { events.push(job.lifecycle); rows.set(job.id, job); },
    get: async (id) => rows.get(id) ?? null,
    list: async () => [...rows.values()],
    markActiveInterrupted: async () => [],
  };
  const service = new DurableFirmwareBuildJobService({
    repository,
    artifacts: { save: async () => { events.push('artifact'); }, get: async () => artifact, list: async () => [artifact], delete: async () => {} },
    executor: { execute: async () => { events.push('worker'); return { artifact, stagedOutputId: artifact.id, log: [] }; } },
    activateArtifact: () => { events.push('activate'); },
    now: () => 1000,
  });
  try {
    await service.initialize();
    assert.equal(await service.start('upload-1', actor), true);
    await service.whenIdle();
    assert.deepEqual(events, ['accepted', 'running', 'worker', 'artifact', 'succeeded', 'activate']);
    assert.equal(await service.status(), null);
    assert.equal((await service.operationalStatus()).latestLifecycle, 'succeeded');
  } finally {
    await service.dispose();
  }
});

test('a failed durable acceptance never starts the build worker', async () => {
  let workerCalls = 0;
  const repository: FirmwareBuildJobRepository = {
    create: async () => { throw new Error('database unavailable'); },
    save: async () => {}, get: async () => null, list: async () => [], markActiveInterrupted: async () => [],
  };
  const service = new DurableFirmwareBuildJobService({
    repository,
    artifacts: { save: async () => {}, get: async () => null, list: async () => [], delete: async () => {} },
    executor: { execute: async () => { workerCalls += 1; return { artifact, stagedOutputId: artifact.id, log: [] }; } },
  });
  try {
    await service.initialize();
    await assert.rejects(service.start('upload-1', actor), /database unavailable/);
    await service.whenIdle();
    assert.equal(workerCalls, 0);
  } finally {
    await service.dispose();
  }
});

test('startup marks active rows interrupted and never submits them to the worker', async () => {
  const active: FirmwareBuildJobRecord = {
    id: 'old-build', uploadId: 'old-upload', actor, lifecycle: 'running', startedAt: 10,
    finishedAt: null, artifact: null, log: [], error: null,
  };
  let recoveredAt = 0;
  let workerCalls = 0;
  const repository: FirmwareBuildJobRepository = {
    create: async () => {}, save: async () => {}, get: async () => active,
    list: async () => [{ ...active, lifecycle: 'interrupted', finishedAt: 20 }],
    markActiveInterrupted: async (at) => { recoveredAt = at; return []; },
  };
  const service = new DurableFirmwareBuildJobService({
    repository,
    artifacts: { save: async () => {}, get: async () => null, list: async () => [], delete: async () => {} },
    executor: { execute: async () => { workerCalls += 1; return { artifact, stagedOutputId: artifact.id, log: [] }; } },
    now: () => 20,
  });
  try {
    await service.initialize();
    assert.equal(recoveredAt, 20);
    assert.equal((await service.status() as { lifecycle: string }).lifecycle, 'interrupted');
    assert.equal(workerCalls, 0);
  } finally {
    await service.dispose();
  }
});

test('a transient progress write failure does not poison progress persistence for later builds', async () => {
  const rows = new Map<string, FirmwareBuildJobRecord>();
  let failedProgressWrite = false;
  const repository: FirmwareBuildJobRepository = {
    create: async (job) => { rows.set(job.id, job); },
    save: async (job) => {
      if (job.lifecycle === 'running' && job.log.length > 0 && !failedProgressWrite) {
        failedProgressWrite = true;
        throw new Error('temporary database outage');
      }
      rows.set(job.id, job);
    },
    get: async (id) => rows.get(id) ?? null,
    list: async () => [...rows.values()],
    markActiveInterrupted: async () => [],
  };
  let buildNumber = 0;
  const service = new DurableFirmwareBuildJobService({
    repository,
    artifacts: { save: async () => {}, get: async () => artifact, list: async () => [artifact], delete: async () => {} },
    executor: {
      execute: async (_request, progress) => {
        buildNumber += 1;
        progress(`build ${buildNumber}`);
        return { artifact, stagedOutputId: artifact.id, log: [] };
      },
    },
    now: (() => { let time = 1000; return () => ++time; })(),
  });
  try {
    await service.initialize();
    assert.equal(await service.start('upload-1', actor), true);
    await assert.rejects(service.whenIdle(), /temporary database outage/);
    assert.equal((await service.status() as { lifecycle: string }).lifecycle, 'failed');

    assert.equal(await service.start('upload-2', actor), true);
    await service.whenIdle();
    assert.equal(await service.status(), null);
    assert.equal((await service.operationalStatus()).latestLifecycle, 'succeeded');
  } finally {
    await service.dispose();
  }
});
