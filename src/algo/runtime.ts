/**
 * Running the graph over one frame.
 *
 * Two answers exist for every device stage and the difference between them is
 * the point of this tool:
 *
 *   observed  what the sensor itself decided for this frame, from its REPORT
 *   preview   what the firmware's detector does with the parameters currently
 *             in the inspector, replayed here over the same frames
 *
 * While the inspector matches the sensor the two agree. Change a number and
 * only the preview moves; press Apply and the sensor is told, and within a
 * frame or two the observed answer catches up. If it does not, either the
 * command never landed (check the node's last_cmd) or the host and the device
 * disagree, which is a bug worth knowing about.
 */
import { pixelToFloor } from '../shared/geometry.js';
import type { EdgeRuntime } from '../edge/runtime.js';
import { DetectorHost, fromWireParams, type DetectorParams, type FrameResult } from './detector.js';
import { DEFAULT_DESK, estimateDesks, type DeskParams } from './desk.js';
import { encodeFrame, FrameStore } from './frames.js';
import { isModel, locate, type LocatorModel } from './model.js';
import { upstreamOf } from './graph.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { specOf } from './nodes.js';
import type { ParamBroker } from './params.js';
import type { FramePair, NodeEnvelope, Pipeline } from './types.js';

/** Defaults the firmware itself starts from, for a node that has not reported yet. */
const FALLBACK_DETECTOR: DetectorParams = {
  min_contrast: 0.6, min_peak: 1.2, noise_k: 4, min_area: 1, max_area: 60,
  bg_tau: 90, bg_frames: 20, split_sep: 1.9,
};

export interface RunOptions {
  frame?: number;
  /** Run only this node and what it needs. */
  only?: string;
}

export interface RunResult {
  frameId: number;
  timestamp: number;
  uid: string;
  envelopes: NodeEnvelope[];
  /** Set when the firmware detector could not be run here. */
  previewUnavailable: string | null;
}

