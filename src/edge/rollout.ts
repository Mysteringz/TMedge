/**
 * Rolling a firmware image out to nodes.
 *
 * A node on a ceiling is expensive to reach, so an update is never a
 * broadcast: one node goes first and has to come back reporting the new
 * image and a working sensor before any other node is touched. If the pilot
 * fails, the rest keep the firmware they have and the rollout stops. That is
 * the whole point of the staging -- a bad build costs one node, not a floor.
 *
 * The image itself travels to the node's gateway, which serves it on the node
 * network; the node is told only a port, a path and a SHA-256, in a signed
 * packet. Nothing here has to trust the gateway: an image whose bytes do not
 * hash to what the edge signed is thrown away by the node.
 */

export type RolloutTarget =
  | { kind: 'node'; uid: string }
  | { kind: 'floor'; floorId: string }
  | { kind: 'all' };

export type NodeUpdateState =
  | 'queued'
  | 'sending'        // image at the gateway, request on its way
  | 'downloading'
  | 'verifying'
  | 'applying'
  | 'rebooting'
  | 'confirmed'      // running the new image and proved healthy
  | 'failed'
  | 'skipped';       // the pilot failed, so this one was left alone

const TERMINAL: NodeUpdateState[] = ['confirmed', 'failed', 'skipped'];

export interface NodeUpdate {
  uid: string;
  label: string;
  floorId: string | null;
  gatewayId: string | null;
  state: NodeUpdateState;
  percent: number;
  error?: string;
  startedAt: number | null;
  updatedAt: number;
}

export interface RolloutView {
  id: string;
  buildId: string;
  version: string;
  target: RolloutTarget;
  startedBy: string;
  startedAt: number;
  finishedAt: number | null;
  /** pilot -> rest -> done, or stopped when the pilot failed. */
  stage: 'pilot' | 'rest' | 'done' | 'stopped';
  note: string;
  nodes: NodeUpdate[];
}

export interface RolloutNode {
  uid: string;
  label: string;
  floorId: string | null;
  /** The address the edge has for it: "gw:<id>|ip:port" or a plain IP. */
  address: string | null;
  online: boolean;
}

export interface RolloutDeps {
  /** The built image, or null if it is gone. */
  image(buildId: string): { bytes: Buffer; sha256: string; size: number; version: string } | null;
  nodes(): RolloutNode[];
  sendImageToGateway(gatewayId: string, meta: { id: string; size: number; sha256: string }, bytes: Buffer): boolean;
  sendOta(uid: string, image: { port: number; size: number; sha256: string; path: string }): Promise<void>;
  /** Port the edge itself serves images on, for a node that talks to it directly. */
  directPort: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface RolloutTimings {
  /** A gateway has this long to take delivery of the image. */
  imageMs: number;
  /** From "sending" to the node reporting it is rebooting. */
  flashMs: number;
  /** After the reboot, how long to wait for the node to confirm itself. */
  confirmMs: number;
  /** How many of the rest go at once, after the pilot. */
  batch: number;
}

const DEFAULT_TIMINGS: RolloutTimings = {
  imageMs: 120_000,
  flashMs: 180_000,
  confirmMs: 300_000,   // the node's own probation is 3 minutes
  batch: 3,
};

export class RolloutError extends Error {}

export class Rollouts {
  private active: RolloutView | null = null;
  private readonly past: RolloutView[] = [];
  private readonly now: () => number;
  private readonly timings: RolloutTimings;
  /** Gateways that have taken delivery of the image being rolled out. */
  private readonly gatewaysReady = new Map<string, { port: number; at: number }>();
  private readonly gatewaysAsked = new Map<string, number>();

  constructor(private readonly deps: RolloutDeps, timings: Partial<RolloutTimings> = {}) {
    this.now = deps.now ?? Date.now;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
  }

  current(): RolloutView | null { return this.active; }
  history(): RolloutView[] { return [...this.past].reverse(); }

  /** Which nodes a target picks, in the order they would be updated. */
  select(target: RolloutTarget): RolloutNode[] {
    const all = this.deps.nodes();
    const pick = target.kind === 'node'
      ? all.filter((n) => n.uid === target.uid)
      : target.kind === 'floor' ? all.filter((n) => n.floorId === target.floorId) : all;
    return pick.filter((n) => n.online && n.address !== null);
  }

