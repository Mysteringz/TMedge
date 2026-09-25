/**
 * The preview engine: the node's own detector, compiled for this machine.
 *
 * The debugger has to answer "what would this sensor do if I changed this
 * threshold?" before anyone changes it on a ceiling. The honest way to answer
 * that is to run the firmware's detector -- `TMsense/src/tm_detector.cpp`,
 * the same file the ESP32 runs, unmodified -- over the frames we captured
 * from that sensor. A re-implementation in TypeScript would drift from the
 * firmware silently, and a debugger that lies about the thing it is debugging
 * is worse than no debugger.
 *
 * The background is an exponential average over history, so previewing a
 * different `bg_tau` means replaying the whole ring, not one frame. That also
 * gives determinism: same frames, same parameters, same answer, every time.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceDetection, FramePair } from './types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TMSENSE = process.env.TMSENSE_DIR || join(ROOT, '..', 'TMsense');

/** Detector parameters in the units the C code uses, not the wire's integers. */
export interface DetectorParams {
  min_contrast: number;   // C
  min_peak: number;       // C
  noise_k: number;
  min_area: number;       // px
  max_area: number;       // px
  bg_tau: number;         // frames
  bg_frames: number;      // frames
  split_sep: number;      // px
}

/** The wire's integer parameters, as STATUS reports them, to C units. */
export function fromWireParams(p: Partial<Record<string, number>>): Partial<DetectorParams> {
  const out: Partial<DetectorParams> = {};
  if (p.min_contrast !== undefined) out.min_contrast = p.min_contrast / 100;
  if (p.min_peak !== undefined) out.min_peak = p.min_peak / 100;
  if (p.noise_k !== undefined) out.noise_k = p.noise_k / 10;
  if (p.min_area !== undefined) out.min_area = p.min_area;
  if (p.max_area !== undefined) out.max_area = p.max_area;
  if (p.bg_tau !== undefined) out.bg_tau = p.bg_tau;
  if (p.bg_frames !== undefined) out.bg_frames = p.bg_frames;
  if (p.split_sep !== undefined) out.split_sep = p.split_sep / 10;
  return out;
}

export interface FrameResult {
  index: number;
  backgroundReady: boolean;
  globalShift: boolean;
  truncated: boolean;
  backgroundMean: number;
  detections: DeviceDetection[];
  /** 768 each; present when planes were requested. */
  background?: Float32Array;
  diff?: Float32Array;
  foreground?: Uint8Array;
  label?: Uint8Array;
}

const PLANE_BYTES = 4 + 768 * 4 + 768 * 4 + 768 + 768;

export class DetectorHost {
  private binary: string | null = null;
  private checked = false;
  private buildError: string | null = null;

  /** Why the preview is unavailable, or null when it works. */
  get unavailable(): string | null {
    this.ensure();
    return this.binary ? null : (this.buildError ?? 'the firmware detector is not built');
  }

  private ensure(): void {
    if (this.checked) return;
    this.checked = true;
    const src = join(TMSENSE, 'test', 'host', 'detector_host.cpp');
    const algo = join(TMSENSE, 'src', 'tm_detector.cpp');
    if (!existsSync(src) || !existsSync(algo)) {
      this.buildError = `the firmware source is not beside this checkout (looked in ${TMSENSE})`;
      return;
    }
    const outDir = join(process.env.DATA_DIR || join(ROOT, 'data'), 'algo');
    const out = join(outDir, 'detector_host');
    // Rebuild when either source is newer than the binary: the point of this
    // is to track the firmware, so a stale binary would defeat it.
    const newest = Math.max(statSync(src).mtimeMs, statSync(algo).mtimeMs);
    if (existsSync(out) && statSync(out).mtimeMs >= newest) {
      this.binary = out;
      return;
    }
    mkdirSync(outDir, { recursive: true });
    const r = spawnSync('g++', [
      '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter',
      `-I${join(TMSENSE, 'include')}`, src, algo, '-o', out,
    ], { encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      this.buildError = r.error
        ? `g++ is not installed on this machine (${r.error.message})`
        : `the firmware detector did not compile: ${(r.stderr || '').split('\n')[0]}`;
      return;
    }
    this.binary = out;
  }

  /**
   * Replay `frames` through the detector and return a result per frame. The
   * caller passes the whole history it wants the background built from; the
   * frame of interest is the last one.
   */
  run(frames: FramePair[], params: DetectorParams, planes: boolean): Promise<FrameResult[]> {
    this.ensure();
    const binary = this.binary;
    if (!binary) return Promise.reject(new Error(this.unavailable ?? 'no detector'));
    if (frames.length === 0) return Promise.resolve([]);

    const args = [
      ...(planes ? ['--planes'] : []),
      `min_contrast=${params.min_contrast}`, `min_peak=${params.min_peak}`,
      `noise_k=${params.noise_k}`, `min_area=${params.min_area}`, `max_area=${params.max_area}`,
      `bg_tau=${params.bg_tau}`, `bg_frames=${params.bg_frames}`, `split_sep=${params.split_sep}`,
    ];
    const input = Buffer.alloc(frames.length * 768 * 4);
    frames.forEach((f, i) => {
      for (let p = 0; p < 768; p++) input.writeFloatLE(f.temps[p] ?? 0, (i * 768 + p) * 4);
    });

    return new Promise<FrameResult[]>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`detector exited ${code}: ${err.slice(0, 200)}`));
        try {
          return resolve(parse(Buffer.concat(chunks), planes));
        } catch (e) {
          return reject(e as Error);
        }
      });
      child.stdin.end(input);
    });
  }
}

function parse(out: Buffer, planes: boolean): FrameResult[] {
  const results: FrameResult[] = [];
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const line = out.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const js = JSON.parse(line) as {
      i: number; ready: number; shift: number; trunc: number; bg: number;
      d: [number, number, number, number, number, number][];
    };
    const r: FrameResult = {
      index: js.i,
      backgroundReady: js.ready === 1,
      globalShift: js.shift === 1,
      truncated: js.trunc === 1,
      backgroundMean: js.bg,
      detections: js.d.map(([x, y, area, contrast, peak, heat]) => ({ x, y, area, contrast, peak, heat })),
    };
    if (planes) {
      if (out.subarray(pos, pos + 4).toString('ascii') !== 'PLN1') throw new Error('detector planes out of step');
      const base = pos + 4;
      r.background = readFloats(out, base);
      r.diff = readFloats(out, base + 3072);
      r.foreground = new Uint8Array(out.subarray(base + 6144, base + 6144 + 768));
      r.label = new Uint8Array(out.subarray(base + 6912, base + 7680));
      pos += PLANE_BYTES;
    }
    results.push(r);
  }
  return results;
}

function readFloats(buf: Buffer, at: number): Float32Array {
  const a = new Float32Array(768);
  for (let i = 0; i < 768; i++) a[i] = buf.readFloatLE(at + i * 4);
  return a;
}
