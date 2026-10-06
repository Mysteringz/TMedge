import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import { projectTarStream } from './project-tar-stream.js';

export interface WorkerBuildResult {
  exitCode: number;
  artifact: Buffer | null;
  log: string[];
}

export interface FirmwareBuildWorker {
  build(projectRoot: string, reportProgress: (line: string) => void): Promise<WorkerBuildResult>;
  dispose(): Promise<void>;
}

export interface FirmwareBuildWorkerOptions {
  url?: string;
  timeoutMs?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/** Streams a source archive to the isolated worker and forwards bounded log events. */
export class FirmwareBuildWorkerClient implements FirmwareBuildWorker {
  private readonly requests = new Map<ClientRequest, (error: Error) => void>();
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly endpointConfigured: boolean;
  private disposed = false;

  constructor(private readonly options: FirmwareBuildWorkerOptions = {}) {
    const configuredUrl = options.url ?? process.env.FIRMWARE_BUILD_WORKER_URL;
    this.endpointConfigured = configuredUrl !== undefined && configuredUrl.length > 0;
    this.url = new URL(configuredUrl ?? 'http://127.0.0.1:8123/build');
    if (this.url.protocol !== 'http:' && this.url.protocol !== 'https:') throw new Error('firmware worker URL must use HTTP or HTTPS');
    this.timeoutMs = options.timeoutMs ?? 20 * 60_000;
  }

  get configured(): boolean {
    return this.endpointConfigured && Boolean(this.url.hostname && this.url.pathname === '/build');
  }

  async build(projectRoot: string, reportProgress: (line: string) => void): Promise<WorkerBuildResult> {
    if (this.disposed) throw new Error('firmware build worker client is closed');
    if (!this.configured) throw new Error('FIRMWARE_BUILD_WORKER_URL must point to the isolated build worker');
    const archive = await projectTarStream(projectRoot, {
      maxFiles: this.options.maxFiles ?? 800,
      maxFileBytes: this.options.maxFileBytes ?? 8 * 1024 * 1024,
      maxTotalBytes: this.options.maxTotalBytes ?? 64 * 1024 * 1024,
    });
    if (this.disposed) {
      archive.stream.destroy();
      throw new Error('firmware build worker client is closed');
    }
    return this.postArchive(archive.stream, archive.contentLength, reportProgress);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const active = [...this.requests];
    await Promise.all(active.map(async ([request, finish]) => {
      const closed = waitForRequestClose(request);
      finish(new Error('firmware build worker is shutting down'));
      await closed;
    }));
  }

  private postArchive(archive: Readable, contentLength: number, reportProgress: (line: string) => void): Promise<WorkerBuildResult> {
    return new Promise((resolve, reject) => {
      const send = this.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = send(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-tar', accept: 'application/x-ndjson', 'content-length': String(contentLength) },
      });
      let settled = false;
      let response: IncomingMessage | null = null;
      let buffer = '';
      let result: WorkerBuildResult | null = null;
      const log: string[] = [];
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.requests.delete(request);
        archive.unpipe(request);
        archive.destroy();
        response?.destroy();
        request.destroy();
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error('firmware build worker returned no result'));
      };
      const timeout = setTimeout(() => finish(new Error('firmware build worker timed out')), this.timeoutMs);
      timeout.unref();
      this.requests.set(request, finish);
      request.once('response', (incoming) => {
        response = incoming;
        incoming.once('error', (error) => finish(error));
        incoming.once('aborted', () => finish(new Error('firmware worker response was aborted')));
        incoming.once('close', () => {
          if (!incoming.complete) finish(new Error('firmware worker response closed before completion'));
        });
        if (incoming.statusCode !== 200) {
          const details: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => details.push(chunk));
          incoming.once('end', () => finish(new Error(`firmware worker returned HTTP ${incoming.statusCode}: ${Buffer.concat(details).toString('utf8').slice(0, 1000)}`)));
          return;
        }
        incoming.on('data', (chunk: Buffer) => {
          if (settled) return;
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (settled) break;
            consumeEvent(line, log, reportProgress, (value) => { result = value; }, finish);
          }
        });
        incoming.once('end', () => {
          if (settled) return;
          if (buffer.trim()) consumeEvent(buffer, log, reportProgress, (value) => { result = value; }, finish);
          finish();
        });
      });
      request.once('error', (error) => finish(error));
      request.once('close', () => {
        if (!response) finish(new Error('firmware worker request closed before a response'));
      });
      archive.once('error', (error) => finish(error));
      archive.pipe(request);
    });
  }
}

function consumeEvent(
  line: string,
  log: string[],
  reportProgress: (line: string) => void,
  setResult: (result: WorkerBuildResult) => void,
  fail: (error?: Error) => void,
): void {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line) as { type?: string; line?: unknown; exitCode?: unknown; artifactBase64?: unknown };
    if (event.type === 'log' && typeof event.line === 'string') {
      log.push(event.line);
      if (log.length > 400) log.shift();
      reportProgress(event.line);
    }
    if (event.type === 'result' && typeof event.exitCode === 'number') {
      const artifact = typeof event.artifactBase64 === 'string' ? Buffer.from(event.artifactBase64, 'base64') : null;
      setResult({ exitCode: event.exitCode, artifact, log: log.slice(-400) });
    }
  } catch {
    fail(new Error('firmware worker returned malformed progress data'));
  }
}

function waitForRequestClose(request: ClientRequest): Promise<void> {
  if (request.closed) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    timeout.unref();
    request.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
