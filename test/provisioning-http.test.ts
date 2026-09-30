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
import { createProvisioningAdminRouter, createProvisioningToolRouter } from '../src/modules/provisioning/routes/provisioning-routers.js';
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
      method: 'POST', headers: { ...adminHeaders, 'x-tm-console': '1' },
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
