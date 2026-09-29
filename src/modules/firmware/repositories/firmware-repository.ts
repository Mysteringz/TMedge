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
  sweep(olderThanMs?: number): void;
  bytes(id: string): Buffer | null;
  remove(id: string): boolean;
  diskBytes(): number;
  list(): FirmwareArtifact[];
  get(id: string): FirmwareArtifact | null;
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
