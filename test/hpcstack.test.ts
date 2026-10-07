/**
 * Claims about Plan A end to end, against a fake HKU (test/hpc-stack/run.sh:
 * an AnyConnect VPN asking for PIN + TOTP, DNS and an SSH login node with a
 * fake SLURM that exist only inside the tunnel). Skipped unless that script
 * started the stack; it never touches a real HKU system.
 *
 * The fake PIN is the canary from HANDOVER.md T1. In this file it exists only
 * as bytes decoded from hex: as a string literal it would sit in this
 * process's heap, and the last test looks for it there.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { after, describe, test } from 'node:test';
import { AlgoUsers, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { buildRegistry } from '../src/edge/registry.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { packCredentials, sealCredentials, type SealTicket } from '../src/shared/hpcseal.js';
import { T_DATA, T_EXIT, T_RESIZE, TermChannel, TermSender, type TermTicket } from '../src/shared/hpcterm.js';
import { fingerprintOf } from '../src/algo/train/hpc/hostkeys.js';
import { WebSocket } from 'ws';
import { KEY, nodesJson, siteJson } from './fixtures.js';

const ON = process.env.HPC_STACK === '1';
const skip = ON ? false : 'needs the fake HKU stack: npm run test:hpc-stack';

/** PIN_CANARY_7f3a, never spelled out here. */
const canary = () => Buffer.from('50494e5f43414e4152595f37663361', 'hex');
/** The shared ing account's password on the fake cluster (SRV_CANARY_51e9), likewise. */
const serverCanary = () => Buffer.from('5352565f43414e4152595f35316539', 'hex');
const PINS: Record<string, () => Buffer> = { tmchan: canary, kwlee: () => Buffer.from('kwlee-portal-pin-2'), lockme: () => Buffer.from('lockme-pin-3') };
const SEEDS: Record<string, string> = {
  tmchan: '3132333435363738393031323334353637383930', kwlee: '3837363534333231303938373635343332313039', lockme: '3131313131313131313131313131313131313131',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const used = new Map<string, number>();
/** A code from a 30 s window this account has not used, well clear of its edge. */
async function otp(uid: string): Promise<Buffer> {
  for (;;) {
    const now = Date.now();
    const w = Math.floor(now / 30_000);
    const left = 30_000 - (now % 30_000);
    if (w > (used.get(uid) ?? -1) && left > 6000) {
      used.set(uid, w);
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(w));
      const h = createHmac('sha1', Buffer.from(SEEDS[uid]!, 'hex')).update(b).digest();
      const o = h[19]! & 15;
      return Buffer.from(String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'));
    }
    await sleep(left + 300);
  }
}

// --- what the tests hunt for ---------------------------------------------------
const logged: string[] = [];
for (const k of ['log', 'warn', 'error', 'info'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); orig(...a); };
}
const responses: string[] = [];

/** Samples every process of ours: a credential in argv or the environment is a failure. */
function watchProcs(needles: Buffer[]): () => string[] {
  const hits = new Set<string>();
  const uid = process.getuid?.() ?? -1;
  const t = setInterval(() => {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (statSync(`/proc/${pid}`).uid !== uid) continue;
        for (const f of ['cmdline', 'environ']) {
          const b = readFileSync(`/proc/${pid}/${f}`);
          for (const n of needles) if (b.includes(n)) hits.add(`${pid}/${f}`);
        }
      } catch { /* gone */ }
    }
  }, 10);
  return () => { clearInterval(t); return [...hits]; };
}

function filesContaining(dir: string, needle: Buffer): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...filesContaining(p, needle));
    else if (st.isFile() && readFileSync(p).includes(needle)) out.push(p);
  }
  return out;
}

// --- the console, with Plan A pointed at the fake ---------------------------------
const running: (() => Promise<void>)[] = [];
after(async () => { for (const stop of running) await stop(); });

