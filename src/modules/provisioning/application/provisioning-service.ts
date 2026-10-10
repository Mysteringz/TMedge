export interface JoinRequestView {
  id: string;
  uid: string;
  label: string;
  firmware: string | null;
  from: string;
  at: number;
  expiresAt: number;
}

export interface ProvisionedNodeView {
  uid: string;
  label: string;
  floorId: null;
  pose: null;
  owns: readonly string[];
  rgb: false;
}

export type JoinRequestResult =
  | { status: 'pending'; request: JoinRequestView }
  | { status: 'already-registered'; uid: string };

/** Async application boundary for provisioning and its current file adapter. */
export interface ProvisioningService {
  readonly enabled: boolean;
  authorize(token: string | null): boolean;
  /** Checks authoritative storage without admitting an identity. */
  ready(): Promise<void>;
  request(input: unknown, from: string): Promise<JoinRequestResult>;
  statusOf(uid: string): Promise<'registered' | 'pending' | 'unknown'>;
  requests(): Promise<JoinRequestView[]>;
  approve(id: string, actor: string): Promise<ProvisionedNodeView>;
  deny(id: string, actor: string): Promise<JoinRequestView>;
}
