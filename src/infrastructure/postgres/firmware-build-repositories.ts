import { createHash } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { Actor } from '../../modules/shared/application/contracts.js';
import type { FirmwareBuildJobRecord, FirmwareBuildJobRepository } from '../../modules/firmware/repositories/firmware-build-job-repository.js';
import type { FirmwareArtifact, FirmwareArtifactContentStorage, FirmwareArtifactRepository } from '../../modules/firmware/repositories/firmware-repository.js';

const MAX_LOG_LINES = 400;
const MAX_LOG_LINE_CHARS = 4096;
const MAX_LOG_BYTES = 128 * 1024;

interface ArtifactRow { id: string; sha256: string; size: string | number; version: string }
interface JobRow {
  id: string; upload_id: string; actor_id: string; actor_kind: Actor['kind']; lifecycle: FirmwareBuildJobRecord['lifecycle'];
  started_at: Date | string; finished_at: Date | string | null; artifact_id: string | null;
  artifact_sha256: string | null; artifact_size: string | number | null; artifact_version: string | null;
  log: string[] | string; error: string | null;
}

/** Immutable metadata adapter; image bytes remain in the edge artifact store. */
export class PostgresFirmwareArtifactRepository implements FirmwareArtifactRepository {
  constructor(
    private readonly source: DataSource,
    private readonly artifactContent?: Pick<FirmwareArtifactContentStorage, 'read'>,
  ) {}

