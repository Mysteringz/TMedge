/**
 * The sign-in page's dot field, after Bluegrid's DotFieldBackground: a grid of
 * round dots whose size and opacity follow a slow, smooth noise field, drawn
 * in the console's orange.
 *
 * Noise rather than waves from moving sources: concentric rings sweeping
 * across a full-page field read as busy behind a form someone is trying to
 * fill in. Noise has no centre to look at; it drifts like haze.
 */
export interface Pointer { x: number; y: number }

// Ken Perlin's improved noise, 3D: x and y across the page, z through time,
// so the field evolves in place instead of scrolling.
const P = new Uint8Array(512);
{
  const p = Array.from({ length: 256 }, (_, i) => i);
  // A fixed shuffle: the same page every load, no Math.random in a frame.
  let s = 0x2f6b;
  for (let i = 255; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255]!;
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + t * (b - a);
function grad(h: number, x: number, y: number, z: number): number {
  const k = h & 15, u = k < 8 ? x : y, v = k < 4 ? y : k === 12 || k === 14 ? x : z;
  return ((k & 1) ? -u : u) + ((k & 2) ? -v : v);
}
/** Roughly -1..1. */
function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = P[X]! + Y, AA = P[A]! + Z, AB = P[A + 1]! + Z, B = P[X + 1]! + Y, BA = P[B]! + Z, BB = P[B + 1]! + Z;
  return lerp(
    lerp(lerp(grad(P[AA]!, x, y, z), grad(P[BA]!, x - 1, y, z), u), lerp(grad(P[AB]!, x, y - 1, z), grad(P[BB]!, x - 1, y - 1, z), u), v),
    lerp(lerp(grad(P[AA + 1]!, x, y, z - 1), grad(P[BA + 1]!, x - 1, y, z - 1), u), lerp(grad(P[AB + 1]!, x, y - 1, z - 1), grad(P[BB + 1]!, x - 1, y - 1, z - 1), u), v),
    w,
  );
}

/**
 * One frame at time t (ms) on a W x H canvas in CSS pixels. `pt` is the
 * pointer as a fraction of the canvas, or null when it is elsewhere.
 *
 * `gap` is half the page's 32px 2x Grid (console.css .cx-grid) and the first
 * dot sits on its origin, so every other dot lands on a grid intersection
 * and the rest on the midpoints. Any other pitch drifts in and out of step
 * with the lines behind it and reads as unfinished.
 */
export function drawDotWave(ctx: CanvasRenderingContext2D, t: number, W: number, H: number, ink: string, pt: Pointer | null, gap = 16): void {
  ctx.clearRect(0, 0, W, H);
  const maxR = gap * 0.3;
  // About 0.05 noise units a second: a blob takes ~20 s to come and go.
  const z = t * 0.00005;
  const cols = Math.ceil(W / gap) + 1, rows = Math.ceil(H / gap) + 1;
  // The grid's lines are 1px wide from 0, so their centres are at 0.5.
  const ox = 0.5, oy = 0.5;
  ctx.fillStyle = ink;
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      const x = ox + q * gap, y = oy + r * gap;
      // Two octaves: broad shapes about a third of a screen across, and a
      // quieter finer layer so the edges are organic rather than blobby.
      const nx = x / 420, ny = y / 420;
      let v = 0.5 + 0.55 * noise3(nx, ny, z) + 0.2 * noise3(nx * 2.3 + 17, ny * 2.3 + 5, z * 1.6);
      if (pt) {
        // A soft swell under the pointer, no rings.
        const dp = Math.hypot(x - pt.x * W, y - pt.y * H);
        v += 0.35 * Math.exp(-dp * dp / (gap * gap * 60));
      }
      v = Math.max(0, Math.min(1, v));
      // Quiet troughs, bright crests: the field reads as texture, not noise.
      ctx.globalAlpha = 0.05 + v * v * 0.7;
      ctx.beginPath();
      ctx.arc(x, y, 0.6 + v * maxR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
