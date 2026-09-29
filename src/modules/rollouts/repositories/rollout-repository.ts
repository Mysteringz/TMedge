export type RolloutStage = 'pilot' | 'rest' | 'done' | 'stopped';
export type RolloutNodeState = 'queued' | 'sending' | 'downloading' | 'verifying' | 'applying' | 'rebooting' | 'confirmed' | 'failed' | 'skipped';

export type RolloutTargetRecord =
  | { kind: 'node'; uid: string }
  | { kind: 'floor'; floorId: string }
  | { kind: 'all' };

export interface RolloutNodeRecord {
  uid: string;
  label: string;
  floorId: string | null;
  gatewayId: string | null;
  transport: 'udp' | 'gateway' | 'direct' | null;
  state: RolloutNodeState;
  percent: number;
  error?: string;
  startedAt: number | null;
  updatedAt: number;
}

export interface RolloutRecord {
  id: string;
  buildId: string;
  version: string;
  target: RolloutTargetRecord;
  startedBy: string;
  startedAt: number;
  finishedAt: number | null;
  stage: RolloutStage;
  note: string;
  nodes: RolloutNodeRecord[];
}

/** Async persistence boundary; each saveSnapshot atomically writes current plus bounded history. */
export interface RolloutRepository {
  current(): Promise<RolloutRecord | null>;
  history(): Promise<RolloutRecord[]>;
  saveSnapshot(current: RolloutRecord | null, history: readonly RolloutRecord[]): Promise<void>;
}
