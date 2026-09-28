/**
 * Sending live data to a browser that may not keep up.
 *
 * `ws.send` never refuses: whatever a slow client has not taken yet waits in
 * this process's memory. The console and the algo debugger stream frames
 * every second, so one tab behind a slow link (a VPN, a phone) queued without
 * bound until the edge ran out of heap and was killed -- taking ingest,
 * occupancy and the site's data down with it (four times on 2026-09-26, once
 * on 2026-09-27). Live views only ever want the newest state, and both resend
 * it periodically, so a client that is behind simply misses messages until it
 * has caught up. It sees fewer updates, never older ones, and the edge's
 * memory stays bounded.
 */
import type { WebSocket } from 'ws';

/** Unsent bytes one client may have queued before it is skipped. */
export const MAX_CLIENT_BACKLOG = 1024 * 1024;

/** Send unless this client is already behind. Returns whether it was sent. */
export function sendLatest(ws: WebSocket, data: string | Buffer, maxBacklog = MAX_CLIENT_BACKLOG): boolean {
  if (ws.readyState !== ws.OPEN || ws.bufferedAmount > maxBacklog) return false;
  ws.send(data);
  return true;
}
