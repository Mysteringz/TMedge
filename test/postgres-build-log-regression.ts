import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { PostgresFirmwareBuildJobRepository } from '../src/infrastructure/postgres/firmware-build-repositories.js';

/** Runs inside the existing disposable schema lifecycle before process/cutover checks. */
export async function assertPostgresBuildLogBoundary(source: DataSource): Promise<void> {
  const id = randomUUID();
  const repository = new PostgresFirmwareBuildJobRepository(source);
  try {
    await repository.create({ id, uploadId: 'log-boundary-regression', actor: { id: 'test', kind: 'system' },
      lifecycle: 'running', startedAt: Date.now(), finishedAt: null, artifact: null,
      log: Array.from({ length: 33 }, () => 'x'.repeat(3968)), error: null });
    const [row] = await source.query('SELECT octet_length(log::text) AS bytes FROM public.firmware_build_jobs WHERE id = $1', [id]) as Array<{ bytes: number }>;
    assert.ok(row && row.bytes <= 131072);
    const stored = await repository.get(id);
    assert.ok(stored);
    assert.equal(stored.log.length, 32);
    await repository.save({ ...stored, lifecycle: 'failed', finishedAt: Date.now(), error: 'test failure',
      log: Array.from({ length: 60 }, () => '热"\\\n'.repeat(1000)) });
    const [updated] = await source.query('SELECT octet_length(log::text) AS bytes FROM public.firmware_build_jobs WHERE id = $1', [id]) as Array<{ bytes: number }>;
    assert.ok(updated && updated.bytes <= 131072);
  } finally { await source.query('DELETE FROM public.firmware_build_jobs WHERE id = $1', [id]); }
}
