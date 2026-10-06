/**
 * Parameter writes, and the way back from them.
 *
 * This is the part of the debugger that reaches outside the process. A device
 * parameter here becomes a signed COMMAND to a sensor on a ceiling; an edge
 * parameter changes what students are told about a real room on the next
 * frame. Both are meant to be used -- tuning against a live scene is the
 * point -- but neither should be able to quietly stay wrong.
 *
 * So every live change is **temporary by default**: it takes effect at once
 * and is put back after REVERT_MS unless somebody commits it. Writing to the
 * node's flash is a separate act again, because that value survives a reboot
 * and outlives whoever set it. Everything is logged with its old value, which
 * is what makes a mistake recoverable rather than archaeological.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CMD_SAVE_PARAMS, CMD_SET_PARAM, PARAM_LIMITS, PARAM_NAMES } from '../edge/protocol.js';
import type { EdgeRuntime } from '../edge/runtime.js';
import type { OccupancyOptions } from '../edge/occupancy.js';
import type { AuditEntry, ParamBinding } from './types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** How long an uncommitted live change lasts before it is put back. */
export const REVERT_MS = 15 * 60_000;

/** What the node will accept; it lives with the wire format it belongs to. */
export { PARAM_LIMITS as DEVICE_PARAMS } from '../edge/protocol.js';

/** Edge tuning the debugger may change, and the limits it may move between. */
export const EDGE_PARAMS: Record<string, { lo: number; hi: number; unit: string }> = {
  'occupancy.seatRadiusCm': { lo: 20, hi: 300, unit: 'cm' },
  'occupancy.mergeCm': { lo: 0, hi: 200, unit: 'cm' },
  'occupancy.enterWindow': { lo: 1, hi: 60, unit: 'frames' },
  'occupancy.enterMin': { lo: 1, hi: 60, unit: 'frames' },
  'occupancy.releaseMs': { lo: 2000, hi: 300_000, unit: 'ms' },
  'occupancy.staleMs': { lo: 2000, hi: 120_000, unit: 'ms' },
};

export interface PendingChange {
  uid: string;
  nodeId: string;
  param: string;
  binding: ParamBinding['kind'];
  from: number | null;
  to: number;
  at: number;
  revertAt: number;
  /** Set once the node's STATUS shows it took the command. */
  confirmedAt: number | null;
  cmdSeq: number | null;
  /** Recovery commands remain pending until a subsequent STATUS confirms them. */
  restoring?: boolean;
}

export interface ParameterAuditSink { append(entry: AuditEntry): void }

export class ParamBroker {
  private readonly pending = new Map<string, PendingChange>();
  private readonly audit: AuditEntry[] = [];
  private readonly logPath: string;
  private timer: NodeJS.Timeout | null = null;
  private readonly pendingPath: string | null;
  private readonly reverting = new Set<string>();
  private readonly persisting = new Set<string>();