  start(buildId: string, target: RolloutTarget, by: string): RolloutView {
    if (this.active && this.active.stage !== 'done' && this.active.stage !== 'stopped') {
      throw new RolloutError('an update is already running');
    }
    const image = this.deps.image(buildId);
    if (!image) throw new RolloutError(`build ${buildId} has no image`);
    const chosen = this.select(target);
    if (chosen.length === 0) throw new RolloutError('no node matches that target, or none is online');

    this.gatewaysReady.clear();
    this.gatewaysAsked.clear();
    const at = this.now();
    this.active = {
      id: `roll-${at.toString(36)}`,
      buildId,
      version: image.version,
      target,
      startedBy: by,
      startedAt: at,
      finishedAt: null,
      stage: 'pilot',
      note: chosen.length === 1 ? 'one node' : `${chosen[0]?.label ?? 'first node'} goes first; the rest follow if it comes back healthy`,
      nodes: chosen.map((n) => ({
        uid: n.uid,
        label: n.label,
        floorId: n.floorId,
        gatewayId: gatewayOf(n.address),
        state: 'queued' as NodeUpdateState,
        percent: 0,
        startedAt: null,
        updatedAt: at,
      })),
    };
    this.deps.log?.(`rollout ${this.active.id}: ${image.version} (${buildId}) to ${chosen.length} node(s), pilot ${chosen[0]?.uid}`);
    this.tick();
    return this.active;
  }

  /** Stop a rollout; nodes already flashing finish on their own. */
  cancel(by: string): void {
    if (!this.active || this.active.stage === 'done' || this.active.stage === 'stopped') return;
    for (const n of this.active.nodes) if (n.state === 'queued') this.set(n, 'skipped', 'cancelled');
    this.active.stage = 'stopped';
    this.active.note = `cancelled by ${by}`;
    this.finish();
  }

  /** A gateway has the image (or could not take it). */
  onImageReady(gatewayId: string, result: { id: string; ok: boolean; error?: string; port: number }): void {
    if (!this.active || result.id !== this.active.buildId) return;
    if (result.ok) {
      this.gatewaysReady.set(gatewayId, { port: result.port, at: this.now() });
      this.deps.log?.(`rollout: gateway ${gatewayId} has the image on port ${result.port}`);
    } else {
      this.deps.log?.(`rollout: gateway ${gatewayId} refused the image: ${result.error ?? 'unknown'}`);
      for (const n of this.active.nodes) {
        if (n.gatewayId === gatewayId && !TERMINAL.includes(n.state)) this.set(n, 'failed', `gateway: ${result.error ?? 'refused the image'}`);
      }
    }
    this.tick();
  }

  /** Progress straight from the node. */
  onOtaStatus(uid: string, status: { state: string; percent: number; error: string; image: string }): void {
    const node = this.active?.nodes.find((n) => n.uid === uid);
    if (!this.active || !node) return;
    // The node reports the image it is talking about; ignore anything stale.
    const expect = this.active.buildId.slice(0, 8);
    if (status.image !== expect && status.state !== 'failed') return;
    switch (status.state) {
      case 'downloading':
        this.set(node, 'downloading', undefined, status.percent);
        break;
      case 'verifying':
        this.set(node, 'verifying', undefined, 100);
        break;
      case 'applying':
        this.set(node, 'applying', undefined, 100);
        break;
      case 'rebooting':
        this.set(node, 'rebooting', undefined, 100);
        break;
      case 'confirmed':
        this.set(node, 'confirmed', undefined, 100);
        break;
      case 'reverted':
        this.set(node, 'failed', 'the new image did not come up; the node went back to the old one');
        break;
      case 'failed':
        this.set(node, 'failed', `node reported ${status.error}`);
        break;
      default:
        break;
    }
    this.tick();
  }

