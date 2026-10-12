import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { SshRemoteExports, remoteExports } from '../src/algo/ml-data/remote-exports.js';
import { Exports, type ExportJob } from '../src/algo/ml-data/exports.js';
import { createMlData } from '../src/algo/ml-data/routes.js';
import type { TrainingDatabase } from '../src/algo/ml-data/database.js';
import { principal } from '../src/modules/algo-admin/domain/permissions.js';

const archive = Buffer.from('PK_fixture_compressed_ZIP_contents');
const db: TrainingDatabase = {
  schema: async () => [{ name: 'training.frames', kind: 'table', columns: [], estimatedRows: 504924, bytes: Math.round(8.4 * 1024 ** 3) }],
  query: async () => ({ columns: [], rows: [], elapsedMs: 1, truncated: false }), close: async () => undefined,
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ml-remote-'));
  const key = join(root, 'key'), knownHosts = join(root, 'known_hosts'), mode = join(root, 'mode');
  writeFileSync(key, 'fixture-private-key', { mode: 0o600 }); writeFileSync(knownHosts, 'fixture-pinned-host'); writeFileSync(mode, 'good');
  const command = join(root, 'ssh.mjs');
  writeFileSync(command, [
    '#!/usr/bin/env node',
    'import {readFileSync} from "node:fs";',
    'import {createHash} from "node:crypto";',
    'const mode=readFileSync(' + JSON.stringify(mode) + ',"utf8");',
    'const data=Buffer.from(' + JSON.stringify(archive.toString('base64')) + ',"base64");',
    'const args=process.argv.at(-1).split(" ");',
    'const emit=value=>process.stdout.write(JSON.stringify(value)+"\\n");',
    'if(args[0]==="generate"){',
    ' emit({state:"processing",bytes:0});',
    ' if(mode==="hang"){setInterval(()=>{},1000);}',
    ' else if(mode==="failed"){emit({state:"failed",error:"disk_full"});process.exitCode=1;}',
    ' else if(mode==="unsafe"){emit({state:"failed",error:"postgresql://secret@private-host/database"});process.exitCode=1;}',
    ' else if(mode==="missing"){process.exitCode=0;}',
    ' else {emit({state:"processing",bytes:data.length});emit({state:"completed",bytes:data.length,sha256:createHash("sha256").update(data).digest("hex"),expiresAt:Date.now()+86400000});}',
    '} else if(args[0]==="download"){',
    ' const start=Number(args[2]),length=Number(args[3]);',
    ' if(mode==="slow"){process.stdout.write(data.subarray(start,start+1));setTimeout(()=>process.stdout.write(data.subarray(start+1,start+length)),15000);}',
    ' else process.stdout.write(data.subarray(start,start+length-(mode==="truncated"?1:0)));',
    '} else {process.exitCode=1;}',
  ].join('\n'), { mode: 0o700 });
  const options = { host: 'crowdaware-ml-export@127.0.0.1', port: 2223, key, knownHosts, command };
  return { root, mode, options, remote: new SshRemoteExports(options) };
}
async function finished(exports: Exports, job: ExportJob) {
  for (let i = 0; i < 200; i++) {
    const value = exports.get(job.id, job.owner, job.epoch);
    if (value.state === 'completed' || value.state === 'failed') return value;
    await delay(10);
  }
  throw new Error('remote export did not finish');
}

