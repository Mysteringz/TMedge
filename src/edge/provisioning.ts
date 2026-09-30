/**
 * Admitting a node that TMflash has just provisioned.
 *
 * The chicken and egg this solves: a node cannot authenticate until its uid
 * is in nodes.json, but nobody knows a node's uid until it has been flashed.
 * So TMflash asks, and a person at the console answers.
 *
 * A request is not an admission. Anything arriving here only becomes a
 * *pending* request; a node is admitted when someone with the console open
 * clicks Allow. That is deliberate: this file is the one place where a
 * machine on somebody's desk can change which devices the edge will talk to,
 * and the token in front of it is a way to queue a question, not a way to
 * answer it. A stolen token gets you a row in a list a human has to approve.
 *
 * What is admitted is an *identity*, never a placement. The new node may
 * connect and stream immediately, but has no floor, no pose and owns no
 * table, so it cannot move a single number a student sees until someone
 * places it deliberately. Registration and installation are different acts
 * performed by different people at different times, and conflating them is
 * how a node ends up counting a room it has never seen.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NodeDef, Registry } from './registry.js';

/** A request nobody has answered goes stale rather than waiting forever. */
export const REQUEST_TTL_MS = 30 * 60_000;
/** One machine cannot fill the console with requests. */
export const MAX_PENDING = 32;

const UID_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const LABEL_RE = /^[\w .,'()/-]{1,60}$/;

export interface JoinRequest {
  id: string;
  uid: string;
  label: string;
  /** Firmware version the flasher reported, for the person deciding. */
  firmware: string | null;
  /** Who asked, as far as we can tell: the caller's address. */
  from: string;
  at: number;
  expiresAt: number;
}

export type JoinOutcome =
  | { status: 'pending'; request: JoinRequest }
  | { status: 'already-registered'; uid: string };

export interface ProvisioningOptions {
  /** Shared secret TMflash presents. Provisioning is off when null. */
  token: string | null;
  nodesPath: string;
  /** Appended to, never rewritten: the record of who admitted what. */
  auditPath: string;
  now?: () => number;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Provisioning {
  private readonly pending = new Map<string, JoinRequest>();
  private readonly now: () => number;

  constructor(private readonly reg: Registry, private readonly opts: ProvisioningOptions) {
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.opts.token !== null;
  }

  /**
   * Constant-time, and the same answer for "no token configured" as for a
   * wrong one: whether this edge accepts provisioning at all is not something
   * an unauthenticated caller needs to learn.
   */
  authorise(presented: string | null): boolean {
    const want = this.opts.token;
    if (want === null || presented === null) return false;
    return safeEqual(presented, want);
  }

  requests(): JoinRequest[] {
    this.expire();
    return [...this.pending.values()].sort((a, b) => a.at - b.at);
  }

  /** Queue a request from TMflash. Never admits anything by itself. */
  request(input: { uid?: unknown; label?: unknown; firmware?: unknown }, from: string): JoinOutcome {
    this.expire();
    const uid = String(input.uid ?? '').toLowerCase().trim();
    if (!UID_RE.test(uid)) throw new Error('uid must be a MAC like 30:ed:a0:cb:f5:f8');

    const rawLabel = String(input.label ?? '').trim();
    // A label ends up in an admin's UI and in nodes.json; keep it to things
    // that cannot be mistaken for markup or break the file.
    if (rawLabel && !LABEL_RE.test(rawLabel)) throw new Error('label may only contain letters, digits and . , \' ( ) / -');
    const firmware = String(input.firmware ?? '').trim().slice(0, 40) || null;

    if (this.reg.nodes.has(uid)) return { status: 'already-registered', uid };

    const existing = [...this.pending.values()].find((r) => r.uid === uid);
    if (existing) return { status: 'pending', request: existing };
    if (this.pending.size >= MAX_PENDING) throw new Error('too many requests are already waiting for an answer');

    const at = this.now();
    const req: JoinRequest = {
      id: randomUUID(),
      uid,
      label: rawLabel || uid,
      firmware,
      from,
      at,
      expiresAt: at + REQUEST_TTL_MS,
    };
    this.pending.set(req.id, req);
    this.log({ action: 'request', at, uid, label: req.label, by: from, id: req.id });
    return { status: 'pending', request: req };
  }

  /** Has this uid been admitted? TMflash polls this after asking. */
  statusOf(uid: string): 'registered' | 'pending' | 'unknown' {
    this.expire();
    const u = uid.toLowerCase();
    if (this.reg.nodes.has(u)) return 'registered';
    return [...this.pending.values()].some((r) => r.uid === u) ? 'pending' : 'unknown';
  }

  /**
   * Admit a pending request: write it to nodes.json and add it to the running
   * registry, so the node can connect without waiting for a restart.
   *
   * Safe to do live only because the entry is unplaced. It owns no table and
   * has no pose, so no table's ownership, coverage or count can change --
   * the registry's derived state stays exactly as it was built.
   */
  approve(id: string, by: string): NodeDef {
    this.expire();
    const req = this.pending.get(id);
    if (!req) throw new Error('no such request (it may have expired)');
    if (this.reg.nodes.has(req.uid)) {
      this.pending.delete(id);
      throw new Error(`${req.uid} is already registered`);
    }

    const node: NodeDef = {
      uid: req.uid,
      label: req.label,
      floorId: null,
      pose: null,
      owns: [],
      simulated: false,
      rgb: false,
      detector: 'node',
    };

    // File first. If it cannot be written the node is not admitted at all,
    // rather than admitted until the next restart forgets it.
    this.appendToNodesFile(node);
    this.reg.nodes.set(node.uid, node);
    this.pending.delete(id);
    this.log({ action: 'approve', at: this.now(), uid: node.uid, label: node.label, by, id });
    return node;
  }

  deny(id: string, by: string): JoinRequest {
    const req = this.pending.get(id);
    if (!req) throw new Error('no such request (it may have expired)');
    this.pending.delete(id);
    this.log({ action: 'deny', at: this.now(), uid: req.uid, label: req.label, by, id });
    return req;
  }

  /**
   * Add one node to nodes.json, preserving everything else in it.
   *
   * Read-modify-write through a temporary file in the same directory, then
   * rename: a rename is atomic, so a crash or a full disk leaves the old file
   * intact rather than a half-written config the edge would refuse to start
   * with. The file is re-read each time rather than cached, so a hand edit
   * between admissions is not silently reverted.
   */
  private appendToNodesFile(node: NodeDef): void {
    const path = this.opts.nodesPath;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { nodes?: unknown }).nodes)) {
      throw new Error(`${path} is not a nodes config with a "nodes" array`);
    }
    const doc = parsed as { nodes: unknown[] };
    if (doc.nodes.some((n) => typeof n === 'object' && n !== null && (n as { uid?: unknown }).uid === node.uid)) {
      throw new Error(`${node.uid} is already in ${path}`);
    }
    // Only the fields an unplaced node has: floor, pose and owns are what
    // placing it later will add.
    doc.nodes.push({ uid: node.uid, label: node.label });

    const tmp = join(dirname(path), `.nodes.json.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644 });
    renameSync(tmp, path);
  }

  private expire(): void {
    const now = this.now();
    for (const [id, r] of [...this.pending]) if (r.expiresAt <= now) this.pending.delete(id);
  }

  private log(e: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.opts.auditPath), { recursive: true });
      appendFileSync(this.opts.auditPath, `${JSON.stringify(e)}\n`);
    } catch {
      /* the log is a courtesy; never fail an admission because it could not be written */
    }
  }
}
