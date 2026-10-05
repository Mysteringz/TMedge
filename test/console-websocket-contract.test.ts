import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { ConsoleWebSocketAdapter } from '../src/modules/console-live/console-websocket-adapter.js';
import type { ConsoleDetection } from '../src/shared/types.js';

test('console report WebSocket messages retain the browser dets contract', { timeout: 3000 }, async (t) => {
  const server = createServer();
  const source = new EventEmitter();
  const adapter = new ConsoleWebSocketAdapter(server, source, () => ({ nodes: [] }));
  adapter.start();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${adapter.issueToken()}`);
  t.after(async () => {
    socket.terminate();
    await adapter.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const report = new Promise<unknown>((resolve) => {
    socket.on('message', (bytes) => {
      const message: unknown = JSON.parse(String(bytes));
      if (message && typeof message === 'object' && 'type' in message && message.type === 'report') resolve(message);
    });
  });
  const dets: ConsoleDetection[] = [{
    x: 12, y: 15, area: 9, contrast: 2, peak: 31, heat: 12,
    floorX: 120, floorY: 150, tableId: 'table-a', counted: true, persons: 1,
  }];
  source.emit('report', 'node-a', dets, 123456);
  assert.deepEqual(await report, { type: 'report', uid: 'node-a', at: 123456, dets });
});
