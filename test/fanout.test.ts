/**
 * A browser that cannot keep up must cost the edge a bounded amount of
 * memory. Before this, one slow console or algo tab queued every frame in the
 * edge until its heap ran out and ingest died with it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_CLIENT_BACKLOG, sendLatest } from '../src/shared/fanout.js';

test('fan-out: a client that stops reading is skipped once behind, so its backlog stays bounded', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  const port = (wss.address() as { port: number }).port;
  const serverSide = new Promise<WebSocket>((r) => wss.on('connection', r));
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => client.on('open', r));
  // The browser on a slow link: nothing is read from the socket any more.
  (client as unknown as { _socket: { pause(): void } })._socket.pause();
  const ws = await serverSide;

  const frame = 'x'.repeat(50_000);   // about one algo frame
  let sent = 0;
  let skipped = 0;
  let peak = 0;
  for (let i = 0; i < 400; i++) {       // 20 MB offered
    if (sendLatest(ws, frame)) sent++;
    else skipped++;
    peak = Math.max(peak, ws.bufferedAmount);
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(skipped > 0, 'the slow client was skipped');
  assert.ok(peak <= MAX_CLIENT_BACKLOG + frame.length, `backlog peaked at ${peak} bytes`);
  assert.ok(sent < 400, `${sent} of 400 sent`);
  client.terminate();
  wss.close();
});

test('fan-out: a client that keeps up gets every message', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  const port = (wss.address() as { port: number }).port;
  const serverSide = new Promise<WebSocket>((r) => wss.on('connection', r));
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  let got = 0;
  client.on('message', () => got++);
  await new Promise((r) => client.on('open', r));
  const ws = await serverSide;
  for (let i = 0; i < 50; i++) {
    assert.equal(sendLatest(ws, JSON.stringify({ i })), true);
    await new Promise((r) => setTimeout(r, 2));
  }
  const until = Date.now() + 2000;
  while (got < 50 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.equal(got, 50);
  client.close();
  wss.close();
});