const MODEL_DIR = join(process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data'), 'algo', 'models');

export class AlgoRuntime {
  readonly frames = new FrameStore();
  readonly detector = new DetectorHost();
  private pipelines = new Map<string, Pipeline>();
  /**
   * Replaying the ring through the detector costs a process and tens of
   * milliseconds, and dragging the frame slider asks for one per pixel. Two
   * guards: identical work in flight is shared rather than duplicated, and
   * the last few answers are kept, so scrubbing back and forth over frames
   * already seen costs nothing.
   */
  private readonly runCache = new Map<string, FrameResult | null>();
  private readonly inFlight = new Map<string, Promise<FrameResult | null>>();

  constructor(private readonly rt: EdgeRuntime, private readonly broker: ParamBroker) {}

  private async detect(uid: string, frame: number, params: DetectorParams): Promise<FrameResult | null> {
    const key = `${uid}:${frame}:${JSON.stringify(params)}`;
    const cached = this.runCache.get(key);
    if (cached !== undefined) return cached;
    const running = this.inFlight.get(key);
    if (running) return running;
    const work = (async () => {
      const history = this.frames.historyTo(uid, frame);
      const results = await this.detector.run(history, params, true);
      return results[results.length - 1] ?? null;
    })();
    this.inFlight.set(key, work);
    try {
      const out = await work;
      this.runCache.set(key, out);
      // Small: each entry holds four 768-element planes.
      if (this.runCache.size > 12) this.runCache.delete(this.runCache.keys().next().value as string);
      return out;
    } finally {
      this.inFlight.delete(key);
    }
  }

  setPipeline(p: Pipeline): void {
    this.pipelines.set(p.id, p);
  }

  /**
   * Resolved device parameters: what the node reports, then what has been
   * asked of it and not yet confirmed, then inspector edits on top.
   *
   * The middle layer matters. A write is a datagram and the node only reports
   * every 10 seconds, so for that window `live` still holds the old number.
   * Without the overlay both the slider and the preview snapped back to it
   * the moment the change was applied, which read as the change being lost.
   */
  resolveDetector(uid: string, edits: Record<string, number>): { params: DetectorParams; wire: Record<string, number>; dirty: string[] } {
    const live = this.broker.deviceParams(uid);
    const asked = this.broker.requested(uid);
    const wire = { ...live, ...asked, ...edits };
    const dirty = Object.keys(edits).filter((k) => live[k] !== undefined && live[k] !== edits[k]);
    return { params: { ...FALLBACK_DETECTOR, ...fromWireParams(wire) }, wire, dirty };
  }

  async run(p: Pipeline, opts: RunOptions = {}): Promise<RunResult> {
    const uid = p.uid;
    const pair = opts.frame !== undefined ? this.frames.get(uid, opts.frame) : this.frames.latest(uid);
    const now = Date.now();
    if (!pair) {
      return {
        frameId: -1, timestamp: now, uid, envelopes: [],
        previewUnavailable: 'no thermal frame from this node yet — set "Send RAW every N frames" above 0',
      };
    }

    const needed = opts.only ? upstreamOf(p, opts.only) : null;
    const nodes = p.nodes.filter((n) => n.enabled && (!needed || needed.has(n.id)));

    // The detector is run once for the whole graph: background subtraction and
    // human detection are two views of one pass, exactly as on the node.
    const bgNode = nodes.find((n) => n.type === 'background_subtraction');
    const humanNode = nodes.find((n) => n.type === 'human_detection');
    const edits = { ...(bgNode?.params ?? {}), ...(humanNode?.params ?? {}) };
    const { params, wire, dirty } = this.resolveDetector(uid, edits);

    let preview: FrameResult | null = null;
    let previewUnavailable: string | null = this.detector.unavailable;
    let detectorMs = 0;
    if (!previewUnavailable && (bgNode || humanNode)) {
      const t0 = Date.now();
      try {
        preview = await this.detect(uid, pair.frame, params);
      } catch (err) {
        previewUnavailable = (err as Error).message;
      }
      detectorMs = Date.now() - t0;
    }

    const node = this.rt.reg.nodes.get(uid) ?? null;
    const floor = node ? this.rt.reg.floors.find((f) => f.id === node.floorId) ?? null : null;
    const envelopes: NodeEnvelope[] = [];
    const push = (
      id: string, type: string, started: number,
      outputs: Record<string, unknown>, debug: Record<string, unknown>, metrics: Record<string, number | string>,
      parameters: Record<string, number> = {}, error?: string,
    ) => {
      envelopes.push({
        frameId: pair.frame, timestamp: pair.receivedAt, nodeId: id, type,
        domain: specOf(type)?.domain ?? 'view',
        executionTimeMs: Math.max(0, Date.now() - started), outputs, debug, metrics, parameters, error,
      });
    };

    // Projected people, shared by the later stages.
    const projected = (dets: { x: number; y: number; area: number; heat: number }[]) =>
      dets.map((d, i) => {
        // Plan coordinates are [x, y] in centimetres, origin top-left.
        const [fx, fy] = node ? pixelToFloor(node.pose, d.x, d.y) : [0, 0];
        return { id: i + 1, px: d.x, py: d.y, x: fx, y: fy, area: d.area, heat: d.heat };
      });

    for (const n of nodes) {
      const started = Date.now();
      try {
        switch (n.type) {
          case 'thermal_input': {
            const f = encodeFrame(pair);
            const health = this.rt.nodes().find((h) => h.uid === uid) ?? null;
            push(n.id, n.type, started, { frame: f }, {
              sensorOk: health?.status ? true : null,
              backgroundReady: health?.backgroundReady ?? null,
              label: node?.label ?? uid,
              uid,
              // A dual-cam rig has a camera worth showing beside this frame.
              rgb: node?.rgb ?? false,
              // This sensor is mounted so its image is left-right reversed
              // against the room. The geometry already knows (pixelToFloor
              // negates x), but a picture shown as the sensor sends it is
              // mirrored against everything else on screen, so the viewers
              // flip it back and say so.
              mirror: node?.pose.mirror ?? false,
            }, {
              resolution: '32 x 24',
              frame: pair.frame,
              'fps (reported)': health?.fps ?? 0,
              'min C': round(f.min), 'max C': round(f.max), 'mean C': round(f.mean),
            }, { refresh: wire.refresh ?? 0, raw_every: wire.raw_every ?? 0 });
            break;
          }

          case 'background_subtraction': {
            if (!preview) throw new Error(previewUnavailable ?? 'no preview');
            // Scale the difference plane against the threshold that actually
            // matters, not against its own maximum: in an empty room the
            // maximum *is* the sensor noise, and stretching 0.3 C of noise
            // across the full colour ramp makes a quiet room look like static.
            const observedMax = Math.max(0, ...Array.from(preview.diff ?? []));
            const diffMax = Math.max(observedMax, params.min_contrast * 1.5);
            push(n.id, n.type, started, {
              background: plane(preview.background, pair.tMin, pair.step),
              diff: quantise(preview.diff, 0, diffMax),
              foreground: mask(preview.foreground),
            }, {
              mirror: node?.pose.mirror ?? false,
              backgroundMean: round(preview.backgroundMean),
              globalShift: preview.globalShift,
              detectorMs,
              // Early frames in the ring have no background yet, so every
              // stage downstream reads zero. Say so, or it looks broken.
              ...(preview.backgroundReady ? {} : {
                warning: `the background model needs ${params.bg_frames} frames and this one is ${this.frames.historyTo(uid, pair.frame).length} into the ring — nothing can be detected yet`,
              }),
            }, {
              'foreground px': countMask(preview.foreground),
              'max difference C': round(observedMax),
              'background ready': preview.backgroundReady ? 'yes' : 'learning',
            }, pick(wire, ['min_contrast', 'noise_k', 'bg_tau', 'bg_frames']));
            break;
          }

          case 'human_detection': {
            if (!preview) throw new Error(previewUnavailable ?? 'no preview');
            const observed = pair.deviceDetections ?? [];
            const warming = !preview.backgroundReady;
            const blobs = preview.detections.map((d, i) => ({
              id: i + 1,
              ...d,
              // Not from the device: a readable stand-in for "how far past the
              // thresholds this blob is", so a marginal blob looks marginal.
              confidence: confidence(d.contrast, d.area, params),
            }));
            push(n.id, n.type, started, {
              detections: blobs,
              labels: mask(preview.label, 255),
            }, {
              mirror: node?.pose.mirror ?? false,
              observed,
              note: observed.length
                ? 'observed = what the sensor decided for this frame; detections = this inspector’s parameters'
                : 'no REPORT paired with this frame yet',
              agrees: observed.length === blobs.length,
              // A simulated node does not derive its REPORT from its own
              // picture: it reports the world model directly and renders the
              // frame separately. The two are therefore allowed to disagree,
              // and on a busy floor they will -- merged Gaussians exceed
              // max_area and the real detector drops the component. Only on
              // hardware does a disagreement mean something is wrong.
              simulated: node?.simulated ?? false,
              ...(warming ? { warning: 'the background model is still learning at this frame; scrub later in the ring' } : {}),
              ...(node?.simulated
                ? { why: 'this node is simulated: its REPORT is ground truth and its RAW is a rendering, so the two need not agree' }
                : {}),
            }, {
              candidates: preview.detections.length,
              accepted: blobs.length,
              'device said': observed.length,
              'mean confidence': blobs.length ? round(blobs.reduce((s, b) => s + b.confidence, 0) / blobs.length) : 0,
              truncated: preview.truncated ? 'yes' : 'no',
            }, pick(wire, ['min_area', 'max_area', 'min_peak', 'split_sep']));
            break;
          }

          case 'projection': {
            const source = preview?.detections ?? pair.deviceDetections ?? [];
            const points = projected(source);
            push(n.id, n.type, started, { points }, {
              pose: node?.pose ?? null,
              floor: floor ? { id: floor.id, width: floor.width, height: floor.height } : null,
              tables: floor?.tables.map((t) => ({ id: t.id, ...t.rect })) ?? [],
            }, {
              people: points.length,
              'mount height cm': node?.pose.heightCm ?? 0,
            });
            break;
          }

          case 'human_location_ml': {
            const model = loadModel(uid);
            if (!model) {
              push(n.id, n.type, started, { points: [] }, {
                untrained: true,
                expects: join(MODEL_DIR, `${uid.replace(/:/g, '')}.json`),
                how: 'record RGB/thermal pairs on a rig with a camera, then run tools/train_human_location.py and put the model here',
              }, { trained: 'no' }, {});
              break;
            }
            const threshold = n.params.threshold ?? model.threshold;
            const minArea = n.params.minArea ?? model.minArea;
            const { detections, probs } = locate({ ...model, threshold, minArea }, pair.temps);
            const points = projected(detections.map((d) => ({ x: d.x, y: d.y, area: d.area, heat: 0 })));
            // The device's own answer for the same frame is the only fair
            // comparison available live, so it is shown beside this one.
            const observed = pair.deviceDetections ?? [];
            push(n.id, n.type, started, { points }, {
              probabilities: quantise(probs, 0, 1),
              detections,
              observed,
              model: {
                trainedAt: model.trainedAt, samples: model.samples, positives: model.positives,
                metrics: model.metrics, notes: model.notes ?? null,
              },
              mirror: node?.pose.mirror ?? false,
            }, {
              people: detections.length,
              'device said': observed.length,
              threshold,
              'held-out F1': model.metrics.f1,
              'median error px': model.metrics.medianErrorPx,
            }, { threshold, minArea });
            break;
          }

          case 'heatmap': {
            const dwell = floor ? this.rt.dwell.get(floor.id) : undefined;
            const json = dwell?.toJSON() ?? null;
            push(n.id, n.type, started, { heat: json }, {
              floorId: floor?.id ?? null,
            }, {
              cells: json ? json.cells.length : 0,
              'peak person-seconds': json ? round(json.max) : 0,
            });
            break;
          }

          case 'desk_estimator': {
            const dwell = floor ? this.rt.dwell.get(floor.id) : undefined;
            const json = dwell?.toJSON();
            const dp: DeskParams = { ...DEFAULT_DESK, ...(n.params as Partial<DeskParams>) };
            if (!json) {
              push(n.id, n.type, started, { tables: [] }, {}, { candidates: 0 }, dp as unknown as Record<string, number>);
              break;
            }
            const configured = floor?.tables.map((t) => ({ id: t.id, ...t.rect })) ?? [];
            const result = estimateDesks(json.cells, json.cols, json.rows, configured, dp);
            const offsets = result.desks.map((d) => d.matches?.offsetCm ?? null).filter((v): v is number => v !== null);
            push(n.id, n.type, started, { tables: result.desks }, {
              stages: result.stages,
              configured,
            }, {
              'seat clusters': result.stages.clusters.length,
              candidates: result.stages.candidates.length,
              selected: result.desks.length,
              'configured tables': configured.length,
              'median offset cm': offsets.length ? round(median(offsets)) : 'n/a',
            }, dp as unknown as Record<string, number>);
            break;
          }

          case 'occupancy': {
            const snap = this.rt.latest;
            const state = snap?.floors.find((f) => f.id === floor?.id) ?? null;
            const live = this.broker.edgeParams();
            push(n.id, n.type, started, { occupancy: state }, {
              authorities: this.rt.engine.authorities(),
              why: state?.tables.map((t) => ({
                id: t.id, status: t.status, occupied: t.occupied, free: t.free,
                seats: t.seats.map((s) => ({ id: s.id, occupied: s.occupied })),
              })) ?? [],
            }, {
              tables: state?.tables.length ?? 0,
              occupied: state?.tables.filter((t) => (t.occupied ?? 0) > 0).length ?? 0,
              empty: state?.tables.filter((t) => t.occupied === 0).length ?? 0,
              unknown: state?.tables.filter((t) => t.occupied === null).length ?? 0,
            }, {
              seatRadiusCm: live['occupancy.seatRadiusCm'] ?? 0,
              mergeCm: live['occupancy.mergeCm'] ?? 0,
              enterWindow: live['occupancy.enterWindow'] ?? 0,
              enterMin: live['occupancy.enterMin'] ?? 0,
              releaseMs: live['occupancy.releaseMs'] ?? 0,
              staleMs: live['occupancy.staleMs'] ?? 0,
            });
            break;
          }

          case 'frame_stats': {
            const bins = new Array<number>(32).fill(0);
            let min = Infinity, max = -Infinity;
            for (const t of pair.temps) { if (t < min) min = t; if (t > max) max = t; }
            const span = Math.max(0.01, max - min);
            for (const t of pair.temps) {
              const i = Math.min(31, Math.floor(((t - min) / span) * 32));
              bins[i] = (bins[i] ?? 0) + 1;
            }
            push(n.id, n.type, started, {}, { histogram: bins, min, max }, {
              'min C': round(min), 'max C': round(max), 'span C': round(span),
            });
            break;
          }

          case 'final_map': {
            const state = this.rt.latest?.floors.find((f) => f.id === floor?.id) ?? null;
            push(n.id, n.type, started, {}, {
              floor: floor ? { id: floor.id, name: floor.name, width: floor.width, height: floor.height, outline: floor.outline } : null,
              tables: state?.tables ?? [],
              node: node ? { uid, pose: node.pose, label: node.label } : null,
            }, {
              'free seats': state?.totals.free ?? 0,
              'unknown seats': state?.totals.unknownSeats ?? 0,
            });
            break;
          }

          default:
            push(n.id, n.type, started, {}, {}, {}, {}, `no runner for ${n.type}`);
        }
      } catch (err) {
        push(n.id, n.type, started, {}, {}, {}, {}, (err as Error).message);
      }
    }

    return {
      frameId: pair.frame,
      timestamp: pair.receivedAt,
      uid,
      envelopes,
      previewUnavailable: previewUnavailable && (bgNode || humanNode) ? previewUnavailable : null,
    };
  }

  /** Which parameters in the inspector differ from what the sensor is running. */
  dirtyFor(p: Pipeline): string[] {
    const edits: Record<string, number> = {};
    for (const n of p.nodes) if (specOf(n.type)?.domain === 'device') Object.assign(edits, n.params);
    return this.resolveDetector(p.uid, edits).dirty;
  }
}

const modelCache = new Map<string, { at: number; model: LocatorModel | null }>();

/** Re-read at most every 10 s, so dropping in a new model needs no restart. */
function loadModel(uid: string): LocatorModel | null {
  const key = uid.replace(/:/g, '');
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < 10_000) return hit.model;
  const path = join(MODEL_DIR, `${key}.json`);
  let model: LocatorModel | null = null;
  try {
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      model = isModel(parsed) ? parsed : null;
    }
  } catch {
    model = null;
  }
  modelCache.set(key, { at: Date.now(), model });
  return model;
}

