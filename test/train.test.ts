/**
 * Claims about module 02 (ML Training on HKU HPC2021), milestone M1:
 * a job spec is validated, rendered to an sbatch script nobody can inject
 * into, built from code whose archive cannot write outside its directory,
 * and visible only to the person who made it. Nothing here reaches HKU.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { after, describe, test } from 'node:test';
import { AlgoUsers, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { loadHpcConfig, parseHpcConfig, parseTimeLimit } from '../src/algo/train/config.js';
import { renderSbatch, shQuote } from '../src/algo/train/sbatch.js';
import { validateSpec, type JobSpec } from '../src/algo/train/spec.js';
import { JobStore } from '../src/algo/train/store.js';
import { extractZip, readZip, ZipError } from '../src/algo/train/zip.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { ConfigError, buildRegistry } from '../src/edge/registry.js';
import { EdgeRuntime } from '../src/edge/runtime.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tmedge-train-'));

const CFG_JSON = {
  verified: false, source: 'test', backend: 'none',
  partitions: [
    { name: 'cpu', maxTime: '2-00:00:00', gpu: false },
    { name: 'gpu', maxTime: '12:00:00', gpu: true, maxGpus: 4 },
  ],
  defaultPartition: 'cpu',
  modules: ['python/3.11', 'cuda/12.1', 'anaconda3'],
  maxUploadMb: 2, maxUnpackedMb: 4, quotaMb: 64,
};
const cfg = parseHpcConfig(CFG_JSON);
const FILES = ['train.py', 'src/model.py'];

const good = (over: Partial<JobSpec> = {}): JobSpec => ({
  name: 'occupancy_gbc', partition: 'cpu', cpusPerTask: 4, memGb: 16, gpus: 0, timeLimit: '2:00:00',
  modules: [], condaEnv: null, entrypoint: 'train.py', args: [], env: {}, notifyEmail: false, ...over,
});

function problemsOf(spec: unknown, files: readonly string[] = FILES): string[] {
  const v = validateSpec(spec, cfg, files);
  return v.ok ? [] : v.problems.map((p) => p.field);
}

// --- config -----------------------------------------------------------------

describe('HPC config', () => {
  test('the shipped config/hpc.json loads: Plan A at HKU, partitions marked unverified until M0', () => {
    const shipped = loadHpcConfig(join(REPO, 'config', 'hpc.json'));
    assert.equal(shipped.backend, 'vpn-ssh');
    assert.equal(shipped.planA?.vpnHost, 'vpn2fa.hku.hk');
    assert.equal(shipped.planA?.submitHost, '10.21.36.12');
    assert.equal(shipped.planA?.sshUser, 'ing');
    assert.equal(shipped.planA?.sshAuth, 'shared-password', 'the shared password is typed each time, never configured');
    assert.equal(shipped.planA?.vpnServerCert, null, 'the real VPN is checked against the system CAs, not a pin');
    assert.equal(shipped.verified, false, 'placeholders must not pose as what sinfo said');
    assert.ok(shipped.maxUploadMb < 100, 'Cloudflare Tunnel refuses request bodies over 100 MB');
  });

  test('is strict: unknown fields, a backend that reaches HKU, bad partitions are refused', () => {
    assert.throws(() => parseHpcConfig({ ...CFG_JSON, extra: 1 }), ConfigError);
    assert.throws(() => parseHpcConfig({ ...CFG_JSON, backend: 'ssh' }), /"none" or "vpn-ssh"/);
    assert.throws(() => parseHpcConfig({ ...CFG_JSON, backend: 'vpn-ssh' }), /planA: required/);
    assert.throws(() => parseHpcConfig({ ...CFG_JSON, defaultPartition: 'nope' }), ConfigError);
    assert.throws(() => parseHpcConfig({ ...CFG_JSON, partitions: [{ name: 'cpu', maxTime: '99', gpu: false }] }), /maxTime/);
    assert.throws(() => parseHpcConfig({ ...CFG_JSON, partitions: [{ name: 'cpu', maxTime: '1:00:00', gpu: false, maxGpus: 2 }] }), /GPU/);
    assert.throws(() => parseHpcConfig({ ...CFG_JSON, modules: ['ok', 'not ok; rm -rf ~'] }), /modules/);
  });

  test('time limits: D-HH:MM:SS and H:MM:SS, nothing else, never zero', () => {
    assert.equal(parseTimeLimit('1-00:00:00'), 86400);
    assert.equal(parseTimeLimit('2:30:00'), 9000);
    assert.equal(parseTimeLimit('100:00:00'), 360000);
    for (const bad of ['0:00:00', '1-24:00:00', '1:60:00', '90', '1-1:00:00', '1:00', '', ' 1:00:00', '1:00:00\n']) {
      assert.equal(parseTimeLimit(bad), null, bad);
    }
  });
});

// --- validation ---------------------------------------------------------------

describe('job spec validation (HANDOVER §6.2)', () => {
  test('a reasonable CPU job and a GPU job pass', () => {
    assert.deepEqual(problemsOf(good()), []);
    assert.deepEqual(problemsOf(good({ partition: 'gpu', gpus: 2, modules: ['cuda/12.1'], condaEnv: 'torch-2.3' })), []);
  });

  test('each field refuses what the handover refuses', () => {
    const cases: [Partial<Record<keyof JobSpec, unknown>>, string][] = [
      [{ name: 'has space' }, 'name'], [{ name: '' }, 'name'], [{ name: 'x'.repeat(41) }, 'name'], [{ name: 'a\n#SBATCH' }, 'name'],
      [{ partition: 'debug' }, 'partition'], [{ partition: 'cpu --exclusive' }, 'partition'],
      [{ cpusPerTask: 0 }, 'cpusPerTask'], [{ cpusPerTask: 65 }, 'cpusPerTask'], [{ cpusPerTask: 2.5 }, 'cpusPerTask'], [{ cpusPerTask: '4' }, 'cpusPerTask'],
      [{ memGb: 0 }, 'memGb'], [{ memGb: 513 }, 'memGb'],
      [{ gpus: 1 }, 'gpus'], [{ gpus: 9 }, 'gpus'], [{ gpus: -1 }, 'gpus'],
      [{ timeLimit: '3-00:00:00' }, 'timeLimit'], [{ timeLimit: '1:00' }, 'timeLimit'], [{ timeLimit: '1:00:00; id' }, 'timeLimit'],
      [{ modules: ['tensorflow'] }, 'modules'], [{ modules: ['anaconda3', 'anaconda3'] }, 'modules'], [{ modules: 'anaconda3' }, 'modules'],
      [{ condaEnv: '../base' }, 'condaEnv'], [{ condaEnv: '--help' }, 'condaEnv'], [{ condaEnv: '..' }, 'condaEnv'], [{ condaEnv: 'a b' }, 'condaEnv'],
      [{ entrypoint: 'missing.py' }, 'entrypoint'], [{ entrypoint: 'src' }, 'entrypoint'], [{ entrypoint: '/etc/x.py' }, 'entrypoint'],
      [{ args: ['x'.repeat(257)] }, 'args'], [{ args: ['ok', 3] }, 'args'], [{ args: ['nul\0byte'] }, 'args'], [{ args: ['\uD800 lone'] }, 'args'],
      [{ args: Array.from({ length: 65 }, () => 'a') }, 'args'],
      [{ env: { lower: 'x' } }, 'env'], [{ env: { '1ABC': 'x' } }, 'env'], [{ env: { 'A B': 'x' } }, 'env'], [{ env: { A: 1 } }, 'env'],
      [{ env: { A: 'x'.repeat(1025) } }, 'env'], [{ env: ['A=1'] }, 'env'],
      [{ notifyEmail: true }, 'notifyEmail'], [{ notifyEmail: 'yes' }, 'notifyEmail'],
    ];
    for (const [over, field] of cases) {
      assert.deepEqual(problemsOf({ ...good(), ...over }), [field], `${JSON.stringify(over)} should fail on ${field}`);
    }
  });

  test('a GPU partition caps GPUs, and its own time limit applies', () => {
    assert.deepEqual(problemsOf(good({ partition: 'gpu', gpus: 5 })), ['gpus']);
    assert.deepEqual(problemsOf(good({ partition: 'gpu', gpus: 1, timeLimit: '13:00:00' })), ['timeLimit']);
  });

  test('unknown fields are refused rather than ignored', () => {
    assert.deepEqual(problemsOf({ ...good(), sbatchExtra: '--exclusive' }), ['sbatchExtra']);
  });

  test('an entrypoint that python would read as an option is refused even if the file exists', () => {
    assert.deepEqual(problemsOf(good({ entrypoint: '-m.py' }), ['-m.py']), ['entrypoint']);
  });
});

// --- rendering ------------------------------------------------------------------

describe('sbatch rendering (HANDOVER §6.3)', () => {
  const GOLDEN = join(REPO, 'test', 'golden', 'train');
  const variants: Record<string, JobSpec> = {
    cpu: good(),
    gpu: good({ name: 'resnet-smoke', partition: 'gpu', gpus: 2, cpusPerTask: 8, memGb: 64, timeLimit: '0-06:00:00', modules: ['cuda/12.1'] }),
    conda: good({ modules: ['anaconda3'], condaEnv: 'myseat-py311' }),
    'args-env': good({
      entrypoint: 'src/model.py', args: ['--data', '~/data/seat q3.parquet', '--epochs', '10', "it's", '$(id)'],
      env: { OMP_NUM_THREADS: '4', WANDB_MODE: 'offline', NOTE: 'a "quoted" $HOME' },
    }),
  };

  for (const [name, spec] of Object.entries(variants)) {
    test(`golden: ${name}`, () => {
      const out = renderSbatch(spec);
      const file = join(GOLDEN, `${name}.sbatch`);
      if (process.env.UPDATE_GOLDEN === '1') { mkdirSync(GOLDEN, { recursive: true }); writeFileSync(file, out); }
      assert.equal(out, readFileSync(file, 'utf8'));
    });
  }

  test('golden: mail (for when M0 and the HPC profile allow it)', () => {
    const out = renderSbatch({ ...good(), notifyEmail: true }, { mailUser: 'tmchan@connect.hku.hk' });
    const file = join(GOLDEN, 'mail.sbatch');
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(file, out);
    assert.equal(out, readFileSync(file, 'utf8'));
    assert.throws(() => renderSbatch({ ...good(), notifyEmail: true }), /HKU address/);
    assert.throws(() => renderSbatch({ ...good(), notifyEmail: true }, { mailUser: 'x@evil.example' }), /HKU address/);
  });

  test('shQuote matches Python shlex.quote', () => {
    assert.equal(shQuote(''), "''");
    assert.equal(shQuote('--epochs'), '--epochs');
    assert.equal(shQuote('a/b.py'), 'a/b.py');
    assert.equal(shQuote('a b'), "'a b'");
    assert.equal(shQuote("it's"), `'it'"'"'s'`);
    assert.equal(shQuote('é'), "'é'", 'non-ASCII is quoted: \\w is ASCII-only, as in shlex');
  });
});

// --- hostile input through a real shell -------------------------------------------

/** Deterministic, so a failure can be replayed. */
function prng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PIECES = ["'", '"', '$', '`', '\\', '!', ';', '&', '|', '<', '>', '(', ')', '{', '}', '[', ']', '*', '?', '~', '#',
  '\n', '\t', '\r', ' ', '%', '=', ':', ',', '.', '/', '-', '_', '@', '+', '^', 'a', 'Z', '0', '$(id)', '`id`',
  '${HOME}', `'"'"'`, 'é', '中', '😀', '\u202e', '\u200b', '\x01', '\x7f', '--', '-n', '-e', '%s', '\\n', '$((1+1))', '!!'];
