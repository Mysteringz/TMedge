import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { ConsoleDetection, RawFrameMessage } from '../../shared/types.js';
import { sendLatest } from '../../shared/fanout.js';
import { WebSocketServer, type WebSocket } from 'ws';

const MAX_SUBSCRIPTIONS = 64;

interface ConsoleStreamSource {
  on(event: 'report', listener: (uid: string, detections: ConsoleDetection[], at: number) => void): this;
  on(event: 'raw', listener: (message: RawFrameMessage) => void): this;
  on(event: 'rgb', listener: (uid: string, jpeg: Buffer, at: number) => void): this;
  off(event: 'report', listener: (uid: string, detections: ConsoleDetection[], at: number) => void): this;
  off(event: 'raw', listener: (message: RawFrameMessage) => void): this;
  off(event: 'rgb', listener: (uid: string, jpeg: Buffer, at: number) => void): this;
}

/** Owns console WebSocket upgrades, subscriptions, broadcasts, and cleanup. */
export class ConsoleWebSocketAdapter {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly subscriptions = new Map<WebSocket, Set<string>>();
  private readonly secret = randomBytes(32);
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly onUpgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void => {
    this.handleUpgrade(request, socket, head);
  };
  private readonly onReport = (uid: string, detections: ConsoleDetection[], at: number): void => {
    this.broadcast({ type: 'report', uid, at, dets: detections });
  };
  private readonly onRaw = (frame: RawFrameMessage): void => {
    this.broadcast({ type: 'raw', ...frame }, (client) => this.subscriptions.get(client)?.has(frame.uid) ?? false);
  };
  private readonly onRgb = (uid: string, jpeg: Buffer, at: number): void => {
    this.broadcast({ type: 'rgb', uid, at, jpeg: jpeg.toString('base64') }, (client) => this.subscriptions.get(client)?.has(uid) ?? false);
  };

  constructor(
    private readonly server: Server,
    private readonly source: ConsoleStreamSource,
    private readonly state: () => Record<string, unknown>,
  ) {}

  start(): void {
    if (this.started) return;
    if (this.closed) throw new Error('console WebSocket adapter is closed');
    this.started = true;
    this.server.on('upgrade', this.onUpgrade);
    this.source.on('report', this.onReport);
    this.source.on('raw', this.onRaw);
    this.source.on('rgb', this.onRgb);
    this.timer = setInterval(() => this.broadcast({ type: 'state', ...this.state() }), 1000);
    this.timer.unref();
  }

  issueToken(now = Date.now()): string {
    const expiresAt = now + 60_000;
    return `${expiresAt}.${createHmac('sha256', this.secret).update(String(expiresAt)).digest('hex')}`;
  }

  broadcast(message: unknown, filter?: (client: WebSocket) => boolean): void {
    const serialized = JSON.stringify(message);
    for (const client of this.subscriptions.keys()) {
      if (client.readyState === client.OPEN && (!filter || filter(client))) sendLatest(client, serialized);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.server.off('upgrade', this.onUpgrade);
    this.source.off('report', this.onReport);
    this.source.off('raw', this.onRaw);
    this.source.off('rgb', this.onRgb);
    const clientClosures: Promise<void>[] = [];
    for (const client of this.wss.clients) {
      this.subscriptions.delete(client);
      const closed = client.readyState === 3 ? Promise.resolve() : new Promise<void>((resolve) => {
        client.once('close', () => resolve());
        const timeout = setTimeout(resolve, 1000);
        timeout.unref();
      });
      clientClosures.push(closed);
      client.close(1001, 'server shutting down');
      client.terminate();
    }
    this.closePromise = Promise.all(clientClosures)
      .then(() => new Promise<void>((resolve) => this.wss.close(() => resolve())))
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)));
    return this.closePromise;
  }

  private handleUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://x');
    const [expiresAt, signature] = (url.searchParams.get('token') ?? '').split('.');
    if (!this.validToken(url.pathname, expiresAt, signature)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (client) => this.acceptClient(client));
  }

  private validToken(pathname: string, expiresAt: string | undefined, signature: string | undefined): boolean {
    return pathname === '/ws' && Boolean(expiresAt && signature) && Number(expiresAt) > Date.now() &&
      this.safeEqual(signature ?? '', createHmac('sha256', this.secret).update(expiresAt ?? '').digest('hex'));
  }

  private acceptClient(client: WebSocket): void {
    this.subscriptions.set(client, new Set());
    client.on('message', (data) => this.receive(client, String(data)));
    client.once('close', () => this.subscriptions.delete(client));
    client.send(JSON.stringify({ type: 'state', ...this.state() }));
  }

  private receive(client: WebSocket, text: string): void {
    try {
      const message = JSON.parse(text) as { type?: string; uids?: unknown };
      if (message.type === 'subscribe' && Array.isArray(message.uids)) {
        this.subscriptions.set(client, new Set(message.uids.filter((uid): uid is string => typeof uid === 'string').slice(0, MAX_SUBSCRIPTIONS)));
      }
    } catch {
      // Malformed browser messages are ignored to keep the console stream alive.
    }
  }

  private safeEqual(actual: string, expected: string): boolean {
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  }
}
