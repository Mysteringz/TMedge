import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandStatus } from '../public-console/js/console-client/command-status.js';

const receipt = { id: 'receipt-1', uid: 'node-1', operation: 'Identify', sequence: 1, boot: 1, state: 'sent', requestedAt: 1, updatedAt: 1, message: 'Sent — waiting for device.' };
function harness(fetcher) {
  const originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  const listeners = new Map();
  globalThis.document = { hidden: false, addEventListener: (event, callback) => listeners.set(event, callback), removeEventListener: (event) => listeners.delete(event) };
  globalThis.fetch = fetcher;
  const output = { textContent: '', setAttribute: () => undefined }, status = new CommandStatus(output);
  return { status, output, listeners, close: () => { status.dispose(); globalThis.fetch = originalFetch; if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; } };
}
test('receipt polling has one request; node change aborts it and late private data cannot replace selection', async () => {
  let calls = 0, aborted = false;
  const state = harness((_url, options) => { calls++; return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); }); });
  try {
    state.status.select('node-1'); state.status.show(receipt);
    for (let i = 0; i < 10; i++) state.status.refresh(); assert.equal(calls, 1);
    state.status.select('node-2'); await new Promise((done) => setImmediate(done));
    assert.equal(aborted, true); assert.equal(state.output.textContent, 'No recent command.');
    assert.equal(calls, 1); assert.ok(!state.output.textContent.includes('node-1'));
  } finally { state.close(); }
});
test('receipt404 stays unavailable/uncertain; refresh never dispatches/replays a command', async () => {
  const methods = [];
  const state = harness(async (_url, options) => { methods.push(options.method ?? 'GET'); return { status: 404 }; });
  try {
    state.status.select('node-1'); state.status.show(receipt); await new Promise((done) => setImmediate(done));
    assert.match(state.output.textContent, /Command status is no longer available.*Outcome uncertain/);
    state.status.refresh(); await new Promise((done) => setImmediate(done));
    assert.deepEqual(methods, ['GET']);
  } finally { state.close(); }
});
test('hidden polling pauses and visible refresh resumes; disposal removes listeners/timers', async () => {
  let calls = 0;
  const state = harness(async () => { calls++; return { status: 200, ok: true, json: async () => ({ data: receipt }) }; });
  try {
    state.status.select('node-1'); state.status.show(receipt); await new Promise((done) => setImmediate(done));
    globalThis.document.hidden = true; state.listeners.get('visibilitychange')(); state.status.refresh(); assert.equal(calls, 1);
    globalThis.document.hidden = false; state.listeners.get('visibilitychange')(); await new Promise((done) => setImmediate(done)); assert.equal(calls, 2);
    state.status.dispose(); assert.equal(state.listeners.size, 0); state.status.refresh(); assert.equal(calls, 2);
  } finally { state.close(); }
});
