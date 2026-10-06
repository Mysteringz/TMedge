/**
 * The terminal channel for module 02's shell on the cluster: the browser's
 * half (WebCrypto), shared with the server's tests.
 *
 * What a person types into the shell -- a `passwd`, a token -- deserves the
 * same care as their PIN, and this site is behind Cloudflare Tunnel, where
 * TLS ends before the edge. So the stream is encrypted end to end between
 * the page and the edge process: ECDH P-256 (a fresh key on each side, per
 * terminal), HKDF-SHA256 into one AES-256-GCM key per direction, and a
 * frame counter in every nonce that must go up by exactly one, so frames
 * cannot be replayed, dropped or reordered unnoticed.
 *
 * Frame: [12-byte IV = direction, 0, 0, 0, counter as u64 BE][ciphertext + tag]
 * Plaintext: [type][payload] -- 0 data, 1 resize (u16 cols, u16 rows), 2 exit (u8 code).
 */
import { b64u, unb64u, type Bytes } from './hpcseal.js';

export const TERM_INFO = 'tmedge-hpc-terminal-v1';
export const DIR_C2S = 1;
export const DIR_S2C = 2;
export const T_DATA = 0;
export const T_RESIZE = 1;
export const T_EXIT = 2;

export interface TermTicket { tid: string; publicKey: string }

/** WebCrypto's key type, named the same way in the browser and in Node's typings. */
type Key = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

export function termAad(tid: string): Bytes {
  const e = new TextEncoder().encode(`${TERM_INFO}|${tid}`);
  const out = new Uint8Array(e.length);
  out.set(e);
  return out;
}

export function termIv(dir: number, counter: number): Bytes {
  const iv = new Uint8Array(12);
  iv[0] = dir;
  new DataView(iv.buffer).setBigUint64(4, BigInt(counter));
  return iv;
}

export function counterOf(iv: Uint8Array): { dir: number; counter: number } {
  return { dir: iv[0]!, counter: Number(new DataView(iv.buffer, iv.byteOffset, 12).getBigUint64(4)) };
}

/** The browser's end: keys, counters, and strict in-order processing both ways. */
export class TermChannel {
  private sendCount = 0;
  private recvCount = 0;
  private sendChain: Promise<unknown> = Promise.resolve();
  private recvChain: Promise<unknown> = Promise.resolve();

  private constructor(readonly tid: string, readonly publicKey: string, private readonly c2s: Key, private readonly s2c: Key) {}

  static async open(t: TermTicket): Promise<TermChannel> {
    const subtle = globalThis.crypto.subtle;
    const server = await subtle.importKey('raw', unb64u(t.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const mine = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: server }, mine.privateKey, 256));
    const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    shared.fill(0);
    const info = new TextEncoder().encode(TERM_INFO);
    const infoBytes = new Uint8Array(info.length);
    infoBytes.set(info);
    const okm = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: unb64u(t.tid), info: infoBytes }, hk, 512));
    const c2s = await subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt']);
    const s2c = await subtle.importKey('raw', okm.slice(32, 64), 'AES-GCM', false, ['decrypt']);
    okm.fill(0);
    return new TermChannel(t.tid, b64u(await subtle.exportKey('raw', mine.publicKey)), c2s, s2c);
  }

  /** Encrypts one message; calls resolve in the order they were sent. */
  seal(type: number, payload: Uint8Array): Promise<Bytes> {
    const n = this.sendCount++;
    const run = this.sendChain.then(async () => {
      const plain = new Uint8Array(1 + payload.length);
      plain[0] = type;
      plain.set(payload, 1);
      const iv = termIv(DIR_C2S, n);
      const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: termAad(this.tid) }, this.c2s, plain));
      plain.fill(0);
      const frame = new Uint8Array(12 + ct.length);
      frame.set(iv);
      frame.set(ct, 12);
      return frame;
    });
    this.sendChain = run.catch(() => undefined);
    return run;
  }

  /** Decrypts one frame, in arrival order; rejects anything out of sequence or tampered with. */
  open(frame: Uint8Array): Promise<{ type: number; payload: Uint8Array }> {
    const run = this.recvChain.then(async () => {
      if (frame.length < 12 + 16 + 1) throw new Error('short frame');
      const iv = frame.slice(0, 12);
      const { dir, counter } = counterOf(iv);
      if (dir !== DIR_S2C || counter !== this.recvCount) throw new Error('frame out of sequence');
      this.recvCount++;
      const plain = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: termAad(this.tid) }, this.s2c, frame.slice(12)));
      return { type: plain[0]!, payload: plain.subarray(1) };
    });
    this.recvChain = run.catch(() => undefined);
    return run;
  }
}

/** The part of a WebSocket the sender needs (the browser's, or ws in tests). */
export interface FrameSocket { readonly readyState: number; send(data: Uint8Array): void }

/**
 * Sends sealed frames in order, never dropping one. A frame made before the
 * socket is open -- the first resize when the terminal fits itself, xterm's
 * reply to the shell's first query -- waits here, because its counter is
 * already spent: dropping it would put every later frame out of sequence and
 * the edge would (rightly) close the terminal.
 */
export class TermSender {
  private queue: Uint8Array[] = [];
  private socket: FrameSocket | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly channel: TermChannel) {}

  send(type: number, payload: Uint8Array): Promise<void> {
    const sealed = this.channel.seal(type, payload);
    // seal() resolves in counter order; so do these, one after another.
    const run = this.chain.then(() => sealed).then((frame) => {
      if (this.socket && this.socket.readyState === 1) this.socket.send(frame);
      else this.queue.push(frame);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Call when the socket opens: everything held goes first, in order. */
  open(socket: FrameSocket): Promise<void> {
    const run = this.chain.then(() => {
      this.socket = socket;
      for (const f of this.queue.splice(0)) socket.send(f);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
