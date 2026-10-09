import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { Socket } from 'node:net';
import { IncomingMessage } from 'node:http';
import { createECDH } from 'node:crypto';
import express from 'express';
import { existsSync } from 'node:fs';
import { HpcService } from '../src/algo/train/hpc/service.js';
import { parseHpcConfig } from '../src/algo/train/config.js';
import { JobStore, ProfileStore } from '../src/algo/train/store.js';
import { Gateway, type GatewayDeps, type GatewayConfig } from '../src/algo/train/hpc/gateway.js';
import { Credentials } from '../src/algo/train/hpc/sealed.js';
import { packCredentials, sealCredentials } from '../src/shared/hpcseal.js';
import type { SealTicket } from '../src/shared/hpcseal.js';
import { AlgoUsers, createAlgoAuth, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { createTrain } from '../src/algo/train/routes.js';
import { DurableCommandOutcomes } from '../src/modules/nodes/application/durable-command-outcomes.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const config: GatewayConfig = { vpnHost: 'vpn.example', vpnServerCert: null, vpnAuthGroup: null, submitHost: 'hpc.example', sshUser: null, knownHosts: '/unused', runDir: '/unused', idleTtlMs: 600000, maxSessions: 2, ports: [21000, 21003], tools: { openconnect: 'unused', ocproxy: 'unused', ssh: 'unused' } };
function fakeDeps() {
  const counts = { tunnel: 0, ssh: 0, closed: 0, pinned: 0 };
  const deps: GatewayDeps = {
    now: Date.now, portFree: async () => true,
    authenticate: async () => ({ cookie: Buffer.from('cookie'), connectUrl: 'https://vpn.example/', fingerprint: 'pin-sha256:A', resolve: null }),
    connectTunnel: async (options) => { counts.tunnel++; return { pid: 1, port: options.port, closed: new Promise(() => undefined), close: async () => { counts.closed++; } }; },
    hostKeys: { isPinned: () => true, scan: async () => [], pin: () => { counts.pinned++; } },
    ssh: () => { counts.ssh++; let alive = false; return { get alive() { return alive; }, open: async () => { alive = true; }, close: async () => { alive = false; }, run: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }), shellCommand: () => ({ bin: 'unused', args: [], home: 'unused', target: 'unused' }) }; },
  };
  return { deps, counts };
}

test('revocation during VPN authentication cannot create a detached tunnel or SSH session', async () => {
  const { deps, counts } = fakeDeps(), begun = deferred<void>(), resume = deferred<void>();
  const cookie = Buffer.from('secret-cookie');
  deps.authenticate = async () => { begun.resolve(); await resume.promise; return { cookie, connectUrl: 'https://vpn.example/', fingerprint: 'pin-sha256:A', resolve: null }; };
  const gateway = new Gateway(config, deps);
  const credentials = new Credentials(Buffer.from(packCredentials(Buffer.from('pin'), Buffer.from('123456'))));
  let valid = true;
  const opening = gateway.open('alice', 'hku', 'hku@hku.hk', credentials, { authorized: () => valid });
  const failed = assert.rejects(opening, /session ended/);
  await begun.promise; valid = false; await gateway.close('alice'); resume.resolve(); await failed;
  assert.equal(counts.tunnel, 0); assert.equal(counts.ssh, 0); assert.equal(counts.pinned, 0);
  assert.ok(cookie.every((byte) => byte === 0)); assert.equal(gateway.info('alice').state, 'none'); credentials.wipe();
});

test('revocation while creating a tunnel cleans the detached resource', async () => {
  const { deps, counts } = fakeDeps(), begun = deferred<void>(), resume = deferred<void>();
  const original = deps.connectTunnel;
  deps.connectTunnel = async (options) => { begun.resolve(); await resume.promise; return original(options); };
  const gateway = new Gateway(config, deps), credentials = new Credentials(Buffer.from(packCredentials(Buffer.from('pin'), Buffer.from('123456'))));
  let valid = true;
  const opening = gateway.open('alice', 'hku', 'hku@hku.hk', credentials, { authorized: () => valid });
  const failed = assert.rejects(opening, /session ended/);
  await begun.promise; valid = false; await gateway.close('alice'); resume.resolve(); await failed;
  assert.equal(counts.closed, 1); assert.equal(counts.ssh, 0); credentials.wipe();
});

