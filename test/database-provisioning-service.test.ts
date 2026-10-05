import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRegistry } from '../src/edge/registry.js';
import { DatabaseProvisioningService } from '../src/modules/provisioning/application/database-provisioning-service.js';
import { ApplicationError } from '../src/modules/shared/application/contracts.js';
import type {
  NodeRegistration, ProvisioningRepository, ProvisioningRequestRecord, ProvisioningResolution, ProvisioningTransaction,
} from '../src/modules/provisioning/repositories/provisioning-repository.js';
import { nodesJson, siteJson } from './fixtures.js';

const TOKEN = 't'.repeat(32);
const UID = '30:ed:a0:11:22:33';

class MemoryProvisioningRepository implements ProvisioningRepository {
  requestsById = new Map<string, ProvisioningRequestRecord>();
  nodes = new Map<string, NodeRegistration>();
  audits: Array<{ action: string; subjectId: string }> = [];
  failAfterCommit = false;
  unavailable = false;

  async findRequest(id: string) { return structuredClone(this.requestsById.get(id) ?? null); }
  async findRequestByNodeUid(uid: string) {
    return [...this.requestsById.values()].find((request) => request.uid === uid && request.status === 'pending') ?? null;
  }
  async listPendingRequests() {
    return [...this.requestsById.values()].filter((request) => request.status === 'pending').map((request) => structuredClone(request));
  }
  async findNode(uid: string) { return structuredClone(this.nodes.get(uid) ?? null); }
  async reconcile(id: string, uid: string): Promise<ProvisioningResolution | null> {
    const request = this.requestsById.get(id);
    if (!request || request.uid !== uid) return null;
    if (request.status !== 'approved') return { status: request.status, request: structuredClone(request) };
    const node = this.nodes.get(uid);
    return node && request.registeredUid === uid
      ? { status: 'approved', request: structuredClone(request), node: structuredClone(node) }
      : null;
  }
  async transaction<T>(work: (tx: ProvisioningTransaction) => Promise<T>): Promise<T> {
    if (this.unavailable) throw new Error('database unavailable');
    const requests = structuredClone(this.requestsById);
    const nodes = structuredClone(this.nodes);
    const audits = structuredClone(this.audits);
    const tx: ProvisioningTransaction = {
      findRequestForUpdate: async (id) => structuredClone(requests.get(id) ?? null),
      lockPendingQueue: async () => {},
      countPendingRequests: async () => [...requests.values()].filter((r) => r.status === 'pending').length,
      findExpiredPendingRequestsForUpdate: async (at) => [...requests.values()]
        .filter((r) => r.status === 'pending' && r.expiresAt <= at).map((r) => structuredClone(r)),
      findPendingRequestByNodeUid: async (uid) => [...requests.values()]
        .find((r) => r.uid === uid && r.status === 'pending') ?? null,
      findNode: async (uid) => structuredClone(nodes.get(uid) ?? null),
      saveRequest: async (request) => { requests.set(request.id, structuredClone(request)); },
      registerNode: async (node) => { if (nodes.has(node.uid)) throw new Error('duplicate node'); nodes.set(node.uid, structuredClone(node)); },
      appendAudit: async (event) => { audits.push({ action: event.action, subjectId: event.subjectId }); },
    };
    const result = await work(tx);
    this.requestsById = requests;
    this.nodes = nodes;
    this.audits = audits;
    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new Error('connection lost after commit');
    }
    return result;
  }
}

function setup() {
  let now = 1_800_000_000_000;
  const repository = new MemoryProvisioningRepository();
  const registry = buildRegistry(siteJson(), nodesJson());
  const service = new DatabaseProvisioningService(repository, registry, { token: TOKEN, now: () => now });
  return { repository, registry, service, advance: (ms: number) => { now += ms; } };
}

test('database provisioning requires its token and queues a durable request', async () => {
  const { repository, registry, service } = setup();
  assert.equal(service.authorize(TOKEN), true);
  assert.equal(service.authorize(null), false);
  const result = await service.request({ uid: UID, label: 'Hall sensor', firmware: 'v1.2' }, '127.0.0.1');
  assert.equal(result.status, 'pending');
  assert.equal(registry.nodes.has(UID), false, 'request alone does not activate the identity');
  assert.equal((await service.statusOf(UID)), 'pending');
  assert.equal(repository.audits[0]?.action, 'request.created');
});

