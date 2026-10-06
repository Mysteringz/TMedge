/**
 * Claims about Plan A's parts that hold without any VPN (CI): sealing,
 * the openconnect driver's one-attempt rule, SLURM parsing, the session
 * manager's limits, and the routes refusing before anything is decrypted.
 * The whole chain against a fake HKU is test/hpcstack.test.ts.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, test } from 'node:test';
import { parseHpcConfig } from '../src/algo/train/config.js';
import { Gateway, GatewayBusy, LockedOut, type GatewayDeps } from '../src/algo/train/hpc/gateway.js';
import { AuthFailed, authenticate, parseAuthOutput, type AuthResult } from '../src/algo/train/hpc/openconnect.js';
import { Credentials, SealedInbox, SealError } from '../src/algo/train/hpc/sealed.js';
import { mapState, parseElapsed, parseSacct, parseSbatch, parseSqueue } from '../src/algo/train/hpc/slurm.js';
import { SshFailed, type SshLike } from '../src/algo/train/hpc/ssh.js';
import { packCredentials, sealCredentials } from '../src/shared/hpcseal.js';

const bytes = (s: string) => Buffer.from(s);
const creds = (pin = 'pin-1234', otp = '123456') => new Credentials(Buffer.from(packCredentials(bytes(pin), bytes(otp))));

describe('sealed credentials', () => {
  test('what the browser seals, the edge opens once, for that person, action and job only', async () => {
    const inbox = new SealedInbox();
    const seal = async (user: string, action: string, job: string | null) =>
      sealCredentials(inbox.issue(user), action, job, packCredentials(bytes('my-portal-pin'), bytes('654321')));

    const s = await seal('alice', 'submit', 'job-1');
    const c = inbox.open('alice', s, 'submit', 'job-1');
    assert.equal(c.pin().toString(), 'my-portal-pin');
    assert.equal(c.otp().toString(), '654321');
    assert.equal(c.sshPassword().toString(), 'my-portal-pin', 'HPC2021 SSH password defaults to the PIN');
    assert.throws(() => inbox.open('alice', s, 'submit', 'job-1'), SealError, 'a ticket opens once');

    for (const [user, action, job] of [['bob', 'submit', 'job-1'], ['alice', 'cancel', 'job-1'], ['alice', 'submit', 'job-2']] as const) {
      const other = await seal('alice', 'submit', 'job-1');
      assert.throws(() => inbox.open(user, other, action, job), SealError, `${user}/${action}/${job}`);
    }
  });

  test('a ticket expires', async () => {
    let now = 1_000_000;
    const inbox = new SealedInbox(() => now);
    const s = await sealCredentials(inbox.issue('alice'), 'submit', null, packCredentials(bytes('p'), bytes('123456')));
    now += 4 * 60_000;
    assert.throws(() => inbox.open('alice', s, 'submit', null), /expired/);
  });

  test('wipe zeroes the bytes, and printing or serialising never shows them', () => {
    const plain = Buffer.from(packCredentials(bytes('PIN_SECRET_x'), bytes('987654')));
    const c = new Credentials(plain);
    for (const shown of [inspect(c), JSON.stringify({ c }), String(c), `${c}`]) assert.doesNotMatch(shown, /PIN_SECRET|987654/);
    c.wipe();
    assert.ok(plain.every((b) => b === 0), 'every byte is zero');
    assert.throws(() => c.pin(), /wiped/);
  });

  test('values that would break a line-based pipe are refused', () => {
    assert.throws(() => creds('pin\nOTP', '123456'), /line break/);
    assert.throws(() => creds('pin', '12ab56'), /6 to 8 digits/);
    assert.throws(() => new Credentials(Buffer.from([2, 1, 65, 6, 49, 49, 49, 49, 49, 49, 0])), /format/);
  });
});

/**
 * A stand-in openconnect that behaves like the real one did against an
 * AnyConnect server: --passwd-on-stdin takes the first line; a wrong one gets
 * "Login failed." and the password prompt again (reading stdin again); a
 * right one gets the code prompt. Everything it reads goes to a file.
 */
