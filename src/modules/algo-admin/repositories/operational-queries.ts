import type { FirmwareSummary, ParameterSummary, SensorSummary, TrainingSummary } from '../domain/operational-health.js';

/** Minimal sanitized observations; null means intentionally disabled. */
export interface OperationalQueries {
  sensors(now: number): SensorSummary | Promise<SensorSummary>;
  training(owner: string): TrainingSummary | null | Promise<TrainingSummary | null>;
  firmware(): FirmwareSummary | null | Promise<FirmwareSummary | null>;
  parameters(): ParameterSummary | Promise<ParameterSummary>;
}