  async save(artifact: FirmwareArtifact): Promise<void> {
    validateArtifact(artifact);
    await this.source.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO public.firmware_artifacts (id, sha256, size, version) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`, [artifact.id, artifact.sha256, artifact.size, artifact.version],
      );
      const rows = await manager.query('SELECT id, sha256, size, version FROM public.firmware_artifacts WHERE id = $1', [artifact.id]) as ArtifactRow[];
      if (!rows[0] || !sameArtifact(mapArtifact(rows[0]), artifact)) throw new Error(`Firmware artifact metadata conflict for ${artifact.id}`);
    });
  }

  async get(id: string): Promise<FirmwareArtifact | null> {
    const rows = await this.source.query('SELECT id, sha256, size, version FROM public.firmware_artifacts WHERE id = $1', [id]) as ArtifactRow[];
    return rows[0] ? mapArtifact(rows[0]) : null;
  }

  async list(): Promise<FirmwareArtifact[]> {
    const rows = await this.source.query('SELECT id, sha256, size, version FROM public.firmware_artifacts ORDER BY id') as ArtifactRow[];
    return rows.map(mapArtifact);
  }

  async delete(id: string): Promise<void> {
    await this.source.query('DELETE FROM public.firmware_artifacts WHERE id = $1', [id]);
  }
}

/** Persists job metadata and converts accepted/running jobs to interrupted at restart. */
export class PostgresFirmwareBuildJobRepository implements FirmwareBuildJobRepository {
  constructor(
    private readonly source: DataSource,
    private readonly artifactContent?: Pick<FirmwareArtifactContentStorage, 'read'>,
  ) {}

  async create(job: FirmwareBuildJobRecord): Promise<void> {
    await this.verifyReadyArtifact(job);
    const value = normalizeJob(job);
    await this.source.query(
      `INSERT INTO public.firmware_build_jobs
       (id, upload_id, actor_id, actor_kind, lifecycle, started_at, finished_at, artifact_id, log, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`, jobValues(value),
    );
  }

  async save(job: FirmwareBuildJobRecord): Promise<void> {
    await this.verifyReadyArtifact(job);
    const value = normalizeJob(job);
    await this.source.query(
      `INSERT INTO public.firmware_build_jobs
       (id, upload_id, actor_id, actor_kind, lifecycle, started_at, finished_at, artifact_id, log, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (id) DO UPDATE SET upload_id = EXCLUDED.upload_id, actor_id = EXCLUDED.actor_id,
         actor_kind = EXCLUDED.actor_kind, lifecycle = EXCLUDED.lifecycle, started_at = EXCLUDED.started_at,
         finished_at = EXCLUDED.finished_at, artifact_id = EXCLUDED.artifact_id, log = EXCLUDED.log, error = EXCLUDED.error`,
      jobValues(value),
    );
  }

  async get(jobId: string): Promise<FirmwareBuildJobRecord | null> {
    const rows = await this.source.query(`${JOB_SELECT} WHERE j.id = $1`, [jobId]) as JobRow[];
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async list(): Promise<FirmwareBuildJobRecord[]> {
    const rows = await this.source.query(`${JOB_SELECT} ORDER BY j.started_at DESC, j.id`) as JobRow[];
    return rows.map(mapJob);
  }

  async markActiveInterrupted(at: number): Promise<FirmwareBuildJobRecord[]> {
    return this.source.transaction(async (manager) => {
      // TypeORM's PostgreSQL runner returns [rows, rowCount] for UPDATE/DELETE queries.
      const [updated] = await manager.query(
        `UPDATE public.firmware_build_jobs SET lifecycle = 'interrupted', finished_at = $1,
           error = COALESCE(error, 'build interrupted by process restart')
         WHERE lifecycle IN ('accepted', 'running') RETURNING id`, [new Date(at)],
      ) as [Array<{ id: string }>, number];
      if (updated.length === 0) return [];
      const rows = await manager.query(`${JOB_SELECT} WHERE j.id = ANY($1::text[]) ORDER BY j.started_at DESC, j.id`,
        [updated.map((row) => row.id)]) as JobRow[];
      return rows.map(mapJob);
    });
  }

  private async verifyReadyArtifact(job: FirmwareBuildJobRecord): Promise<void> {
    if (job.lifecycle !== 'succeeded') return;
    const artifact = job.artifact;
    if (!artifact || !this.artifactContent) {
      throw new Error('Cannot mark a build succeeded without an artifact content verifier');
    }
    validateArtifact(artifact);
    const bytes = this.artifactContent.read(artifact.id, artifact.sha256, artifact.size);
    const digest = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
    if (!bytes || bytes.length !== artifact.size || digest !== artifact.sha256) {
      throw new Error(`Cannot mark build ${job.id} succeeded: artifact bytes are missing or fail SHA-256 verification`);
    }
    const rows = await this.source.query(
      'SELECT id, sha256, size, version FROM public.firmware_artifacts WHERE id = $1', [artifact.id],
    ) as ArtifactRow[];
    if (!rows[0] || !sameArtifact(mapArtifact(rows[0]), artifact)) {
      throw new Error(`Cannot mark build ${job.id} succeeded: committed firmware artifact metadata is missing or mismatched`);
    }
  }
}

const JOB_SELECT = `SELECT j.id, j.upload_id, j.actor_id, j.actor_kind, j.lifecycle, j.started_at, j.finished_at,
  j.artifact_id, a.sha256 AS artifact_sha256, a.size AS artifact_size, a.version AS artifact_version, j.log, j.error
  FROM public.firmware_build_jobs j LEFT JOIN public.firmware_artifacts a ON a.id = j.artifact_id`;

function jobValues(job: FirmwareBuildJobRecord): unknown[] {
  return [job.id, job.uploadId, job.actor.id, job.actor.kind, job.lifecycle, new Date(job.startedAt),
    job.finishedAt === null ? null : new Date(job.finishedAt), job.artifact?.id ?? null, JSON.stringify(job.log), job.error];
}

function normalizeJob(job: FirmwareBuildJobRecord): FirmwareBuildJobRecord {
  const log = job.log.slice(-MAX_LOG_LINES).map((line) => line.slice(-MAX_LOG_LINE_CHARS));
  while (log.length > 0 && Buffer.byteLength(JSON.stringify(log)) > MAX_LOG_BYTES) log.shift();
  return { ...job, log };
}

function validateArtifact(artifact: FirmwareArtifact): void {
  if (!/^[a-f0-9]{16}$/.test(artifact.id) || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || artifact.sha256.slice(0, 16) !== artifact.id || !Number.isSafeInteger(artifact.size) || artifact.size <= 0
    || typeof artifact.version !== 'string' || artifact.version.trim() === '') {
    throw new Error('Invalid firmware artifact metadata');
  }
}

function mapArtifact(row: ArtifactRow): FirmwareArtifact {
  return { id: row.id, sha256: row.sha256, size: Number(row.size), version: row.version };
}

function sameArtifact(a: FirmwareArtifact, b: FirmwareArtifact): boolean {
  return a.id === b.id && a.sha256 === b.sha256 && a.size === b.size && a.version === b.version;
}

function mapJob(row: JobRow): FirmwareBuildJobRecord {
  const log = typeof row.log === 'string' ? JSON.parse(row.log) as unknown : row.log;
  return {
    id: row.id, uploadId: row.upload_id, actor: { id: row.actor_id, kind: row.actor_kind }, lifecycle: row.lifecycle,
    startedAt: epoch(row.started_at), finishedAt: row.finished_at === null ? null : epoch(row.finished_at),
    artifact: row.artifact_id === null || row.artifact_sha256 === null || row.artifact_size === null || row.artifact_version === null
      ? null : { id: row.artifact_id, sha256: row.artifact_sha256, size: Number(row.artifact_size), version: row.artifact_version },
    log: Array.isArray(log) ? log.filter((line): line is string => typeof line === 'string') : [], error: row.error,
  };
}

function epoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
