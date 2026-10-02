import type { NodePose } from '../../../shared/types.js';

/** Plain registration data used by import/export and startup loaders. */
export interface RegistryNodeRecord {
  uid: string;
  label: string;
  floorId: string | null;
  pose: NodePose | null;
  owns: readonly string[];
  simulated: boolean;
  rgb: boolean;
}

export class RegistrationConflictError extends Error {}

export interface RegistryRepository {
  listNodes(): Promise<RegistryNodeRecord[]>;
  /** Atomically inserts rows that are absent; exact existing rows are safe reruns. */
  importNodes(nodes: readonly RegistryNodeRecord[]): Promise<{ inserted: number; unchanged: number }>;
}
