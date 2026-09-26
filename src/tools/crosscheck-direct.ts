/**
 * The direct-to-cloud transport, firmware vs edge: part of `npm run crosscheck`.
 *
 * Builds TMsense's own tm_ws / tm_cloud_proto / tm_cloud_session for the host
 * (test/host/build_cloud_host.sh), runs the firmware's unit tests, then drives
 * `cloud_host` -- the firmware session over a plain socket -- against this
 * edge's real NodeServer and Ingest. A TypeScript client agreeing with a
 * TypeScript server proves nothing about the node; this does.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_NODE_LIMITS } from '../edge/config.js';
import { Ingest } from '../edge/ingest.js';
import { authMac, NodeServer } from '../edge/nodelink.js';
import { CMD_SET_PARAM, parsePacket, type Report } from '../edge/protocol.js';

type HostEvent = Record<string, unknown> & { event: string };

export async function directCrosscheck(tmsense: string, key: Buffer, ok: (name: string) => void): Promise<void> {
  const vectorsPath = `${tmsense}/test/host/fixtures/tmnode_auth_vectors.json`;
  const vectors = (JSON.parse(readFileSync(vectorsPath, 'utf8')) as { vectors: { key: string; uid: string; nonce: string; mac: string }[] }).vectors;
  for (const v of vectors) assert.equal(authMac(Buffer.from(v.key), v.uid, v.nonce), v.mac);
  ok(`auth proof: the edge computes the firmware's ${vectors.length} fixed vectors`);

  const dir = execFileSync(`${tmsense}/test/host/build_cloud_host.sh`, [resolve('dist/cloud')], { encoding: 'utf8' }).trim().split('\n').pop() ?? '';
  const unit = execFileSync(`${dir}/cloud_test`, [vectorsPath], { encoding: 'utf8' }).trim();
  assert.match(unit, /0 failed/);
  ok(`firmware transport unit tests: ${unit.replace('cloud_test: ', '')}`);

  const uid = '01:02:03:04:05:06';
  const ing = new Ingest({ port: 0, host: '127.0.0.1', verify: { keys: [key], allowUnsigned: false }, commandKey: key });
  const reports: Report[] = [];
  ing.on('report', (p) => reports.push(p));
  const received: Buffer[] = [];
  const approved = new Set<string>();
  const server = new NodeServer({
    host: '127.0.0.1', port: 0, limits: DEFAULT_NODE_LIMITS, keys: [key],
    isRegistered: (u) => u === uid,
    ingest: (d, r) => {
      received.push(Buffer.from(d));
      return ing.handle(d, r);
    },
    dropRoute: (u, s) => void ing.dropDirectRoute(u, s),
    image: () => null,
    otaApproved: (_u, build) => approved.has(build),
  });
  const port = await server.listen();
  const child = spawn(`${dir}/cloud_host`, [`ws://127.0.0.1:${port}/tmnode`], { stdio: ['pipe', 'pipe', 'inherit'] });
  const events: HostEvent[] = [];
  let wake: (() => void) | null = null;
  createInterface({ input: child.stdout }).on('line', (l) => {
    events.push(JSON.parse(l) as HostEvent);
    wake?.();
  });
  const waitFor = async (pred: (e: HostEvent) => boolean, what: string, ms = 5000): Promise<HostEvent> => {
    const until = Date.now() + ms;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() > until) throw new Error(`firmware harness never reported: ${what}\n${JSON.stringify(events.slice(-5))}`);
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 50);
      });
    }
  };
  const send = (line: string) => child.stdin.write(`${line}\n`);

  try {
    const ready = await waitFor((e) => e.event === 'state' && e.state === 'ready', 'ready');
    assert.ok(typeof ready.session === 'string' && ready.session.length > 0);
    ok('firmware session: upgrade, challenge answered with the site key, ready');

    send('status');
    send('report 3');
    await waitFor((e) => e.event === 'ack' && e.reportsAcked === 1, 'ACK for the report');
    const sent = events.filter((e) => e.event === 'sent').map((e) => String(e.hex));
    for (const hex of sent) assert.ok(received.some((b) => b.toString('hex') === hex), 'bytes arrive exactly as the firmware built them');
    const r = reports[0];
    assert.ok(r);
    assert.equal(r.uid, uid);
    assert.equal(r.boot, 7);
    assert.equal(r.detections.length, 3);
    assert.deepEqual(r, parsePacket(Buffer.from(sent[1] ?? '', 'hex'), { keys: [key], allowUnsigned: false }));
    ok('STATUS and REPORT: firmware bytes carried unchanged, accepted, and the REPORT acknowledged');

    send('raw');
    send('report 0');
    await waitFor((e) => e.event === 'ack' && e.reportsAcked === 2, 'second ACK');
    assert.ok(received.some((b) => b.length === 806), 'an 806-byte RAW crossed as one message');
    ok('RAW (806 B) crosses in one message; the next REPORT is acknowledged');

    const rejectedBefore = ing.rejectReasons.get('replayed or duplicate sequence') ?? 0;
    send('replay');
    send('report 1');
    await waitFor((e) => e.event === 'ack' && e.reportsAcked === 3, 'third ACK');
    assert.equal(ing.rejectReasons.get('replayed or duplicate sequence'), rejectedBefore + 1);
    assert.equal(reports.length, 3, 'the replayed report was counted once');
    ok('a replayed packet is refused by the edge and gets no ACK; the next one does');

    const seq = await ing.sendCommand(uid, CMD_SET_PARAM, 1, -150);
    const cmd = await waitFor((e) => e.event === 'downlink' && e.kind === 'command', 'command');
    assert.deepEqual({ result: cmd.result, seq: cmd.seq, opcode: cmd.opcode, arg0: cmd.arg0, value: cmd.value },
      { result: 0, seq, opcode: CMD_SET_PARAM, arg0: 1, value: -150 });
    ok('COMMAND down the socket: the firmware verifies it with identical fields');

    const build = '0123456789abcdef';
    approved.add(build);
    await ing.sendOta(uid, { port: 443, size: 1000, sha256: 'ab'.repeat(32), path: `/fw/${build}.bin` });
    const ota = await waitFor((e) => e.event === 'downlink' && e.kind === 'ota', 'OTA');
    assert.equal(ota.result, 0);
    assert.equal(ota.path, `/fw/${build}.bin`);
    assert.equal(ota.port, 443);
    assert.equal(ota.granted, true, 'the grant arrived first and matches the signed sequence and build');
    assert.equal(ota.tokenLength, 64);
    ok('OTA: grant then signed request; the firmware matches them by sequence and build');
  } finally {
    child.stdin.end();
    child.kill();
    await server.close();
  }
}