test('approval commits node, request, and audit before activating an unplaced node', async () => {
  const { repository, registry, service } = setup();
  const request = await service.request({ uid: UID, label: 'Hall sensor' }, '127.0.0.1');
  assert.equal(request.status, 'pending');
  const node = await service.approve(request.request.id, 'console');
  assert.equal(node.uid, UID);
  assert.deepEqual(repository.audits.map((event) => event.action), ['request.created', 'request.approved']);
  assert.equal(registry.nodes.get(UID)?.floorId, null);
  assert.equal(registry.nodes.get(UID)?.pose, null);
  assert.deepEqual(registry.nodes.get(UID)?.owns, []);
  assert.equal(await service.statusOf(UID), 'registered');
  assert.equal((await service.approve(request.request.id, 'console')).uid, UID, 'retry returns the committed identity');
  assert.equal(repository.audits.filter((event) => event.action === 'request.approved').length, 1, 'retry does not duplicate audit');
});

test('expired requests are durable and can be retried as a new request', async () => {
  const { repository, service, advance } = setup();
  const first = await service.request({ uid: UID }, '127.0.0.1');
  assert.equal(first.status, 'pending');
  advance(31 * 60_000);
  assert.equal(await service.statusOf(UID), 'unknown');
  assert.ok([...repository.requestsById.values()].some((request) => request.status === 'expired'));
  const second = await service.request({ uid: UID }, '127.0.0.1');
  assert.equal(second.status, 'pending');
  if (second.status === 'pending') assert.notEqual(second.request.id, first.request.id);
});

test('attempting to approve an expired request commits its expiry before rejecting', async () => {
  const { repository, service, advance } = setup();
  const pending = await service.request({ uid: UID }, '127.0.0.1');
  assert.equal(pending.status, 'pending');
  advance(31 * 60_000);
  await assert.rejects(service.approve(pending.request.id, 'console'), /expired/);
  assert.equal(repository.requestsById.get(pending.request.id)?.status, 'expired');
  assert.equal(repository.audits.filter((event) => event.action === 'request.expired').length, 1);
});

test('an approval whose commit acknowledgement is lost is reconciled and activated once', async () => {
  const { repository, registry, service } = setup();
  const request = await service.request({ uid: UID }, '127.0.0.1');
  assert.equal(request.status, 'pending');
  repository.failAfterCommit = true;
  const node = await service.approve(request.request.id, 'console');
  assert.equal(node.uid, UID);
  assert.equal([...registry.nodes.keys()].filter((uid) => uid === UID).length, 1);
  assert.equal(repository.audits.filter((event) => event.action === 'request.approved').length, 1);
});

test('a database outage rejects approval without activating the identity', async () => {
  const { repository, registry, service } = setup();
  const request = await service.request({ uid: UID }, '127.0.0.1');
  assert.equal(request.status, 'pending');
  repository.unavailable = true;
  await assert.rejects(service.approve(request.request.id, 'console'), (error: unknown) => {
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.kind, 'unavailable');
    assert.equal(error.message, 'provisioning storage is unavailable');
    return true;
  });
  assert.equal(registry.nodes.has(UID), false, 'the live registry stays on its last committed view');
});

test('database provisioning preserves validation, missing-request, and resolved-request conflict categories', async () => {
  const { service } = setup();
  const hasKind = (kind: ApplicationError['kind']) => (error: unknown): boolean => {
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.kind, kind);
    return true;
  };
  await assert.rejects(service.request({ uid: 'invalid' }, 'localhost'), hasKind('validation'));
  await assert.rejects(service.approve('missing', 'console'), hasKind('not-found'));
  await assert.rejects(service.deny('missing', 'console'), hasKind('not-found'));
  const pending = await service.request({ uid: UID }, 'localhost');
  assert.equal(pending.status, 'pending');
  await service.deny(pending.request.id, 'console');
  await assert.rejects(service.approve(pending.request.id, 'console'), hasKind('conflict'));
});

test('request and denial with lost commit acknowledgement still reconcile their durable results', async () => {
  const { repository, service } = setup();
  repository.failAfterCommit = true;
  const pending = await service.request({ uid: UID }, 'localhost');
  assert.equal(pending.status, 'pending');
  assert.equal(repository.requestsById.get(pending.request.id)?.status, 'pending');
  repository.failAfterCommit = true;
  const denied = await service.deny(pending.request.id, 'console');
  assert.equal(denied.uid, UID);
  assert.equal(repository.requestsById.get(pending.request.id)?.status, 'denied');
  assert.deepEqual(repository.audits.map((event) => event.action), ['request.created', 'request.denied']);
});
