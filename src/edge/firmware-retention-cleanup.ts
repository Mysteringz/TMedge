import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  FirmwareArtifactContentStorage, FirmwareCleanupReport, ImageInUseQuery,
} from '../modules/firmware/repositories/firmware-repository.js';
import type { FirmwareBuild } from './firmware.js';

interface UploadReference { id: string; dir: string; startedAt: number; lastActivityAt: number }

export function cleanupFirmwareData(input: {
  directory: string;
  artifacts: FirmwareArtifactContentStorage;
  builds: Map<string, FirmwareBuild>;
  uploads: Map<string, UploadReference>;
  imageInUse: ImageInUseQuery;
  now: number;
  retentionMs: number;
}): FirmwareCleanupReport {
  const report = emptyFirmwareCleanupReport();
  report.at = input.now;
  report.retentionMs = input.retentionMs;
  const cutoff = input.now - input.retentionMs;
  cleanAbandonedSources(join(input.directory, 'uploads'), input.uploads, cutoff, report);
  cleanFailedBuilds(join(input.directory, 'builds'), input.artifacts, input.builds, input.imageInUse, cutoff, report);
  cleanUnindexedBuildFiles(join(input.directory, 'builds'), input.artifacts, input.builds, input.imageInUse, cutoff, report);
  cleanOrphanArtifacts(input.artifacts, input.builds, input.imageInUse, cutoff, report);
  cleanStagedArtifacts(input.artifacts, input.imageInUse, cutoff, report);
  cleanMetadataTemps(join(input.directory, 'builds'), input.builds, input.imageInUse, cutoff, report);
  return report;
}

function cleanAbandonedSources(
  directory: string, uploads: Map<string, UploadReference>, cutoff: number, report: FirmwareCleanupReport,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if ((uploads.get(entry.name)?.lastActivityAt ?? 0) >= cutoff) continue;
    if (statSync(path).mtimeMs >= cutoff) continue;
    report.bytesRemoved += directoryBytes(path);
    rmSync(path, { recursive: true, force: true });
    uploads.delete(entry.name);
    report.abandonedSourcesRemoved += 1;
  }
}

function cleanFailedBuilds(
  directory: string, artifacts: FirmwareArtifactContentStorage, builds: Map<string, FirmwareBuild>,
  imageInUse: ImageInUseQuery, cutoff: number, report: FirmwareCleanupReport,
): void {
  for (const [id, build] of builds) {
    if (build.state !== 'failed' || build.uploadedAt >= cutoff) continue;
    if (preserveInUse(id, imageInUse, report)) continue;
    report.bytesRemoved += removeArtifact(artifacts, id);
    removeBuildFiles(directory, id);
    builds.delete(id);
    report.failedOutputsRemoved += 1;
  }
}

function cleanOrphanArtifacts(
  artifacts: FirmwareArtifactContentStorage, builds: Map<string, FirmwareBuild>, imageInUse: ImageInUseQuery,
  cutoff: number, report: FirmwareCleanupReport,
): void {
  for (const artifact of artifacts.list()) {
    if (builds.has(artifact.id) || artifact.modifiedAt >= cutoff) continue;
    if (preserveInUse(artifact.id, imageInUse, report)) continue;
    if (artifacts.remove(artifact.id)) {
      report.bytesRemoved += artifact.size;
      report.failedOutputsRemoved += 1;
    }
  }
}

function cleanStagedArtifacts(
  artifacts: FirmwareArtifactContentStorage, imageInUse: ImageInUseQuery, cutoff: number, report: FirmwareCleanupReport,
): void {
  for (const staged of artifacts.listStaging()) {
    if (staged.modifiedAt >= cutoff || preserveInUse(staged.id, imageInUse, report)) continue;
    if (artifacts.removeStaging(staged.name)) {
      report.bytesRemoved += staged.size;
      report.failedOutputsRemoved += 1;
    }
  }
}

function cleanUnindexedBuildFiles(
  directory: string, artifacts: FirmwareArtifactContentStorage, builds: Map<string, FirmwareBuild>,
  imageInUse: ImageInUseQuery, cutoff: number, report: FirmwareCleanupReport,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const id = entry.name.match(/^([a-f0-9]{16})(?:\.json)?$/)?.[1];
    if (!entry.isDirectory() && !entry.isFile() || !id || builds.has(id)) continue;
    if (statSync(join(directory, entry.name)).mtimeMs >= cutoff || preserveInUse(id, imageInUse, report)) continue;
    report.bytesRemoved += entry.isDirectory() ? directoryBytes(join(directory, entry.name)) : statSync(join(directory, entry.name)).size;
    rmSync(join(directory, entry.name), { recursive: entry.isDirectory(), force: true });
    report.bytesRemoved += removeArtifact(artifacts, id);
    report.failedOutputsRemoved += 1;
  }
}

function cleanMetadataTemps(
  directory: string, builds: Map<string, FirmwareBuild>, imageInUse: ImageInUseQuery,
  cutoff: number, report: FirmwareCleanupReport,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const id = entry.name.match(/^([a-f0-9]{16})\.json\..+\.tmp$/)?.[1];
    if (!entry.isFile() || !id || builds.has(id) || statSync(join(directory, entry.name)).mtimeMs >= cutoff) continue;
    if (preserveInUse(id, imageInUse, report)) continue;
    report.bytesRemoved += statSync(join(directory, entry.name)).size;
    rmSync(join(directory, entry.name), { force: true });
    report.failedOutputsRemoved += 1;
  }
}

function removeBuildFiles(directory: string, id: string): void {
  rmSync(join(directory, `${id}.json`), { force: true });
  rmSync(join(directory, id), { recursive: true, force: true });
}

function removeArtifact(artifacts: FirmwareArtifactContentStorage, id: string): number {
  const file = artifacts.list().find((item) => item.id === id);
  return file && artifacts.remove(id) ? file.size : 0;
}

export function emptyFirmwareCleanupReport(): FirmwareCleanupReport {
  return { at: 0, retentionMs: 0, abandonedSourcesRemoved: 0, failedOutputsRemoved: 0, bytesRemoved: 0, inUseArtifactsPreserved: 0 };
}

function preserveInUse(id: string, query: ImageInUseQuery, report: FirmwareCleanupReport): boolean {
  if (!query.isImageInUse(id)) return false;
  report.inUseArtifactsPreserved += 1;
  return true;
}

function directoryBytes(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}