interface BootOpts { knownHosts?: string; shared?: boolean }
async function boot(o: BootOpts | string = {}) {
  const opts: BootOpts = typeof o === 'string' ? { knownHosts: o } : o;
  const knownHosts = opts.knownHosts ?? process.env.HPC_STACK_KNOWN_HOSTS!;
  const dir = mkdtempSync(join(tmpdir(), 'tmedge-hpcstack-'));
  process.env.DATA_DIR = join(dir, 'data');
  process.env.HPC_CONFIG = join(dir, 'hpc.json');
  writeFileSync(process.env.HPC_CONFIG, JSON.stringify({
    verified: false, source: 'fake HKU', backend: 'vpn-ssh',
    planA: {
      vpnHost: process.env.HPC_STACK_VPN, vpnDomains: ['hku.hk'], vpnServerCert: process.env.HPC_STACK_CERT, vpnAuthGroup: null,
      // Shared mode mirrors ing@10.21.36.12: one account, reached by IP inside the tunnel.
      submitHost: opts.shared ? '192.168.99.1' : 'hpc.fakehku.test',
      sshUser: opts.shared ? 'ing' : null, sshAuth: opts.shared ? 'shared-password' : 'pin',
      knownHosts, idleTtlSeconds: 120, maxSessions: 2, socksPorts: [21500 + Math.floor(Math.random() * 400), 21999], tools: {},
    },
    partitions: [{ name: 'cpu', maxTime: '1:00:00', gpu: false }], defaultPartition: 'cpu', modules: ['python'],
    maxUploadMb: 5, maxUnpackedMb: 10, quotaMb: 50,
  }));
  const usersPath = join(dir, 'users.json');
  for (const [u, p] of [['alice', 'correct horse battery'], ['bob', 'battery staple horse'], ['carol', 'staple horse battery']]) await new AlgoUsers(usersPath).add(u!, p!);
  const cfg: EdgeConfig = {
    edgeId: 'test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', dataDir: join(dir, 'edge'), recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null, pushUrls: [], pushToken: '', publishMs: 1000,
    gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  const rt = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
  const { server } = startAlgo(rt, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: usersPath }, 'admin-pass'));
  const base = await new Promise<string>((r) => {
    const done = () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    if (server.listening) done(); else server.once('listening', done);
  });
  const closed = new Promise<void>((r) => server.once('close', () => r()));
  running.push(async () => { server.close(); await closed; await sleep(500); await rt.stop(); });
  const login = async (username: string, password: string) => {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };
  return {
    base, dataDir: process.env.DATA_DIR!,
    alice: await login('alice', 'correct horse battery'), bob: await login('bob', 'battery staple horse'), carol: await login('carol', 'staple horse battery'),
  };
}

type Ctx = Awaited<ReturnType<typeof boot>>;
const W = { 'x-tm-algo': '1' };

