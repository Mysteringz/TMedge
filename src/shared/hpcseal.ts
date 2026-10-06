/**
 * Sealing a person's HKU PIN and one-time code in their browser, for exactly
 * one operation on the algo console (module 02, Plan A). Shared by the
 * browser and the server's tests, the way seats.ts is.
 *
 * Why seal inside HTTPS: algo.hkumyseat.com is reached through Cloudflare
 * Tunnel, so TLS ends at Cloudflare and again at cloudflared, and the body
 * would otherwise exist in plain text in both, and in the edge's request
 * parser as a JavaScript string that can never be wiped. Sealed to a key the
 * edge made for this one use, every hop up to the decryption carries only
 * ciphertext, and the edge decrypts straight into bytes it zeroes after use.
 *
 * It does not defend against whoever can change the page itself; nothing in
 * a page can.
 *
 * ECDH P-256 (a fresh key on each side), HKDF-SHA256, AES-256-GCM; the
 * additional data binds the ciphertext to one person, one action, one job.
 */
export const SEAL_INFO = 'tmedge-hpc-credentials-v1';
export const SEAL_ALG = 'ECDH-P256+HKDF-SHA256+A256GCM';

export interface SealTicket { kid: string; publicKey: string; user: string; alg: string }
export interface Sealed { kid: string; epk: string; iv: string; ct: string }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < b.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < b.length) out += B64[n & 63]!;
  }
  return out;
}

/** Bytes on a plain ArrayBuffer, which WebCrypto's typings insist on. */
export type Bytes = Uint8Array<ArrayBuffer>;

export function unb64u(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('not base64url');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let n = 0, bits = 0, o = 0;
  for (const ch of s) {
    n = (n << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (n >> bits) & 255; }
  }
  return out;
}

/** UTF-8, copied onto a fresh ArrayBuffer. */
function bytes(s: string): Bytes {
  const e = new TextEncoder().encode(s);
  const out = new Uint8Array(e.length);
  out.set(e);
  return out;
}

export function sealAad(kid: string, user: string, action: string, jobId: string | null): Bytes {
  return bytes(`${SEAL_INFO}|${kid}|${user}|${action}|${jobId ?? '-'}`);
}

/**
 * [1][pin length][pin][code length][code][password length][password], where
 * the password is the HPC SSH password when it is not the PIN (usually empty).
 */
export function packCredentials(pin: Uint8Array, otp: Uint8Array, password: Uint8Array = new Uint8Array(0)): Bytes {
  if (pin.length < 1 || pin.length > 128 || otp.length < 6 || otp.length > 8 || password.length > 128) throw new Error('credential lengths out of range');
  const out = new Uint8Array(4 + pin.length + otp.length + password.length);
  let p = 0;
  out[p++] = 1;
  for (const f of [pin, otp, password]) { out[p++] = f.length; out.set(f, p); p += f.length; }
  return out;
}

/** Encrypts `plaintext` for the ticket's key, then zeroes `plaintext`. */
export async function sealCredentials(ticket: SealTicket, action: string, jobId: string | null, plaintext: Bytes): Promise<Sealed> {
  const subtle = globalThis.crypto.subtle;
  try {
    const server = await subtle.importKey('raw', unb64u(ticket.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const mine = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: server }, mine.privateKey, 256));
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    shared.fill(0);
    const key = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: unb64u(ticket.kid), info: bytes(SEAL_INFO) },
      hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: sealAad(ticket.kid, ticket.user, action, jobId) }, key, plaintext);
    return { kid: ticket.kid, epk: b64u(await subtle.exportKey('raw', mine.publicKey)), iv: b64u(iv), ct: b64u(ct) };
  } finally {
    plaintext.fill(0);
  }
}
