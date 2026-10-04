/** The home screen's spinning ASCII torus, after a1k0n's donut.c. */
export function donutFrame(A: number, B: number, W = 64, H = 30): string {
  const N = W * H, b: string[] = new Array<string>(N).fill(' '), z = new Float32Array(N);
  const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B);
  for (let j = 0; j < 6.28; j += 0.06) {
    const ct = Math.cos(j), st = Math.sin(j);
    for (let i = 0; i < 6.28; i += 0.018) {
      const sp = Math.sin(i), cp = Math.cos(i), h = ct + 2, D = 1 / (sp * h * sA + st * cA + 5), t = sp * h * cA - st * sA;
      const x = Math.floor(W / 2 + 30 * D * (cp * h * cB - t * sB)), y = Math.floor(H / 2 + 15 * D * (cp * h * sB + t * cB));
      const o = x + W * y, L = Math.floor(8 * ((st * sA - sp * ct * cA) * cB - sp * ct * sA - st * cA - cp * ct * sB));
      if (y >= 0 && y < H && x >= 0 && x < W && D > (z[o] ?? 0)) { z[o] = D; b[o] = '.,-~:;=!*#$@'[L > 0 ? L : 0] ?? '.'; }
    }
  }
  let s = '';
  for (let k = 0; k < H; k++) s += b.slice(k * W, k * W + W).join('') + '\n';
  return s;
}
