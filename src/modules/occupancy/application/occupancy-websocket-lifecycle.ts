import type { IncomingMessage, Server } from 'node:http';
import { parseCookies, Sessions } from '../../student-auth/application/student-session-service.js';
import type { IStudentAccountRepository } from '../../student-auth/repositories/student-account-repository.js';
import { SnapshotStore } from '../../../web/store.js';
import { WebSocketServer, type WebSocket } from 'ws';

const COOKIE = 'tm_session';

/** Owns authenticated occupancy WebSocket clients and snapshot broadcasts. */
export class OccupancyWebSocketLifecycle {
  private readonly server: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private readonly interval: NodeJS.Timeout;
  private pending: NodeJS.Timeout | null = null;
  private disposed = false;

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

  /** Stops timers, rejects upgrades, and closes every client. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.interval);
    if (this.pending) clearTimeout(this.pending);
    this.httpServer.off('upgrade', this.onUpgrade);
    for (const client of this.clients) client.close(1001, 'server stopping');
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private readonly onUpgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void => {
    const email = this.sessions.read(parseCookies(request.headers.cookie)[COOKIE]);
    if (new URL(request.url ?? '/', 'http://x').pathname !== '/ws' || !email || !this.accounts.get(email)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.server.handleUpgrade(request, socket, head, (client) => {
      this.clients.add(client);
      client.on('close', () => this.clients.delete(client));
      client.send(JSON.stringify(this.store.view()));
    });
  };

  private sendCurrentView(): void {
    const message = JSON.stringify(this.store.view());
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  }
}
