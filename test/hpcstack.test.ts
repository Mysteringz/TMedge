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
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { after, describe, test } from 'node:test';
import { AlgoUsers, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { buildRegistry } from '../src/edge/registry.js';
import { EdgeRuntime } from '../src/edge/runtime.js';
import { makeFingerprint, saveFingerprint } from '../src/algo/train/hpc/fingerprint.js';
import { packCredentials, sealCredentials, type SealTicket } from '../src/shared/hpcseal.js';
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
  const rt = new EdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
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

    const stop = watchProcs([canary()]);
    const r = await act(c, c.alice, 'submit', id, await sealed(c, c.alice, 'submit', id, 'tmchan'));
    const procHits = stop();
    assert.equal(r.status, 202, `submit answered ${r.status}: ${JSON.stringify(r.json)}`);
    assert.deepEqual(r.events.map((e) => e.type),
      ['vpn_auth', 'vpn_connect', 'vpn_up', 'ssh_auth', 'ssh_up', 'uploading', 'submitting', 'submitted', 'done'], JSON.stringify(r.events));
    assert.deepEqual(procHits, [], 'the PIN never appears in any process\'s arguments or environment');

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

describe('Plan A with a shared cluster account (ing@<ip>), as on 10.21.36.12', { skip }, () => {
  let c: Ctx;

  test('until an admin sets the password fingerprint, nothing can be sent', async () => {
    c = await boot({ shared: true });
    const hpc = (await call(c, c.alice, 'GET', '/hpc')).json as { available: boolean; reason: string; ssh: { user: string; host: string; auth: string } };
    assert.equal(hpc.available, false, JSON.stringify(hpc));
    assert.match(hpc.reason, /password for ing@192\.168\.99\.1 has not been set up/);
    assert.deepEqual(hpc.ssh, { user: 'ing', host: '192.168.99.1', auth: 'shared-password' });
    const id = await draft(c, c.alice, 'no_fp', 'print(1)\n');
    assert.equal((await call(c, c.alice, 'POST', `/jobs/${id}/submit`, {})).status, 503);
    saveFingerprint(join(c.dataDir, 'algo', 'train', 'ssh-password.json'), await makeFingerprint(serverCanary()));
    assert.equal(((await call(c, c.alice, 'GET', '/hpc')).json as { available: boolean }).available, true);
  });

  test('a wrong cluster password stops before the VPN, and does not count against the HKU account', async () => {
    const id = await draft(c, c.alice, 'wrong_server_pw', 'print(1)\n');
    for (let i = 0; i < 3; i++) {
      const r = await act(c, c.alice, 'submit', id, await sealed(c, c.alice, 'submit', id, 'tmchan', undefined, Buffer.from('000000'), Buffer.from(`not-it-${i}`)));
      assert.deepEqual(r.events.map((e) => e.type), ['error'], 'no vpn_auth: nothing reached HKU or the cluster');
      assert.equal(r.events[0]!.data.code, 'server_password', JSON.stringify(r.events));
    }
    assert.equal((await job(c, c.alice, id)).status, 'SUBMIT_FAILED');
    assert.equal(((await call(c, c.alice, 'GET', '/hpc')).json as { lockedForSeconds: number }).lockedForSeconds, 0);
    const missing = await act(c, c.alice, 'submit', id, await sealed(c, c.alice, 'submit', id, 'tmchan', undefined, Buffer.from('000000')));
    assert.equal(missing.events[0]?.data.code, 'server_password', 'and leaving it out is refused the same way');
  });

  test('two people, each on their own VPN login, both run as ing on the cluster by IP', async () => {
    const a = await draft(c, c.alice, 'alice_on_ing', 'import os, getpass\nprint("user", getpass.getuser(), "via", os.environ.get("SSH_CONNECTION", "?").split()[0])\n');
    const b = await draft(c, c.bob, 'bob_on_ing', 'import getpass\nprint("user", getpass.getuser())\n');
    const stop = watchProcs([canary(), serverCanary()]);
    const [ra, rb] = await Promise.all([
      act(c, c.alice, 'submit', a, await sealed(c, c.alice, 'submit', a, 'tmchan', undefined, undefined, serverCanary())),
      act(c, c.bob, 'submit', b, await sealed(c, c.bob, 'submit', b, 'kwlee', undefined, undefined, serverCanary())),
    ]);
    const hits = stop();
    assert.equal(ra.events.at(-1)?.type, 'done', JSON.stringify(ra.events));
    assert.equal(rb.events.at(-1)?.type, 'done', JSON.stringify(rb.events));
    assert.deepEqual(hits, [], 'neither password appears in any process\'s arguments or environment');
    await until(c, c.alice, a, ['COMPLETED']);
    await until(c, c.bob, b, ['COMPLETED']);
    assert.match(await fetch(`${c.base}/api/train/jobs/${a}/log`, { headers: { cookie: c.alice } }).then((x) => x.text()), /user ing via 192\.168\.99\.\d+/);
    assert.match(await fetch(`${c.base}/api/train/jobs/${b}/log`, { headers: { cookie: c.bob } }).then((x) => x.text()), /user ing/);
  });

  test('the cluster password is nowhere either: files, logs, responses, heap', async () => {
    const needle = serverCanary();
    assert.deepEqual(filesContaining(c.dataDir, needle), []);
    assert.ok(!logged.some((l) => Buffer.from(l).includes(needle)));
    assert.ok(!responses.some((r) => Buffer.from(r).includes(needle)));
    const snap = writeHeapSnapshot(join(mkdtempSync(join(tmpdir(), 'tmedge-heap-')), 'h.heapsnapshot'));
    const heap = readFileSync(snap);
    assert.equal(heap.indexOf(needle), -1, 'the cluster password as a string in the heap');
    assert.equal(heap.indexOf(canary()), -1, 'the PIN as a string in the heap');
  });
});