function hostile(rand: () => number, maxPieces = 12): string {
  let s = '';
  const n = Math.floor(rand() * (maxPieces + 1));
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(rand() * PIECES.length)];
  return s;
}

describe('injection: user strings reach the program byte for byte (T4-7)', () => {
  test('10,000 hostile strings survive shQuote through bash unchanged', () => {
    const rand = prng(20261006);
    const inputs = Array.from({ length: 10_000 }, () => hostile(rand, 16));
    const script = inputs.map((s) => `printf '%s\\0' ${shQuote(s)}`).join('\n');
    // On stdin: as one argument it would pass Linux's 128 kB per-argument limit.
    const out = execFileSync('bash', ['-s'], { input: script, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\0');
    out.pop();
    assert.equal(out.length, inputs.length);
    for (let i = 0; i < inputs.length; i++) assert.equal(out[i], inputs[i], `input #${i}: ${JSON.stringify(inputs[i])}`);
  });

  test('rendered scripts, run by bash with SLURM stubbed, pass every value through exactly', () => {
    const rand = prng(918273);
    const work = mkdtempSync(join(tmpdir(), 'tmedge-sbatch-'));
    mkdirSync(join(work, 'code'));
    mkdirSync(join(work, 'conda', 'etc', 'profile.d'), { recursive: true });
    writeFileSync(join(work, 'conda', 'etc', 'profile.d', 'conda.sh'), '');
    // Files a zip may legitimately contain: spaces and quotes are allowed in names.
    const files = ['train.py', 'src/my model.py', "we'ird $(x).py", 'a;b`c`.py'];
    const keys = ['OMP_NUM_THREADS', 'DATA', 'X_1', '_Y'];
    const stubs = [
      'rec() { printf "%s\\0%s\\0" "$1" "$(( $# - 1 ))" >> "$OUT"; shift; for a in "$@"; do printf "%s\\0" "$a" >> "$OUT"; done; }',
      'module() { rec module "$@"; }',
      'conda() { if [ "$1" = info ]; then printf "%s\\n" "$STUB_CONDA"; else rec conda "$@"; fi; }',
      'srun() { rec srun "$@"; for k in $KEYS; do printf "%s\\0" "${!k-<unset>}" >> "$ENVOUT"; done; }',
      'source "$SCRIPT"',
    ].join('\n');
    let ran = 0;
    let refused = 0;
    for (let i = 0; i < 300; i++) {
      const args = Array.from({ length: Math.floor(rand() * 5) }, () => hostile(rand));
      const env: Record<string, string> = {};
      for (const k of keys) if (rand() < 0.4) env[k] = hostile(rand);
      const spec = {
        ...good(),
        name: rand() < 0.1 ? hostile(rand, 3) : `job_${i}`,
        modules: cfg.modules.filter(() => rand() < 0.4),
        condaEnv: rand() < 0.3 ? null : rand() < 0.5 ? 'torch-2.3' : hostile(rand, 3),
        entrypoint: files[Math.floor(rand() * files.length)]!,
        args, env,
      };
      const v = validateSpec(spec, cfg, files);
      if (!v.ok) { refused++; continue; }
      const script = renderSbatch(v.spec);
      // sbatch reads #SBATCH lines only up to the first command; nothing a
      // user typed may add or change one there.
      const header = script.split('\n').slice(1, script.split('\n').findIndex((l) => l.trim() !== '' && !l.startsWith('#')));
      for (const line of header.filter((l) => l.startsWith('#SBATCH'))) {
        assert.match(line, /^#SBATCH --(job-name=[A-Za-z0-9_-]+|partition=(cpu|gpu)|time=[0-9:-]+|cpus-per-task=\d+|mem=\d+G|gres=gpu:\d|output=slurm-%j\.out|error=slurm-%j\.err)$/, line);
      }
      const scriptPath = join(work, 'job.sbatch');
      const out = join(work, 'calls');
      const envOut = join(work, 'env');
      writeFileSync(scriptPath, script);
      writeFileSync(out, '');
      writeFileSync(envOut, '');
      execFileSync('bash', ['-c', stubs], {
        env: { PATH: process.env.PATH, SLURM_SUBMIT_DIR: work, STUB_CONDA: join(work, 'conda'), SCRIPT: scriptPath,
          OUT: out, ENVOUT: envOut, KEYS: Object.keys(v.spec.env).join(' ') },
      });
      const fields = readFileSync(out, 'utf8').split('\0');
      const calls: string[][] = [];
      for (let p = 0; p < fields.length - 1;) {
        const name = fields[p]!;
        const argc = Number(fields[p + 1]);
        calls.push([name, ...fields.slice(p + 2, p + 2 + argc)]);
        p += 2 + argc;
      }
      const expected = [
        ['module', 'purge'], ...v.spec.modules.map((m) => ['module', 'load', m]),
        ...(v.spec.condaEnv ? [['conda', 'activate', v.spec.condaEnv]] : []),
        ['srun', 'python', v.spec.entrypoint, ...v.spec.args],
      ];
      assert.deepEqual(calls, expected, `seed case ${i}: ${JSON.stringify(v.spec)}`);
      const envValues = readFileSync(envOut, 'utf8').split('\0').slice(0, -1);
      assert.deepEqual(envValues, Object.values(v.spec.env), `env, case ${i}`);
      ran++;
    }
    assert.ok(ran > 150, `most generated specs are valid and were run (${ran} ran, ${refused} refused)`);
    assert.ok(refused > 0, 'and hostile names or conda envs were refused, not rendered');
  });
});

// --- zip safety ---------------------------------------------------------------------

interface Z {
  name: string; data?: Buffer; method?: 0 | 8; unix?: number; flags?: number;
  /** Declared uncompressed size, when it should lie. */
  size?: number; crc?: number;
  /** Reuse an earlier entry's local header and data (the overlapping-entry bomb). */
  sameDataAs?: number;
  localName?: string;
  /** Sizes in a trailing data descriptor, as streaming zippers write them. */
  descriptor?: boolean;
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crcOf = (b: Buffer) => { let c = ~0; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return ~c >>> 0; };

function makeZip(list: Z[], comment = ''): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  const offsets: number[] = [];
  let off = 0;
  for (const z of list) {
    const data = z.data ?? Buffer.alloc(0);
    const method = z.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = z.crc ?? crcOf(data);
    const size = z.size ?? data.length;
    const flags = (z.flags ?? 0x800) | (z.descriptor ? 0x8 : 0);
    const name = Buffer.from(z.name);
    let at: number;
    if (z.sameDataAs !== undefined) at = offsets[z.sameDataAs]!;
    else {
      const lname = Buffer.from(z.localName ?? z.name);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(flags, 6); h.writeUInt16LE(method, 8);
      if (!z.descriptor) { h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(size, 22); }
      h.writeUInt16LE(lname.length, 26);
      at = off;
      parts.push(h, lname, body);
      off += 30 + lname.length + body.length;
      if (z.descriptor) {
        const d = Buffer.alloc(16);
        d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc, 4); d.writeUInt32LE(body.length, 8); d.writeUInt32LE(size, 12);
        parts.push(d);
        off += 16;
      }
    }
    offsets.push(at);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(z.unix !== undefined ? (3 << 8) | 20 : 20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(z.unix !== undefined ? (z.unix << 16) >>> 0 : 0, 38); c.writeUInt32LE(at, 42);
    central.push(c, name);
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(list.length, 8); e.writeUInt16LE(list.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16); e.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...parts, cd, e, Buffer.from(comment)]);
}

const LIMITS = { maxEntries: 50, maxUnpackedBytes: 1024 * 1024 };
const py = (s: string) => Buffer.from(s);

async function unpack(buf: Buffer, limits = LIMITS): Promise<{ dest: string; paths: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'tmedge-zip-'));
  const file = join(dir, 'in.zip');
  writeFileSync(file, buf);
  const { entries } = await readZip(file, limits);
  const dest = join(dir, 'out');
  await extractZip(file, dest, entries);
  return { dest, paths: entries.filter((e) => !e.dir && !e.skip).map((e) => e.path) };
}

