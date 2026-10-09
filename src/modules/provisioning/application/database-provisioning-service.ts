import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NodeDef, Registry } from '../../../edge/registry.js';
import { ApplicationError } from '../../shared/application/contracts.js';
import type {
  JoinRequestResult, JoinRequestView, ProvisionedNodeView, ProvisioningService,
} from './provisioning-service.js';
import type {
  NodeRegistration, ProvisioningRepository, ProvisioningRequestRecord, ProvisioningTransaction,
} from '../repositories/provisioning-repository.js';
import { MAX_PENDING, REQUEST_TTL_MS } from '../domain/provisioning-policy.js';
const UID_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const LABEL_RE = /^[\w .,'()/-]{1,60}$/;

export interface DatabaseProvisioningOptions {
  token: string | null;
  now?: () => number;
  requestId?: () => string;
}

/** PostgreSQL-authoritative provisioning; durable changes precede live activation. */
export class DatabaseProvisioningService implements ProvisioningService {
  private readonly now: () => number;
  private readonly requestId: () => string;

  constructor(
    private readonly repository: ProvisioningRepository,
    private readonly registry: Registry,
    private readonly options: DatabaseProvisioningOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.requestId = options.requestId ?? randomUUID;
  }

  get enabled(): boolean { return this.options.token !== null; }

  authorize(token: string | null): boolean {
    const expected = this.options.token;
    if (expected === null || token === null) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async ready(): Promise<void> { await this.requests(); }

  async request(input: unknown, from: string): Promise<JoinRequestResult> {
    const normalized = validateRequest(input);
    const id = this.requestId();
    const now = this.now();
    try {
      return await this.repository.transaction(async (tx) => {
        await tx.lockPendingQueue();
        await expirePending(tx, now);
        if (await tx.findNode(normalized.uid)) return { status: 'already-registered', uid: normalized.uid };
        const existing = await tx.findPendingRequestByNodeUid(normalized.uid);
        if (existing) return { status: 'pending', request: toView(existing) };
        // The pending-row lock above can wait behind a concurrent approval.
        // Recheck registration after that wait before creating a fresh request.
        if (await tx.findNode(normalized.uid)) return { status: 'already-registered', uid: normalized.uid };
        if (await tx.countPendingRequests() >= MAX_PENDING) {
          throw new ApplicationError('conflict', 'too many requests are already waiting for an answer');
        }
        const request: ProvisioningRequestRecord = {
          id, uid: normalized.uid, label: normalized.label || normalized.uid, firmware: normalized.firmware,
          requestedBy: from, requestedAt: now, expiresAt: now + REQUEST_TTL_MS,
          status: 'pending', resolvedAt: null, resolvedBy: null, registeredUid: null,
        };
        await tx.saveRequest(request);
        await tx.appendAudit({ actor: { id: from, kind: 'system' }, action: 'request.created', subjectId: id, at: now });
        return { status: 'pending', request: toView(request) };
      });
    } catch (error) {
      const committed = await this.repository.findRequest(id).catch(() => null);
      if (committed?.status === 'pending' && committed.uid === normalized.uid) {
        return { status: 'pending', request: toView(committed) };
      }
      if (committed?.status === 'approved' && committed.registeredUid === normalized.uid) {
        return { status: 'already-registered', uid: normalized.uid };
      }
      const registered = await this.repository.findNode(normalized.uid).catch(() => null);
      if (registered) return { status: 'already-registered', uid: normalized.uid };
      const concurrentRequest = await this.repository.findRequestByNodeUid(normalized.uid).catch(() => null);
      if (concurrentRequest && concurrentRequest.expiresAt > this.now()) {
        return { status: 'pending', request: toView(concurrentRequest) };
      }
      throw provisioningError(error);
    }
  }

  async statusOf(uid: string): Promise<'registered' | 'pending' | 'unknown'> {
    try {
      const normalized = uid.toLowerCase();
      if (await this.repository.findNode(normalized)) return 'registered';
      const request = await this.repository.findRequestByNodeUid(normalized);
      if (!request) return 'unknown';
      if (request.expiresAt <= this.now()) {
        await this.repository.transaction((tx) => expirePending(tx, this.now()));
        return 'unknown';
      }
      return 'pending';
    } catch (error) {
      throw provisioningError(error);
    }
  }

  async requests(): Promise<JoinRequestView[]> {
    try {
      await this.repository.transaction((tx) => expirePending(tx, this.now()));
      return (await this.repository.listPendingRequests()).map(toView);
    } catch (error) {
      throw provisioningError(error);
    }
  }

  async approve(id: string, actor: string): Promise<ProvisionedNodeView> {
    const at = this.now();
    let node: NodeRegistration;
    let targetUid: string | null = null;
    try {
      const outcome = await this.repository.transaction(async (tx) => {
        const request = await tx.findRequestForUpdate(id);
        if (!request) throw new ApplicationError('not-found', 'no such request (it may have expired)');
        targetUid = request.uid;
        if (request.status === 'approved' && request.registeredUid === request.uid) {
          const registered = await tx.findNode(request.uid);
          if (registered) return { kind: 'approved' as const, node: registered };
          throw new ApplicationError('conflict', 'approved request has no matching registered node');
        }
        if (request.status !== 'pending') throw new ApplicationError('conflict', 'request is no longer pending');
        if (request.expiresAt <= at) {
          await expireOne(tx, request, at);
          return { kind: 'expired' as const };
        }
        if (await tx.findNode(request.uid)) throw new ApplicationError('conflict', `${request.uid} is already registered`);
        const registered: NodeRegistration = {
          uid: request.uid, label: request.label, floorId: null, pose: null, owns: [],
        };
        await tx.registerNode(registered);
        await tx.saveRequest({
          ...request, status: 'approved', resolvedAt: at,
          resolvedBy: { id: actor, kind: 'console' }, registeredUid: request.uid,
        });
        await tx.appendAudit({ actor: { id: actor, kind: 'console' }, action: 'request.approved', subjectId: id, at });
        return { kind: 'approved' as const, node: registered };
      });
      if (outcome.kind === 'expired') throw new ApplicationError('conflict', 'no such request (it may have expired)');
      node = outcome.node;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      const reconciled = targetUid ? await this.repository.reconcile(id, targetUid).catch(() => null) : null;
      if (!reconciled || reconciled.status !== 'approved') throw provisioningError(error);
      node = reconciled.node;
    }
    try {
      this.activate(node);
    } catch (error) {
      const reconciled = await this.repository.reconcile(id, node.uid).catch(() => null);
      if (!reconciled || reconciled.status !== 'approved' || reconciled.node.label !== node.label) throw provisioningError(error);
      try {
        this.activate(reconciled.node);
      } catch {
        throw new ApplicationError('unavailable', `approval ${id} committed but live registry activation requires reconciliation`);
      }
      node = reconciled.node;
    }
    return toProvisionedNode(node);
  }

  async deny(id: string, actor: string): Promise<JoinRequestView> {
    const at = this.now();
    let result: JoinRequestView;
    try {
      let expired = false;
      result = await this.repository.transaction(async (tx) => {
        const request = await tx.findRequestForUpdate(id);
        if (!request) throw new ApplicationError('not-found', 'no such request (it may have expired)');
        if (request.status === 'denied') return toView(request);
        if (request.status !== 'pending') throw new ApplicationError('conflict', 'request is no longer pending');
        if (request.expiresAt <= at) {
          await expireOne(tx, request, at);
          expired = true;
          return toView({ ...request, status: 'expired', resolvedAt: at });
        }
        const denied = { ...request, status: 'denied' as const, resolvedAt: at, resolvedBy: { id: actor, kind: 'console' as const } };
        await tx.saveRequest(denied);
        await tx.appendAudit({ actor: { id: actor, kind: 'console' }, action: 'request.denied', subjectId: id, at });
        return toView(denied);
      });
      if (expired) throw new ApplicationError('conflict', 'no such request (it may have expired)');
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      const reconciled = await this.repository.findRequest(id).catch(() => null);
      if (reconciled?.status !== 'denied') throw provisioningError(error);
      result = toView(reconciled);
    }
    return result;
  }

  private activate(node: NodeRegistration): void {
    const current = this.registry.nodes.get(node.uid);
    if (current) {
      if (current.label !== node.label || current.floorId !== null || current.pose !== null || current.owns.length !== 0) {
        throw new ApplicationError('conflict', `cannot activate ${node.uid}: live registration differs from committed identity`);
      }
      return;
    }
    const definition: NodeDef = {
      uid: node.uid, label: node.label, floorId: null, pose: null,
      owns: [], simulated: false, rgb: false,
    };
    this.registry.nodes.set(definition.uid, definition);
  }
}

function provisioningError(error: unknown): ApplicationError {
  return error instanceof ApplicationError
    ? error
    : new ApplicationError('unavailable', 'provisioning storage is unavailable');
}

async function expirePending(tx: ProvisioningTransaction, at: number): Promise<void> {
  for (const request of await tx.findExpiredPendingRequestsForUpdate(at)) await expireOne(tx, request, at);
}

async function expireOne(tx: ProvisioningTransaction, request: ProvisioningRequestRecord, at: number): Promise<void> {
  await tx.saveRequest({
    ...request, status: 'expired', resolvedAt: at, resolvedBy: { id: 'system-expiry', kind: 'system' },
  });
  await tx.appendAudit({
    actor: { id: 'system-expiry', kind: 'system' }, action: 'request.expired', subjectId: request.id, at,
  });
}

function validateRequest(input: unknown): { uid: string; label: string; firmware: string | null } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApplicationError('validation', 'request body must be an object');
  }
  const body = input as { uid?: unknown; label?: unknown; firmware?: unknown };
  const uid = String(body.uid ?? '').toLowerCase().trim();
  if (!UID_RE.test(uid)) throw new ApplicationError('validation', 'uid must be a MAC like 30:ed:a0:cb:f5:f8');
  const label = String(body.label ?? '').trim();
  if (label && !LABEL_RE.test(label)) throw new ApplicationError('validation', "label may only contain letters, digits and . , ' ( ) / -");
  return { uid, label, firmware: String(body.firmware ?? '').trim().slice(0, 40) || null };
}

function toView(request: ProvisioningRequestRecord): JoinRequestView {
  return {
    id: request.id, uid: request.uid, label: request.label, firmware: request.firmware,
    from: request.requestedBy, at: request.requestedAt, expiresAt: request.expiresAt,
  };
}

function toProvisionedNode(node: NodeRegistration): ProvisionedNodeView {
  return { uid: node.uid, label: node.label, floorId: null, pose: null, owns: [], rgb: false };
}
