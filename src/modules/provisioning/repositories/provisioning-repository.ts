import type { Actor } from '../../shared/application/contracts.js';
import type { NodePose } from '../../../shared/types.js';

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
  floorId: string | null;
  pose: NodePose | null;
  owns: readonly string[];
  simulated: boolean;
  rgb: boolean;
  detector: 'node' | 'edge';
}

/** The records changed together when a provisioning decision is committed. */
export interface ProvisioningTransaction {
  /** Lock the request row until this transaction finishes. */
  findRequestForUpdate(requestId: string): Promise<ProvisioningRequestRecord | null>;
  /** Serialize new requests so the global pending limit is preserved across processes. */
  lockPendingQueue(): Promise<void>;
  countPendingRequests(): Promise<number>;
  findExpiredPendingRequestsForUpdate(at: number): Promise<ProvisioningRequestRecord[]>;
  findPendingRequestByNodeUid(uid: string): Promise<ProvisioningRequestRecord | null>;
  findNode(uid: string): Promise<NodeRegistration | null>;
  saveRequest(request: ProvisioningRequestRecord): Promise<void>;
  registerNode(node: NodeRegistration): Promise<void>;
  appendAudit(event: { actor: Actor; action: string; subjectId: string; at: number }): Promise<void>;
}

export type ProvisioningResolution =
  | { status: 'pending' | 'denied' | 'expired'; request: ProvisioningRequestRecord }
  | { status: 'approved'; request: ProvisioningRequestRecord; node: NodeRegistration };

export type ApprovalCommitResolution =
  | { kind: 'committed'; request: ProvisioningRequestRecord; node: NodeRegistration; registryRevision: number }
  | { kind: 'not-committed'; registryRevision: number }
  | { kind: 'unknown' };

/** Repository owns transactions and exposes stable-identity reconciliation for uncertain commits. */
export interface ProvisioningRepository {
  findRequest(requestId: string): Promise<ProvisioningRequestRecord | null>;
  findRequestByNodeUid(uid: string): Promise<ProvisioningRequestRecord | null>;
  listPendingRequests(): Promise<ProvisioningRequestRecord[]>;
  findNode(uid: string): Promise<NodeRegistration | null>;
  reconcile(requestId: string, uid: string): Promise<ProvisioningResolution | null>;
  /** Reconciles an uncertain approval COMMIT against the exact candidate and global revision. */
  registryRevision(): Promise<number>;
  reconcileApproval(
    expectedRequest: ProvisioningRequestRecord,
    expectedResolution: { resolvedAt: number; resolvedBy: Actor },
    expectedNode: NodeRegistration,
    expectedBaseRevision: number,
  ): Promise<ApprovalCommitResolution>;
  transaction<T>(work: (transaction: ProvisioningTransaction) => Promise<T>): Promise<T>;
}
