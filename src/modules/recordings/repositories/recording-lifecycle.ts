export interface RecordingStreamHealth {
  queuedBytes: number;
  queueLimitBytes: number;
  droppedRecords: number;
  writeErrors: number;
  lastSuccessfulWriteAt: number | null;
  healthy: boolean;
  lastError: string | null;
}

export interface RecorderHealth {
  detections: RecordingStreamHealth;
  occupancy: RecordingStreamHealth;
  raw: RecordingStreamHealth | null;
}

/** Health port consumed by readiness and operations reporting. */
export interface RecordingHealthProvider {
  health(): RecorderHealth;
}
