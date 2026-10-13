/**
 * The thermal people detector, run on the edge with no ML runtime.
 *
 * Trained in PyTorch (tools/thermalml/heatnet.py) and shipped as JSON: a short
 * list of layers -- 3x3 and 1x1 convolutions with zero padding and stride 1
 * or 2, ReLU, nearest 2x upsampling, add -- with batch norm folded into the
 * weights. This file is those four operations and the decoding, nothing
 * else, so it can be checked line by line against heatnet.forward_np; the
 * golden files in test/golden/heatmodel make that check concrete.
 *
 * Input is heatfeatures.ts's (3 x 24 x 32). Output is one heatmap cell per
 * 2x2 thermal pixels, whose local maxima above the threshold are people.
 */

export const HEAT_MODEL_KIND = 'cnn-heatmap';
export const HEAT_MODEL_VERSION = 2;
export const HEAT_FEATURES = 'heatfeatures-v1';

export interface ConvLayer {
  op: 'conv';
  name: string;
  input: string;
  output: string;
  in: number;
  out: number;
  k: 1 | 3;
  stride: 1 | 2;
  relu: boolean;
  w: number[];
  b: number[];
}
export type HeatLayer = ConvLayer | { op: 'up2'; input: string; output: string } | { op: 'add'; inputs: [string, string]; output: string };

export interface HeatModel {
  version: 2;
  kind: typeof HEAT_MODEL_KIND;
  id: string;
  features: typeof HEAT_FEATURES;
  input: [3, 24, 32];
  outputs: { heatmap: string; offset: string; stride: 2 };
  layers: HeatLayer[];
  threshold: number;
  trainedAt?: number;
  metrics?: Record<string, unknown>;
}

interface Tensor { c: number; h: number; w: number; d: Float32Array }

/** People in thermal pixels; confidence is the heatmap value at the peak. */
export interface HeatDetection { x: number; y: number; confidence: number }

const finiteArray = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * Strict: a model file that does not describe exactly a network this file can
 * run is refused, never half-run. Shapes are checked by walking the layers.
 */
export function isHeatModel(v: unknown): v is HeatModel {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  if (m.version !== HEAT_MODEL_VERSION || m.kind !== HEAT_MODEL_KIND || m.features !== HEAT_FEATURES) return false;
  if (typeof m.id !== 'string' || !/^[0-9a-f]{8,64}$/.test(m.id)) return false;
  if (typeof m.threshold !== 'number' || !(m.threshold > 0 && m.threshold < 1)) return false;
  if (!Array.isArray(m.input) || m.input.join() !== '3,24,32') return false;
  const o = m.outputs as Record<string, unknown> | undefined;
  if (!o || typeof o.heatmap !== 'string' || typeof o.offset !== 'string' || o.stride !== 2) return false;
  if (!Array.isArray(m.layers) || m.layers.length === 0 || m.layers.length > 64) return false;
  const shapes = new Map<string, [number, number, number]>([['x', [3, 24, 32]]]);
  for (const raw of m.layers as unknown[]) {
    const L = raw as Record<string, unknown>;
    if (typeof L.output !== 'string' || shapes.has(L.output)) return false;
    if (L.op === 'conv') {
      const src = typeof L.input === 'string' ? shapes.get(L.input) : undefined;
      const cin = L.in, cout = L.out, k = L.k, s = L.stride;
      if (!src || typeof cin !== 'number' || typeof cout !== 'number' || cin !== src[0] || !Number.isInteger(cout) || cout < 1 || cout > 256) return false;
      if ((k !== 1 && k !== 3) || (s !== 1 && s !== 2) || typeof L.relu !== 'boolean') return false;
      if (!finiteArray(L.w, cout * cin * k * k) || !finiteArray(L.b, cout)) return false;
      const pad = (k - 1) / 2;
      shapes.set(L.output, [cout, Math.floor((src[1] + 2 * pad - k) / s) + 1, Math.floor((src[2] + 2 * pad - k) / s) + 1]);
    } else if (L.op === 'up2') {
      const src = typeof L.input === 'string' ? shapes.get(L.input) : undefined;
      if (!src) return false;
      shapes.set(L.output, [src[0], src[1] * 2, src[2] * 2]);
    } else if (L.op === 'add') {
      const ins = L.inputs;
      if (!Array.isArray(ins) || ins.length !== 2) return false;
      const [a, b] = ins.map((n) => (typeof n === 'string' ? shapes.get(n) : undefined));
      if (!a || !b || a.join() !== b.join()) return false;
      shapes.set(L.output, a);
    } else {
      return false;
    }
  }
  const hm = shapes.get(o.heatmap), off = shapes.get(o.offset);
  return !!hm && !!off && hm.join() === '1,12,16' && off.join() === '2,12,16';
}