describe('zip uploads (HANDOVER §6.2, T4-8)', () => {
  test('a normal project unpacks, Mac litter is left out, data descriptors are fine', async () => {
    const { dest, paths } = await unpack(makeZip([
      { name: 'proj/', unix: 0o040755 },
      { name: 'proj/train.py', data: py('print("hi")\n'), unix: 0o100644 },
      { name: 'proj/lib/util.py', data: py('X = 1\n'.repeat(500)), descriptor: true },
      { name: 'proj/README', data: py('readme'), method: 0 },
      { name: 'proj/empty.txt' },
      { name: '__MACOSX/proj/._train.py', data: py('junk') },
      { name: 'proj/.DS_Store', data: py('junk') },
    ]));
    assert.deepEqual(paths, ['proj/train.py', 'proj/lib/util.py', 'proj/README', 'proj/empty.txt']);
    assert.equal(readFileSync(join(dest, 'proj', 'train.py'), 'utf8'), 'print("hi")\n');
    assert.equal(readFileSync(join(dest, 'proj', 'lib', 'util.py'), 'utf8'), 'X = 1\n'.repeat(500));
    assert.equal(existsSync(join(dest, '__MACOSX')), false);
    assert.equal(existsSync(join(dest, 'proj', '.DS_Store')), false);
  });

  const refusals: [string, Z[], RegExp, typeof LIMITS?][] = [
    ['zip-slip with ..', [{ name: '../evil.py', data: py('x') }], /"\.\."/],
    ['.. in the middle', [{ name: 'a/../../evil.py', data: py('x') }], /"\.\."/],
    ['an absolute path', [{ name: '/etc/cron.d/x', data: py('x') }], /absolute/],
    ['a Windows drive path', [{ name: 'C:/x.py', data: py('x') }], /absolute/],
    ['backslash traversal', [{ name: '..\\evil.py', data: py('x') }], /backslash/],
    ['a symlink', [{ name: 'link', data: py('/etc/passwd'), unix: 0o120777 }], /symbolic/],
    ['a device file', [{ name: 'dev', unix: 0o020644 }], /only files and directories/],
    ['an encrypted entry', [{ name: 'x.py', data: py('x'), flags: 0x801 }], /encrypted/],
    ['a duplicate name', [{ name: 'x.py', data: py('a') }, { name: 'x.py', data: py('b') }], /twice/],
    ['a file that is also a directory', [{ name: 'a', data: py('a') }, { name: 'a/b.py', data: py('b') }], /both a file and a directory/],
    ['too many entries', Array.from({ length: 51 }, (_, i) => ({ name: `f${i}.py`, data: py('x') })), /more than 50 entries/],
    ['a declared size past the unpacked limit', [{ name: 'big.py', data: py('x'), size: 2 * 1024 * 1024 }], /unpacks to more than/],
    ['overlapping entries', [{ name: 'a.py', data: Buffer.alloc(1000) }, { name: 'b.py', data: Buffer.alloc(1000), sameDataAs: 0 }], /overlaps/],
    ['a local name that disagrees with the directory', [{ name: 'ok.py', localName: '../x.py', data: py('x') }], /local name/],
    ['a NUL in a name', [{ name: 'a\0b.py', data: py('x') }], /control characters/],
  ];
  for (const [what, list, re, limits] of refusals) {
    test(`refuses ${what}`, async () => {
      await assert.rejects(unpack(makeZip(list), limits), (err: Error) => err instanceof ZipError && re.test(err.message));
    });
  }

  test('refuses an unsupported compression method', async () => {
    const buf = makeZip([{ name: 'x.py', data: py('x'), method: 0 }]);
    // Patch both headers' method to 12 (bzip2).
    buf.writeUInt16LE(12, 8);
    const cdAt = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt16LE(12, cdAt + 10);
    await assert.rejects(unpack(buf), /compression method 12/);
  });

  test('a bomb that lies about its size is stopped at the size it declared', async () => {
    const zeros = Buffer.alloc(3 * 1024 * 1024);
    await assert.rejects(unpack(makeZip([{ name: 'bomb.py', data: zeros, size: 1000 }])), /inflates past its declared size/);
  });

  test('a corrupt entry is caught by its CRC', async () => {
    await assert.rejects(unpack(makeZip([{ name: 'x.py', data: py('hello'), crc: 1234 }])), /CRC mismatch/);
  });

  test('not a zip at all, truncated, or ZIP64 is refused politely', async () => {
    await assert.rejects(unpack(Buffer.from('print(1)\n')), /not a zip/);
    const whole = makeZip([{ name: 'x.py', data: py('x') }]);
    await assert.rejects(unpack(whole.subarray(0, whole.length - 5)), /not a zip/);
    const z64 = makeZip([{ name: 'x.py', data: py('x') }]);
    z64.writeUInt32LE(0xffffffff, z64.length - 22 + 16);
    await assert.rejects(unpack(z64), /ZIP64/);
  });
});

