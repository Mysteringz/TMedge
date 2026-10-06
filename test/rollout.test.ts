/**
 * Claims about firmware updates: who gets flashed, in what order, and what
 * happens when it goes wrong. A node on a ceiling is expensive to reach, so
 * these are the rules that keep a bad build from costing a floor.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FirmwareStore, safeRelativePath, FirmwareError } from '../src/edge/firmware.js';
import { Rollouts, type RolloutDeps, type RolloutNode } from '../src/edge/rollout.js';

const IMAGE = { bytes: Buffer.alloc(1024, 7), sha256: 'ab'.repeat(32), size: 1024, version: 'tmsense-1.2' };

function harness(nodes: RolloutNode[], image = IMAGE) {
  let clock = 1_000_000;
  const sent: { uid: string; port: number }[] = [];
  const noteSent = (uid: string, port: number) => sent.push({ uid, port });
  const images: string[] = [];
  const rollouts = new Rollouts({
    image: () => image,
    nodes: () => nodes,
    sendImageToGateway: (id) => {
      images.push(id);
      return true;
    },
    sendOta: (uid, image) => {
      noteSent(uid, image.port);
      return Promise.resolve();
    },
    directPort: 8090,
    now: () => clock,
  } satisfies RolloutDeps, { imageMs: 10_000, flashMs: 30_000, confirmMs: 60_000, batch: 2 });

  const ready = (gatewayId: string) => rollouts.onImageReady(gatewayId, { id: 'beef1234beef1234', ok: true, port: 5282 });
  const report = (uid: string, state: string, percent = 0, error = 'none') =>
    rollouts.onOtaStatus(uid, { state, percent, error, image: 'beef1234' });
  const advance = (ms: number) => {
    clock += ms;
    rollouts.tick();
  };
  return { rollouts, sent, images, ready, report, advance, clock: () => clock };
}

const node = (uid: string, over: Partial<RolloutNode> = {}): RolloutNode => {
  const n: RolloutNode = { uid, label: `Above ${uid}`, floorId: 'iw-maker-a', address: 'gw:esanhouse|192.168.0.9:5200', transport: 'gateway', online: true, ...over };
  if (over.transport === undefined) n.transport = n.address === null ? null : n.address.startsWith('gw:') ? 'gateway' : 'udp';
  return n;
};

test('the pilot goes alone: nothing else is touched until it confirms', () => {
  const h = harness([node('n1'), node('n2'), node('n3')]);
  const r = h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester');
  assert.equal(r.stage, 'pilot');
  assert.equal(h.images.length, 1, 'the image goes to the gateway once');
  assert.equal(h.sent.length, 0, 'nothing is asked to flash before the gateway has the image');

  h.ready('esanhouse');
  assert.deepEqual(h.sent.map((s) => s.uid), ['n1'], 'only the pilot');
  h.report('n1', 'downloading', 40);
  h.advance(1000);
  assert.deepEqual(h.sent.map((s) => s.uid), ['n1'], 'still only the pilot while it works');

  h.report('n1', 'confirmed', 100);
  assert.equal(h.rollouts.current()?.stage, 'rest');
  assert.deepEqual(h.sent.map((s) => s.uid), ['n1', 'n2', 'n3'], 'the rest follow, up to the batch size');
});

test('encryption enrollment refuses accidental OTA downgrade before touching a node', () => {
  for (const version of ['tmsense-1.6', 'unknown', 'custom', 'tmsense-1.2']) {
    const h = harness([node('n1', { encryptionRequired: true })], { ...IMAGE, version });
    assert.throws(() => h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester'), /plaintext downgrade refused/);
    assert.equal(h.sent.length, 0); assert.equal(h.images.length, 0);
  }
  const h = harness([node('n1', { encryptionRequired: true })], { ...IMAGE, version: 'tmsense-1.7' });
  assert.equal(h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester').stage, 'pilot');
});

test('the rest go a few at a time, not all at once', () => {
  const h = harness([node('n1'), node('n2'), node('n3'), node('n4'), node('n5')]);
  h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester');
  h.ready('esanhouse');
  h.report('n1', 'confirmed', 100);
  // batch is 2 in this harness: two of the four go, the others wait.
  assert.deepEqual(h.sent.map((s) => s.uid), ['n1', 'n2', 'n3']);
  h.report('n2', 'confirmed', 100);
  assert.deepEqual(h.sent.map((s) => s.uid), ['n1', 'n2', 'n3', 'n4'], 'one finishing lets one more start');
});

test('a pilot that fails stops the rollout and leaves every other node alone', () => {
  const h = harness([node('n1'), node('n2'), node('n3')]);
  h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester');
  h.ready('esanhouse');
  h.report('n1', 'failed', 0, 'sha');

  const r = h.rollouts.current();
  assert.equal(r?.stage, 'stopped');
  assert.equal(r?.nodes[0]?.state, 'failed');
  assert.deepEqual(r?.nodes.slice(1).map((n) => n.state), ['skipped', 'skipped']);
  assert.deepEqual(h.sent.map((s) => s.uid), ['n1'], 'no other node was ever asked to flash');
  assert.match(r?.note ?? '', /kept its firmware/);
});

test('a node that reverts counts as a failure, not a success', () => {
  const h = harness([node('n1'), node('n2')]);
  h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester');
  h.ready('esanhouse');
  h.report('n1', 'rebooting', 100);
  h.report('n1', 'reverted');
  const r = h.rollouts.current();
  assert.equal(r?.nodes[0]?.state, 'failed');
  assert.match(r?.nodes[0]?.error ?? '', /did not come up/);
  assert.equal(r?.stage, 'stopped');
});

test('a node that goes quiet after rebooting is failed, not left hanging', () => {
  const h = harness([node('n1'), node('n2')]);
  h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester');
  h.ready('esanhouse');
  h.report('n1', 'rebooting', 100);
  h.advance(59_000);
  assert.equal(h.rollouts.current()?.nodes[0]?.state, 'rebooting', 'still within its window');
  h.advance(5_000);
  assert.equal(h.rollouts.current()?.nodes[0]?.state, 'failed');
  assert.match(h.rollouts.current()?.nodes[0]?.error ?? '', /did not come back/);
});

test('a gateway that never takes the image fails its nodes rather than hanging', () => {
  const h = harness([node('n1')]);
  h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester');
  h.advance(11_000);
  assert.equal(h.rollouts.current()?.nodes[0]?.state, 'failed');
  assert.match(h.rollouts.current()?.nodes[0]?.error ?? '', /never took the image/);
});

test('targets pick the right nodes, and offline ones are left out', () => {
  const nodes = [
    node('n1'),
    node('n2', { floorId: 'iw-event-lg' }),
    node('n3', { online: false }),
    node('n4', { address: null }),
  ];
  const h = harness(nodes);
  assert.deepEqual(h.rollouts.select({ kind: 'all' }).map((n) => n.uid), ['n1', 'n2']);
  assert.deepEqual(h.rollouts.select({ kind: 'floor', floorId: 'iw-event-lg' }).map((n) => n.uid), ['n2']);
  assert.deepEqual(h.rollouts.select({ kind: 'node', uid: 'n1' }).map((n) => n.uid), ['n1']);
  assert.equal(h.rollouts.select({ kind: 'node', uid: 'n3' }).length, 0, 'an offline node is not a target');
  assert.throws(() => h.rollouts.start('beef1234beef1234', { kind: 'node', uid: 'n3' }, 'tester'), /no node matches/);
});

test('a node that talks to the edge directly fetches from the edge, not a gateway', () => {
  const h = harness([node('direct', { address: '192.168.0.9' })]);
  h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester');
  assert.equal(h.images.length, 0, 'no gateway is involved');
  assert.deepEqual(h.sent, [{ uid: 'direct', port: 8090 }], 'it is pointed at the edge console port');
});

test('a direct-to-cloud node is sent 443 and its /fw path: never a gateway push, never the console port', () => {
  const h = harness([node('wss', { address: 'ws:wss:session', transport: 'direct' })]);
  h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester');
  assert.equal(h.images.length, 0, 'no gateway is involved');
  assert.deepEqual(h.sent, [{ uid: 'wss', port: 443 }]);
  assert.equal(h.rollouts.current()?.nodes[0]?.gatewayId, null);
});

test('a direct node may download only while its own step is waiting for the image', () => {
  const h = harness([node('wss', { address: 'ws:wss:s', transport: 'direct' }), node('other', { address: 'ws:other:s', transport: 'direct' })]);
  h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester');
  assert.equal(h.rollouts.wantsDownload('wss', 'beef1234beef1234'), true);
  assert.equal(h.rollouts.wantsDownload('wss', 'feedfeedfeedfeed'), false, 'another build');
  assert.equal(h.rollouts.wantsDownload('other', 'beef1234beef1234'), false, 'still queued behind the pilot');
  h.report('wss', 'downloading', 40);
  assert.equal(h.rollouts.wantsDownload('wss', 'beef1234beef1234'), true);
  h.report('wss', 'rebooting', 100);
  assert.equal(h.rollouts.wantsDownload('wss', 'beef1234beef1234'), false, 'done downloading');
  h.rollouts.cancel('tester');
  assert.equal(h.rollouts.wantsDownload('other', 'beef1234beef1234'), false, 'cancelled');
});

test('a node whose direct session has closed is not a rollout target', () => {
  const h = harness([node('gone', { address: 'ws:gone:s', transport: null })]);
  assert.equal(h.rollouts.select({ kind: 'all' }).length, 0);
});

test('two rollouts cannot run at once', () => {
  const h = harness([node('n1'), node('n2')]);
  h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester');
  assert.throws(() => h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester'), /already running/);
});

test('an invalid target never falls through to updating every node', () => {
  const h = harness([node('n1'), node('n2')]);
  assert.throws(() => h.rollouts.start('beef1234beef1234', { kind: 'typo' } as never, 'tester'), /target/);
  assert.throws(() => h.rollouts.select(null as never), /target/);
  assert.equal(h.images.length, 0);
});

test('unrequested, mismatched and late OTA status cannot change a rollout decision', () => {
  const h = harness([node('n1'), node('n2')]);
  h.rollouts.start('beef1234beef1234', { kind: 'all' }, 'tester');
  h.report('n2', 'confirmed', 100);
  assert.equal(h.rollouts.current()?.nodes[1]?.state, 'queued');
  h.ready('esanhouse');
  h.rollouts.onOtaStatus('n1', { state: 'failed', percent: 0, error: 'busy', image: 'feedfeed' });
  assert.equal(h.rollouts.current()?.nodes[0]?.state, 'sending');
  h.report('n1', 'failed');
  h.report('n1', 'confirmed', 100);
  assert.equal(h.rollouts.current()?.stage, 'stopped');
  assert.equal(h.rollouts.current()?.nodes[0]?.state, 'failed');
  assert.equal(h.sent.length, 1);
});

test('uploaded paths that climb out of the project are refused', () => {
  assert.equal(safeRelativePath('TMsense/src/main.cpp'), join('TMsense', 'src', 'main.cpp'));
  assert.throws(() => safeRelativePath('../../etc/passwd'), FirmwareError);
  assert.throws(() => safeRelativePath('/etc/passwd'), FirmwareError);
  assert.throws(() => safeRelativePath('src/../../out'), FirmwareError);
  assert.throws(() => safeRelativePath('TMsense/.git/config'), FirmwareError, 'history is not part of a build');
  assert.throws(() => safeRelativePath('TMsense/.pio/build/firmware.bin'), FirmwareError, 'build output is not source');
});

test('a project without the secret-free release environment is refused before worker dispatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmfw-'));
  const store = new FirmwareStore(dir);
  const up = store.startUpload('tester');
  store.addFile(up, 'TMsense/platformio.ini', Buffer.from('[env:heltec]\nboard = heltec_wifi_lora_32_V3\n'));
  assert.throws(() => store.buildWorkspace(up), /\[env:tmflash\]/);
});

test('a build with no platformio.ini at all is refused before worker dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmfw-'));
  const store = new FirmwareStore(dir);
  const up = store.startUpload('tester');
  store.addFile(up, 'notes.md', Buffer.from('# not a project'));
  assert.throws(() => store.buildWorkspace(up), /no platformio\.ini/);
  store.addFile(up, 'src/main.cpp', Buffer.from('// not a project'));
  await assert.rejects(store.build(up, 'tester'), /no platformio\.ini/);
});

test('firmware uploads reject executable build hooks, provisioning secrets and excess sessions', () => {
  const store = new FirmwareStore(mkdtempSync(join(tmpdir(), 'tmfw-')), { pio: '/bin/false' });
  const up = store.startUpload('tester');
  for (const path of ['TMsense/extra.py', 'TMsense/lib/evil/library.json', 'TMsense/include/node_config.h', 'TMsense/include/tm_test_ca.h']) {
    assert.throws(() => store.addFile(up, path, Buffer.from('x')), FirmwareError);
  }
  for (let i = 1; i < 8; i++) store.startUpload('tester');
  assert.throws(() => store.startUpload('tester'), /too many/);
});

test('failed builds unlock their upload for correction and a retry', async () => {
  const store = new FirmwareStore(mkdtempSync(join(tmpdir(), 'tmfw-')), { pio: '/bin/false' });
  const up = store.startUpload('tester');
  store.addFile(up, 'platformio.ini', Buffer.from('[env:tmflash]'));
  await assert.rejects(store.build(up, 'tester'), /build failed|isolated firmware builds require/);
  store.addFile(up, 'src/main.cpp', Buffer.from('// corrected'));
  await assert.rejects(store.build(up, 'tester'), /build failed|isolated firmware builds require/);
  store.discard(up);
});

test('the firmware compiler cannot read private files outside its source and SDKs', async () => {
  if (process.platform !== 'linux') return;
  const dir = mkdtempSync(join(tmpdir(), 'tmfw-'));
  const install = join(dir, 'compiler');
  mkdirSync(join(install, 'bin'), { recursive: true });
  const privatePath = join(dir, 'private.h');
  const secret = 'fixture-private-contents';
  writeFileSync(privatePath, secret);
  const runner = join(install, 'bin', 'pio');
  writeFileSync(runner, '#!/bin/sh\nexec /usr/bin/g++ -c src/main.cpp -o /tmp/main.o\n', { mode: 0o700 });
  const store = new FirmwareStore(join(dir, 'images'), { pio: runner });
  const up = store.startUpload('tester');
  store.addFile(up, 'platformio.ini', Buffer.from('[env:tmflash]'));
  store.addFile(up, 'src/main.cpp', Buffer.from(`#include "${privatePath}"\n`));
  await assert.rejects(store.build(up, 'tester'), (error: unknown) => {
    const log = (error as FirmwareError & { log?: string[] }).log?.join('\n') ?? '';
    assert.match(log, /No such file/);
    assert.ok(!log.includes(secret));
    return true;
  });
});

test('builds survive a restart of the edge, and a missing image is not offered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmfw-'));
  const first = new FirmwareStore(dir);
  const bytes = Buffer.alloc(16, 3);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = sha256.slice(0, 16);
  const buildDir = join(dir, 'builds', id);
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, 'firmware.bin'), bytes);
  writeFileSync(join(buildDir, 'build.json'), JSON.stringify({
    id, sha256, size: bytes.length, version: 'tmsense-1.2', state: 'ready',
    uploadedBy: 'tester', uploadedAt: 1, builtAt: 2, files: 3, sourceBytes: 4, log: [],
  }));
  void first;
  const reopened = new FirmwareStore(dir);
  assert.equal(reopened.get(id)?.version, 'tmsense-1.2');
  assert.equal(reopened.bytes(id)?.length, 16);
  assert.equal(existsSync(join(dir, 'artifacts', `${id}.bin`)), true);
  assert.equal(existsSync(join(dir, 'builds', id)), false);
  assert.equal(reopened.get('deadbeefdeadbeef'), null);
});
