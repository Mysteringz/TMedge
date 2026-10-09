export interface HealthSource<T> { state: 'available' | 'unavailable' | 'disabled'; observedAt: number | null; staleAfterMs: number; data: T | null }
export interface SensorHealth { uid: string; label: string; floorId: string | null; online: boolean; reportReceivedAt: number | null; statusReceivedAt: number | null }
export interface TrainingHealth { id: string; name: string; status: string; updatedAt: number; lastPolledAt: number | null; endedAt: number | null; remoteObservationRequired: boolean }
export interface FirmwareNodeHealth { uid: string; label: string; state: string; percent: number; updatedAt: number; outcomeUncertain: boolean }
export interface RolloutHealth { id: string; version: string; stage: string; startedAt: number; finishedAt: number | null; interrupted: boolean; total: number; failed: number; uncertain: number; confirmed: number; rows: FirmwareNodeHealth[] }
export interface FirmwareSummary { build: { state: 'idle' | 'building' | 'failed'; startedAt: number | null }; rollout: RolloutHealth | null }
export interface ParameterHealth { uid: string; param: string; binding: string; revertAt: number; confirmedAt: number | null; restoring: boolean }
export interface HealthSnapshot {
  generatedAt: number;
  sensors: HealthSource<{ total: number; offline: number; unknown: number; rows: SensorHealth[] }>;
  training: HealthSource<{ total: number; failed: number; rows: TrainingHealth[] }>;
  firmware: HealthSource<FirmwareSummary>;
  parameters: HealthSource<{ total: number; rows: ParameterHealth[] }>;
}