function fakeOpenconnect(dir: string, pin: string, code: string, extra = ''): string {
  const bin = join(dir, 'openconnect');
  writeFileSync(bin, `#!/bin/bash
log=${join(dir, 'stdin.log')}
IFS= read -r pw; echo "pw:$pw" >> "$log"
${extra}
echo "Please enter your password." >&2
if [ "$pw" != "${pin}" ]; then
  echo "Login failed." >&2
  printf "Password:" >&2; IFS= read -r again && echo "retry:$again" >> "$log"
  echo "Login failed." >&2; exit 1
fi
echo "Please enter your OTP password." >&2; printf "Password:" >&2
IFS= read -r otp; echo "otp:$otp" >> "$log"
[ "$otp" = "${code}" ] || { echo "Got HTTP response: HTTP/1.1 401 Authentication failed" >&2; echo "Failed to complete authentication" >&2; exit 1; }
echo "COOKIE='abc'\\''def'"; echo "HOST='1.2.3.4'"; echo "CONNECT_URL='https://vpn.example/'"; echo "FINGERPRINT='pin-sha256:AAAA'"; echo "RESOLVE='vpn.example:1.2.3.4'"
`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'stdin.log'), '');
  return bin;
}

describe('openconnect: one attempt, and the code only when asked for', () => {
  const run = async (pin: string, otp: string, extra = '') => {
    const dir = mkdtempSync(join(tmpdir(), 'tmedge-oc-'));
    const bin = fakeOpenconnect(dir, 'right-pin', '135790', extra);
    const result = await authenticate({ bin, host: 'vpn.example', vpnUser: 'u@hku.hk', creds: creds(pin, otp), serverCert: null, authGroup: null, timeoutMs: 5000 })
      .then((r) => r, (e: unknown) => e);
    return { result, seen: readFileSync(join(dir, 'stdin.log'), 'utf8').trim().split('\n').filter(Boolean) };
  };

  test('right PIN and code: the cookie, as bytes, unquoted', async () => {
    const { result, seen } = await run('right-pin', '135790');
    const r = result as AuthResult;
    assert.equal(r.cookie.toString(), "abc'def");
    assert.equal(r.connectUrl, 'https://vpn.example/');
    assert.equal(r.resolve, 'vpn.example:1.2.3.4');
    assert.deepEqual(seen, ['pw:right-pin', 'otp:135790']);
  });

  test('a wrong PIN ends the attempt: no second try, and the code is never sent', async () => {
    const { result, seen } = await run('wrong-pin', '135790');
    assert.ok(result instanceof AuthFailed && result.code === 'bad_credentials', String(result));
    assert.deepEqual(seen, ['pw:wrong-pin'], 'nothing after the PIN: not the code, not a retry');
  });

  test('a wrong code is reported as the code', async () => {
    const { result } = await run('right-pin', '000000');
    assert.ok(result instanceof AuthFailed && result.code === 'bad_otp', String(result));
  });

  test('a prompt that is not for the code (a group menu) is not answered with the code', async () => {
    const { result, seen } = await run('right-pin', '135790', 'printf "GROUP: [Staff|Student]:" >&2; IFS= read -r g; echo "group:$g" >> "$log"');
    assert.ok(result instanceof AuthFailed && result.code === 'unsupported', String(result));
    assert.deepEqual(seen, ['pw:right-pin']);
  });

  test('cookie parsing rejects incomplete output', () => {
    assert.equal(parseAuthOutput(Buffer.from("COOKIE='x'\n")), null);
    assert.equal(parseAuthOutput(Buffer.from("COOKIE=''\nCONNECT_URL='https://a/'\nFINGERPRINT='x'\n")), null);
  });
});

