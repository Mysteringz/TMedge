import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FirmwareBuildWorkerClient } from '../src/infrastructure/firmware-build/firmware-build-worker-client.js';

const RESULT = `${JSON.stringify({ type: 'result', exitCode: 0, artifactBase64: 'AQID' })}\n`;

async function worker(t: TestContext, respond: RequestListener, timeoutMs = 1000): Promise<{
  client: FirmwareBuildWorkerClient; root: string;
}> {
  const root = mkdtempSync(join(tmpdir(), 'tmedge-worker-lifecycle-'));
  writeFileSync(join(root, 'platformio.ini'), '[env:tmflash]\n');
  const server = createServer(respond);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new FirmwareBuildWorkerClient({ url: `http://127.0.0.1:${address.port}/build`, timeoutMs });
  t.after(async () => {
    await client.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  return { client, root };
}

for (const statusCode of [200, 503]) {
  test(`worker rejects an interrupted HTTP ${statusCode} response and accepts a retry`, { timeout: 3000 }, async (t) => {
    let attempts = 0;
    const { client, root } = await worker(t, (request, response) => {
      request.resume();
      request.once('end', () => {
        attempts += 1;
        if (attempts > 1) return response.end(RESULT);
        response.writeHead(statusCode, { 'content-type': 'application/x-ndjson', 'content-length': '9999' });
        response.write(`${JSON.stringify({ type: 'log', line: 'compiler started' })}\n`);
        setImmediate(() => response.destroy());
      });
    });
    await assert.rejects(client.build(root, () => {}), /aborted|closed before completion|ECONNRESET|socket hang up/);
    const result = await client.build(root, () => {});
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.artifact, Buffer.from([1, 2, 3]));
  });
}

test('a result event cannot turn a truncated HTTP response into success', { timeout: 3000 }, async (t) => {
  const { client, root } = await worker(t, (request, response) => {
    request.resume();
    request.once('end', () => {
      response.writeHead(200, { 'content-length': String(Buffer.byteLength(RESULT) + 100) });
      response.write(RESULT);
      setImmediate(() => response.destroy());
    });
  });
  await assert.rejects(client.build(root, () => {}), /aborted|closed before completion|ECONNRESET|socket hang up/);
});

test('worker rejects malformed NDJSON without forwarding later events and permits retry', { timeout: 3000 }, async (t) => {
  let attempts = 0;
  const progress: string[] = [];
  const { client, root } = await worker(t, (request, response) => {
    request.resume();
    request.once('end', () => {
      attempts += 1;
      response.end(attempts === 1
        ? `{invalid}\n${JSON.stringify({ type: 'log', line: 'invalid later progress' })}\n${RESULT}`
        : RESULT);
    });
  });
  await assert.rejects(client.build(root, (line) => progress.push(line)), /malformed progress/);
  assert.deepEqual(progress, []);
  assert.equal((await client.build(root, () => {})).exitCode, 0);
});

test('worker rejects a complete response without a result and permits retry', { timeout: 3000 }, async (t) => {
  let attempts = 0;
  const { client, root } = await worker(t, (request, response) => {
    request.resume();
    request.once('end', () => response.end(++attempts === 1 ? '' : RESULT));
  });
  await assert.rejects(client.build(root, () => {}), /no result/);
  assert.equal((await client.build(root, () => {})).exitCode, 0);
});

test('worker timeout settles after response headers arrive and permits retry', { timeout: 3000 }, async (t) => {
  let attempts = 0;
  const progress: string[] = [];
  const { client, root } = await worker(t, (request, response) => {
    request.resume();
    request.once('end', () => {
      if (++attempts > 1) return response.end(RESULT);
      response.write(`${JSON.stringify({ type: 'log', line: 'compiler stalled' })}\n`);
    });
  }, 100);
  await assert.rejects(client.build(root, (line) => progress.push(line)), /timed out/);
  assert.deepEqual(progress, ['compiler stalled']);
  assert.equal((await client.build(root, () => {})).exitCode, 0);
});

test('disposing a worker with an active response settles the promise and rejects future builds', { timeout: 3000 }, async (t) => {
  const { client, root } = await worker(t, (request, response) => {
    request.resume();
    request.once('end', () => response.write(`${JSON.stringify({ type: 'log', line: 'compiler started' })}\n`));
  });
  let progressReceived: () => void = () => {};
  const progress = new Promise<void>((resolve) => { progressReceived = resolve; });
  const pending = client.build(root, () => progressReceived());
  const rejected = assert.rejects(pending, /shutting down/);
  await progress;
  await client.dispose();
  await rejected;
  await assert.rejects(client.build(root, () => {}), /client is closed/);
});

test('a normal response close preserves successful results and accepts another build', { timeout: 3000 }, async (t) => {
  const { client, root } = await worker(t, (request, response) => {
    request.resume();
    request.once('end', () => response.end(RESULT));
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await client.build(root, () => {});
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.artifact, Buffer.from([1, 2, 3]));
  }
});
