/**
 * The edge's half of credential sealing (src/shared/hpcseal.ts): a one-time
 * key per operation, and decryption straight into bytes.
 *
 * What this file promises about a PIN or code:
 * - it is never a JavaScript string here (strings cannot be wiped, and live
 *   until the garbage collector decides);
 * - it lives in one Buffer, which `Credentials.wipe()` zeroes, and every
 *   intermediate (shared secret, derived key, deciphered pieces) is zeroed
 *   before this returns;
 * - printing, logging or serialising a Credentials shows "[redacted]".
 *
 * A ticket is single use: its private key is forgotten on the first attempt
 * to open, whether or not that succeeds.
 */
import { createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import { inspect } from 'node:util';
import { SEAL_ALG, SEAL_INFO, sealAad, unb64u, type SealTicket } from '../../../shared/hpcseal.js';

export class SealError extends Error {}

const TTL_MS = 3 * 60_000;
const MAX_TICKETS_PER_USER = 4;
const MAX_TICKETS = 256;

export class Credentials {
  readonly #buf: Buffer;
  readonly #pin: Buffer;
  readonly #otp: Buffer;
  readonly #password: Buffer | null;
  #wiped = false;

  /** Takes ownership of `plain`, the unpacked plaintext. */
  constructor(plain: Buffer) {
    if (plain[0] !== 1) throw new SealError('unknown credential format');
    const fields: Buffer[] = [];
    let p = 1;
    for (let i = 0; i < 3; i++) {
      const len = plain[p++];
      if (len === undefined || p + len > plain.length) throw new SealError('malformed credentials');
      fields.push(plain.subarray(p, p + len));
      p += len;
    }
    if (p !== plain.length) throw new SealError('malformed credentials');
    const [pin, otp, password] = fields as [Buffer, Buffer, Buffer];
    // Each value goes down a line-based pipe: no line breaks, no NUL.
    const lineSafe = (b: Buffer) => !b.includes(0x0a) && !b.includes(0x0d) && !b.includes(0x00);
    if (pin.length < 1 || !lineSafe(pin)) throw new SealError('the PIN is empty or has a line break in it');
    if (otp.length < 6 || otp.length > 8 || !otp.every((c) => c >= 0x30 && c <= 0x39)) throw new SealError('the one-time code is 6 to 8 digits');
    if (!lineSafe(password)) throw new SealError('the HPC password has a line break in it');
    this.#buf = plain;
    this.#pin = pin;
    this.#otp = otp;
    this.#password = password.length > 0 ? password : null;
  }

  #live(b: Buffer): Buffer {
    if (this.#wiped) throw new SealError('credentials were already used and wiped');
    return b;
  }

  pin(): Buffer { return this.#live(this.#pin); }
  otp(): Buffer { return this.#live(this.#otp); }
  /** HPC2021's SSH password is the Portal PIN unless the person said otherwise. */
  sshPassword(): Buffer { return this.#live(this.#password ?? this.#pin); }
  /** The password typed for SSH, if one was (shared-account mode requires it). */
  sshPasswordGiven(): Buffer | null { return this.#password ? this.#live(this.#password) : null; }
  get wiped(): boolean { return this.#wiped; }

  wipe(): void {
    this.#buf.fill(0);
    this.#wiped = true;
  }

  toString(): string { return '[redacted]'; }
  toJSON(): string { return '[redacted]'; }
  [inspect.custom](): string { return 'Credentials [redacted]'; }
}

interface Ticket { ecdh: ECDH; user: string; expires: number }

export class SealedInbox {
  private tickets = new Map<string, Ticket>();

  constructor(private readonly now: () => number = Date.now) {}

  private sweep(): void {
    const t = this.now();
    for (const [kid, ticket] of this.tickets) if (ticket.expires <= t) this.tickets.delete(kid);
  }

  /** A fresh key for one sealed message from `user`. */
  issue(user: string): SealTicket {
    this.sweep();
    const mine = [...this.tickets.entries()].filter(([, t]) => t.user === user);
    while (mine.length >= MAX_TICKETS_PER_USER) this.tickets.delete(mine.shift()![0]);
    if (this.tickets.size >= MAX_TICKETS) throw new SealError('too many sign-ins in progress; try again in a minute');
    const ecdh = createECDH('prime256v1');
    const publicKey = ecdh.generateKeys();
    const kid = randomBytes(16).toString('base64url');
    this.tickets.set(kid, { ecdh, user, expires: this.now() + TTL_MS });
    return { kid, publicKey: publicKey.toString('base64url'), user, alg: SEAL_ALG };
  }

  /**
   * Decrypts a sealed message from the browser into Credentials. The ticket
   * is gone after this, success or not. Messages never contain the input.
   */
  open(user: string, sealed: unknown, action: string, jobId: string | null): Credentials {
    if (typeof sealed !== 'object' || sealed === null) throw new SealError('expected sealed credentials');
    const s = sealed as Record<string, unknown>;
    const field = (k: string, max: number) => {
      const v = s[k];
      if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new SealError('malformed sealed credentials');
      try { return Buffer.from(unb64u(v)); } catch { throw new SealError('malformed sealed credentials'); }
    };
    const kid = typeof s.kid === 'string' ? s.kid : '';
    const ticket = this.tickets.get(kid);
    this.tickets.delete(kid);
    if (!ticket || ticket.user !== user || ticket.expires <= this.now()) {
      throw new SealError('the sign-in form expired; open it again');
    }
    const epk = field('epk', 100);
    const iv = field('iv', 24);
    const ct = field('ct', 800);
    if (iv.length !== 12 || ct.length < 17) throw new SealError('malformed sealed credentials');
    let shared: Buffer | null = null;
    let key: Buffer | null = null;
    const pieces: Buffer[] = [];
    try {
      shared = ticket.ecdh.computeSecret(epk);
      key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(unb64u(kid)), SEAL_INFO, 32));
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(sealAad(kid, user, action, jobId)));
      decipher.setAuthTag(ct.subarray(ct.length - 16));
      pieces.push(decipher.update(ct.subarray(0, ct.length - 16)));
      pieces.push(decipher.final());
      const plain = Buffer.alloc(pieces.reduce((n, b) => n + b.length, 0));
      let o = 0;
      for (const b of pieces) { b.copy(plain, o); o += b.length; }
      try {
        return new Credentials(plain);
      } catch (err) {
        plain.fill(0);
        throw err;
      }
    } catch (err) {
      if (err instanceof SealError) throw err;
      throw new SealError('the sealed credentials did not open (expired form, or not meant for this action)');
    } finally {
      shared?.fill(0);
      key?.fill(0);
      for (const b of pieces) b.fill(0);
    }
  }
}
