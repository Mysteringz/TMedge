/**
 * When training frames are kept: never, always, or while somebody is there.
 *
 * "Always" was the only way to collect, so collecting meant someone
 * remembering to press Record before people arrived and to stop it after --
 * and most of what an always-on recorder keeps is an empty room overnight.
 * "Auto" keeps frames only around a detection: a short pre-roll so the frame
 * where a person first appears is in the set (its RAW reaches the edge before
 * the REPORT that says somebody is in it), and a hold after the last
 * detection so someone the detector loses for a frame or two, or who is
 * walking out of view, is not cut off mid-movement.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type RecordMode = 'off' | 'auto' | 'on';
export const RECORD_MODES: readonly RecordMode[] = ['off', 'auto', 'on'];

/** About five frames at 1 Hz: enough to hold the entry, small enough to keep in memory. */
export const PREROLL_MS = 5_000;
/** The detector drops a still or partly occluded person for a few frames at a time. */
export const HOLD_MS = 10_000;

export function isRecordMode(value: unknown): value is RecordMode {
  return typeof value === 'string' && (RECORD_MODES as readonly string[]).includes(value);
}

/**
 * The console's request body: `{ mode }`, or the older `{ on }` from a tab
 * opened before this release. Anything else is refused, not read as off.
 */
export function recordModeOf(body: unknown): RecordMode | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { mode?: unknown; on?: unknown };
  if (b.mode !== undefined) return isRecordMode(b.mode) ? b.mode : null;
  if (typeof b.on === 'boolean') return b.on ? 'on' : 'off';
  return null;
}

/**
 * The mode is remembered across restarts in `recording.mode` beside the old
 * `recording.on` flag. A box that was explicitly recording keeps doing so;
 * every other box starts in auto, which is the point: nobody has to ask.
 * The old flag is still written so a rollback to a release that only knows
 * it records exactly when this one would in "on".
 */
export class RecordSwitch {
  mode: RecordMode = 'auto';
  private readonly modeFile: string;
  private lastPersonAt = new Map<string, number>();
  private pending = new Map<string, Array<{ at: number; run: () => void }>>();

  constructor(private readonly legacyFile: string) {
    this.modeFile = join(dirname(legacyFile), 'recording.mode');
    try {
      const saved = existsSync(this.modeFile) ? readFileSync(this.modeFile, 'utf8').trim() : null;
      if (isRecordMode(saved)) this.mode = saved;
      else if (existsSync(legacyFile) && readFileSync(legacyFile, 'utf8').trim() === '1') this.mode = 'on';
    } catch {
      /* unreadable is the default */
    }
  }

  setMode(mode: RecordMode): void {
    this.mode = mode;
    if (mode !== 'auto') this.pending.clear();
    try {
      writeFileSync(this.modeFile, mode);
      writeFileSync(this.legacyFile, mode === 'on' ? '1' : '0');
    } catch {
      /* it still applies to this process; it just will not survive a restart */
    }
  }

  /**
   * A detector's verdict for a node. When a person appears, whatever this
   * node offered in the pre-roll window is kept now, in arrival order, so a
   * thermal frame is still written before the RGB frame that pairs with it.
   */
  presence(uid: string, people: number, now = Date.now()): void {
    if (people <= 0) return;
    const wasActive = this.active(uid, now);
    this.lastPersonAt.set(uid, now);
    if (this.mode !== 'auto' || wasActive) return;
    const queued = this.pending.get(uid) ?? [];
    this.pending.delete(uid);
    for (const item of queued) if (now - item.at <= PREROLL_MS) item.run();
  }

  /** Somebody was seen at this node within the hold. */
  active(uid: string, now = Date.now()): boolean {
    const at = this.lastPersonAt.get(uid);
    return at !== undefined && now - at <= HOLD_MS;
  }

  /** Any node is capturing right now (for the console's status line). */
  capturing(now = Date.now()): boolean {
    if (this.mode === 'on') return true;
    if (this.mode === 'off') return false;
    for (const uid of this.lastPersonAt.keys()) if (this.active(uid, now)) return true;
    return false;
  }

  /**
   * Run `write` now if this frame should be kept; in auto with nobody there,
   * hold it for the pre-roll instead. Returns whether it ran now.
   */
  gate(uid: string, write: () => void, now = Date.now()): boolean {
    if (this.mode === 'off') return false;
    if (this.mode === 'on' || this.active(uid, now)) {
      write();
      return true;
    }
    const queued = (this.pending.get(uid) ?? []).filter((item) => now - item.at <= PREROLL_MS);
    queued.push({ at: now, run: write });
    this.pending.set(uid, queued);
    return false;
  }
}
