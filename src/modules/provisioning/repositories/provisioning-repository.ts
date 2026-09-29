import type { Actor } from '../../shared/application/contracts.js';

export interface ProvisioningRequestRecord {
  id: string;
  uid: string;
  label: string;
  firmware: string | null;
  requestedBy: string;
  requestedAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  resolvedAt: number | null;
  resolvedBy: Actor | null;
  registeredUid: string | null;
}

export interface NodeRegistration {
  uid: string;
  label: string;
  floorId: null;
  pose: null;
  owns: readonly string[];
}

/** The records changed together when a provisioning decision is committed. */
export interface ProvisioningTransaction {
  saveRequest(request: ProvisioningRequestRecord): Promise<void>;
  registerNode(node: NodeRegistration): Promise<void>;
  appendAudit(event: { actor: Actor; action: string; subjectId: string; at: number }): Promise<void>;
}

export type ProvisioningResolution =
  | { status: 'pending' | 'denied' | 'expired'; request: ProvisioningRequestRecord }
  | { status: 'approved'; request: ProvisioningRequestRecord; node: NodeRegistration };

/** Repository owns each transaction and reconciles uncertain commits by stable request/node IDs. */
export interface ProvisioningRepository {
  findRequest(requestId: string): Promise<ProvisioningRequestRecord | null>;
  findRequestByNodeUid(uid: string): Promise<ProvisioningRequestRecord | null>;
  findNode(uid: string): Promise<NodeRegistration | null>;
  reconcile(requestId: string, uid: string): Promise<ProvisioningResolution | null>;
  transaction<T>(work: (transaction: ProvisioningTransaction) => Promise<T>): Promise<T>;
}