// --- the store --------------------------------------------------------------------------

describe('job store', () => {
  test('an unreadable jobs.json is never overwritten', () => {
    const root = mkdtempSync(join(tmpdir(), 'tmedge-store-'));
    writeFileSync(join(root, 'jobs.json'), '[{"half": ');
    const store = new JobStore(root);
    assert.match(store.error ?? '', /unreadable/);
    assert.throws(() => store.list('alice'), /unreadable/);
    assert.equal(readFileSync(join(root, 'jobs.json'), 'utf8'), '[{"half": ', 'left exactly as found');
  });
});

// --- over HTTP ------------------------------------------------------------------------------

function runtime() {
  const c: EdgeConfig = {
    edgeId: 'test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', dataDir: mkdtempSync(join(tmpdir(), 'tmedge-')), recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null, pushUrls: [], pushToken: '', publishMs: 1000,
    gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  return new EdgeRuntime(c, buildRegistry(siteJson(), nodesJson()));
}

const running: (() => Promise<void>)[] = [];
after(async () => { for (const stop of running) await stop(); });

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'tmedge-train-http-'));
  process.env.DATA_DIR = join(dir, 'data');
  process.env.HPC_CONFIG = join(dir, 'hpc.json');
  writeFileSync(process.env.HPC_CONFIG, JSON.stringify(CFG_JSON));
  const usersPath = join(dir, 'users.json');
  await new AlgoUsers(usersPath).add('alice', 'correct horse battery');
  await new AlgoUsers(usersPath).add('bob', 'battery staple horse');
  const rt = runtime();
  const { server } = startAlgo(rt, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: usersPath }, 'admin-pass'));
  const base = await new Promise<string>((r) => {
    const done = () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    if (server.listening) done(); else server.once('listening', done);
  });
  running.push(async () => { server.close(); await rt.stop(); });
  const login = async (username: string, password: string) => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };
  const root = join(process.env.DATA_DIR, 'algo', 'train');
  return { base, root, alice: await login('alice', 'correct horse battery'), bob: await login('bob', 'battery staple horse') };
}

