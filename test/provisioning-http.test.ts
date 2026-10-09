import assert from 'node:assert/strict';
import express, { type RequestHandler } from 'express';
import { createServer, type Server } from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applicationErrorHandler } from '../src/infrastructure/http/errors.js';
import { FileProvisioningService } from '../src/infrastructure/provisioning/file-provisioning-service.js';
import { createProvisioningAdminRouter, createProvisioningToolRouter, pairingCode } from '../src/modules/provisioning/routes/provisioning-routers.js';
import { DatabaseProvisioningService } from '../src/modules/provisioning/application/database-provisioning-service.js';
import type { ProvisioningService } from '../src/modules/provisioning/application/provisioning-service.js';
import type { ProvisioningRepository } from '../src/modules/provisioning/repositories/provisioning-repository.js';
import { Provisioning } from '../src/edge/provisioning.js';
import { buildRegistry } from '../src/edge/registry.js';
import { nodesJson, siteJson } from './fixtures.js';

const TOKEN = 'p'.repeat(32);
const UID = '30:ed:a0:11:22:33';

test('provisioning routes preserve token/admin guards and persist before admission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmedge-provision-http-'));
  const nodesPath = join(dir, 'nodes.json');
  writeFileSync(nodesPath, JSON.stringify(nodesJson()));
  const service = new FileProvisioningService(new Provisioning(buildRegistry(siteJson(), nodesJson()), {
    token: TOKEN, nodesPath, auditPath: join(dir, 'audit.jsonl'),
  }));
  const events: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/provision', createProvisioningToolRouter({ service, broadcast: (event) => events.push(event) }));
  const admin: RequestHandler = (req, res, next) => req.get('authorization') === `Basic ${Buffer.from('admin:secret').toString('base64')}`
    ? next()
    : res.status(401).send('authentication required');
  const mutating: RequestHandler = (req, res, next) => req.get('x-tm-console') === '1'
    ? next()
    : res.status(403).json({ error: 'missing x-tm-console header' });
  app.use('/api/provision', admin, createProvisioningAdminRouter({ service, mutating, broadcast: (event) => events.push(event) }));
  app.use(applicationErrorHandler);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const adminHeaders = { authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` };
  try {
    const denied = await fetch(`${base}/api/provision/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: UID }) });
    assert.equal(denied.status, 401);

    for (const authorization of [`Bearer ${TOKEN} extra`, `Bearer ${TOKEN},other`, `Bearer wrong`, `Basic ${TOKEN}`]) {
      const response = await fetch(`${base}/api/provision/status/${UID}`, { headers: { authorization } });
      assert.equal(response.status, 401, 'a malformed or incorrect bearer credential must not authorize polling');
      const request = await fetch(`${base}/api/provision/request`, {
        method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ uid: UID }),
      });
      assert.equal(request.status, 401, 'a malformed credential must not queue a join request');
    }
    assert.deepEqual(events, [], 'rejected credentials have no side effects');
    const invalidUID = await fetch(`${base}/api/provision/status/not-a-mac`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(invalidUID.status, 400);

    const queued = await fetch(`${base}/api/provision/request`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ uid: UID, label: 'Lab node' }),
    });
    assert.equal(queued.status, 202);
    const queuedBody = await queued.json() as { id: string; status: string };
    assert.equal(queuedBody.status, 'pending');

    const status = await fetch(`${base}/api/provision/status/${encodeURIComponent(UID)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.deepEqual(await status.json(), { uid: UID, status: 'pending' });
    assert.equal((await fetch(`${base}/api/provision/requests`)).status, 401);
    assert.equal((await fetch(`${base}/api/provision/requests`, { headers: adminHeaders })).status, 200);

    const blocked = await fetch(`${base}/api/provision/requests/${queuedBody.id}/approve`, { method: 'POST', headers: adminHeaders });
    assert.equal(blocked.status, 403);
    const admitted = await fetch(`${base}/api/provision/requests/${queuedBody.id}/approve`, {
      method: 'POST', headers: { ...adminHeaders, 'x-tm-console': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ uid: UID, pairingCode: pairingCode(queuedBody.id) }),
    });
    assert.equal(admitted.status, 200);
    assert.deepEqual(await admitted.json(), { ok: true, uid: UID, label: 'Lab node', placed: false });
    const persisted = JSON.parse(readFileSync(nodesPath, 'utf8')) as { nodes: { uid: string; label?: string }[] };
    assert.ok(persisted.nodes.some((node) => node.uid === UID && node.label === 'Lab node'));
    assert.equal(events.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('database provisioning outages return safe 503 errors for tool and admin operations', async () => {
  const secret = 'password=private-secret query=SELECT * FROM private_table host=internal-db';
  const outage = async (): Promise<never> => { throw new Error(secret); };
  const repository: ProvisioningRepository = {
    transaction: outage, findRequest: outage, findRequestByNodeUid: outage,
    findNode: outage, listPendingRequests: outage, reconcile: outage,
  };
  const service = new DatabaseProvisioningService(repository, buildRegistry(siteJson(), nodesJson()), { token: TOKEN });
  await withRoutes(service, async (base, events) => {
    const requests: Array<{ path: string; method: string; body?: string }> = [
      { path: '/request', method: 'POST', body: JSON.stringify({ uid: UID }) },
      { path: '/status/' + encodeURIComponent(UID), method: 'GET' },
      { path: '/requests', method: 'GET' },
      { path: '/requests/00000000-0000-4000-8000-000000000001/approve', method: 'POST' },
      { path: '/requests/00000000-0000-4000-8000-000000000001/deny', method: 'POST' },
    ];
    for (const request of requests) {
      const response = await fetch(base + request.path, {
        method: request.method, body: request.body,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      });
      assert.equal(response.status, 503, request.path);
      assert.deepEqual(await response.json(), { error: 'provisioning storage is unavailable' });
    }
    assert.deepEqual(events, []);
  });
});

test('file provisioning preserves typed validation and missing-request responses and redacts storage failures', async () => {
  const registry = buildRegistry(siteJson(), nodesJson());
  const dir = mkdtempSync(join(tmpdir(), 'tmedge-provision-http-errors-'));
  const service = new FileProvisioningService(new Provisioning(registry, {
    token: TOKEN, nodesPath: join(dir, 'private-missing-nodes.json'), auditPath: join(dir, 'audit.jsonl'),
  }));
  await withRoutes(service, async (base, events) => {
    const request = (body: unknown) => fetch(base + '/request', {
      method: 'POST', body: JSON.stringify(body),
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    });
    const invalid = await request({ uid: 'invalid' });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json() as { error: string }).error, /uid must be a MAC/);
    for (const verdict of ['approve', 'deny']) {
      const missing = await fetch(base + '/requests/missing/' + verdict, { method: 'POST' });
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: 'no such request (it may have expired)' });
    }
    const queued = await request({ uid: UID });
    assert.equal(queued.status, 202);
    const pending = await queued.json() as { id: string };
    const confirmation = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: UID, pairingCode: pairingCode(pending.id) }) };
    const failed = await fetch(base + '/requests/' + pending.id + '/approve', confirmation);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'provisioning storage is unavailable' });
    assert.equal(registry.nodes.has(UID), false);
    registry.nodes.set(UID, { uid: UID, label: 'Concurrent admission', floorId: null, pose: null, owns: [], simulated: false, rgb: false });
    const conflict = await fetch(base + '/requests/' + pending.id + '/approve', confirmation);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: `${UID} is already registered` });
    assert.equal(events.length, 1, 'failed mutations do not broadcast resolution');
  });
});

async function withRoutes(service: ProvisioningService, work: (base: string, events: unknown[]) => Promise<void>): Promise<void> {
  const events: unknown[] = [];
  const broadcast = (event: unknown): void => { events.push(event); };
  const app = express();
  app.use(express.json());
  app.use('/api/provision', createProvisioningToolRouter({ service, broadcast }));
  app.use('/api/provision', createProvisioningAdminRouter({ service, broadcast, mutating: (_req, _res, next) => next() }));
  app.use(applicationErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await work(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/provision`, events);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
