/** Real batch-shell execution and saved results when SLURM accounting is off. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseHpcConfig } from '../src/algo/train/config.js';
import type { GatewayDeps } from '../src/algo/train/hpc/gateway.js';
import { Credentials } from '../src/algo/train/hpc/sealed.js';
import { HpcService } from '../src/algo/train/hpc/service.js';
import { parseExitReport } from '../src/algo/train/hpc/slurm.js';
import type { SshLike } from '../src/algo/train/hpc/ssh.js';
import { renderSbatch } from '../src/algo/train/sbatch.js';
import type { JobSpec } from '../src/algo/train/spec.js';
import { JobStore, ProfileStore, type TrainJob } from '../src/algo/train/store.js';
import { packCredentials } from '../src/shared/hpcseal.js';

const spec: JobSpec = {
  name: 'python3_smoke', partition: 'debug', cpusPerTask: 1, memGb: 1, gpus: 0,
  timeLimit: '0:02:00', modules: [], condaEnv: null, entrypoint: 'train.py', args: [], env: {}, notifyEmail: false,
};
const jobId = 'bb998b91-f290-4b55-9469-554ea172a87f';

test('a python3-only node executes one task and keeps its exit result', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tmedge-python3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'code'));
  const python3 = execFileSync('bash', ['-c', 'command -v python3']).toString().trim();
  symlinkSync(python3, join(bin, 'python3'));
  symlinkSync('/bin/mv', join(bin, 'mv'));
  writeFileSync(join(bin, 'srun'), '#!/bin/bash\n[ "$1" = --ntasks=1 ] || exit 99\nshift\nexec "$@"\n', { mode: 0o700 });
  const script = join(dir, 'job.sbatch');
  const rendered = renderSbatch(spec);
  assert.match(rendered, /^#SBATCH --ntasks=1$/m);
  writeFileSync(script, rendered);
  const env = { PATH: bin, SLURM_SUBMIT_DIR: dir, SLURM_JOB_ID: '324' };

  for (const exitCode of [0, 7]) {
    writeFileSync(join(dir, 'code', 'train.py'), `print("one task", flush=True)\nraise SystemExit(${exitCode})\n`);
    const result = spawnSync('/bin/bash', [script], { env, encoding: 'utf8' });
    assert.equal(result.status, exitCode, result.stderr);
    assert.equal(result.stdout, 'one task\n');
    const saved = parseExitReport(readFileSync(join(dir, '.tmedge-exit-324'), 'utf8'), 324);
    assert.equal(saved?.exitCode, exitCode);
    assert.equal(saved?.status, exitCode === 0 ? 'COMPLETED' : 'FAILED');
  }

  // Prefer the active environment's python when it exists, rather than
  // selecting a different interpreter just because it is named python3.
  writeFileSync(join(bin, 'python'), `#!/bin/bash\necho environment-python\nexec ${python3} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(dir, 'code', 'train.py'), 'print("one task", flush=True)\n');
  const active = spawnSync('/bin/bash', [script], { env, encoding: 'utf8' });
  assert.equal(active.status, 0, active.stderr);
  assert.equal(active.stdout, 'environment-python\none task\n');
});

test('an unavailable interpreter fails clearly and its result survives', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tmedge-no-python-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'code'));
  symlinkSync('/bin/mv', join(dir, 'bin', 'mv'));
  const script = join(dir, 'job.sbatch');
  writeFileSync(script, renderSbatch(spec));
  const result = spawnSync('/bin/bash', [script], {
    env: { PATH: join(dir, 'bin'), SLURM_SUBMIT_DIR: dir, SLURM_JOB_ID: '324' }, encoding: 'utf8',
  });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /No Python interpreter found/);
  assert.equal(parseExitReport(readFileSync(join(dir, '.tmedge-exit-324'), 'utf8'), 324)?.exitCode, 127);
});

test('a saved result must belong to this job and contain valid exit and duration fields', () => {
  assert.equal(parseExitReport('TMEDGE_EXIT_V1|324|0|3\n', 324)?.status, 'COMPLETED');
  for (const invalid of [
    'TMEDGE_EXIT_V1|325|0|3', 'TMEDGE_EXIT_V1|324|256|3', 'TMEDGE_EXIT_V1|324|0|-3',
    'TMEDGE_EXIT_V1|324|0|9007199254740992', '0', 'TMEDGE_EXIT_V2|324|0|3',
    'TMEDGE_EXIT_V1|324|0|3\nextra',
  ]) assert.equal(parseExitReport(invalid, 324), null, invalid);
});

test('refresh persists completed and failed results without sacct, and explains missing legacy results', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tmedge-no-accounting-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initial: TrainJob = {
    id: jobId, user: 'alice', spec, status: 'PENDING',
    code: { kind: 'py', filename: 'train.py', bytes: 1, sha256: '', unpackedBytes: 1, fileCount: 1, py: ['train.py'] },
    sbatch: renderSbatch(spec), createdAt: Date.now(), updatedAt: Date.now(), submittedAt: Date.now(),
    startedAt: null, endedAt: null, slurmJobId: 324, remoteDir: `~/hpc-dash/jobs/${jobId}`,
    exitCode: null, lastPolledAt: null, slurmState: 'PENDING', slurmReason: null, elapsedSeconds: null,
    node: null, message: null,
  };
  const { slurmReason: _reason, ...legacy } = initial;
  writeFileSync(join(root, 'jobs.json'), JSON.stringify([legacy]));
  const store = new JobStore(root);
  assert.equal(store.get('alice', jobId)?.slurmReason, null, 'old job records remain readable');
  const profiles = new ProfileStore(root);
  profiles.set('alice', { hkuUid: 'u1', vpnDomain: 'hku.hk' });
  let queue = '';
  let receipt = '';
  const ssh: SshLike = {
    alive: true, open: async () => undefined, close: async () => undefined,
    shellCommand: () => ({ bin: '/bin/true', args: [], home: '/tmp', target: 'u1@cluster.test' }),
    run: async (command) => ({
      code: command.startsWith('sacct ') ? 1 : 0, stderr: '',
      stdout: Buffer.from(command.startsWith('squeue ') ? queue : command.startsWith('if test -f ') ? receipt : ''),
    }),
  };
  const deps: GatewayDeps = {
    now: Date.now, portFree: async () => true, ssh: () => ssh,
    hostKeys: { isPinned: () => true, pin: () => undefined, scan: async () => [] },
    authenticate: async () => ({ cookie: Buffer.from('fake-cookie'), connectUrl: 'https://vpn.test/', fingerprint: 'fake', resolve: null }),
    connectTunnel: async ({ port }) => ({ pid: 1, port, closed: new Promise(() => undefined), close: async () => undefined }),
  };
  const cfg = parseHpcConfig({
    verified: true, backend: 'vpn-ssh', partitions: [{ name: 'debug', maxTime: '2:00:00', gpu: false }],
    defaultPartition: 'debug', modules: [],
    planA: { vpnHost: 'vpn.test', vpnDomains: ['hku.hk'], submitHost: 'cluster.test', socksPorts: [21000, 21099], tools: { openconnect: '/bin/true', ocproxy: '/bin/true', ssh: '/bin/true' } },
  });
  const service = new HpcService(cfg, store, profiles, root, deps);
  t.after(() => service.stop());
  const gateway = service.gateway;
  assert.ok(gateway);
  const credentials = new Credentials(Buffer.from(packCredentials(Buffer.from('fake-pin'), Buffer.from('123456'))));
  try { await gateway.open('alice', 'u1', 'u1@hku.hk', credentials); }
  finally { credentials.wipe(); }

  const refresh = async () => {
    const job = store.get('alice', jobId);
    assert.ok(job);
    const op = service.ops.create('alice', jobId, 'refresh');
    await service.refresh(op, job, null);
    assert.equal(op.events.at(-1)?.type, 'done');
    return store.get('alice', jobId);
  };
  queue = '324|PENDING|Resources|0:00|(null)\n';
  assert.equal((await refresh())?.slurmReason, 'Resources');
  queue = '';
  for (const exitCode of [0, 7]) {
    store.update(initial);
    receipt = `TMEDGE_EXIT_V1|324|${exitCode}|3\n`;
    const updated = await refresh();
    assert.equal(updated?.status, exitCode === 0 ? 'COMPLETED' : 'FAILED');
    assert.equal(updated?.exitCode, exitCode);
    assert.equal(updated?.slurmReason, null, 'an old pending reason is cleared');
    assert.ok(updated?.endedAt);
    assert.equal(new JobStore(root).get('alice', jobId)?.exitCode, exitCode, 'the result survives a server restart');
  }
  store.update({ ...initial, exitCode: 0 });
  receipt = '';
  const unknown = await refresh();
  assert.equal(unknown?.status, 'UNKNOWN', 'a purged legacy job must not stay PENDING forever');
  assert.equal(unknown?.endedAt, null, 'missing evidence is not a completion time');
  assert.equal(unknown?.exitCode, null, 'a pending accounting placeholder is not a successful exit');
  assert.match(unknown?.message ?? '', /Open Log and Stderr/);
});
