import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { LiveCommandReceipts, ReceiptDispatchError } from '../src/modules/nodes/application/live-command-receipts.js';
import { DurableCommandOutcomes } from '../src/modules/nodes/application/durable-command-outcomes.js';
import { ExecuteNodeCommand } from '../src/modules/nodes/application/execute-node-command.js';
import { ResetNodeCursor } from '../src/modules/nodes/application/reset-node-cursor.js';
import { createNodeRouter } from '../src/modules/nodes/routes/node-router.js';
import type { CommandReceipt } from '../src/modules/nodes/domain/command-receipt.js';
import { ParamBroker } from '../src/algo/params.js';
import type { EdgeRuntime } from '../src/edge/runtime.js';
import { principal } from '../src/modules/algo-admin/domain/permissions.js';

const UID = '00:01:02:03:04:05';
const command = { uid: UID, opcode: 3, argument: 0, value: 10 };
const context = { issuer: 'algo:alice', authorized: () => true };
test('receipt rejects cached same-clock STATUS and requires UID/sequence/boot with private ownership', async () => {
  const service = new LiveCommandReceipts({ dispatch: async () => 10, boot: () => 1, now: () => 100 });
  service.observeStatus({ uid: UID, sequence: 10, boot: 1, at: 100 });
  const receipt = await service.send(command, context);
  assert.equal(receipt.state, 'sent'); assert.equal(receipt.operation, 'Identify');
  service.observeStatus({ uid: 'wrong', sequence: 10, boot: 1, at: 100 });
  service.observeStatus({ uid: UID, sequence: 9, boot: 1, at: 100 });
  assert.equal(service.get(context.issuer, UID, receipt.id)?.state, 'sent');
  assert.equal(service.get('algo:bob', UID, receipt.id), null); assert.equal(service.get('legacy:console', UID, receipt.id), null);
  service.observeStatus({ uid: UID, sequence: 10, boot: 1, at: 100 });
  assert.equal(service.get(context.issuer, UID, receipt.id)?.state, 'acknowledged');
  assert.match(service.get(context.issuer, UID, receipt.id)?.message ?? '', /does not confirm execution or persistence/);
});
test('reboot uncertainty, timeout/TTL and restart never become successful acknowledgements', async () => {
  let now = 100;
  const service = new LiveCommandReceipts({ dispatch: async () => 10, boot: () => 1, now: () => now });
  const receipt = await service.send(command, context);
  service.observeStatus({ uid: UID, sequence: 99, boot: 2, at: 101 });
  assert.equal(service.get(context.issuer, UID, receipt.id)?.state, 'uncertain');
  const timeout = await service.send(command, context); now += 60001;
  assert.equal(service.get(context.issuer, UID, timeout.id)?.state, 'timed-out');
  now += 900001; assert.equal(service.get(context.issuer, UID, timeout.id), null);
  assert.equal(new LiveCommandReceipts({ dispatch: async () => 1, boot: () => null }).get(context.issuer, UID, receipt.id), null);
});
test('stalled requested dispatch is bounded, late completion preserves uncertainty and never replays', async () => {
  let now = 100, dispatches = 0;
  let release: (sequence: number) => void = () => undefined;
  const service = new LiveCommandReceipts({ boot: () => 1, now: () => now, dispatchTimeoutMs: 5,
    dispatch: () => { dispatches++; return new Promise<number>((resolve) => { release = resolve; }); } });
  const receipt = await service.send(command, context);
  assert.equal(receipt.state, 'uncertain'); assert.equal(receipt.sequence, null);
  now += 60001; release(10); await new Promise<void>((done) => setImmediate(done));
  service.observeStatus({ uid: UID, sequence: 10, boot: 1, at: now });
  assert.equal(service.get(context.issuer, UID, receipt.id)?.state, 'uncertain'); assert.equal(dispatches, 1);
});
test('512 outstanding bound and completed eviction do not trigger extra dispatch', async () => {
  let sequence = 0;
  const service = new LiveCommandReceipts({ boot: () => 1, dispatch: async () => ++sequence });
  const receipts = [];
  for (let i = 0; i < 512; i++) receipts.push(await service.send(command, context));
  await assert.rejects(service.send(command, context), /Too many pending/); assert.equal(sequence, 512);
  const first = receipts[0]; assert.ok(first);
  service.observeStatus({ uid: UID, sequence: first.sequence ?? 0, boot: 1, at: Date.now() });
  await service.send(command, context); assert.equal(sequence, 513); assert.equal(service.get(context.issuer, UID, first.id), null);
});
test('authorization prevents dispatch and unsafe errors never leak through receipts', async () => {
  let calls = 0;
  const service = new LiveCommandReceipts({ boot: () => null, dispatch: async () => { calls++; throw new Error('SECRET192.168.1.10'); } });
  await assert.rejects(service.send(command, { ...context, authorized: () => false }), (error: unknown) => error instanceof ReceiptDispatchError && error.receipt.state === 'failed');
  assert.equal(calls, 0);
  await assert.rejects(service.send(command, context), (error: unknown) => error instanceof ReceiptDispatchError && error.receipt.state === 'uncertain' && !JSON.stringify(error.receipt).includes('SECRET'));
});
test('durable intent retains dispatch safety, rejects old clock STATUS and reconciles changed boot even with different sequence', async () => {
  const events: string[] = [];
  const durable = new DurableCommandOutcomes({ record: async (event) => { events.push(event.outcome); } }, async () => 10, () => 100, 60000, () => 1);
  durable.observeStatus(UID, 10, { boot: 1, at: 100 });
  assert.equal(await durable.send(command, { id: 'console', kind: 'console' }), 10);
  assert.deepEqual(events, ['requested', 'sent']);
  durable.observeStatus(UID, 10, { boot: 1, at: 99 }); await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(events, ['requested', 'sent']);
  durable.observeStatus(UID, 99, { boot: 2, at: 100 }); await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(events, ['requested', 'sent', 'uncertain']); await durable.dispose();
});
test('parameter dispatch and recovery require dispatched sequence plus newer accepted STATUS generation even at equal clock', async () => {
  let generation = 1, resolveSend: (sequence: number) => void = () => undefined;
  let statusAt = Date.now(), boot = 1;
  const runtime = { cfg: { dataDir: mkdtempSync(join(tmpdir(), 'tm-command-param-')) },
    nodes: () => [{ uid: UID, boot, status: { generation, receivedAt: statusAt, lastCmd: 100, params: { min_contrast: 60 } } }],
    ingest: { links: new Map([[UID, { boot: 1 }]]), sendCommand: () => new Promise<number>((resolve) => { resolveSend = resolve; }) },
  } as unknown as EdgeRuntime;
  const broker = new ParamBroker(runtime);
  const sending = broker.apply({ uid: UID, nodeId: 'bg', param: 'min_contrast', binding: { kind: 'device', param: 'min_contrast' }, value: 60, by: 'test' });
  const pending = broker.changes()[0]; assert.ok(pending); statusAt = pending.at;
  assert.equal(pending.cmdSeq, null); assert.equal(broker.changes()[0]?.confirmedAt, null);
  resolveSend(100); await sending; assert.equal(broker.changes()[0]?.confirmedAt, null);
  generation++; boot = 2; assert.equal(broker.changes()[0]?.confirmedAt, null);
  boot = 1; assert.notEqual(broker.changes()[0]?.confirmedAt, null);
  const recovery = broker.revert(UID, 'min_contrast', 'test'); resolveSend(100); await recovery;
  assert.equal(broker.changes().length, 1); assert.equal(broker.changes()[0]?.restoring, true);
  generation++; statusAt = broker.changes()[0]?.commandAt ?? Date.now();
  assert.equal(broker.changes().length, 0);
});
test('changed boot during delayed durable sent commit becomes uncertain before pending insertion', async () => {
  const events: string[] = []; let release: () => void = () => undefined;
  const sent = new Promise<void>((resolve) => { release = resolve; });
  let reached: () => void = () => undefined; const committing = new Promise<void>((resolve) => { reached = resolve; });
  const durable = new DurableCommandOutcomes({ record: async ({ outcome }) => { events.push(outcome); if (outcome === 'sent') { reached(); await sent; } } }, async () => 10, () => 100, 60000, () => 1);
  const sending = durable.send(command, { id: 'console', kind: 'console' }); await committing;
  durable.observeStatus(UID, 99, { boot: 2, at: 100 }); release(); await sending;
  assert.deepEqual(events, ['requested', 'sent', 'uncertain']); await durable.dispose();
});
test('HTTP receipt read remains issuer-private; POST returns additive status and preserves error uncertainty', async () => {
  const service = new LiveCommandReceipts({ boot: () => 1, dispatch: async () => 10 });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.embeddedConsole = true; res.locals.principal = principal(req.get('x-user') ?? 'alice', 'admin'); res.locals.permits = () => true; next(); });
  app.use('/api/nodes', createNodeRouter({ reads: { raw: () => null, rgb: () => null, receipt: (owner, uid, id) => service.get(owner, uid, id) },
    executeCommand: new ExecuteNodeCommand((item, authorized, issuer) => service.send(item, { issuer: issuer ?? '', authorized: authorized ?? (() => false) })),
    resetCursor: new ResetNodeCursor(() => false), mutating: (_req, _res, next) => next() }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/nodes/${UID}`;
  try {
    const response = await fetch(`${base}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'identify', value: 10 }) });
    assert.equal(response.status, 200); const result = await response.json() as { sent: boolean; receipt: CommandReceipt }; assert.equal(result.sent, true);
    const url = `${base}/commands/${result.receipt.id}`;
    assert.equal((await fetch(url)).status, 200); assert.equal((await fetch(url, { headers: { 'x-user': 'bob' } })).status, 404);
    assert.equal((await fetch(`${base}/commands/missing`)).status, 404);
    service.observeStatus({ uid: UID, boot: 1, sequence: 10, at: Date.now() });
    assert.equal(((await (await fetch(url)).json()) as { data: CommandReceipt }).data.state, 'acknowledged');
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
