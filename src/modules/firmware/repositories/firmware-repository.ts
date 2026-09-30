/** Metadata for a validated image; source bytes remain in controlled file storage. */
export interface FirmwareArtifact {
  id: string;
  sha256: string;
  size: number;
  version: string;
}

/** Synchronous, edge-local byte and upload operations; durable metadata uses async repositories. */
export interface FirmwareArtifactFiles {
  startUpload(actor: string): string;
  addFile(uploadId: string, path: string, bytes: Buffer): void;
  cleanup(imageInUse: ImageInUseQuery, olderThanMs?: number): FirmwareCleanupReport;
  retentionReport(): FirmwareCleanupReport;
  bytes(id: string): Buffer | null;
  remove(id: string, imageInUse: ImageInUseQuery): boolean;
  diskBytes(): number;
  list(): FirmwareArtifact[];
  get(id: string): FirmwareArtifact | null;
}

export interface FirmwareCleanupReport {
  at: number;
  retentionMs: number;
  abandonedSourcesRemoved: number;
  failedOutputsRemoved: number;
  bytesRemoved: number;
  inUseArtifactsPreserved: number;
}

/** Content-addressed image bytes, stored independently from build metadata. */
export interface FirmwareArtifactContentStorage {
  promote(id: string, sha256: string, bytes: Buffer): void;
  read(id: string, sha256: string, size: number): Buffer | null;
  remove(id: string): boolean;
  list(): Array<{ id: string; modifiedAt: number; size: number }>;
  listStaging(): Array<{ name: string; id: string; modifiedAt: number; size: number }>;
  removeStaging(name: string): boolean;
}

/** Async durable metadata boundary, separate from local image byte reads. */
export interface FirmwareArtifactRepository {
  save(artifact: FirmwareArtifact): Promise<void>;
  get(id: string): Promise<FirmwareArtifact | null>;
  list(): Promise<FirmwareArtifact[]>;
  delete(id: string): Promise<void>;
}

/** Authoritative query used before artifact deletion or cleanup. */
export interface ImageInUseQuery {
  isImageInUse(imageId: string): boolean;
}