describe('SLURM parsing (HANDOVER §6.5)', () => {
  test('sacct: steps ignored, CANCELLED by <uid>, exit codes, elapsed', () => {
    const out = [
      '4101|COMPLETED|0:0|00:01:05|2026-10-06T15:00:00|2026-10-06T15:01:05|gpu-a10-1',
      '4101.batch|COMPLETED|0:0|00:01:05|x|x|gpu-a10-1',
      '4101.extern|COMPLETED|0:0|00:01:05|x|x|gpu-a10-1',
      '4102|CANCELLED by 12345|0:15|1-02:03:04|x|x|node7',
      '4103|OUT_OF_MEMORY|0:125|00:10:00|x|x|node8',
      '4104|TIMEOUT|0:0|02:00:00|x|x|node9',
      '4105|PENDING|0:0|00:00:00|Unknown|Unknown|None assigned',
      '4106|FAILED|1:0|00:00:03|x|x|node1',
      '4107|SOMETHING_NEW|0:0|00:00:00|x|x|None',
      '4108.0|RUNNING|0:0|00:00:01|x|x|n',
      '', 'garbage',
    ].join('\n');
    const s = parseSacct(out);
    assert.deepEqual([...s.keys()], [4101, 4102, 4103, 4104, 4105, 4106, 4107]);
    assert.deepEqual(s.get(4101), { status: 'COMPLETED', raw: 'COMPLETED', exitCode: 0, elapsedSeconds: 65, node: 'gpu-a10-1' });
    assert.equal(s.get(4102)?.status, 'CANCELLED');
    assert.equal(s.get(4102)?.raw, 'CANCELLED by 12345');
    assert.equal(s.get(4102)?.elapsedSeconds, 93784);
    assert.equal(s.get(4103)?.status, 'OUT_OF_MEMORY');
    assert.equal(s.get(4104)?.status, 'TIMEOUT');
    assert.equal(s.get(4105)?.node, null);
    assert.equal(s.get(4106)?.exitCode, 1);
    assert.equal(s.get(4107)?.status, 'UNKNOWN');
    assert.equal(parseSacct('').size, 0);
  });

  test('sbatch, squeue, states and times', () => {
    assert.equal(parseSbatch('4321\n'), 4321);
    assert.equal(parseSbatch('4321;hpc2021\n'), 4321);
    assert.equal(parseSbatch('sbatch: error: invalid partition\n'), null);
    assert.equal(parseSqueue('7|RUNNING\n8|PENDING\n').get(8)?.status, 'PENDING');
    assert.equal(mapState('NODE_FAIL'), 'FAILED');
    assert.equal(mapState('COMPLETING'), 'RUNNING');
    assert.equal(mapState('REQUEUED'), 'PENDING');
    assert.equal(parseElapsed('05:07'), 307);
    assert.equal(parseElapsed('nope'), null);
  });
});

