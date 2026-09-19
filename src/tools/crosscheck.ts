/**
 * Firmware bytes vs edge parser, both directions: `npm run crosscheck`.
 *
 * Compiles TMnode's own tm_packet.cpp on this machine (TMSENSE_DIR, default
 * ../TMsense), has it emit REPORT / RAW / STATUS packets, and parses each with
 * the edge's protocol.ts. Then the edge builds COMMANDs and the firmware's
 * parser must accept them -- and reject a tampered one and one for another node.
 *
 * `npm test` checks the TypeScript parser against the TypeScript builder,
 * which would keep passing while both disagree with the firmware. This is the
 * check that cannot.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildCommand, CMD_SET_PARAM, parsePacket, REPORT_TRUNCATED, type Report, type Raw, type Status } from '../edge/protocol.js';

const tmnode = resolve(process.env.TMSENSE_DIR ?? process.env.TMNODE_DIR ?? '../TMsense');
const bin = execFileSync(`${tmnode}/test/host/build_packet_host.sh`, [resolve('dist/packet_host')], { encoding: 'utf8' }).trim();
const key = Buffer.from('crosscheck-key');
const verify = { keys: [key], allowUnsigned: false };
let checks = 0;
const ok = (name: string) => {
  checks++;
  console.log(`ok  ${name}`);
};

const lines = execFileSync(bin, ['emit'], { encoding: 'utf8' }).trim().split('\n');
const packets = new Map(lines.map((l) => {
  const j = JSON.parse(l) as { name: string; hex: string };
  return [j.name, Buffer.from(j.hex, 'hex')];
}));
const get = (n: string): Buffer => {
  const b = packets.get(n);
  if (!b) throw new Error(`firmware did not emit ${n}`);
  return b;
};
const near = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

// REPORT with three detections: every field, at the resolution the wire carries.
{
  const r = parsePacket(get('report3'), verify) as Report;
  assert.equal(r.kind, 'report');
  assert.equal(r.uid, '01:02:03:04:05:06');
  assert.equal(r.boot, 7);
  assert.equal(r.seq, 100);
  assert.equal(r.uptimeMs, 123456);
  assert.equal(r.frame, 4242);
  near(r.ta, 35.81, 0.005, 'ta');
  near(r.sceneMin, 21.04, 0.005, 'sceneMin');
  near(r.sceneMax, 33.87, 0.005, 'sceneMax');
  near(r.bgMean, 23.5, 0.005, 'bgMean');
  assert.equal(r.detections.length, 3);
  r.detections.forEach((d, i) => {
    near(d.x, 1.5 + i, 1 / 16, `x[${i}]`);
    near(d.y, 3.25 + (i % 20), 1 / 16, `y[${i}]`);
    assert.equal(d.area, 4 + i);
    near(d.contrast, 2.35 + 0.1 * i, 0.026, `contrast[${i}]`);
    near(d.peak, 30.5 + 0.25 * (i % 8), 0.126, `peak[${i}]`);
    near(d.heat, 12.3 + i, 0.051, `heat[${i}]`);
  });
  ok('REPORT: header and 3 detections match the firmware inputs');
}
{
  const r = parsePacket(get('report_truncated'), verify) as Report;
  assert.equal(r.detections.length, 24);
  assert.ok(r.flags & REPORT_TRUNCATED);
  assert.ok(get('report_truncated').length <= 222, 'max REPORT must fit a LoRa frame');
  ok(`REPORT with 30 blobs: truncated to 24, flagged, ${get('report_truncated').length} B (fits LoRa)`);
}
{
  const r = parsePacket(get('report_empty'), verify) as Report;
  assert.equal(r.detections.length, 0);
  assert.equal(get('report_empty').length, 44);
  ok('empty REPORT is 44 bytes');
}
{
  const r = parsePacket(get('raw'), verify) as Raw;
  assert.equal(r.frame, 4242);
  const temp = (i: number) => r.tMin + (r.pixels[i] ?? 0) * r.step;
  for (const i of [0, 31, 32, 400, 767]) near(temp(i), 20 + (i % 32) * 0.3 + Math.floor(i / 32) * 0.05, r.step, `pixel ${i}`);
  ok(`RAW: 768 pixels decode within one level (${(r.step * 1000).toFixed(1)} mC)`);
}
{
  const s = parsePacket(get('status'), verify) as Status;
  assert.equal(s.fw, 'tmnode-9.9.9');
  assert.equal(s.ip, '192.168.0.9');
  assert.equal(s.rssi, -57);
  assert.equal(s.channel, 10);
  assert.equal(s.freeHeap, 238676);
  assert.equal(s.stackFree, 5728);
  assert.equal(s.frames, 99999);
  assert.equal(s.lastCmd, 1789754860);
  assert.deepEqual(s.params, { min_contrast: 60, min_peak: 120, noise_k: 40, min_area: 1, max_area: 60, bg_tau: 90, bg_frames: 20, raw_every: 1, refresh: 2, split_sep: 19 });
  ok('STATUS: every field and all 10 params');
}
{
  const flipped = Buffer.from(get('report3'));
  flipped[30] = (flipped[30] ?? 0) ^ 1;
  assert.throws(() => parsePacket(flipped, verify), /bad signature/);
  assert.throws(() => parsePacket(get('report3'), { keys: [Buffer.from('other')], allowUnsigned: false }), /bad signature/);
  assert.throws(() => parsePacket(get('report_unsigned'), verify), /unsigned/);
  assert.equal((parsePacket(get('report_unsigned'), { keys: [], allowUnsigned: true }) as Report).signed, false);
  ok('one flipped byte, a wrong key, and an unsigned packet are all rejected');
}

// Edge -> firmware: commands.
const parse = (buf: Buffer) => JSON.parse(execFileSync(bin, ['parse', buf.toString('hex')], { encoding: 'utf8' })) as
  { result: number; seq: number; opcode: number; arg0: number; value: number };
{
  const cmd = buildCommand('01:02:03:04:05:06', { seq: 1789754999, opcode: CMD_SET_PARAM, arg0: 1, value: -150 }, key);
  assert.deepEqual(parse(cmd), { result: 0, seq: 1789754999, opcode: CMD_SET_PARAM, arg0: 1, value: -150 });
  ok('COMMAND built by the edge is accepted by the firmware with identical fields');
  const tampered = Buffer.from(cmd);
  tampered[28] = (tampered[28] ?? 0) ^ 0x10;
  assert.equal(parse(tampered).result, -7);
  assert.equal(parse(buildCommand('01:02:03:04:05:07', { seq: 1, opcode: 2, arg0: 0, value: 0 }, key)).result, -5);
  assert.equal(parse(buildCommand('01:02:03:04:05:06', { seq: 1, opcode: 2, arg0: 0, value: 0 }, Buffer.from('wrong'))).result, -7);
  ok('firmware rejects a tampered command, one for another node, and one with the wrong key');
}

console.log(`\ncrosscheck: ${checks} checks passed against ${tmnode}`);
