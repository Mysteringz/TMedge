import type { IncomingMessage, Server } from 'node:http';
import { parseCookies, Sessions, studentSessionVersion } from '../../student-auth/application/student-session-service.js';
import type { IStudentAccountRepository } from '../../student-auth/repositories/student-account-repository.js';
import { SnapshotStore } from '../../../web/store.js';
import { WebSocketServer, type WebSocket } from 'ws';

const COOKIE = 'tm_session';

/** Owns authenticated occupancy WebSocket clients and snapshot broadcasts. */
export class OccupancyWebSocketLifecycle {
  private readonly server: WebSocketServer;
  private readonly clients = new Map<WebSocket, { email: string; token: string }>();
  private readonly interval: NodeJS.Timeout;
  private pending: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly upgrades = new Set<import('node:stream').Duplex>();

  constructor(
    private readonly httpServer: Server,
    private readonly store: SnapshotStore,
    private readonly sessions: Sessions,
    private readonly accounts: IStudentAccountRepository,
  ) {
    this.server = new WebSocketServer({ noServer: true, maxPayload: 1024 });
    this.httpServer.on('upgrade', this.onUpgrade);
    this.interval = setInterval(this.broadcast, 10_000);
    this.interval.unref();
  }

  /** Coalesces simultaneous pushes into one current-state message. */
  readonly broadcast = (): void => {
    if (this.disposed || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.sendCurrentView();
    }, 100);
  };

  closeSession(token: string | undefined): void {
    if (!token) return;
    for (const [client, identity] of this.clients) if (identity.token === token) client.terminate();
  }

  /** Stops timers, rejects upgrades, and closes every client. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.interval);
    if (this.pending) clearTimeout(this.pending);
    this.httpServer.off('upgrade', this.onUpgrade);
    for (const socket of this.upgrades) socket.destroy();
    this.upgrades.clear();
    for (const client of this.clients.keys()) client.close(1001, 'server stopping');
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private readonly onUpgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void => {
    if (this.disposed || this.upgrades.size >= 100) { socket.destroy(); return; }
    socket.on('error', () => socket.destroy());
    this.upgrades.add(socket);
    void this.authorizeUpgrade(request, socket, head);
  };

  private async authorizeUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> {
    const timer = setTimeout(() => socket.destroy(), 5000);
    try {
      const token = parseCookies(request.headers.cookie)[COOKIE];
      const detail = this.sessions.detail(token);
      const user = detail ? await this.accounts.get(detail.email) : undefined;
      if (new URL(request.url ?? '/', 'http://x').pathname !== '/ws' || !detail || !user || detail.version !== studentSessionVersion(user)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n', () => socket.destroy());
        return;
      }
      if (this.disposed || socket.destroyed) return;
      this.server.handleUpgrade(request, socket, head, (client) => {
        this.clients.set(client, { email: detail.email, token: token! });
        client.on('close', () => this.clients.delete(client));
        client.send(JSON.stringify(this.store.view()));
      });
    } catch {
      if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n', () => socket.destroy());
    } finally {
      clearTimeout(timer);
      this.upgrades.delete(socket);
    }
  }

  private sendCurrentView(): void {
    const message = JSON.stringify(this.store.view());
    for (const [client, identity] of this.clients) {
      const detail = this.sessions.detail(identity.token);
      if (!detail || detail.email !== identity.email) { client.terminate(); continue; }
      if (client.readyState === client.OPEN) client.send(message);
    }
  }
}