describe('session manager (HANDOVER §6.4)', () => {
  const setup = (opts: { authFails?: 'bad_credentials' | 'bad_otp' | 'server_error'; sshFails?: boolean; max?: number; sshUser?: string } = {}) => {
    let now = 1_000_000;
    const calls = { auth: 0, connect: 0, sshOpen: 0, tunnelsClosed: 0, sshClosed: 0, sshUsers: [] as string[], vpnUsers: [] as string[] };
    const deps: GatewayDeps = {
      now: () => now,
      portFree: async () => true,
      hostKeys: { isPinned: () => true, pin: () => undefined, scan: async () => [] },
      authenticate: async (o) => {
        calls.auth++;
        calls.vpnUsers.push(o.vpnUser);
        if (opts.authFails) throw new AuthFailed(opts.authFails, 'no');
        return { cookie: Buffer.from('cookie'), connectUrl: 'https://v/', fingerprint: 'pin-sha256:A', resolve: null };
      },
      connectTunnel: async (o) => {
        calls.connect++;
        assert.ok(o.auth.cookie.length > 0);
        return { pid: 1, port: o.port, closed: new Promise(() => undefined), close: async () => { calls.tunnelsClosed++; } };
      },
      ssh: (o) => {
        calls.sshUsers.push(o.user);
        let alive = false;
        const link: SshLike = {
          get alive() { return alive; },
          open: async () => { calls.sshOpen++; if (opts.sshFails) throw new SshFailed('bad_password', 'no'); alive = true; },
          run: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }),
          shellCommand: () => ({ bin: '/bin/true', args: [], home: '/tmp', target: 'x@y' }),
          close: async () => { alive = false; calls.sshClosed++; },
        };
        return link;
      },
    };
    const g = new Gateway({
      vpnHost: 'v', vpnServerCert: null, vpnAuthGroup: null, submitHost: 'h', sshUser: opts.sshUser ?? null, knownHosts: '/k', runDir: '/r',
      idleTtlMs: 600_000, maxSessions: opts.max ?? 10, ports: [21000, 21002],
      tools: { openconnect: '/oc', ocproxy: '/ocp', ssh: '/ssh' },
    }, deps);
    return { g, calls, tick: (ms: number) => { now += ms; } };
  };

  test('a failed login is one attempt; the third failure locks the account for 15 minutes', async () => {
    const { g, calls, tick } = setup({ authFails: 'bad_otp' });
    for (let i = 0; i < 3; i++) await assert.rejects(g.open('alice', 'u1', 'u1@hku.hk', creds()), AuthFailed);
    assert.equal(calls.auth, 3, 'one call per attempt: never retried');
    await assert.rejects(g.open('alice', 'u1', 'u1@hku.hk', creds()), LockedOut);
    await assert.rejects(g.open('carol', 'u1', 'u1@hku.hk', creds()), LockedOut, 'the HKU UID is locked too, not just the dashboard account');
    assert.equal(calls.auth, 3, 'a locked attempt never reaches HKU');
    tick(15 * 60_000 + 1);
    await assert.rejects(g.open('alice', 'u1', 'u1@hku.hk', creds()), AuthFailed);
    assert.equal(calls.auth, 4);
  });

  test('each person logs in to the VPN as themselves; SSH uses the shared account when there is one', async () => {
    const own = setup();
    await own.g.open('alice', 'u1', 'u1@hku.hk', creds());
    assert.deepEqual([own.calls.vpnUsers, own.calls.sshUsers], [['u1@hku.hk'], ['u1']]);
    const shared = setup({ sshUser: 'ing' });
    await shared.g.open('alice', 'u1', 'u1@hku.hk', creds());
    await shared.g.open('bob', 'u2', 'u2@connect.hku.hk', creds());
    assert.deepEqual([shared.calls.vpnUsers, shared.calls.sshUsers], [['u1@hku.hk', 'u2@connect.hku.hk'], ['ing', 'ing']]);
  });

  test('an unreachable VPN does not count toward the lockout', async () => {
    const { g } = setup({ authFails: 'server_error' });
    for (let i = 0; i < 4; i++) await assert.rejects(g.open('alice', 'u1', 'u1@hku.hk', creds()), AuthFailed);
  });

  test('an SSH password failure tears the tunnel down and counts', async () => {
    const { g, calls } = setup({ sshFails: true });
    await assert.rejects(g.open('alice', 'u1', 'u1@hku.hk', creds()), SshFailed);
    assert.equal(calls.tunnelsClosed, 1);
    assert.equal(g.info('alice').state, 'none');
    assert.equal(g.lockedFor('alice', 'u1'), 0);
  });

  test('one session each, a global cap, and idle sessions reaped', async () => {
    const { g, calls, tick } = setup({ max: 2 });
    await g.open('alice', 'u1', 'u1@hku.hk', creds());
    await g.open('bob', 'u2', 'u2@hku.hk', creds());
    await assert.rejects(g.open('carol', 'u3', 'u3@hku.hk', creds()), GatewayBusy);
    assert.equal(g.info('alice').state, 'up');
    assert.equal(g.info('alice').expiresInSeconds, 600);
    tick(5 * 60_000);
    await g.use('alice', async () => undefined);
    tick(6 * 60_000);
    await g.reap();
    assert.equal(g.info('bob').state, 'none', 'idle past the TTL: closed');
    assert.equal(g.info('alice').state, 'up', 'used within the TTL: kept');
    await g.use('alice', async () => undefined, false);
    tick(10 * 60_000 + 1);
    await g.reap();
    assert.equal(g.info('alice').state, 'none', 'the poller watching does not keep a session alive');
    assert.equal(calls.sshClosed, 2);
  });
});