function pick(src: Record<string, number>, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k] as number;
  return out;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function countMask(m?: Uint8Array): number {
  let n = 0;
  for (const v of m ?? []) if (v) n++;
  return n;
}

/** A temperature plane as levels the browser can colour, plus its scale. */
function plane(a: Float32Array | undefined, tMin: number, step: number) {
  if (!a) return null;
  let min = Infinity, max = -Infinity;
  for (const v of a) { if (v < min) min = v; if (v > max) max = v; }
  return quantise(a, min, max) ?? { tMin, step };
}

function quantise(a: Float32Array | undefined, min: number, max: number) {
  if (!a) return null;
  const span = Math.max(1e-6, max - min);
  const bytes = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    bytes[i] = Math.max(0, Math.min(255, Math.round((((a[i] ?? min) - min) / span) * 255)));
  }
  return { min, max, pixels: bytes.toString('base64') };
}

function mask(a: Uint8Array | undefined, scale = 1) {
  if (!a) return null;
  const bytes = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) bytes[i] = Math.min(255, (a[i] ?? 0) * scale);
  return { pixels: bytes.toString('base64') };
}

/**
 * A readable margin, not a probability: how far a blob sits past the
 * thresholds that admitted it. Labelled "derived" in the UI because the
 * sensor reports no such number.
 */
function confidence(contrast: number, area: number, p: DetectorParams): number {
  const byHeat = Math.min(1, contrast / Math.max(0.1, p.min_peak * 2));
  const mid = (p.min_area + Math.min(p.max_area, p.min_area * 12)) / 2;
  const byArea = Math.min(1, area / Math.max(1, mid));
  return Math.round(Math.min(1, 0.65 * byHeat + 0.35 * byArea) * 100) / 100;
}
