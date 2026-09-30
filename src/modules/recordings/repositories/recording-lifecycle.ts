export interface RecordingSession {
  id: string;
  state: 'recording' | 'stopping' | 'complete' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  bytesWritten: number;
  queueDepth: number;
  queueLimit: number;
  droppedRecords: number;
  lastSuccessfulWriteAt: number | null;
  healthy: boolean;
  error?: string;
}

/** Recording operations stay bounded and report filesystem failures explicitly. */
export interface RecordingLifecycle {
  start(id: string): Promise<RecordingSession>;
  stop(id: string): Promise<RecordingSession>;
  status(id: string): RecordingSession | null;
}

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