function conv(x: Tensor, L: ConvLayer): Tensor {
  const { k, stride: s } = L;
  const pad = (k - 1) / 2;
  const ho = Math.floor((x.h + 2 * pad - k) / s) + 1;
  const wo = Math.floor((x.w + 2 * pad - k) / s) + 1;
  const out = new Float32Array(L.out * ho * wo);
  const xd = x.d, w = L.w;
  for (let o = 0; o < L.out; o++) {
    const bias = L.b[o] ?? 0;
    for (let y = 0; y < ho; y++) {
      for (let xx = 0; xx < wo; xx++) {
        let acc = bias;
        for (let c = 0; c < L.in; c++) {
          const wBase = ((o * L.in + c) * k) * k;
          const xBase = c * x.h * x.w;
          for (let ky = 0; ky < k; ky++) {
            const iy = y * s + ky - pad;
            if (iy < 0 || iy >= x.h) continue;
            for (let kx = 0; kx < k; kx++) {
              const ix = xx * s + kx - pad;
              if (ix < 0 || ix >= x.w) continue;
              acc += (w[wBase + ky * k + kx] ?? 0) * (xd[xBase + iy * x.w + ix] ?? 0);
            }
          }
        }
        out[(o * ho + y) * wo + xx] = L.relu && acc < 0 ? 0 : acc;
      }
    }
  }
  return { c: L.out, h: ho, w: wo, d: out };
}

/** Heatmap logits (12 x 16) and offsets (2 x 12 x 16) for one (3 x 24 x 32) input. */
export function heatForward(model: HeatModel, features: Float32Array): { heatmap: Float32Array; offset: Float32Array } {
  if (features.length !== 3 * 24 * 32) throw new Error('heat model input must be 3 x 24 x 32');
  const t = new Map<string, Tensor>([['x', { c: 3, h: 24, w: 32, d: features }]]);
  for (const L of model.layers) {
    if (L.op === 'conv') {
      t.set(L.output, conv(t.get(L.input) as Tensor, L));
    } else if (L.op === 'up2') {
      const x = t.get(L.input) as Tensor;
      const h = x.h * 2, w = x.w * 2;
      const d = new Float32Array(x.c * h * w);
      for (let c = 0; c < x.c; c++) {
        for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) d[(c * h + y) * w + xx] = x.d[(c * x.h + (y >> 1)) * x.w + (xx >> 1)] ?? 0;
      }
      t.set(L.output, { c: x.c, h, w, d });
    } else {
      const a = t.get(L.inputs[0]) as Tensor, b = t.get(L.inputs[1]) as Tensor;
      const d = new Float32Array(a.d.length);
      for (let i = 0; i < d.length; i++) d[i] = (a.d[i] ?? 0) + (b.d[i] ?? 0);
      t.set(L.output, { ...a, d });
    }
  }
  return { heatmap: (t.get(model.outputs.heatmap) as Tensor).d, offset: (t.get(model.outputs.offset) as Tensor).d };
}

/**
 * Local maxima of the heatmap above `threshold`, as people in thermal pixels.
 * Ties go to raster order (as edgedetect.ts splits blobs), so a flat top is one person.
 */
export function heatDecode(heatmap: Float32Array, offset: Float32Array, threshold: number, h = 12, w = 16, stride = 2): HeatDetection[] {
  const p = new Float64Array(h * w);
  for (let i = 0; i < h * w; i++) p[i] = 1 / (1 + Math.exp(-(heatmap[i] ?? 0)));
  const out: HeatDetection[] = [];
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) {
      const v = p[i * w + j] ?? 0;
      if (v < threshold) continue;
      let peak = true;
      for (let di = -1; di <= 1 && peak; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (!(di || dj) || i + di < 0 || i + di >= h || j + dj < 0 || j + dj >= w) continue;
          const n = p[(i + di) * w + (j + dj)] ?? 0;
          if (n > v || (n === v && (i + di) * w + (j + dj) < i * w + j)) { peak = false; break; }
        }
      }
      if (peak) {
        out.push({
          x: stride * (j + 0.5 + (offset[i * w + j] ?? 0)),
          y: stride * (i + 0.5 + (offset[h * w + i * w + j] ?? 0)),
          confidence: v,
        });
      }
    }
  }
  return out;
}