test('privileged node dispatch rechecks authority after durable intent finishes', async () => {
  const recorded = deferred<void>(), resume = deferred<void>(); let valid = true, dispatches = 0;
  const outcomes: string[] = [];
  const service = new DurableCommandOutcomes({ record: async (event) => { outcomes.push(event.outcome); if (event.outcome === 'requested') { recorded.resolve(); await resume.promise; } } }, async () => { dispatches++; return 1; });
  const sending = service.send({ uid: '0000000000000001', opcode: 2, argument: 0, value: 0 }, { id: 'alice', kind: 'console' }, () => valid);
  const failed = assert.rejects(sending, /access changed/);
  await recorded.promise; valid = false; resume.resolve(); await failed;
  assert.equal(dispatches, 0); assert.deepEqual(outcomes, ['requested', 'uncertain']); await service.dispose();
});

test('revoking only the initiating cookie after gateway acquisition cleans its new session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-acquired-')), { deps, counts } = fakeDeps();
  const configuration = parseHpcConfig({ verified: false, backend: 'vpn-ssh', partitions: [{ name: 'cpu', maxTime: '1:00:00', gpu: false }], defaultPartition: 'cpu', modules: [], planA: { vpnHost: 'vpn.example', vpnDomains: ['hku.hk'], submitHost: 'hpc.example', idleTtlSeconds: 600, maxSessions: 2, socksPorts: [21000, 21003] } });
  const profiles = new ProfileStore(root); profiles.set('alice', { hkuUid: 'hku', vpnDomain: 'hku.hk' });
  const service = new HpcService(configuration, new JobStore(root), profiles, root, deps);
  const operation = service.ops.create('alice', null, 'connect'); let initiatingCookieValid = true;
  service.authorized = () => true; // Another browser remains authorized.
  service.bindAuthority(operation, () => initiatingCookieValid);
  const gateway = service.gateway!, original = gateway.open.bind(gateway);
  gateway.open = async (...args: Parameters<Gateway['open']>) => { const session = await original(...args); initiatingCookieValid = false; return session; };
  const credentials = new Credentials(Buffer.from(packCredentials(Buffer.from('pin'), Buffer.from('123456'))));
  await service.connect(operation, credentials, false);
  assert.equal(operation.events.at(-1)?.type, 'error'); assert.equal(gateway.info('alice').state, 'none');
  assert.equal(counts.closed, 1); assert.equal(credentials.wiped, true); await service.stop();
});

test('revocation during fingerprint hashing cannot persist a fingerprint or report connected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-fingerprint-')), { deps, counts } = fakeDeps();
  const configuration = parseHpcConfig({ verified: false, backend: 'vpn-ssh', partitions: [{ name: 'cpu', maxTime: '1:00:00', gpu: false }], defaultPartition: 'cpu', modules: [], planA: { vpnHost: 'vpn.example', vpnDomains: ['hku.hk'], submitHost: 'hpc.example', sshAuth: 'shared-password', sshUser: 'shared', idleTtlSeconds: 600, maxSessions: 2, socksPorts: [21000, 21003] } });
  const profiles = new ProfileStore(root); profiles.set('alice', { hkuUid: 'hku', vpnDomain: 'hku.hk' });
  const service = new HpcService(configuration, new JobStore(root), profiles, root, deps);
  const operation = service.ops.create('alice', null, 'connect'); let valid = true;
  service.bindAuthority(operation, () => valid);
  operation.subscribe((event) => { if (event.type === 'ssh_up') setImmediate(() => { valid = false; }); });
  const credentials = new Credentials(Buffer.from(packCredentials(Buffer.from('pin'), Buffer.from('123456'), Buffer.from('shared password'))));
  await service.connect(operation, credentials, false);
  assert.equal(operation.events.at(-1)?.type, 'error'); assert.equal(existsSync(service.fingerprintFile), false);
  assert.equal(service.gateway!.info('alice').state, 'none'); assert.equal(counts.closed, 1); assert.equal(credentials.wiped, true); await service.stop();
});

