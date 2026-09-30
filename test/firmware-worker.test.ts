import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { FirmwareStore } from '../src/edge/firmware.js';
import { FirmwareStoreExecutor } from '../src/infrastructure/firmware-build/firmware-store-executor.js';
import { FirmwareBuildWorkerClient, type FirmwareBuildWorker } from '../src/infrastructure/firmware-build/firmware-build-worker-client.js';
import { projectTarStream } from '../src/infrastructure/firmware-build/project-tar-stream.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tmedge-worker-test-'));
}

async function readStream(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/build`;
}

test('project tar stream has a correct content length and archives only regular source files', async () => {
  const root = tempDir();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'platformio.ini'), '[env:tmflash]\n');
  writeFileSync(join(root, 'src', 'main.cpp'), 'int main() {}\n');
  const archive = await projectTarStream(root, { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 2048 });
  const bytes = await readStream(archive.stream);
  assert.equal(bytes.length, archive.contentLength);
  assert.equal(bytes.toString('utf8', 0, 100).replace(/\0.*$/, ''), 'platformio.ini');
  assert.equal(bytes.toString('utf8', 512, 512 + '[env:tmflash]\n'.length), '[env:tmflash]\n');
  assert.equal(bytes.toString('utf8', 1024, 1032), 'main.cpp');
  assert.equal(bytes.toString('utf8', 1369, 1372), 'src');
});

test('worker client forwards progress and accepts a staged artifact over streamed HTTP', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'platformio.ini'), '[env:tmflash]\n');
  const artifact = Buffer.from([1, 2, 3, 4]);
  let archiveBytes = 0;
  const server = createServer((request, response) => {
    request.on('data', (chunk: Buffer) => { archiveBytes += chunk.length; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(`${JSON.stringify({ type: 'log', line: 'compile started' })}\n`);
      response.end(`${JSON.stringify({ type: 'result', exitCode: 0, artifactBase64: artifact.toString('base64') })}\n`);
    });
  });
  const client = new FirmwareBuildWorkerClient({ url: await listen(server) });
  const progress: string[] = [];
  try {
    const result = await client.build(root, (line) => progress.push(line));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.artifact, artifact);
    assert.deepEqual(progress, ['compile started']);
    assert.ok(archiveBytes > 512);
  } finally {
    await client.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('build executor promotes only the isolated worker artifact and preserves its hash', async () => {
  const root = tempDir();
  const store = new FirmwareStore(root);
  const uploadId = store.startUpload('console');
  store.addFile(uploadId, 'platformio.ini', Buffer.from('[env:tmflash]\n'));
  store.addFile(uploadId, 'include/tm_config.h', Buffer.from('#define TM_FW_VERSION "worker-test"\n'));
  const bytes = Buffer.from('firmware image');
  const worker: FirmwareBuildWorker = {
    async build(_project, reportProgress) {
      reportProgress('isolated compile complete');
      return { exitCode: 0, artifact: bytes, log: ['isolated compile complete'] };
    },
    async dispose() {},
  };
  const executor = new FirmwareStoreExecutor(store, worker);
  const result = await executor.execute({ jobId: 'job-1', uploadId, actor: { id: 'console', kind: 'console' } }, () => {});
  assert.equal(result.artifact.size, bytes.length);
  assert.equal(result.artifact.sha256, (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(store.bytes(result.artifact.id), bytes);
  await executor.dispose();
});

test('worker timeout aborts the in-flight HTTP request', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'platformio.ini'), '[env:tmflash]\n');
  const server = createServer((request) => request.resume());
  const client = new FirmwareBuildWorkerClient({ url: await listen(server), timeoutMs: 40 });
  try {
    await assert.rejects(client.build(root, () => {}), /timed out/);
  } finally {
    await client.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const workerUrl = process.env.TMEDGE_TEST_WORKER_URL;
test('adversarial PlatformIO pre-script cannot see host secrets or write outside its workspace', {
  skip: workerUrl && process.platform === 'linux'
    ? false
    : 'run on Linux with TMEDGE_TEST_WORKER_URL set to a disposable firmware worker to rehearse the host filesystem boundary',
}, async () => {
  const root = tempDir();
  const hostSecretPath = join(tmpdir(), `tmedge-worker-secret-${process.pid}.txt`);
  writeFileSync(hostSecretPath, 'host-only sentinel');
  writeFileSync(join(root, 'platformio.ini'), '[env:tmflash]\nplatform = native\nextra_scripts = pre:probe.py\n');
  writeFileSync(join(root, 'probe.py'), [
    'import os',
    'from pathlib import Path',
    'assert "TMEDGE_TEST_SECRET" not in os.environ',
    `assert not Path(${JSON.stringify(hostSecretPath)}).exists()`,
    'try:',
    '    Path("/opt/tmedge-worker-escape").write_text("escaped")',
    '    raise RuntimeError("worker root filesystem was writable")',
    'except PermissionError:',
    '    print("ISOLATION_PROBE_OK")',
  ].join('\n'));
  const client = new FirmwareBuildWorkerClient({ url: workerUrl, timeoutMs: 120_000 });
  try {
    const result = await client.build(root, () => {});
    assert.ok(result.log.some((line) => line.includes('ISOLATION_PROBE_OK')));
    assert.equal(result.exitCode, 1, 'the probe project has no tmflash hardware image output');
  } finally {
    await client.dispose();
    unlinkSync(hostSecretPath);
  }
});