const W = { 'x-tm-algo': '1' };
const upload = (base: string, cookie: string, filename: string, body: Buffer, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/train/uploads?filename=${encodeURIComponent(filename)}`, {
    method: 'POST', headers: { cookie, ...W, 'content-type': 'application/octet-stream', ...headers }, body,
  });
const send = (base: string, cookie: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}/api/train${path}`, {
    method, headers: { cookie, ...W, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('module 02 over HTTP', () => {
  test('a draft round trip: upload, create, read back, edit, delete', async () => {
    const { base, root, alice } = await boot();
    const up = await upload(base, alice, 'train.py', py('print("epoch 1")\n'));
    assert.equal(up.status, 201);
    const { upload: u } = await up.json() as { upload: { id: string; py: string[]; sha256: string } };
    assert.deepEqual(u.py, ['train.py']);

    const created = await send(base, alice, 'POST', '/jobs', { uploadId: u.id, spec: good() });
    assert.equal(created.status, 201);
    const { job } = await created.json() as { job: { id: string; status: string; sbatch: string } };
    assert.equal(job.status, 'DRAFT');
    assert.equal(job.sbatch, renderSbatch(good()), 'the preview is the script that would be submitted');
    assert.equal(existsSync(join(root, 'jobs', job.id, 'code', 'train.py')), true);
    assert.equal((await send(base, alice, 'POST', '/jobs', { uploadId: u.id, spec: good() })).status, 400, 'an upload is adopted once');

    const list = await (await fetch(`${base}/api/train/jobs`, { headers: { cookie: alice } })).json() as { jobs: { id: string }[] };
    assert.deepEqual(list.jobs.map((j) => j.id), [job.id]);
    const file = await fetch(`${base}/api/train/jobs/${job.id}/file?path=train.py`, { headers: { cookie: alice } });
    assert.equal(await file.text(), 'print("epoch 1")\n');

    const edited = await send(base, alice, 'PUT', `/jobs/${job.id}`, { spec: good({ cpusPerTask: 8 }) });
    assert.equal(edited.status, 200);
    assert.match(((await edited.json()) as { job: { sbatch: string } }).job.sbatch, /--cpus-per-task=8/);

    const copy = await send(base, alice, 'POST', '/jobs', { fromJobId: job.id, spec: good({ name: 'again', cpusPerTask: 2 }) });
    assert.equal(copy.status, 201, 'a new draft from a job\'s code');
    const copied = ((await copy.json()) as { job: { id: string } }).job.id;
    assert.equal(readFileSync(join(root, 'jobs', copied, 'code', 'train.py'), 'utf8'), 'print("epoch 1")\n');

    assert.equal((await send(base, alice, 'DELETE', `/jobs/${job.id}`)).status, 200);
    assert.equal(existsSync(join(root, 'jobs', copied, 'code', 'train.py')), true, 'the copy keeps its own code');
    assert.equal(existsSync(join(root, 'jobs', job.id)), false);
    const audit = readFileSync(join(root, 'audit.jsonl'), 'utf8');
    assert.match(audit, /"action":"create"/);
    assert.match(audit, /"action":"delete"/);
  });

  test("another person's job is a 404 on every endpoint, and their upload cannot be borrowed", async () => {
    const { base, alice, bob } = await boot();
    const { upload: u } = await (await upload(base, alice, 'train.py', py('pass\n'))).json() as { upload: { id: string } };
    const { job } = await (await send(base, alice, 'POST', '/jobs', { uploadId: u.id, spec: good() })).json() as { job: { id: string } };
    assert.equal((await fetch(`${base}/api/train/jobs/${job.id}`, { headers: { cookie: bob } })).status, 404);
    assert.equal((await fetch(`${base}/api/train/jobs/${job.id}/file?path=train.py`, { headers: { cookie: bob } })).status, 404);
    assert.equal((await send(base, bob, 'PUT', `/jobs/${job.id}`, { spec: good() })).status, 404);
    assert.equal((await send(base, bob, 'DELETE', `/jobs/${job.id}`)).status, 404);
    const listed = await (await fetch(`${base}/api/train/jobs`, { headers: { cookie: bob } })).json() as { jobs: unknown[] };
    assert.deepEqual(listed.jobs, []);

    assert.equal((await send(base, bob, 'POST', '/jobs', { fromJobId: job.id, spec: good() })).status, 400, 'nor copied');
    const { upload: u2 } = await (await upload(base, alice, 'other.py', py('pass\n'))).json() as { upload: { id: string } };
    assert.equal((await send(base, bob, 'POST', '/jobs', { uploadId: u2.id, spec: good({ entrypoint: 'other.py' }) })).status, 400);
    assert.equal((await fetch(`${base}/api/train/uploads/${u2.id}/file?path=other.py`, { headers: { cookie: bob } })).status, 404);
    assert.equal((await fetch(`${base}/api/train/jobs/${job.id}`, { headers: { cookie: alice } })).status, 200, 'and it is still there');
  });

  test('signed out is 401; a write without the console header is 403', async () => {
    const { base, alice } = await boot();
    assert.equal((await fetch(`${base}/api/train/config`)).status, 401);
    const res = await fetch(`${base}/api/train/uploads?filename=x.py`, {
      method: 'POST', headers: { cookie: alice, 'content-type': 'application/octet-stream' }, body: 'pass',
    });
    assert.equal(res.status, 403);
  });

  test('uploads: size, type and name are checked before anything is kept', async () => {
    const { base, root, alice } = await boot();
    assert.equal((await upload(base, alice, 'big.py', Buffer.alloc(5 * 1024 * 1024 + 1, 0x41))).status, 413);
    assert.equal((await upload(base, alice, 'big.zip', Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await upload(base, alice, 'train.exe', py('MZ'))).status, 400);
    assert.equal((await upload(base, alice, '../train.py', py('x'))).status, 400);
    assert.equal((await upload(base, alice, '.hidden.py', py('x'))).status, 400);
    assert.equal((await upload(base, alice, 'empty.py', Buffer.alloc(0))).status, 400);
    assert.equal((await upload(base, alice, 'latin1.py', Buffer.from([0x23, 0xe9, 0x0a]))).status, 400, 'not UTF-8');
    assert.equal((await upload(base, alice, 'x.py', py('{"code":"print(1)"}'), { 'content-type': 'application/json' })).status, 415);
    const slip = await upload(base, alice, 'evil.zip', makeZip([{ name: '../../evil.py', data: py('x') }]));
    assert.equal(slip.status, 400);
    assert.match(((await slip.json()) as { error: string }).error, /"\.\."/);
    assert.deepEqual(readdirSync(join(root, 'uploads')), [], 'a refused upload leaves nothing behind');
    assert.deepEqual(readdirSync(join(root, 'incoming')), []);
  });

  test('a zip project: its .py files are the entrypoint choices', async () => {
    const { base, alice } = await boot();
    const res = await upload(base, alice, 'proj.zip', makeZip([
      { name: 'src/train.py', data: py('import model\n') }, { name: 'src/model.py', data: py('W = 1\n') },
      { name: 'data/notes.txt', data: py('n') },
    ]));
    assert.equal(res.status, 201);
    const { upload: u } = await res.json() as { upload: { id: string; py: string[]; fileCount: number } };
    assert.deepEqual(u.py, ['src/model.py', 'src/train.py']);
    assert.equal(u.fileCount, 3);
    assert.equal(await (await fetch(`${base}/api/train/uploads/${u.id}/file?path=src/train.py`, { headers: { cookie: alice } })).text(), 'import model\n');
    const bad = await send(base, alice, 'POST', '/jobs', { uploadId: u.id, spec: good() });
    assert.equal(bad.status, 400, 'train.py is not at the root of this project');
    assert.deepEqual(((await bad.json()) as { problems: { field: string }[] }).problems.map((p) => p.field), ['entrypoint']);
    assert.equal((await send(base, alice, 'POST', '/jobs', { uploadId: u.id, spec: good({ entrypoint: 'src/train.py' }) })).status, 201);
  });

  test('preview judges and renders a spec without saving anything', async () => {
    const { base, root, alice } = await boot();
    const ok = await (await send(base, alice, 'POST', '/preview', { spec: good(), py: ['train.py'] })).json();
    assert.deepEqual(ok, { ok: true, sbatch: renderSbatch(good()) }, 'the same renderer the save uses');
    const bad = await (await send(base, alice, 'POST', '/preview', { spec: good({ name: 'x y' }), py: ['train.py'] })).json() as { ok: boolean; problems: { field: string }[] };
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.problems.map((p) => p.field), ['name']);
    assert.deepEqual(readdirSync(join(root, 'jobs')), []);
  });

  test('the shell page admits only its own fresh style nonce, never unsafe-inline',
    { skip: existsSync(join(REPO, 'public-algo', 'index.html')) ? false : 'needs the built console (npm run build)' }, async () => {
      const { base, alice } = await boot();
      const nonces: string[] = [];
      for (let i = 0; i < 2; i++) {
        const page = await fetch(`${base}/train`, { headers: { cookie: alice } });
        const nonce = /<meta name="csp-nonce" content="([^"]+)">/.exec(await page.text())?.[1] ?? '';
        assert.ok(nonce.length >= 22, 'a nonce is in the page for the editor to use');
        const csp = page.headers.get('content-security-policy') ?? '';
        assert.ok(csp.includes(`style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com;`), csp);
        assert.doesNotMatch(csp, /unsafe-inline/);
        nonces.push(nonce);
      }
      assert.notEqual(nonces[0], nonces[1], 'per page, not per process');
      const api = await fetch(`${base}/api/train/config`, { headers: { cookie: alice } });
      assert.doesNotMatch(api.headers.get('content-security-policy') ?? '', /nonce/, 'nothing else carries one');
    });

  test('with Plan A switched off, submit refuses before reading any credential', async () => {
    const { base, alice } = await boot();
    const config = await (await fetch(`${base}/api/train/config`, { headers: { cookie: alice } })).json() as { hpc: { available: boolean; reason: string } };
    assert.equal(config.hpc.available, false);
    assert.match(config.hpc.reason, /not switched on/);
    const { upload: u } = await (await upload(base, alice, 'train.py', py('pass\n'))).json() as { upload: { id: string } };
    const { job } = await (await send(base, alice, 'POST', '/jobs', { uploadId: u.id, spec: good() })).json() as { job: { id: string; status: string } };
    const r = await send(base, alice, 'POST', `/jobs/${job.id}/submit`, { sealed: { kid: 'x', epk: 'y', iv: 'z', ct: 'w' } });
    assert.equal(r.status, 503);
    const after = await (await fetch(`${base}/api/train/jobs/${job.id}`, { headers: { cookie: alice } })).json() as { job: { status: string } };
    assert.equal(after.job.status, 'DRAFT', 'and the draft is untouched');
    assert.equal((await send(base, alice, 'POST', `/jobs/${job.id}/refresh`, {})).status, 409, 'nothing to refresh: never sent');
  });
});
