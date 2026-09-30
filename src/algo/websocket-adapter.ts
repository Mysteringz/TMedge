import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { sendLatest } from '../shared/fanout.js';

/** Owns debugger WebSocket upgrades, token signing, clients, and cleanup. */
export class AlgoWebSocketAdapter {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  private readonly clients = new Set<WebSocket>();
  private readonly secret = randomBytes(32);
  private started = false;
  private closePromise: Promise<void> | null = null;
  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    this.upgrade(request, socket, head);
  };

  constructor(private readonly httpServer: Server, private readonly initialState: () => unknown) {}

  /** Attaches the debugger's token-checked WebSocket endpoint. */
  start(): void {
    if (this.started) return;
    if (this.closePromise) throw new Error('algo WebSocket adapter is closed');
    this.started = true;
    this.httpServer.on('upgrade', this.onUpgrade);
  }

  /** Issues the existing short-lived signed query token. */
  issueToken(now = Date.now()): string {
    const expiresAt = now + 60_000;
    return `${expiresAt}.${createHmac('sha256', this.secret).update(String(expiresAt)).digest('hex')}`;
  }

  /** Sends the latest event to connected clients without queuing slow clients. */
  broadcast(message: unknown): void {
    const serialized = JSON.stringify(message);
    for (const client of this.clients) sendLatest(client, serialized);
  }

  /** Detaches upgrade handling and terminates every connected debugger client. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise((resolve) => {
      this.httpServer.off('upgrade', this.onUpgrade);
      for (const client of this.clients) {
        client.close(1001, 'debugger stopping');
        client.terminate();
      }
      this.clients.clear();
      if (!this.started) return resolve();
      this.server.close(() => resolve());
    });
    return this.closePromise;
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://x');
    const [expiresAt, signature] = (url.searchParams.get('token') ?? '').split('.');
    if (!this.validToken(url.pathname, expiresAt, signature)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.server.handleUpgrade(request, socket, head, (client) => {
      this.clients.add(client);
      client.once('close', () => this.clients.delete(client));
      client.send(JSON.stringify(this.initialState()));
    });
  }

  private validToken(pathname: string, expiresAt: string | undefined, signature: string | undefined): boolean {
    if (pathname !== '/ws' || !expiresAt || !signature || Number(expiresAt) <= Date.now()) return false;
    const expected = createHmac('sha256', this.secret).update(expiresAt).digest('hex');
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  }
}
