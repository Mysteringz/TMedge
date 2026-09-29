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