  constructor(private readonly rt: EdgeRuntime) {
    const dir = join(rt.cfg?.dataDir || process.env.DATA_DIR || join(ROOT, 'data'), 'algo');
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, 'audit.jsonl');
    this.pendingPath = rt.cfg?.dataDir ? join(dir, 'pending-params.json') : null;
    if (this.pendingPath && existsSync(this.pendingPath)) {
      if (statSync(this.pendingPath).size > 8 * 1024 * 1024) throw new Error('pending parameter journal exceeds its limit');
      const saved: unknown = JSON.parse(readFileSync(this.pendingPath, 'utf8'));
      if (!Array.isArray(saved) || saved.length > 50000) throw new Error('invalid pending parameter journal');
      for (const c of saved as PendingChange[]) {
        const limits = PARAM_LIMITS[c?.param as (typeof PARAM_NAMES)[number]];
        if (!c || c.binding !== 'device' || !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(c.uid) || !limits ||
            !Number.isInteger(c.from) || c.from === null || c.from < limits.lo || c.from > limits.hi) {
          throw new Error('invalid pending parameter journal entry');
        }
        // RAM edge settings restart at configured defaults. Device settings
        // can survive, so restore their original value as soon as reachable.
        this.pending.set(this.key(c.uid, c.param), { ...c, revertAt: Date.now() });
      }
    }
  }

  start(): void {
    if (this.timer) return;
    // One sweep a second is enough: the deadline is minutes away.
    this.timer = setInterval(() => this.sweep(Date.now()), 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private key(uid: string, param: string): string {
    return `${param.startsWith('occupancy.') ? '*' : uid}\u0000${param}`;
  }

  private savePending(): void {
    if (!this.pendingPath) return;
    const temporary = `${this.pendingPath}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.pending.values()].filter((c) => c.binding === 'device')), { mode: 0o600, flush: true });
    renameSync(temporary, this.pendingPath);
    const directory = openSync(dirname(this.pendingPath), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  private log(e: AuditEntry): void {
    this.audit.push(e);
    if (this.audit.length > 500) this.audit.shift();
    try {
      appendFileSync(this.logPath, `${JSON.stringify(e)}\n`);
    } catch {
      /* the log is a courtesy; never fail a change because it could not be written */
    }
  }

  changes(): PendingChange[] {
    this.confirm(Date.now());
    return [...this.pending.values()];
  }

  /**
   * Match outstanding device writes against what the nodes now report.
   *
   * A command is a datagram to a ceiling: it can be lost, and the node
   * refuses anything outside its own range without telling us. So a write is
   * only "landed" once the node's STATUS both echoes a command sequence at
   * least as new as ours and shows the value we asked for. Until then the
   * dashboard says it is waiting rather than quietly showing the old number,
   * which is what made a successful write look like it had reverted.
   */
  private confirm(now: number): void {
    const restored: [string, PendingChange][] = [];
    for (const [key, c] of this.pending) {
      if (c.confirmedAt !== null || c.binding !== 'device') continue;
      const node = this.rt.nodes().find((n) => n.uid === c.uid);
      const status = node?.status;
      if (!status) continue;
      const applied = (status.params as Record<string, number> | undefined)?.[c.param];
      const seen = c.cmdSeq === null || status.lastCmd >= c.cmdSeq;
      if (seen && applied === c.to) {
        if (c.restoring) { this.pending.delete(key); restored.push([key, c]); }
        else c.confirmedAt = now;
      }
    }
    if (restored.length) {
      try { this.savePending(); } catch {
        // Retain recovery until its removal is durable. Sampling live state
        // must never turn an unavailable disk into an uncaught timer error.
        for (const [key, c] of restored) this.pending.set(key, c);
      }
    }
  }

  recent(n = 100): AuditEntry[] {
    return this.audit.slice(-n);
  }

  /**
   * What the sensor says it is running, from its last STATUS. This is the
   * only trustworthy answer: what we asked for and what it applied are
   * different things until `last_cmd` says otherwise.
   */
  deviceParams(uid: string): Record<string, number> {
    return { ...(this.rt.nodes().find((n) => n.uid === uid)?.status?.params ?? {}) };
  }

  /**
   * Device values that have been asked for but not yet seen in a STATUS.
   *
   * A node reports every 10 seconds, so between the click and the next
   * report the only record of what was asked for is here. Showing the old
   * reading during that window is what looked like the change being thrown
   * away, so the dashboard reads through this and the answer only falls back
   * to STATUS once STATUS agrees.
   */
  requested(uid: string): Record<string, number> {
    this.confirm(Date.now());
    const out: Record<string, number> = {};
    for (const c of this.pending.values()) {
      // Once the node has confirmed, STATUS is the better answer: it also
      // shows a value changed from the serial console or lost to a reboot,
      // which an overlay of what we asked for would hide.
      if (c.uid === uid && c.binding === 'device' && c.confirmedAt === null) out[c.param] = c.to;
    }
    return out;
  }

  edgeParams(): Record<string, number> {
    const o = this.rt.engine.options();
    return {
      'occupancy.seatRadiusCm': o.seatRadiusCm,
      'occupancy.mergeCm': o.mergeCm,
      'occupancy.enterWindow': o.enterWindow,
      'occupancy.enterMin': o.enterMin,
      'occupancy.releaseMs': o.releaseMs,
      'occupancy.staleMs': o.staleMs,
    };
  }

  /**
   * Push a value at the thing that owns it. Device parameters go out as a
   * signed command and are confirmed later by the node's STATUS; edge
   * parameters take effect on the next frame.
   */
  async apply(opts: {
    uid: string; nodeId: string; param: string; binding: ParamBinding; value: number; by: string;
  }): Promise<PendingChange> {
    const { uid, nodeId, param, binding, value, by } = opts;
    if (this.persisting.has(uid)) throw new Error('wait for the parameter save to finish');
    const now = Date.now();
    let from: number | null = null;

    let cmdSeq: number | null = null;
    if (binding.kind === 'device') {
      const id = PARAM_NAMES.indexOf(binding.param as (typeof PARAM_NAMES)[number]);
      if (id < 0) throw new Error(`${binding.param} is not a node parameter`);
      if (!Number.isInteger(value)) throw new Error('a node parameter is an integer on the wire');
      const limits = PARAM_LIMITS[binding.param as (typeof PARAM_NAMES)[number]];
      if (limits && (value < limits.lo || value > limits.hi)) {
        throw new Error(`the node only accepts ${binding.param} between ${limits.lo} and ${limits.hi}; it would ignore ${value}`);
      }
      from = this.deviceParams(uid)[binding.param] ?? null;
      if (from === null) throw new Error('wait for a STATUS with the current parameter before changing it');
    } else if (binding.kind === 'edge') {
      const limits = EDGE_PARAMS[binding.path];
      if (!limits) throw new Error(`${binding.path} is not a tunable edge parameter`);
      if (!Number.isFinite(value) || value < limits.lo || value > limits.hi) {
        throw new Error(`${binding.path} must be between ${limits.lo} and ${limits.hi} ${limits.unit}`);
      }
      from = this.edgeParams()[binding.path] ?? null;
    } else {
      throw new Error('that parameter is local to the debugger and needs no write');
    }

    // The previous value is the one worth keeping: a second change to the same
    // parameter should still revert to what the system had before anyone
    // started, not to the middle of an experiment.
    const key = this.key(uid, binding.kind === 'device' ? binding.param : binding.path);
    if (this.reverting.has(key)) throw new Error('wait for the current parameter command to finish');
    const existing = this.pending.get(key);
    const change: PendingChange = {
      uid,
      nodeId,
      param: binding.kind === 'device' ? binding.param : binding.path,
      binding: binding.kind,
      from: existing ? existing.from : from,
      to: value,
      at: now,
      revertAt: now + REVERT_MS,
      // An edge change is applied by the line above; a device change has only
      // been *sent*, and is not confirmed until the node says so.
      confirmedAt: binding.kind === 'edge' ? now : null,
      cmdSeq,
    };
    this.pending.set(key, change);
    this.reverting.add(key);
    let recorded = false;
    try {
      // Save the recovery intent before issuing a command that may outlive us.
      this.savePending();
      recorded = true;
      if (binding.kind === 'device') {
        cmdSeq = await this.rt.ingest.sendCommand(uid, CMD_SET_PARAM, PARAM_NAMES.indexOf(binding.param as (typeof PARAM_NAMES)[number]), value);
        change.cmdSeq = cmdSeq;
      } else if (binding.kind === 'edge') this.setEdge(binding.path, value);
    } catch (error) {
      if (recorded && binding.kind === 'device') {
        // Dispatch errors cannot prove a command never reached the device.
        // Keep the durable baseline and attempt recovery rather than forget it.
        change.revertAt = Date.now() + 5000;
      } else {
        if (existing) this.pending.set(key, existing); else this.pending.delete(key);
        this.savePending();
      }
      throw error;
    } finally {
      this.reverting.delete(key);
    }
    this.log({
      at: now, uid, nodeId, param: change.param, binding: change.binding,
      from: change.from, to: value, by, revertAt: change.revertAt, action: 'apply',
    });
    return change;
  }

  /** Keep a change: it stops being on a timer, but is still only in RAM. */
  commit(uid: string, param: string, by: string): boolean {
    const key = this.key(uid, param);
    if (this.reverting.has(key)) throw new Error('wait for the current parameter command to finish');
    const c = this.pending.get(key);
    if (!c) return false;
    this.pending.delete(key);
    try { this.savePending(); } catch (error) { this.pending.set(key, c); throw error; }
    this.log({
      at: Date.now(), uid, nodeId: c.nodeId, param, binding: c.binding,
      from: c.from, to: c.to, by, revertAt: null, action: 'commit',
    });
    return true;
  }

  /** Put a change back now, rather than waiting for its deadline. */
  async revert(uid: string, param: string, by: string): Promise<boolean> {
    const key = this.key(uid, param);
    const c = this.pending.get(key);
    if (!c) return false;
    if (this.reverting.has(key)) return false;
    if (this.persisting.has(uid)) return false;
    const previous = c.to;
    this.reverting.add(key);
    if (c.from !== null) {
      try {
        if (c.binding === 'device') {
          const id = PARAM_NAMES.indexOf(c.param as (typeof PARAM_NAMES)[number]);
          if (id < 0) throw new Error('invalid recovery parameter');
          c.cmdSeq = await this.rt.ingest.sendCommand(uid, CMD_SET_PARAM, id, c.from);
          c.restoring = true;
          c.to = c.from;
          c.confirmedAt = null;
          c.revertAt = Date.now() + 5000;
        } else {
          this.setEdge(c.param, c.from);
        }
      } catch (error) {
        c.revertAt = Date.now() + 5000;
        this.reverting.delete(key);
        this.savePending();
        throw error;
      }
    }
    this.reverting.delete(key);
    if (c.binding !== 'device' && this.pending.get(key) === c) this.pending.delete(key);
    this.savePending();
    this.confirm(Date.now());
    this.log({
      at: Date.now(), uid, nodeId: c.nodeId, param, binding: c.binding,
      from: previous, to: c.from ?? previous, by, revertAt: null, action: 'revert',
    });
    return true;
  }

  /**
   * Write the node's current parameters to its flash. Deliberately separate
   * from apply: this is the one action a reboot does not undo, so it is never
   * a side effect of turning a knob.
   */
  async persist(uid: string, by: string): Promise<void> {
    if (this.persisting.has(uid)) throw new Error('wait for the parameter save to finish');
    if ([...this.pending].some(([key, c]) => c.uid === uid && (this.reverting.has(key) || c.restoring))) {
      throw new Error('wait for the current parameter command and recovery to finish');
    }
    this.persisting.add(uid);
    try {
      await this.rt.ingest.sendCommand(uid, CMD_SAVE_PARAMS);
      const previous = [...this.pending].filter(([, c]) => c.uid === uid && c.binding === 'device');
      for (const [key, c] of this.pending) {
        if (c.uid === uid && c.binding === 'device') this.pending.delete(key);
      }
      try { this.savePending(); } catch (error) {
        for (const [key, c] of previous) this.pending.set(key, c);
        throw error;
      }
      this.log({
        at: Date.now(), uid, nodeId: 'device', param: '*', binding: 'device',
        from: null, to: 0, by, revertAt: null, action: 'persist',
      });
    } finally { this.persisting.delete(uid); }
  }

  private setEdge(path: string, value: number): void {
    const field = path.split('.')[1] as keyof OccupancyOptions;
    this.rt.engine.setOptions({ [field]: value } as Partial<OccupancyOptions>);
  }

  private sweep(now: number): void {
    for (const [key, c] of [...this.pending]) {
      if (c.revertAt > now) continue;
      if (this.reverting.has(key)) continue;
      void this.revert(c.uid, c.param, 'auto-revert').catch(() => { /* retained for the next retry */ });
    }
  }

}