describe('the shared cluster password, kept as a fingerprint', () => {
  test('the right bytes match, anything else does not, and the file holds no password', async () => {
    const { makeFingerprint, matches, saveFingerprint, loadFingerprint } = await import('../src/algo/train/hpc/fingerprint.js');
    const pw = Buffer.from('correct-cluster-pw');
    const fp = await makeFingerprint(pw);
    assert.equal(await matches(Buffer.from('correct-cluster-pw'), fp), true);
    assert.equal(await matches(Buffer.from('correct-cluster-pX'), fp), false);
    assert.equal(await matches(Buffer.alloc(0), fp), false);
    const file = join(mkdtempSync(join(tmpdir(), 'tmedge-fp-')), 'ssh-password.json');
    saveFingerprint(file, fp);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /correct-cluster-pw/);
    assert.deepEqual(loadFingerprint(file), fp);
    writeFileSync(file, JSON.stringify({ ...fp, N: 2 }));
    assert.equal(loadFingerprint(file), null, 'a weakened fingerprint is not accepted');
    const second = await makeFingerprint(pw);
    assert.notEqual(second.hash, fp.hash, 'salted: the same password never fingerprints the same twice');
  });
});

describe('Plan A config', () => {
  const base = {
    verified: false, backend: 'vpn-ssh', partitions: [{ name: 'cpu', maxTime: '1:00:00', gpu: false }], defaultPartition: 'cpu', modules: [],
    planA: { vpnHost: 'vpn2fa.hku.hk', vpnDomains: ['hku.hk'], submitHost: 'hpc2021.hku.hk', idleTtlSeconds: 600, maxSessions: 4, socksPorts: [21000, 21099] },
  };
  test('strict about anything that ends up on a command line', () => {
    assert.equal(parseHpcConfig(base).planA?.vpnHost, 'vpn2fa.hku.hk');
    const bad = (planA: Record<string, unknown>) => () => parseHpcConfig({ ...base, planA: { ...base.planA, ...planA } });
    assert.throws(bad({ vpnHost: 'vpn2fa.hku.hk; id' }), /vpnHost/);
    assert.throws(bad({ submitHost: '-oProxyCommand=x' }), /submitHost/);
    assert.throws(bad({ tools: { ocproxy: '/usr/bin/ocproxy -g' } }), /ocproxy/);
    assert.throws(bad({ socksPorts: [80, 90] }), /socksPorts/);
    assert.throws(bad({ extra: 1 }), /unknown field/);
    assert.throws(bad({ sshAuth: 'shared-password' }), /sshUser: required/);
    assert.throws(bad({ sshUser: 'ing; id' }), /sshUser/);
    assert.throws(bad({ submitHost: '-oProxyCommand=x' }), /submitHost/);
    assert.equal(parseHpcConfig({ ...base, planA: { ...base.planA, submitHost: '10.21.36.12', sshUser: 'ing', sshAuth: 'shared-password' } }).planA?.sshUser, 'ing');
    assert.throws(() => parseHpcConfig({ ...base, backend: 'none' }), /only with backend/);
  });
});