  /** Call about once a second: starts what is due and times out what is stuck. */
  tick(): void {
    const r = this.active;
    if (!r || r.stage === 'done' || r.stage === 'stopped') return;
    const now = this.now();

    for (const n of r.nodes) {
      if (TERMINAL.includes(n.state) || n.startedAt === null) continue;
      const waited = now - (n.updatedAt || n.startedAt);
      const limit = n.state === 'rebooting' ? this.timings.confirmMs : this.timings.flashMs;
      if (waited > limit) {
        this.set(n, 'failed', n.state === 'rebooting'
          ? 'the node did not come back and confirm the new image'
          : `stuck in "${n.state}"`);
      }
    }

    const pilot = r.nodes[0];
    if (!pilot) return;
    if (r.stage === 'pilot') {
      if (pilot.state === 'queued') this.begin(pilot);
      else if (pilot.state === 'confirmed') {
        r.stage = r.nodes.length > 1 ? 'rest' : 'done';
        r.note = r.nodes.length > 1 ? 'pilot confirmed; updating the rest' : 'done';
        this.deps.log?.(`rollout ${r.id}: pilot ${pilot.uid} confirmed`);
      } else if (pilot.state === 'failed') {
        for (const n of r.nodes.slice(1)) if (!TERMINAL.includes(n.state)) this.set(n, 'skipped', 'pilot failed');
        r.stage = 'stopped';
        r.note = `stopped: the pilot node failed (${pilot.error ?? 'unknown'}). Every other node kept its firmware.`;
        this.deps.log?.(`rollout ${r.id}: stopped, pilot failed: ${pilot.error}`);
      }
    }

    if (r.stage === 'rest') {
      // A few at a time: twenty nodes pulling a megabyte through one gateway
      // at once is how an update turns into an outage.
      let inFlight = r.nodes.filter((n) => !TERMINAL.includes(n.state) && n.startedAt !== null).length;
      for (const n of r.nodes.slice(1)) {
        if (inFlight >= this.timings.batch) break;
        if (n.state !== 'queued') continue;
        this.begin(n);
        if (n.startedAt !== null) inFlight += 1;
      }
    }

    if (r.stage !== 'stopped' && r.nodes.every((n) => TERMINAL.includes(n.state))) {
      const ok = r.nodes.filter((n) => n.state === 'confirmed').length;
      r.stage = 'done';
      r.note = `${ok} of ${r.nodes.length} node(s) now run ${r.version}`;
      this.finish();
    }
  }

  // --- internals ------------------------------------------------------------

  private begin(node: NodeUpdate): void {
    const r = this.active;
    if (!r) return;
    const image = this.deps.image(r.buildId);
    if (!image) {
      this.set(node, 'failed', 'the image is gone from this edge');
      return;
    }
    // A node behind a gateway downloads from that gateway, so the image has
    // to be there first. One push per gateway, however many nodes it serves.
    if (node.gatewayId) {
      const ready = this.gatewaysReady.get(node.gatewayId);
      if (!ready) {
        const asked = this.gatewaysAsked.get(node.gatewayId);
        if (asked === undefined) {
          const sent = this.deps.sendImageToGateway(node.gatewayId, { id: r.buildId, size: image.size, sha256: image.sha256 }, image.bytes);
          this.gatewaysAsked.set(node.gatewayId, this.now());
          if (!sent) this.set(node, 'failed', `gateway ${node.gatewayId} is not connected`);
        } else if (this.now() - asked > this.timings.imageMs) {
          this.set(node, 'failed', `gateway ${node.gatewayId} never took the image`);
        }
        return;   // try again on the next tick
      }
      this.request(node, ready.port, image);
      return;
    }
    this.request(node, this.deps.directPort, image);
  }

  private request(node: NodeUpdate, port: number, image: { sha256: string; size: number }): void {
    const r = this.active;
    if (!r) return;
    this.set(node, 'sending');
    node.startedAt = this.now();
    this.deps.sendOta(node.uid, { port, size: image.size, sha256: image.sha256, path: `/fw/${r.buildId}.bin` })
      .catch((err: unknown) => {
        this.set(node, 'failed', err instanceof Error ? err.message : String(err));
        this.tick();
      });
  }

  private set(node: NodeUpdate, state: NodeUpdateState, error?: string, percent?: number): void {
    node.state = state;
    node.updatedAt = this.now();
    if (percent !== undefined) node.percent = percent;
    if (error) node.error = error;
    if (state === 'confirmed') node.percent = 100;
  }

  private finish(): void {
    if (!this.active) return;
    this.active.finishedAt = this.now();
    this.past.push(this.active);
    if (this.past.length > 20) this.past.shift();
    this.deps.log?.(`rollout ${this.active.id}: ${this.active.note}`);
  }
}

/** "gw:<id>|ip:port" -> "<id>"; a plain address has no gateway. */
export function gatewayOf(address: string | null): string | null {
  return address ? (/^gw:([^|]+)\|/.exec(address)?.[1] ?? null) : null;
}
