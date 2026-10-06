/**
 * The shared cluster password, kept only as a fingerprint (an scrypt hash
 * with its own salt) in DATA_DIR on the box, never in git: everyone types the
 * password at each sign-in, and it is checked here before anything connects,
 * so a typo costs no HKU login, no one-time code and no failed SSH attempt on
 * the cluster.
 *
 * scrypt with N=2^15, r=8 costs 32 MiB and tens of milliseconds per guess,
 * which keeps an offline attack on a stolen file slow without straining a
 * 1 GB box. The password itself only ever arrives here as bytes.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writePrivateJson } from '../../../shared/private-file.js';

export interface Fingerprint {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
  setAt: string;
}

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };

function derive(password: Buffer, salt: Buffer, f: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: f.N, r: f.r, p: f.p, maxmem: 256 * f.N * f.r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function makeFingerprint(password: Buffer): Promise<Fingerprint> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  const fp: Fingerprint = { alg: 'scrypt', ...PARAMS, salt: salt.toString('hex'), hash: key.toString('hex'), setAt: new Date().toISOString() };
  key.fill(0);
  return fp;
}

export async function matches(password: Buffer, fp: Fingerprint): Promise<boolean> {
  const key = await derive(password, Buffer.from(fp.salt, 'hex'), fp);
  try {
    const want = Buffer.from(fp.hash, 'hex');
    return want.length === key.length && timingSafeEqual(key, want);
  } finally {
    key.fill(0);
  }
}

/** The stored fingerprint, or null when none is set (or the file is not one). */
export function loadFingerprint(path: string): Fingerprint | null {
  if (!existsSync(path)) return null;
  try {
    const f = JSON.parse(readFileSync(path, 'utf8')) as Fingerprint;
    const ok = f.alg === 'scrypt' && Number.isInteger(f.N) && f.N >= 2 ** 14 && f.N <= 2 ** 20 && Number.isInteger(f.r) && f.r >= 1 && f.r <= 16 &&
      Number.isInteger(f.p) && f.p >= 1 && f.p <= 4 && /^[0-9a-f]{32}$/.test(f.salt) && /^[0-9a-f]{64}$/.test(f.hash);
    return ok ? f : null;
  } catch {
    return null;
  }
}

export function saveFingerprint(path: string, fp: Fingerprint): void {
  writePrivateJson(path, fp);
}