test('a fresh browser identity epoch cannot preserve prior HPC credentials or tickets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-epoch-')), configPath = join(root, 'hpc.json');
  writeFileSync(configPath, JSON.stringify({ verified: false, backend: 'vpn-ssh', partitions: [{ name: 'cpu', maxTime: '1:00:00', gpu: false }], defaultPartition: 'cpu', modules: [], planA: { vpnHost: 'vpn.example', vpnDomains: ['hku.hk'], submitHost: 'hpc.example', idleTtlSeconds: 600, maxSessions: 2, socksPorts: [21000, 21003], tools: {} } }));
  const { deps } = fakeDeps(), usersPath = join(root, 'users.json');
  const users = new AlgoUsers(usersPath); await users.add('alice', 'long epoch password', 'engineer');
  const auth = createAlgoAuth(loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: usersPath }, 'set'));
  let epoch = auth.accountEpoch('alice')!;
  const train = createTrain({ root, configPath, gatewayDeps: deps, mutating: (_req, _res, next) => next(), bindingOf: (req) => req.headers.cookie ?? '', accountEpoch: () => epoch, authorized: (req) => req.headers.cookie === epoch, authenticated: (req) => req.headers.cookie === epoch });
  const app = express(); app.use(express.json()); app.use((_req, res, next) => { res.locals.user = 'alice'; next(); }); app.use('/api/train', train.router);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/train`;
  const request = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: epoch, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const sealed = async () => { const ticket = await (await request('/hpc/ticket', {})).json() as SealTicket; return sealCredentials(ticket, 'connect', null, packCredentials(Buffer.from('pin'), Buffer.from('123456'))); };
  try {
    const credentials = await sealed();
    const response = await request('/hpc/connect', { profile: { hkuUid: 'hku', vpnDomain: 'hku.hk' }, sealed: credentials });
    assert.equal(response.status, 202);
    const operation = await response.json() as { opId: string };
    const stream = await request(`/ops/${operation.opId}/events`); const events = await stream.text(); assert.match(events, /CONNECTED/);
    const oldTicket = await sealed();
    const oldTerminal = await (await request('/hpc/term', {})).json() as { tid: string };
    assert.equal((await (await request('/hpc')).json() as { session: { state: string } }).session.state, 'up');
    users.remove('alice'); await users.add('alice', 'long epoch password', 'engineer');
    const recreatedEpoch = auth.accountEpoch('alice')!; assert.notEqual(recreatedEpoch, epoch); epoch = recreatedEpoch;
    assert.notEqual((await (await request('/hpc')).json() as { session: { state: string } }).session.state, 'up', 'fresh login checked before the sweeper must invalidate old cache');
    assert.equal((await request('/hpc/connect', { sealed: oldTicket })).status, 400, 'old credential ticket is destroyed');
    const begun = deferred<void>(), resume = deferred<void>();
    let heldCredentials: Credentials | null = null;
    deps.authenticate = async (options) => { heldCredentials = options.creds; begun.resolve(); await resume.promise; return { cookie: Buffer.from('cookie'), connectUrl: 'https://vpn.example/', fingerprint: 'pin-sha256:A', resolve: null }; };
    const newCredentials = await sealed();
    const pending = await request('/hpc/connect', { sealed: newCredentials });
    const pendingId = (await pending.json() as { opId: string }).opId;
    await begun.promise;
    const pendingStream = await request(`/ops/${pendingId}/events`), reader = pendingStream.body!.getReader();
    await reader.read();
    users.remove('alice'); await users.add('alice', 'long epoch password', 'engineer'); epoch = auth.accountEpoch('alice')!; resume.resolve();
    const result = await reader.read();
    assert.equal(result.done, true, 'revoked reader receives no later private operation event');
    assert.equal((heldCredentials as Credentials | null)?.wiped, true, 'revoked in-flight credentials are wiped');
    const fresh = await request('/hpc/connect', { sealed: await sealed() });
    const freshId = (await fresh.json() as { opId: string }).opId;
    assert.match(await (await request(`/ops/${freshId}/events`)).text(), /CONNECTED/);
    const socket = new Socket(), incoming = new IncomingMessage(socket); incoming.headers.cookie = epoch;
    const key = createECDH('prime256v1').generateKeys().toString('base64url');
    assert.equal(train.sockets!.upgrade(incoming, socket, Buffer.alloc(0), new URL(`http://localhost/train-term?tid=${oldTerminal.tid}&epk=${key}`), 'alice', epoch), false, 'a recreated account with fresh HPC session cannot use old terminal ticket');
    socket.destroy();

  } finally { train.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
