/**
 * MD5, because that is what the ESP32's loader answers with when asked what
 * it has just written (SPI_FLASH_MD5), and Web Crypto does not offer it.
 *
 * Used only to compare a flash region against the image sent to it -- an
 * integrity check against a bad cable or a dropped block, never a defence
 * against anyone. test/flasher.test.ts checks it against Node's own.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = Array.from({ length: 64 }, (_unused, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(data: Uint8Array): Uint8Array {
  const length = data.length;
  // Padded to a multiple of 64 bytes: 0x80, zeros, then the bit length.
  const padded = new Uint8Array(((length + 8) >>> 6 << 6) + 64);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length << 3) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(length / 2 ** 29), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(offset + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const sum = (a + f + (K[i] ?? 0) + (m[g] ?? 0)) >>> 0;
      const shift = S[i] ?? 0;
      a = d; d = c; c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const digest = new DataView(out.buffer);
  digest.setUint32(0, a0, true); digest.setUint32(4, b0, true); digest.setUint32(8, c0, true); digest.setUint32(12, d0, true);
  return out;
}

export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function md5Hex(data: Uint8Array): string {
  return hex(md5(data));
}