test('remote archives for an 8.4-GiB table use no edge ZIP/dump or edge disk-space budget and survive a restart', async () => {
  const f = fixture(); let dumps = 0;
  let exports = new Exports(join(f.root, 'receipts'), db, () => { dumps++; throw new Error('Local dump must never run'); },
    16 * 1024 ** 3, Number.MAX_SAFE_INTEGER, f.remote);
  try {
    const job = exports.start('test-owner', 'epoch', ['training.frames']);
    assert.equal(job.state, 'queued');
    const complete = await finished(exports, job);
    assert.equal(complete.state, 'completed'); assert.equal(complete.storage, 'remote');
    assert.equal(complete.bytes, archive.length); assert.equal(dumps, 0);
    assert.equal(complete.sha256, createHash('sha256').update(archive).digest('hex'));
    assert.equal(existsSync(exports.path(job.id)), false);
    assert.equal(existsSync(join(exports.dir, job.id + '.part')), false);
    await exports.stop();
    exports = new Exports(exports.dir, db, () => { throw new Error('unused'); }, 16 * 1024 ** 3, 1, f.remote);
    assert.equal(exports.get(job.id, 'test-owner', 'epoch').storage, 'remote');
    assert.equal(exports.get(job.id, 'test-owner', 'epoch').state, 'completed');
  } finally { await exports.stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test('remote downloads preserve account isolation, private caching, HEAD, byte ranges and detect truncated streams', async () => {
  const f = fixture(); const exports = new Exports(join(f.root, 'receipts'), db, () => { throw new Error('unused'); }, 16 * 1024 ** 3, 1, f.remote);
  let epoch = 'epoch';
  const auth = { principalOf: (req: { headers: { cookie?: string } }) => req.headers.cookie === 'owner' ? principal('owner', 'operator')
    : req.headers.cookie === 'other' ? principal('other', 'admin') : null, accountEpoch: () => epoch };
  const service = createMlData(auth, { env: {}, dataDir: f.root, db, exports });
  const app = express(); app.use(express.json()); app.use('/api/ml-data', service.router);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/ml-data/exports';
  try {
    const response = await fetch(base, { method: 'POST', headers: { cookie: 'owner', 'Content-Type': 'application/json', 'x-tm-algo': '1' },
      body: JSON.stringify({ tables: ['training.frames'] }) });
    assert.equal(response.status, 202);
    const started = await response.json() as ExportJob;
    const job = await finished(exports, { ...started, owner: 'owner', epoch });
    const url = base + '/' + job.id + '/download', headers = { cookie: 'owner' };
    assert.equal((await fetch(url)).status, 401); assert.equal((await fetch(url, { headers: { cookie: 'other' } })).status, 404);
    const head = await fetch(url, { method: 'HEAD', headers });
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(archive.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const full = await fetch(url, { headers });
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), archive);
    assert.match(full.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(full.headers.get('cloudflare-cdn-cache-control'), 'no-store');
    for (const [range, start, end] of [['bytes=0-9', 0, 9], ['bytes=10-', 10, archive.length - 1], ['bytes=-5', archive.length - 5, archive.length - 1]] as const) {
      const partial = await fetch(url, { headers: { ...headers, Range: range } });
      assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), 'bytes ' + start + '-' + end + '/' + archive.length);
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), archive.subarray(start, end + 1));
    }
    const mismatch = await fetch(url, { headers: { ...headers, Range: 'bytes=0-9', 'If-Range': '"old"' } });
    assert.equal(mismatch.status, 200); assert.deepEqual(Buffer.from(await mismatch.arrayBuffer()), archive);
    const invalid = await fetch(url, { headers: { ...headers, Range: 'bytes=99999-' } });
    assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), 'bytes */' + archive.length);
    writeFileSync(f.mode, 'truncated');
    await assert.rejects(async () => { const short = await fetch(url, { headers }); await short.arrayBuffer(); });
    writeFileSync(f.mode, 'slow');
    const active = await fetch(url, { headers });
    epoch = 'replacement';
    await assert.rejects(() => active.arrayBuffer(), 'Revoking the account closes an active remote transfer');
    assert.equal((await fetch(url, { headers })).status, 404);
    assert.equal(existsSync(exports.path(job.id)), false);
  } finally { await service.stop(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(f.root, { recursive: true, force: true }); }
});

test('remote worker failures, incomplete receipts and cancellation never publish an archive or expose diagnostics', async () => {
  const f = fixture(); const exports = new Exports(join(f.root, 'receipts'), db, () => { throw new Error('unused'); }, 16 * 1024 ** 3, 1, f.remote);
  try {
    for (const mode of ['failed', 'unsafe', 'missing']) {
      writeFileSync(f.mode, mode);
      const job = await finished(exports, exports.start('owner', 'epoch', ['training.frames']));
      assert.equal(job.state, 'failed');
      assert.doesNotMatch(job.error ?? '', /secret|private-host|postgresql:\/\//);
      assert.equal(job.sha256, null); assert.equal(existsSync(exports.path(job.id)), false);
      if (mode === 'failed') assert.match(job.error ?? '', /export server needs more free disk space/);
    }
    writeFileSync(f.mode, 'hang');
    const job = exports.start('owner', 'epoch', ['training.frames']);
    await delay(100); await exports.stop();
    assert.equal(job.state, 'failed'); assert.equal(existsSync(exports.path(job.id)), false);
    assert.equal(JSON.parse(readFileSync(join(exports.dir, job.id + '.json'), 'utf8')).state, 'failed');
  } finally { await exports.stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test('remote SSH configuration refuses partial configuration, public keys, invalid ports and shell-shaped hosts', () => {
  const f = fixture();
  try {
    assert.equal(remoteExports({}), null);
    assert.throws(() => remoteExports({ ML_EXPORT_SSH_HOST: f.options.host }), /configured together/);
    assert.throws(() => new SshRemoteExports({ ...f.options, host: 'root@host;exec' }));
    assert.throws(() => new SshRemoteExports({ ...f.options, port: 65536 }));
    chmodSync(f.options.key, 0o644); assert.throws(() => new SshRemoteExports(f.options), /private/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
