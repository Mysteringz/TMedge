import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RolloutImageUsageQuery } from '../src/infrastructure/firmware-build/rollout-image-usage-query.js';
import { FirmwareBuildJobs } from '../src/modules/firmware/application/firmware-build-jobs.js';

const artifact = { id: 'image-a', sha256: 'a'.repeat(64), size: 10, version: '1.0.0' };

test('build jobs reject a duplicate while running and retain failure details for retry', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const jobs = new FirmwareBuildJobs({
    execute: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('build failed'), { log: ['compiler output'] });
      await new Promise<void>((resolve) => { release = resolve; });
      return { artifact, stagedOutputId: artifact.id, log: [] };
    },
  });
  try {
    const actor = { id: 'console', kind: 'console' as const };
    assert.equal(jobs.start('upload-1', actor), true);
    assert.equal(jobs.start('upload-2', actor), false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(jobs.status(), { startedAt: jobs.status()?.startedAt, log: ['compiler output'], error: 'build failed' });
    assert.equal(jobs.start('upload-2', actor), true, 'a failed build does not block a retry');
    assert.equal(jobs.start('upload-3', actor), false);
    release?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(jobs.status(), null, 'successful completion clears the active job');
  } finally {
    jobs.dispose();
  }
});

test('image cleanup is blocked only while the current matching rollout is active', () => {
  let current: { buildId: string; stage: string } | null = { buildId: 'image-a', stage: 'pilot' };
  const query = new RolloutImageUsageQuery({ current: () => current });
  assert.equal(query.isImageInUse('image-a'), true);
  assert.equal(query.isImageInUse('image-b'), false);
  current = { buildId: 'image-a', stage: 'done' };
  assert.equal(query.isImageInUse('image-a'), false);
  current = { buildId: 'image-a', stage: 'stopped' };
  assert.equal(query.isImageInUse('image-a'), false);
});