async function call(c: Ctx, cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${c.base}/api/train${path}`, {
    method, headers: { cookie, ...W, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, json: (text.startsWith('{') ? JSON.parse(text) : { text }) as Record<string, unknown> };
}

/** A saved draft whose script prints where it ran from. */
async function draft(c: Ctx, cookie: string, name: string, script: string): Promise<string> {
  const up = await fetch(`${c.base}/api/train/uploads?filename=train.py`, {
    method: 'POST', headers: { cookie, ...W, 'content-type': 'application/octet-stream' }, body: Buffer.from(script),
  });
  const { upload } = await up.json() as { upload: { id: string } };
  const spec = { name, partition: 'cpu', cpusPerTask: 1, memGb: 1, gpus: 0, timeLimit: '0:10:00', modules: [], condaEnv: null,
    entrypoint: 'train.py', args: [], env: {}, notifyEmail: false };
  const r = await call(c, cookie, 'POST', '/jobs', { uploadId: upload.id, spec });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return (r.json.job as { id: string }).id;
}

async function sealed(c: Ctx, cookie: string, action: string, jobId: string, uid: string, pin?: Buffer, code?: Buffer, serverPassword?: Buffer) {
  const ticket = (await call(c, cookie, 'POST', '/hpc/ticket')).json as unknown as SealTicket;
  const p = pin ?? PINS[uid]!();
  const plain = packCredentials(p, code ?? await otp(uid), serverPassword);
  p.fill(0);
  serverPassword?.fill(0);
  return { sealed: await sealCredentials(ticket, action, jobId, plain), profile: { hkuUid: uid, vpnDomain: 'hku.hk' } };
}

/** Starts an action and follows its events to the end. */
async function act(c: Ctx, cookie: string, action: string, jobId: string, body?: unknown): Promise<{ status: number; events: { type: string; data: Record<string, unknown> }[]; json: Record<string, unknown> }> {
  const r = await call(c, cookie, 'POST', `/jobs/${jobId}/${action}`, body ?? {});
  if (r.status !== 202) return { status: r.status, events: [], json: r.json };
  const res = await fetch(`${c.base}/api/train/ops/${String(r.json.opId)}/events`, { headers: { cookie } });
  const text = await res.text();
  responses.push(text);
  const events = text.split('\n\n').filter((b) => b.includes('event:')).map((b) => ({
    type: /event: (\S+)/.exec(b)![1]!, data: JSON.parse(/data: (.*)/.exec(b)![1]!) as Record<string, unknown>,
  }));
  return { status: 202, events, json: r.json };
}

async function job(c: Ctx, cookie: string, id: string) {
  return (await call(c, cookie, 'GET', `/jobs/${id}`)).json.job as Record<string, unknown>;
}

async function until(c: Ctx, cookie: string, id: string, want: string[], ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    await act(c, cookie, 'refresh', id);
    const j = await job(c, cookie, id);
    if (want.includes(String(j.status)) || Date.now() > end) return j;
    await sleep(1000);
  }
}

describe('Plan A against a fake HKU', { skip }, () => {
  let c: Ctx;

  test('a draft reaches SLURM through its owner\'s own tunnel, runs, and its log comes back', async () => {
    c = await boot();
    const id = await draft(c, c.alice, 'tunnel_proof',
      'import os, getpass\nprint("client", os.environ.get("SSH_CONNECTION", "?").split()[0])\nprint("user", getpass.getuser())\nprint("epoch 01/01 ok")\n');
    assert.equal((await call(c, c.alice, 'POST', `/jobs/${id}/submit`, {})).status, 428, 'no session: it asks for HKU credentials');
    // What production had on 2026-10-07: the askpass wrapper left by a release
    // that has since been deleted. A login must repair it, not fail on it.
    const wrapper = join(c.dataDir, 'algo', 'train', 'run', 'askpass.sh');
    mkdirSync(dirname(wrapper), { recursive: true, mode: 0o700 });
    writeFileSync(wrapper, '#!/bin/sh\nexec /usr/local/bin/node /opt/tmedge-releases/20261006T112927Z-6ce22a67c8bc/dist/src/algo/train/hpc/askpass.js "$@"\n', { mode: 0o700 });

    const stop = watchProcs([canary()]);
    const r = await act(c, c.alice, 'submit', id, await sealed(c, c.alice, 'submit', id, 'tmchan'));
    const procHits = stop();
    assert.equal(r.status, 202, `submit answered ${r.status}: ${JSON.stringify(r.json)}`);
    assert.deepEqual(r.events.map((e) => e.type),
      ['vpn_auth', 'vpn_connect', 'vpn_up', 'ssh_auth', 'ssh_up', 'uploading', 'submitting', 'submitted', 'done'], JSON.stringify(r.events));
    assert.deepEqual(procHits, [], 'the PIN never appears in any process\'s arguments or environment');
    assert.doesNotMatch(readFileSync(wrapper, 'utf8'), /20261006T112927Z/, 'the stale wrapper was rewritten for this release');

    const done = await until(c, c.alice, id, ['COMPLETED', 'FAILED']);
    assert.equal(done.status, 'COMPLETED', JSON.stringify(done));
    assert.equal(done.exitCode, 0, JSON.stringify(done));
    const log = await fetch(`${c.base}/api/train/jobs/${id}/log`, { headers: { cookie: c.alice } }).then((x) => x.text());
    assert.match(log, /client 192\.168\.99\.\d+/, 'SSH arrived from the VPN pool: it went through the tunnel');
    assert.match(log, /user tmchan/, 'and ran as the person who signed in');
    assert.match(log, /epoch 01\/01 ok/);
  });

  test('with a live session, submit/refresh need no code; closing the session asks again', async () => {
    const id = await draft(c, c.alice, 'reuse_and_cancel', 'import time\nprint("sleeping", flush=True)\ntime.sleep(120)\n');
    const r = await act(c, c.alice, 'submit', id);
    assert.deepEqual(r.events.map((e) => e.type), ['session_reused', 'uploading', 'submitting', 'submitted', 'done']);
    const running = await until(c, c.alice, id, ['RUNNING']);
    assert.equal(running.status, 'RUNNING', JSON.stringify(running));
    const cancelled = await act(c, c.alice, 'cancel', id);
    assert.equal(cancelled.events.at(-1)?.type, 'done', JSON.stringify(cancelled.events));
    const after = await until(c, c.alice, id, ['CANCELLED']);
    assert.equal(after.status, 'CANCELLED', JSON.stringify(after));
    assert.match(String(after.slurmState), /^CANCELLED by \d+$/);

    assert.equal((await call(c, c.alice, 'DELETE', '/hpc/session')).status, 200);
    assert.equal((await call(c, c.alice, 'POST', `/jobs/${id}/refresh`, {})).status, 428);
    assert.equal((await call(c, c.alice, 'GET', '/hpc')).json.session && ((await call(c, c.alice, 'GET', '/hpc')).json.session as { state: string }).state, 'none');
  });

  test('a wrong code fails cleanly; three failures lock further attempts before anything reaches HKU', async () => {
    const id = await draft(c, c.carol, 'lockout', 'print(1)\n');
    const badOtp = await act(c, c.carol, 'submit', id, await sealed(c, c.carol, 'submit', id, 'lockme', undefined, Buffer.from('000000')));
    assert.deepEqual(badOtp.events.at(-1), { type: 'error', data: { code: 'vpn_bad_otp', message: badOtp.events.at(-1)!.data.message } });
    assert.equal((await job(c, c.carol, id)).status, 'SUBMIT_FAILED');
    for (let i = 0; i < 2; i++) {
      const badPin = await act(c, c.carol, 'submit', id, await sealed(c, c.carol, 'submit', id, 'lockme', Buffer.from(`not-the-pin-${i}`)));
      assert.equal(badPin.events.at(-1)?.data.code, 'vpn_bad_credentials', JSON.stringify(badPin.events));
    }
    const fourth = await call(c, c.carol, 'POST', `/jobs/${id}/submit`, await sealed(c, c.carol, 'submit', id, 'lockme'));
    assert.equal(fourth.status, 423, 'locked out by the dashboard, to protect the HKU account');
    assert.match(String(fourth.json.error), /protect your HKU account/);
  });

  test('two people at once: separate tunnels, each signed in as themselves', async () => {
    const a = await draft(c, c.alice, 'alice_job', 'import getpass\nprint("user", getpass.getuser())\n');
    const b = await draft(c, c.bob, 'bob_job', 'import getpass\nprint("user", getpass.getuser())\n');
    const [ra, rb] = await Promise.all([
      act(c, c.alice, 'submit', a, await sealed(c, c.alice, 'submit', a, 'tmchan')),
      act(c, c.bob, 'submit', b, await sealed(c, c.bob, 'submit', b, 'kwlee')),
    ]);
    assert.equal(ra.events.at(-1)?.type, 'done', JSON.stringify(ra.events));
    assert.equal(rb.events.at(-1)?.type, 'done', JSON.stringify(rb.events));
    await until(c, c.alice, a, ['COMPLETED']);
    await until(c, c.bob, b, ['COMPLETED']);
    assert.match(await fetch(`${c.base}/api/train/jobs/${a}/log`, { headers: { cookie: c.alice } }).then((x) => x.text()), /user tmchan/);
    assert.match(await fetch(`${c.base}/api/train/jobs/${b}/log`, { headers: { cookie: c.bob } }).then((x) => x.text()), /user kwlee/);
    assert.equal((await call(c, c.bob, 'GET', `/jobs/${a}/log`)).status, 404, 'and neither can read the other\'s');
  });

  test('a host key that is not the pinned one is refused, and the tunnel is closed', async () => {
    const wrong = join(mkdtempSync(join(tmpdir(), 'tmedge-wrongkey-')), 'known_hosts');
    writeFileSync(wrong, 'hpc.fakehku.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPUqSlzPghJCQEAVxjEPnV4ZaWQLQ8n8AIFyKnye4G85\n');
    const w = await boot(wrong);
    const id = await draft(w, w.alice, 'wrong_key', 'print(1)\n');
    const r = await act(w, w.alice, 'submit', id, await sealed(w, w.alice, 'submit', id, 'tmchan'));
    assert.equal(r.events.at(-1)?.data.code, 'ssh_host_key', JSON.stringify(r.events));
    assert.equal(((await call(w, w.alice, 'GET', '/hpc')).json.session as { state: string }).state, 'none');
  });

  test('the PIN is nowhere: not in files, logs, responses, or as a string in the heap', async () => {
    const needle = canary();
    for (const dir of [c.dataDir, process.env.DATA_DIR!]) assert.deepEqual(filesContaining(dir, needle), [], `data under ${dir}`);
    assert.ok(!logged.some((l) => Buffer.from(l).includes(needle)), 'console output');
    assert.ok(!responses.some((r) => Buffer.from(r).includes(needle)), 'HTTP responses and event streams');
    const snap = writeHeapSnapshot(join(mkdtempSync(join(tmpdir(), 'tmedge-heap-')), 'h.heapsnapshot'));
    assert.equal(readFileSync(snap).indexOf(needle), -1, 'no JavaScript string anywhere in the server process holds the PIN');
  });
});


/** Starts an action and follows its events as they come, answering host-key questions. */
async function actLive(c: Ctx, cookie: string, path: string, body: unknown, onHostKey?: (d: Record<string, unknown>, opId: string) => Promise<void>) {
  const r = await call(c, cookie, 'POST', path, body);
  if (r.status !== 202) return { status: r.status, events: [] as { type: string; data: Record<string, unknown> }[], json: r.json };
  const opId = String(r.json.opId);
  const res = await fetch(`${c.base}/api/train/ops/${opId}/events`, { headers: { cookie } });
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const reader = res.body!.getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += Buffer.from(value).toString('utf8');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const type = /event: (\S+)/.exec(block)?.[1];
      const data = /data: (.*)/.exec(block)?.[1];
      if (!type || data === undefined) continue;
      const e = { type, data: JSON.parse(data) as Record<string, unknown> };
      events.push(e);
      if (type === 'host_key' && onHostKey) await onHostKey(e.data, opId);
    }
  }
  responses.push(JSON.stringify(events));
  return { status: 202, events, json: r.json };
}

/** A terminal on the cluster over the encrypted channel, as the page opens one. */
async function terminal(c: Ctx, cookie: string, cols = 100, rows = 30) {
  const t = (await call(c, cookie, 'POST', '/hpc/term')).json as unknown as TermTicket;
  const ch = await TermChannel.open(t);
  const ws = new WebSocket(`${c.base.replace('http', 'ws')}/train-term?tid=${t.tid}&epk=${ch.publicKey}&cols=${cols}&rows=${rows}`, { headers: { cookie, origin: c.base } });
  let screen = '';
  let exit: number | null = null;
  ws.on('message', async (d: Buffer) => {
    const m = await ch.open(new Uint8Array(d));
    if (m.type === T_DATA) screen += Buffer.from(m.payload).toString('utf8');
    if (m.type === T_EXIT) exit = m.payload[0] ?? null;
  });
  await new Promise<void>((ok, fail) => { ws.once('open', () => ok()); ws.once('error', fail); ws.once('unexpected-response', (_q, r) => fail(new Error(`HTTP ${r.statusCode}`))); });
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  const type = async (bytes: Buffer) => { ws.send(await ch.seal(T_DATA, bytes)); bytes.fill(0); };
  return {
    ws, closed,
    text: () => screen, exit: () => exit,
    type: (s: string) => type(Buffer.from(s)),
    typeBytes: type,
    resize: async (c2: number, r2: number) => { const b = Buffer.alloc(4); b.writeUInt16BE(c2); b.writeUInt16BE(r2, 2); ws.send(await ch.seal(T_RESIZE, b)); },
    until: async (re: RegExp, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!re.test(screen) && Date.now() < end) await sleep(100);
      assert.match(screen, re);
    },
  };
}

describe('Plan A with a shared cluster account (ing@<ip>), as on 10.21.36.12', { skip }, () => {
  let c: Ctx;
  const realKey = () => readFileSync(process.env.HPC_STACK_KNOWN_HOSTS!, 'utf8').trim().split(/\s+/)[2]!;

  test('the first sign-in shows the host key to confirm; refusing pins nothing and logs nobody in', async () => {
    c = await boot({ shared: true, knownHosts: join(mkdtempSync(join(tmpdir(), 'tmedge-tofu-')), 'known_hosts') });
    const hpc = (await call(c, c.alice, 'GET', '/hpc')).json as { available: boolean; firstUse: { hostKey: boolean; password: boolean }; ssh: unknown };
    assert.equal(hpc.available, true, 'nothing to run on the server first');
    assert.deepEqual(hpc.firstUse, { hostKey: true, password: true });
    assert.deepEqual(hpc.ssh, { user: 'ing', host: '192.168.99.1', auth: 'shared-password' });
    const r = await actLive(c, c.alice, '/hpc/connect', await sealed(c, c.alice, 'connect', null as unknown as string, 'tmchan', undefined, undefined, serverCanary()),
      async (_d, opId) => { assert.equal((await call(c, c.alice, 'POST', `/ops/${opId}/hostkey`, { accept: false })).status, 200); });
    assert.equal(r.events.at(-1)?.data.code, 'ssh_host_key', JSON.stringify(r.events));
    assert.deepEqual(((await call(c, c.alice, 'GET', '/hpc')).json as { firstUse: unknown }).firstUse, { hostKey: true, password: true });
  });

  test('accepting pins exactly the key the cluster has, and the successful login records the password fingerprint', async () => {
    let shown: { type: string; fingerprint: string }[] = [];
    const r = await actLive(c, c.alice, '/hpc/connect', await sealed(c, c.alice, 'connect', null as unknown as string, 'tmchan', undefined, undefined, serverCanary()),
      async (d, opId) => { shown = d.keys as typeof shown; await call(c, c.alice, 'POST', `/ops/${opId}/hostkey`, { accept: true }); });
    assert.deepEqual(r.events.map((e) => e.type), ['vpn_auth', 'vpn_connect', 'vpn_up', 'host_key_scan', 'host_key', 'ssh_auth', 'ssh_up', 'password_recorded', 'done'], JSON.stringify(r.events));
    assert.ok(shown.some((k) => k.type === 'ssh-ed25519' && k.fingerprint === fingerprintOf(realKey())), JSON.stringify(shown));
    assert.deepEqual(((await call(c, c.alice, 'GET', '/hpc')).json as { firstUse: unknown }).firstUse, { hostKey: false, password: false });
  });

  test('the terminal: a real shell as ing, through the tunnel, resizable', async () => {
    const t = await terminal(c, c.alice, 100, 30);
    await t.type('echo "who=$(whoami) from=${SSH_CONNECTION%% *} sum=$((6*7))"\r');
    await t.until(/who=ing from=192\.168\.99\.\d+ sum=42/);
    await t.type('stty size\r');
    await t.until(/30 100/);
    await t.resize(132, 41);
    await sleep(300);
    await t.type('stty size\r');
    await t.until(/41 132/);
    await t.type('exit\r');
    assert.equal(await t.closed, 1000);
    assert.equal(t.exit(), 0);
  });

  test('a resize and keystrokes sent while the socket is still opening are not lost (the page does this)', async () => {
    const tk = (await call(c, c.alice, 'POST', '/hpc/term')).json as unknown as TermTicket;
    const ch = await TermChannel.open(tk);
    const sender = new TermSender(ch);
    const ws = new WebSocket(`${c.base.replace('http', 'ws')}/train-term?tid=${tk.tid}&epk=${ch.publicKey}&cols=80&rows=24`, { headers: { cookie: c.alice, origin: c.base } });
    let screen = '';
    ws.on('message', async (d: Buffer) => { const m = await ch.open(new Uint8Array(d)); if (m.type === T_DATA) screen += Buffer.from(m.payload).toString('utf8'); });
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    // Before 'open': exactly what xterm's fit and the first keystroke produce.
    void sender.send(T_RESIZE, new Uint8Array([0, 117, 0, 33]));
    void sender.send(T_DATA, new TextEncoder().encode('stty size; echo early-ok\r'));
    await new Promise((ok) => ws.once('open', ok));
    await sender.open({ readyState: 1, send: (f: Uint8Array) => ws.send(f) });
    const end = Date.now() + 15_000;
    while (!/33 117[\s\S]*early-ok/.test(screen) && Date.now() < end) await sleep(100);
    assert.match(screen, /33 117[\s\S]*early-ok/, `screen was: ${JSON.stringify(screen.slice(-300))}`);
    await sender.send(T_DATA, new TextEncoder().encode('exit\r'));
    assert.equal(await closed, 1000, 'closed by the shell exiting, not "frame out of sequence"');
  });

  test('a frame replayed or out of order closes the terminal', async () => {
    const tk = (await call(c, c.alice, 'POST', '/hpc/term')).json as unknown as TermTicket;
    const ch = await TermChannel.open(tk);
    const ws = new WebSocket(`${c.base.replace('http', 'ws')}/train-term?tid=${tk.tid}&epk=${ch.publicKey}`, { headers: { cookie: c.alice, origin: c.base } });
    await new Promise((ok) => ws.once('open', ok));
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    const f = await ch.seal(T_DATA, Buffer.from('echo one\r'));
    ws.send(f);
    ws.send(f);
    assert.equal(await closed, 1008);
    assert.equal((await call(c, c.bob, 'POST', '/hpc/term')).status, 428, 'and without your own HKU session there is no terminal');
  });

  test('changing the ing password in the terminal, then signing in with "password changed"', async () => {
    const t = await terminal(c, c.alice);
    await t.type('passwd\r');
    await t.until(/[Cc]urrent password:/);
    await t.typeBytes(Buffer.concat([serverCanary(), Buffer.from('\r')]));
    await t.until(/New password:/);
    const next = Buffer.from('Nw-cluster-pw-2026!q');
    await t.typeBytes(Buffer.concat([next, Buffer.from('\r')]));
    await t.until(/Retype new password:/);
    await t.typeBytes(Buffer.concat([next, Buffer.from('\r')]));
    await t.until(/password updated successfully/);
    await t.type('exit\r');
    await t.closed;
    await call(c, c.alice, 'DELETE', '/hpc/session');

    const next2 = () => Buffer.from('Nw-cluster-pw-2026!q');
    // The fingerprint still describes the old password: the new one is refused here...
    const unticked = await actLive(c, c.alice, '/hpc/connect', await sealed(c, c.alice, 'connect', null as unknown as string, 'tmchan', undefined, Buffer.from('000000'), next2()));
    assert.deepEqual(unticked.events.map((e) => [e.type, e.data.code]), [['error', 'server_password']], 'refused before the VPN');
    assert.match(String(unticked.events[0]?.data.message), /password has changed/);
    // ...until the person says it changed: then the cluster judges it, once, and its fingerprint is recorded.
    const ticked = await actLive(c, c.alice, '/hpc/connect', { ...(await sealed(c, c.alice, 'connect', null as unknown as string, 'tmchan', undefined, undefined, next2())), passwordChanged: true });
    assert.deepEqual(ticked.events.slice(-2).map((e) => e.type), ['password_recorded', 'done'], JSON.stringify(ticked.events));
    await call(c, c.alice, 'DELETE', '/hpc/session');
    const oldOne = await actLive(c, c.alice, '/hpc/connect', await sealed(c, c.alice, 'connect', null as unknown as string, 'tmchan', undefined, Buffer.from('000000'), serverCanary()));
    assert.deepEqual(oldOne.events.map((e) => [e.type, e.data.code]), [['error', 'server_password']], 'and now the old one is the one refused here');
  });

  test('neither password is anywhere: files, logs, responses, heap', async () => {
    for (const needle of [serverCanary(), canary(), Buffer.from('Nw-cluster-pw-2026!q')]) {
      assert.deepEqual(filesContaining(c.dataDir, needle), []);
      assert.ok(!logged.some((l) => Buffer.from(l).includes(needle)));
      assert.ok(!responses.some((r) => Buffer.from(r).includes(needle)));
    }
    const heap = readFileSync(writeHeapSnapshot(join(mkdtempSync(join(tmpdir(), 'tmedge-heap-')), 'h.heapsnapshot')));
    assert.equal(heap.indexOf(serverCanary()), -1, 'the old cluster password as a string in the heap');
    assert.equal(heap.indexOf(canary()), -1, 'the PIN as a string in the heap');
  });
});
