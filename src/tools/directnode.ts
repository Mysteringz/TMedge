/**
 * A direct node in TypeScript: the client side of tmnode.v1, for tests and
 * for driving a local edge by hand. The firmware's own implementation is
 * TMsense/src/tm_cloud_session.cpp; `npm run crosscheck` runs that one
 * against this edge, so this file agreeing with nodelink.ts is not the proof.
 *
 *   node dist/src/tools/directnode.js --url ws://127.0.0.1:5211/tmnode --uid 02:00:00:00:00:01 [--frames 30]
 *
 * The key comes from TM_KEY, never from the command line.
 */
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { SUBPROTOCOL } from '../edge/nodelink.js';
import { buildReport, buildStatus, type Identity } from '../edge/protocol.js';

export interface Ack { session: string; boot: number; seq: number }
export interface Grant { seq: number; build: string; token: string; expiresInMs: number }

export class DirectNodeClient {
  ws: WebSocket | null = null;
  session: string | null = null;
  readonly acks: Ack[] = [];
  readonly grants: Grant[] = [];
  readonly downlinks: Buffer[] = [];
  closeCode: number | null = null;
  closeReason = '';
  private waiters: (() => void)[] = [];

  constructor(readonly url: string, readonly uid: string, readonly key: Buffer,
    readonly opts: { protocol?: string; ca?: Buffer; macOverride?: (nonce: string) => string } = {}) {}

  /** Connect and authenticate; resolves once `ready` arrives, rejects on close. */
  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, this.opts.protocol ?? SUBPROTOCOL, { perMessageDeflate: false, ca: this.opts.ca });
      this.ws = ws;
      ws.on('message', (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        if (isBinary) {
          this.downlinks.push(buf);
        } else {
          const m = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
          if (m.type === 'challenge' && typeof m.nonce === 'string') {
            const mac = this.opts.macOverride?.(m.nonce) ??
              createHmac('sha256', this.key).update(`tmnode1|${this.uid}|${m.nonce}`).digest('hex');
            ws.send(JSON.stringify({ type: 'auth', v: 1, uid: this.uid, nonce: m.nonce, mac }));
          } else if (m.type === 'ready' && typeof m.session === 'string') {
            this.session = m.session;
            resolve(m.session);
          } else if (m.type === 'ack') {
            this.acks.push({ session: String(m.session), boot: Number(m.boot), seq: Number(m.seq) });
          } else if (m.type === 'ota_grant') {
            this.grants.push({ seq: Number(m.seq), build: String(m.build), token: String(m.token), expiresInMs: Number(m.expiresInMs) });
          }
        }
        this.wake();
      });
      ws.on('close', (code, reason) => {
        this.closeCode = code;
        this.closeReason = reason.toString();
        this.wake();
        reject(new Error(`closed ${code} ${this.closeReason}`));
      });
      ws.on('error', () => undefined);
    });
  }

  send(datagram: Buffer): void {
    this.ws?.send(datagram, { binary: true });
  }

  close(): void {
    this.ws?.close();
  }

  /** Resolve when `pred` holds, re-checked on every message; reject after `ms`. */
  until(pred: () => boolean, ms = 2000): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting')), ms);
      const check = () => {
        if (pred()) {
          clearTimeout(t);
          resolve();
        } else {
          this.waiters.push(check);
        }
      };
      this.waiters.push(check);
    });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
}

async function main(): Promise<void> {
  const arg = (k: string, d: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 ? process.argv[i + 1] ?? d : d;
  };
  const key = process.env.TM_KEY;
  if (!key) throw new Error('set TM_KEY');
  const uid = arg('uid', '02:00:00:00:00:01');
  const frames = Number(arg('frames', '30'));
  const c = new DirectNodeClient(arg('url', 'ws://127.0.0.1:5211/tmnode'), uid, Buffer.from(key));
  const session = await c.connect();
  console.log(`ready, session ${session}`);
  const id: Identity = { uid, boot: Math.floor(Date.now() / 1000) % 65535, seq: 0, key: Buffer.from(key) };
  const t0 = Date.now();
  c.send(buildStatus(id, 0, {
    fw: 'directnode', ip: '0.0.0.0', rssi: 0, channel: 0, freeHeap: 0, minHeap: 0, stackFree: 0, wifiDrops: 0,
    sensorErrors: 0, frames: 0, fps: 1, vdd: 3.3, ta: 30, lastCmd: 0, flags: 1, params: {},
  }));
  for (let f = 0; f < frames; f++) {
    c.send(buildReport(id, Date.now() - t0, { frame: f, ta: 30, sceneMin: 22, sceneMax: 32, bgMean: 23, flags: 1, detections: [] }));
    await new Promise((r) => setTimeout(r, 1000));
    console.log(`frame ${f}: ${c.acks.length} acks, ${c.downlinks.length} downlinks`);
  }
  c.close();
}

if (process.argv[1]?.endsWith('directnode.js')) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
