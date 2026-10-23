/**
 * Sensors (admin only; formerly the TMedge debug console). Lists every node
 * with its status and readings, filterable like a network controller's device
 * list; selecting one opens a drawer with its live thermal view, detections,
 * detector parameters and commands. Where people sit on the floor is not
 * drawn here: location views live in their own section.
 */
import type { ConsoleDetection, EdgeHealth, NodeHealth, NodePose, OccupancySnapshot, Point, RawFrameMessage } from '../shared/types.js';
import { initFirmware, setFirmwareTargets } from './firmware.js';
import { CommandStatus } from './command-status.js';
import type { CommandReceipt } from '../modules/nodes/domain/command-receipt.js';

let capabilities: string[] = [];
let connected = false, lastMessageAt: number | null = null, commandBusy = false, disposed = false;
let stateRefreshed = false;
let liveSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let commands: CommandStatus | null = null;
const can = (capability: string) => capabilities.includes(capability);
const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

interface Layout {
  site: { id: string; name: string };
  floors: {
    id: string; visibility: 'public' | 'console'; name: string; building: string; width: number; height: number; outline: Point[];
    tables: { id: string; name: string; rect: { x: number; y: number; width: number; height: number }; seats: { id: string; x: number; y: number }[]; owner: string | null; coveredBy: string[] }[];
  }[];
  nodes: { uid: string; label: string; floorId: string | null; pose: NodePose | null; owns: string[]; simulated: boolean; rgb: boolean; footprint: Point[] | null }[];
}

interface StateMsg {
  health: EdgeHealth;
  nodes: NodeHealth[];
  snapshot: OccupancySnapshot;
  authorities: Record<string, { authority: string | null; status: string }>;
}

let layout: Layout | null = null;
let last: StateMsg | null = null;
let selected: string | null = null;
const dets = new Map<string, { at: number; dets: ConsoleDetection[] }>();
const raws = new Map<string, RawFrameMessage>();
const backgrounds = new Map<string, Float32Array>();
let mode: 'temp' | 'diff' = 'temp';
/** What the drawer's live view shows: thermal always exists, RGB only on a rig. */
let liveSource: 'thermal' | 'rgb' = 'thermal';

// List state. Within a filter group the ticked values are alternatives (OR);
// across groups they narrow (AND); a group with nothing ticked filters nothing.
type FilterGroup = 'status' | 'floor' | 'link' | 'detector' | 'kind';
type SortKey = 'type' | 'name' | 'status' | 'people' | 'fps' | 'loss' | 'signal' | 'firmware' | 'floor' | 'address' | 'seen';
const filters = new Map<FilterGroup, Set<string>>();
let query = '';
let view: 'list' | 'grid' = 'list';
let sortKey: SortKey = 'name';
let sortDir: 1 | -1 = 1;
const rgbFrames = new Map<string, { at: number; url: string }>();

// --- colour --------------------------------------------------------------------

const INFERNO: [number, number, number][] = [
  [0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164],
];
function inferno(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (INFERNO.length - 1);
  const i = Math.min(INFERNO.length - 2, Math.floor(x));
  const f = x - i;
  const a = INFERNO[i] ?? [0, 0, 0];
  const b = INFERNO[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function temps(raw: RawFrameMessage): Float32Array {
  const out = new Float32Array(768);
  for (let i = 0; i < 768; i++) out[i] = raw.tMin + (raw.pixels[i] ?? 0) * raw.step;
  return out;
}

/** Client-side background for the "minus background" view: a slow EMA of the frames seen. */
function background(uid: string, t: Float32Array): Float32Array {
  let bg = backgrounds.get(uid);
  if (!bg) {
    bg = Float32Array.from(t);
    backgrounds.set(uid, bg);
  } else {
    for (let i = 0; i < 768; i++) bg[i] = (bg[i] ?? 0) + 0.02 * ((t[i] ?? 0) - (bg[i] ?? 0));
  }
  return bg;
}

function drawThermal(canvas: HTMLCanvasElement, raw: RawFrameMessage, overlay: ConsoleDetection[] | null, big: boolean): [number, number] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [0, 0];
  const t = temps(raw);
  const bg = background(raw.uid, t);
  const values = mode === 'diff' && big ? t.map((v, i) => v - (bg[i] ?? v)) : t;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (mode === 'diff' && big) {
    lo = Math.min(lo, -0.5);
    hi = Math.max(hi, 2);
  }
  const img = ctx.createImageData(32, 24);
  for (let i = 0; i < 768; i++) {
    const [r, g, b] = inferno(((values[i] ?? lo) - lo) / Math.max(hi - lo, 0.1));
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  // Draw at 1:1 into an offscreen canvas, then scale up with no smoothing, so
  // pixels stay square: this is what the sensor actually resolves.
  const off = document.createElement('canvas');
  off.width = 32;
  off.height = 24;
  off.getContext('2d')?.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  if (overlay) {
    const sx = canvas.width / 32;
    const sy = canvas.height / 24;
    ctx.lineWidth = big ? 2.5 : 1.5;
    ctx.font = `${big ? 13 : 10}px ui-sans-serif, system-ui`;
    for (const d of overlay) {
      const r = Math.max(4, Math.sqrt(d.area / Math.PI) * sx);
      ctx.strokeStyle = d.counted ? '#4dffa8' : '#cfd6e3';
      ctx.setLineDash(d.counted ? [] : [4, 3]);
      ctx.beginPath();
      ctx.arc(d.x * sx, d.y * sy, r, 0, Math.PI * 2);
      ctx.stroke();
      if (big) {
        ctx.fillStyle = '#fff';
        ctx.fillText(`+${d.contrast.toFixed(1)}° ${d.persons > 1 ? `×${d.persons}` : ''}${d.tableId ?? ''}`, d.x * sx + r + 3, d.y * sy + 4);
      }
    }
    ctx.setLineDash([]);
  }
  return [lo, hi];
}

/**
 * A mirrored sensor sends a mirrored picture. Every place that draws a
 * thermal frame has to undo that, or it sits next to the rig's camera
 * showing the room the wrong way round -- which is what the grid and the
 * detail panel once did, while the old demo tab alone got it right.
 */
function isMirrored(uid: string): boolean {
  return layout?.nodes.find((n) => n.uid === uid)?.pose?.mirror ?? false;
}

function asRoomSeen(raw: RawFrameMessage, blobs: ConsoleDetection[] | null): [RawFrameMessage, ConsoleDetection[] | null] {
  if (!isMirrored(raw.uid)) return [raw, blobs];
  return [
    { ...raw, pixels: raw.pixels.map((_, i) => raw.pixels[Math.floor(i / 32) * 32 + (31 - (i % 32))] ?? 0) },
    // 31 - x, not 32 - x: columns are 0..31, so the mirror of column 0 is 31.
    // The old demo-tab code was a pixel out, which at 32 px across a 110 deg
    // view is 20-30 cm of floor -- enough to put a blob on the wrong seat.
    blobs ? blobs.map((x) => ({ ...x, x: 31 - x.x })) : blobs,
  ];
}

// --- panels -------------------------------------------------------------------------

function fmtAge(ms: number | null): string {
  if (ms === null) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * An edge-detected node's background is the day-long model, which takes an
 * hour to trust and a day to fill: say which, and how far along it is, so
 * "learning" for an hour after a deploy does not read as a broken node.
 */
function backgroundCell(n: NodeHealth): string {
  const state = n.backgroundReady ? (n.globalShift ? 'shift' : 'ready') : 'learning';
  const bg = n.edgeBackground;
  if (n.detector !== 'edge') return state;
  return `edge · ${state}${bg ? ` · ${bg.hours} h of ${bg.windowHours}` : ''}`;
}

/**
 * Show the latest RGB frame everywhere it appears: grid tile and drawer.
 * Camera orientation is independent of the thermal pose; using the thermal
 * mirror flag here reverses the Pi image for the operator.
 */
function showRgb(uid: string, url: string): void {
  const set = (img: HTMLImageElement | null) => {
    if (!img) return;
    img.src = url;
    img.style.transform = 'none';
  };
  set(document.querySelector<HTMLImageElement>(`#thumbs [data-rgb-uid="${uid}"] img`));
  if (uid === selected) set($<HTMLImageElement>('#rgb-detail-img'));
}

function drawThumb(raw: RawFrameMessage): void {
  const canvas = document.querySelector<HTMLCanvasElement>(`#thumbs [data-uid="${raw.uid}"] canvas`);
  if (canvas) {
    const [frame, blobs] = asRoomSeen(raw, dets.get(raw.uid)?.dets ?? null);
    drawThermal(canvas, frame, blobs, false);
  }
  if (raw.uid === selected) drawBig();
}

function drawBig(): void {
  if (!selected) return;
  renderLiveMeta();
  if (liveSource === 'rgb') return;
  const raw = raws.get(selected);
  if (!raw) return;
  const overlay = ($<HTMLInputElement>('#t-overlay')).checked ? dets.get(selected)?.dets ?? [] : null;
  const [frame, blobs] = asRoomSeen(raw, overlay);
  const [lo, hi] = drawThermal($<HTMLCanvasElement>('#big'), frame, blobs, true);
  $('#scale-lo').textContent = `${lo.toFixed(1)} °C`;
  $('#scale-hi').textContent = `${hi.toFixed(1)} °C`;
}

/**
 * The tag over the live view says whether the picture is live or the last
 * one that arrived. A frozen frame that still says LIVE is how somebody
 * debugs a node that went offline ten minutes ago.
 */
function renderLiveMeta(): void {
  if (!selected) return;
  const isRig = layout?.nodes.some((x) => x.uid === selected && x.rgb) ?? false;
  if (!isRig) liveSource = 'thermal';
  const rgb = liveSource === 'rgb';
  $('#src-seg').hidden = !isRig;
  $('#src-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.src === liveSource)));
  $('#mode-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('#mode-seg').hidden = rgb;
  ($<HTMLElement>('#t-overlay').closest('label') as HTMLElement).hidden = rgb;
  $('#scale').hidden = rgb;
  $('#big').hidden = rgb;
  const img = $<HTMLImageElement>('#rgb-detail-img');
  img.hidden = !rgb;
  const f = rgb ? rgbFrames.get(selected) : undefined;
  if (f && img.src !== f.url) img.src = f.url;
  const at = rgb ? f?.at ?? null : raws.get(selected)?.receivedAt ?? null;
  const fresh = at !== null && Date.now() - at < 5000;
  const tag = $('#live-tag');
  tag.textContent = fresh ? 'LIVE' : at === null ? 'NO SIGNAL' : 'STALE';
  tag.classList.toggle('stale', !fresh);
  const online = last?.nodes.find((n) => n.uid === selected)?.online ?? false;
  $('#live-age').textContent = at !== null ? fmtAge(at) : !online ? 'offline' : rgb ? 'waiting for camera' : 'no RAW (raw_every=0?)';
}

/** Short enough for the table: a direct node's address is a session, not a place. */
function addressCell(n: NodeHealth): string {
  if (n.transport === 'direct') return `wss · ${esc(n.direct?.sessionId?.slice(0, 6) ?? 'session')}`;
  if (n.transport === null && n.address) return 'wss · closed';
  return esc(n.address ?? '–');
}

/** How the node reaches the edge; for a direct node, its session in one line. */
function uplink(n: NodeHealth): string {
  const d = n.direct;
  if (n.transport === 'gateway') return 'via access gateway';
  if (n.transport === 'udp') return d ? `udp (earlier direct sessions: ${d.connects})` : 'udp';
  if (!d) return n.transport === 'direct' ? 'direct' : '–';
  const parts = [d.connected ? `direct session ${d.sessionId?.slice(0, 6) ?? ''} from ${d.source ?? '?'}, up ${fmtAge(d.connectedAt)}` : 'direct session closed'];
  if (d.connected) parts.push(`report accepted ${fmtAge(d.lastReportAt)}`, `${d.acks} ACKs`, `${d.rejected} refused${d.lastRejection ? ` (last: ${d.lastRejection})` : ''}`);
  if (d.previousKey) parts.push('on TM_KEY_PREVIOUS');
  parts.push(`${d.connects} connect(s)`);
  if (d.lastDisconnectAt) parts.push(`last disconnect ${fmtAge(d.lastDisconnectAt)}: ${d.lastDisconnectReason ?? '?'}`);
  return parts.join(' · ');
}

// --- the list -------------------------------------------------------------------------

function isRig(uid: string): boolean {
  return layout?.nodes.some((x) => x.uid === uid && x.rgb) ?? false;
}

function isSimulated(uid: string): boolean {
  return layout?.nodes.some((x) => x.uid === uid && x.simulated) ?? false;
}

function signalQuality(rssi: number): { label: string; cls: 'good' | 'warn' | 'bad' } {
  if (rssi >= -60) return { label: 'Excellent', cls: 'good' };
  if (rssi >= -70) return { label: 'Good', cls: 'good' };
  if (rssi >= -80) return { label: 'Fair', cls: 'warn' };
  return { label: 'Poor', cls: 'bad' };
}

/** A camera for an RGB rig, a framed heat spot for a thermal sensor; faded if simulated. */
function typeIcon(uid: string): string {
  const d = isRig(uid)
    ? 'M3 2h3l1-1h6l1 1h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm7 2.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'
    : 'M1 1h18v12H1zm1 1v10h16V2zm8 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z';
  return `<svg viewBox="0 0 20 14" aria-hidden="true"><path fill-rule="evenodd" d="${d}"${isSimulated(uid) ? ' opacity=".5"' : ''}/></svg>`;
}

const FILTER_TITLES: Record<FilterGroup, string> = { status: 'Status', floor: 'Floor', link: 'Connection', detector: 'Detector', kind: 'Device' };
const FILTER_ORDER: FilterGroup[] = ['status', 'floor', 'link', 'detector', 'kind'];

function facet(n: NodeHealth, g: FilterGroup): string {
  switch (g) {
    case 'status': return n.online ? 'online' : 'offline';
    case 'floor': return n.floorId ?? 'unplaced';
    case 'link': return n.transport ?? 'none';
    case 'detector': return n.detector;
    case 'kind': return isSimulated(n.uid) ? 'simulated' : 'hardware';
  }
}

function facetLabel(g: FilterGroup, v: string): string {
  switch (g) {
    case 'status': return v === 'online' ? 'Online' : 'Offline';
    case 'floor': {
      if (v === 'unplaced') return 'Unplaced';
      const f = layout?.floors.find((x) => x.id === v);
      return f ? (f.visibility === 'console' ? `${f.name} · console only` : f.name) : v;
    }
    case 'link': return ({ direct: 'Direct (WSS)', gateway: 'Access gateway', udp: 'UDP' } as Record<string, string>)[v] ?? 'No route';
    case 'detector': return v === 'edge' ? 'On edge' : 'On sensor';
    case 'kind': return v === 'simulated' ? 'Simulated' : 'Hardware';
  }
}

function sortValue(n: NodeHealth): number | string {
  switch (sortKey) {
    case 'type': return (isRig(n.uid) ? 2 : 0) + (isSimulated(n.uid) ? 1 : 0);
    case 'name': return n.label;
    case 'status': return n.online ? 0 : 1;
    case 'people': return n.lastPeople ?? -1;
    case 'fps': return n.fps;
    case 'loss': return n.lossRate;
    case 'signal': return n.status?.rssi ?? -999;
    case 'firmware': return n.status?.fw ?? '';
    case 'floor': return facetLabel('floor', facet(n, 'floor'));
    case 'address': return n.address ?? '';
    case 'seen': return n.lastSeen ?? 0;
  }
}

function compare(a: number | string, b: number | string): number {
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
}

function visibleNodes(): NodeHealth[] {
  const shown = (last?.nodes ?? []).filter((n) => {
    if (query && ![n.label, n.uid, n.address, n.status?.ip, n.status?.fw].some((x) => x?.toLowerCase().includes(query))) return false;
    for (const [g, set] of filters) if (set.size > 0 && !set.has(facet(n, g))) return false;
    return true;
  });
  return shown.sort((a, b) => compare(sortValue(a), sortValue(b)) * sortDir || compare(a.label, b.label));
}

let filterSig = '';

/**
 * Counts are over every sensor, not the filtered ones, so ticking a box
 * never makes the other options' numbers jump. The checkboxes are only
 * rebuilt when the set of options changes: rebuilding on every state
 * message would eat a click that lands mid-rebuild.
 */
function renderFilters(force: boolean): void {
  if (!last) return;
  const groups: { g: FilterGroup; values: { v: string; count: number }[] }[] = [];
  for (const g of FILTER_ORDER) {
    const counts = new Map<string, number>();
    if (g === 'status') counts.set('online', 0).set('offline', 0);
    for (const n of last.nodes) counts.set(facet(n, g), (counts.get(facet(n, g)) ?? 0) + 1);
    const ticked = (filters.get(g)?.size ?? 0) > 0;
    // A group with one option filters nothing; status always shows, so a floor
    // with every sensor online still says "Offline (0)".
    if (g !== 'status' && counts.size < 2 && !ticked) continue;
    const values = [...counts].map(([v, count]) => ({ v, count }));
    if (g !== 'status') values.sort((a, b) => facetLabel(g, a.v).localeCompare(facetLabel(g, b.v)));
    groups.push({ g, values });
  }
  const wrap = $('#filters');
  const sig = groups.map((x) => `${x.g}:${x.values.map((y) => y.v).join(',')}`).join('|');
  if (!force && sig === filterSig) {
    for (const { g, values } of groups) {
      for (const { v, count } of values) {
        const n = wrap.querySelector(`span.n[data-g="${g}"][data-v="${CSS.escape(v)}"]`);
        if (n) n.textContent = `(${count})`;
      }
    }
    return;
  }
  filterSig = sig;
  const open = new Map<string, boolean>();
  wrap.querySelectorAll<HTMLDetailsElement>('details[data-g]').forEach((d) => open.set(d.dataset.g ?? '', d.open));
  wrap.innerHTML = groups.map(({ g, values }) => `<details class="sx-fold" data-g="${g}"${open.get(g) ?? true ? ' open' : ''}><summary>${FILTER_TITLES[g]}</summary>${values.map(({ v, count }) =>
    `<label class="sx-check"><input type="checkbox" data-g="${g}" data-v="${esc(v)}"${filters.get(g)?.has(v) ? ' checked' : ''}> ${esc(facetLabel(g, v))} <span class="n" data-g="${g}" data-v="${esc(v)}">(${count})</span></label>`).join('')}</details>`).join('');
  wrap.querySelectorAll<HTMLInputElement>('input[data-g]').forEach((cb) => cb.addEventListener('change', () => {
    const g = FILTER_ORDER.find((x) => x === cb.dataset.g);
    const v = cb.dataset.v;
    if (!g || v === undefined) return;
    const set = filters.get(g) ?? new Set<string>();
    if (cb.checked) set.add(v);
    else set.delete(v);
    if (set.size) filters.set(g, set);
    else filters.delete(g);
    renderNodes();
    renderThumbs();
  }));
}

const COLUMNS: { key: SortKey; title: string; num?: boolean }[] = [
  { key: 'type', title: 'Type' }, { key: 'name', title: 'Name' }, { key: 'status', title: 'Status' },
  { key: 'people', title: 'People', num: true }, { key: 'fps', title: 'FPS', num: true }, { key: 'loss', title: 'Loss', num: true },
  { key: 'signal', title: 'Signal', num: true }, { key: 'firmware', title: 'Firmware' }, { key: 'floor', title: 'Floor' },
  { key: 'address', title: 'Address' }, { key: 'seen', title: 'Last seen' },
];

function renderNodes(): void {
  if (!last) return;
  const list = visibleNodes();
  const total = last.nodes.length;
  $('#count').textContent = list.length === total ? `${total} sensor${total === 1 ? '' : 's'}` : `${list.length} of ${total} sensors`;
  const wrap = $('#list-view');
  wrap.hidden = view !== 'list';
  $('#empty').hidden = list.length > 0;
  const head = COLUMNS.map((c) => `<th data-sort="${c.key}" aria-sort="${c.key === sortKey ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'}"${c.num ? ' class="num"' : ''}>${c.title}</th>`).join('');
  const rows = list.map((n) => {
    const s = n.status;
    const seen = n.online && n.lastSeen !== null && Date.now() - n.lastSeen < 5000 ? 'now' : fmtAge(n.lastSeen);
    return `<tr data-uid="${esc(n.uid)}" class="${n.uid === selected ? 'sel' : ''}${n.online ? '' : ' off'}">
      <td><span class="sx-type" title="${isRig(n.uid) ? 'Thermal + RGB rig' : 'Thermal sensor'}">${typeIcon(n.uid)}</span></td>
      <td>${esc(n.label)}</td>
      <td><span class="dotc ${n.online ? 'on' : ''}"></span>${n.online ? 'Online' : 'Offline'}${n.registered ? '' : ' · unregistered'}</td>
      <td class="num">${n.online ? n.lastPeople ?? '–' : '–'}</td><td class="num">${n.fps.toFixed(1)}</td>
      <td class="num">${(n.lossRate * 100).toFixed(1)}%</td><td class="num">${s ? `${s.rssi} dBm` : '–'}</td>
      <td>${esc(s?.fw ?? '–')}</td><td>${esc(facetLabel('floor', facet(n, 'floor')))}</td>
      <td title="${esc(n.address ?? '')}">${addressCell(n)}</td><td>${seen}</td></tr>`;
  }).join('');
  const x = wrap.scrollLeft;
  const table = $('#nodes');
  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody>`;
  wrap.scrollLeft = x;
  table.querySelectorAll<HTMLElement>('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const key = COLUMNS.find((c) => c.key === th.dataset.sort)?.key;
    if (!key) return;
    sortDir = key === sortKey && sortDir === 1 ? -1 : 1;
    sortKey = key;
    renderNodes();
    renderThumbs();
  }));
  // Clicking the open sensor again closes its drawer.
  table.querySelectorAll<HTMLElement>('tr[data-uid]').forEach((tr) => tr.addEventListener('click', () => {
    const uid = tr.dataset.uid ?? null;
    select(uid === selected ? null : uid);
  }));
}

function renderThumbs(): void {
  if (!last) return;
  const wrap = $('#thumbs');
  wrap.hidden = view !== 'grid';
  const list = visibleNodes();
  const visible = new Set(list.map((n) => n.uid));
  for (const n of list) {
    let card = wrap.querySelector<HTMLElement>(`[data-uid="${CSS.escape(n.uid)}"]`);
    const fresh = !card;
    if (!card) {
      card = document.createElement('div');
      card.className = 'thumb';
      card.dataset.uid = n.uid;
      card.innerHTML = `<canvas width="192" height="144"></canvas><div class="cap"><span class="name"></span><span class="info"></span></div>`;
      card.addEventListener('click', () => select(n.uid));
    }
    // Re-appending moves an existing card, so the grid follows the list's sort.
    wrap.appendChild(card);
    const raw = raws.get(n.uid);
    if (fresh && raw) drawThumb(raw);
    card.classList.toggle('sel', n.uid === selected);
    card.classList.toggle('off', !n.online);
    const name = card.querySelector('.name');
    const info = card.querySelector('.info');
    if (name) name.textContent = n.label;
    if (info) {
      info.textContent = raw
        ? `${n.lastPeople ?? 0} blob(s) · ${fmtAge(raw.receivedAt)}${isMirrored(n.uid) ? ' · mirrored' : ''}`
        : n.online ? 'no RAW (raw_every=0?)' : 'offline';
    }

    // Verification rigs also get an RGB tile, right after their thermal one.
    // Only nodes flagged "rgb" in nodes.json ever have one.
    if (!isRig(n.uid)) continue;
    let rgbCard = wrap.querySelector<HTMLElement>(`[data-rgb-uid="${CSS.escape(n.uid)}"]`);
    const frame = rgbFrames.get(n.uid);
    if (!rgbCard) {
      rgbCard = document.createElement('div');
      rgbCard.className = 'thumb rgb';
      rgbCard.dataset.rgbUid = n.uid;
      rgbCard.innerHTML = `<img alt="Live RGB camera"><div class="cap"><span class="name"></span><span class="info"></span></div>`;
      rgbCard.addEventListener('click', () => select(n.uid));
      card.after(rgbCard);
      if (frame) showRgb(n.uid, frame.url);
    } else card.after(rgbCard);
    rgbCard.classList.toggle('sel', n.uid === selected);
    const rgbName = rgbCard.querySelector('.name');
    const rgbInfo = rgbCard.querySelector('.info');
    // Same caption as its thermal twin, so the pair reads as a pair.
    if (rgbName) rgbName.textContent = `${n.label} · RGB`;
    if (rgbInfo) rgbInfo.textContent = frame ? fmtAge(frame.at) : 'waiting for camera';
  }
  wrap.querySelectorAll<HTMLElement>('.thumb').forEach((t) => {
    t.hidden = !visible.has(t.dataset.uid ?? t.dataset.rgbUid ?? '');
  });
}

// --- the drawer -----------------------------------------------------------------------

function renderDetail(): void {
  const n = last?.nodes.find((x) => x.uid === selected);
  if (!n) return;
  $('#detail-title').textContent = n.label;
  $('#detail-name').textContent = n.label;
  $('#detail-icon').innerHTML = typeIcon(n.uid);
  const badge = $('#detail-badge');
  const [text, cls] = !n.registered ? ['Unregistered', 'warn'] : n.online ? ['Online', 'good'] : ['Offline', 'bad'];
  badge.textContent = text;
  badge.className = `sx-badge ${cls}`;
  $('#detail-sub').textContent = [n.uid, isRig(n.uid) ? 'thermal + RGB rig' : 'thermal sensor', isSimulated(n.uid) ? 'simulated' : null,
    n.pose ? `h=${n.pose.heightCm} cm` : 'not placed'].filter((x) => x !== null).join(' · ');

  const s = n.status;
  const q = s ? signalQuality(s.rssi) : null;
  const conn: [string, string] = !n.online ? ['Offline', 'bad'] : s && q ? [`${q.label} (${s.rssi} dBm)`, q.cls] : ['Online', 'good'];
  const counting = Object.entries(last?.authorities ?? {}).filter(([, a]) => a.authority === n.uid).map(([t]) => t);
  // Connection quality first, as a network controller leads with it: it is
  // the first thing to rule out when a sensor's numbers look wrong.
  const rows: [string, string, string?][] = [
    ['Connection', ...conn],
    ['Uplink', uplink(n)],
    ['People detected', n.online ? String(n.lastPeople ?? 0) : '–'],
    ['Counting for', counting.join(', ') || '–'],
    ['Owns', n.owns.join(', ') || '–'],
    ['Floor', facetLabel('floor', n.floorId ?? 'unplaced')],
    ['Frame rate', `${n.fps.toFixed(2)} fps`],
    ['Packet loss', `${(n.lossRate * 100).toFixed(1)}%`, n.lossRate > 0.05 ? 'warn' : undefined],
    ['Detector', n.detector === 'edge' ? 'on edge' : 'on sensor'],
    ['Background', backgroundCell(n)],
    ['Scene', n.sceneMin !== null && n.sceneMax !== null ? `${n.sceneMin.toFixed(1)}–${n.sceneMax.toFixed(1)} °C` : '–'],
    ['Sensor Ta', n.ta !== null ? `${n.ta.toFixed(1)} °C` : '–'],
    ['One-person heat', n.refHeat !== null ? `${n.refHeat.toFixed(2)} °C·m²` : 'learning'],
    ['IP address', s?.ip ?? n.address ?? '–'],
    ['MAC address', n.uid],
    ['Wi-Fi', s ? `ch ${s.channel} · drops ${s.wifiDrops}` : '–'],
    ['Memory', s ? `heap ${(s.heap / 1024).toFixed(0)} kB (min ${(s.minHeap / 1024).toFixed(0)}) · stack ${s.stackFree} B` : '–'],
    ['Sensor', s ? `Vdd ${s.vdd.toFixed(2)} V · errors ${s.sensorErrors} · frames ${s.frames}` : '–', s && s.sensorErrors > 0 ? 'warn' : undefined],
    ['Firmware', s?.fw ?? '–'],
    ['Boot', n.boot === null ? '–' : String(n.boot)],
    ['Packets', `${n.reports} reports · ${n.raws} raw · ${n.rejected} rejected`, n.rejected > 0 ? 'warn' : undefined],
    ['Authentication', n.lastSeen === null ? '–' : n.signed ? 'signed' : 'UNSIGNED', n.lastSeen !== null && !n.signed ? 'bad' : undefined],
    ['Last seen', fmtAge(n.lastSeen)],
    ['Last command sequence observed', s ? String(s.lastCmd) : '–'],
  ];
  $('#detail-kv').innerHTML = rows.map(([k, v, c]) => `<dt>${esc(k)}</dt><dd class="${c ?? ''}">${esc(v)}</dd>`).join('');

  const controls = $('#controls');
  // Heard through a local proxy (the RGB rig via userspace Tailscale): there is
  // no route back, so offering commands would only produce errors.
  const proxied = n.transport === 'udp' && n.address !== null && /^(127\.|::1$|::ffff:127\.)/.test(n.address);
  // A direct node whose session has closed has no route until it reconnects.
  const noRoute = n.address !== null && n.transport === null;
  controls.hidden = !n.online || proxied || noRoute;
  controls.querySelectorAll<HTMLButtonElement>('button[data-op]').forEach((button) => { button.disabled = !connected || !stateRefreshed || commandBusy || lastMessageAt === null || Date.now() - lastMessageAt > 15000 || !can(button.dataset.op === 'reboot' ? 'nodes.admin' : 'nodes.write'); });
  $('#cmd-result').textContent = proxied ? 'Commands unavailable: this node is reached through a local proxy.'
    : noRoute ? 'Commands unavailable: the node\'s direct session has closed.' : $('#cmd-result').textContent;
  const params = $('#params');
  params.querySelectorAll<HTMLInputElement>('input').forEach((input) => { input.disabled = !connected || !stateRefreshed || commandBusy || !can('nodes.write') || lastMessageAt === null || Date.now() - lastMessageAt > 15000; });
  if (s && params.dataset.uid !== n.uid) {
    params.dataset.uid = n.uid;
    params.innerHTML = Object.entries(s.params).map(([k, v]) => `<label>${esc(k)}<input data-param="${esc(k)}" type="number" ${can('nodes.write') && connected ? '' : 'disabled'} step="1" value="${esc(String(v))}"></label>`).join('');
    params.querySelectorAll<HTMLInputElement>('input').forEach((inp) => inp.addEventListener('change', () => {
      void command({ op: 'set', param: inp.dataset.param, value: Number(inp.value) });
    }));
  } else if (!s) {
    params.innerHTML = '<p class="muted small">No status report from this sensor yet.</p>';
    delete params.dataset.uid;
  }
  renderDets();
}

/** What the selected sensor sees right now, strongest first. */
function renderDets(): void {
  if (!selected) return;
  const d = dets.get(selected);
  const fresh = d && Date.now() - d.at < 3000 ? [...d.dets].sort((a, b) => b.contrast - a.contrast) : [];
  $('#dets-sub').textContent = d ? (fresh.length ? `${fresh.length} now` : 'none in the last 3 s') : 'waiting for a report';
  const rows = fresh.map((x) => `<tr><td>${x.x.toFixed(1)}, ${x.y.toFixed(1)}</td><td>+${x.contrast.toFixed(1)} °C</td><td>${x.persons}</td>`
    + `<td>${esc(x.tableId ?? '–')}</td><td>${x.tableId ? (x.counted ? 'yes' : 'no (not authority)') : 'no'}</td></tr>`).join('')
    || '<tr><td class="empty" colspan="5">No people detected right now.</td></tr>';
  $('#detail-dets').innerHTML = `<thead><tr><th>Cell</th><th>Contrast</th><th>People</th><th>Table</th><th>Counted</th></tr></thead><tbody>${rows}</tbody>`;
}


/* --- Nodes asking to join ------------------------------------------------
 *
 * TMflash flashes a node and asks for it to be admitted; the answer is a
 * person's, here. Requests queue rather than replace each other, because
 * commissioning a batch means several arrive while the first is still open
 * and none of them should be lost behind another.
 */
interface JoinRequest {
  id: string; uid: string; label: string;
  firmware: string | null; from: string; at: number; expiresAt: number;
}

const joinQueue: JoinRequest[] = [];
let joinShowing: JoinRequest | null = null;
let joinBusy = false;

function queueJoin(req: JoinRequest): void {
  if (joinQueue.some((r) => r.id === req.id) || joinShowing?.id === req.id) return;
  joinQueue.push(req);
  showNextJoin();
}

function dropJoin(id: string): void {
  const i = joinQueue.findIndex((r) => r.id === id);
  if (i >= 0) joinQueue.splice(i, 1);
  // Someone at another console answered the one on screen; close it rather
  // than let this admin approve something that no longer exists.
  if (joinShowing?.id === id) {
    joinShowing = null;
    ($('#join-dialog') as HTMLDialogElement).close();
    showNextJoin();
  }
}

function showNextJoin(): void {
  const dlg = $('#join-dialog') as HTMLDialogElement;
  if (joinShowing || dlg.open) return;
  const req = joinQueue.shift();
  if (!req) return;
  joinShowing = req;
  $('#join-uid').textContent = req.uid;
  $('#join-label').textContent = req.label;
  $('#join-fw').textContent = req.firmware ?? 'not reported';
  $('#join-from').textContent = req.from;
  $('#join-queue').textContent = joinQueue.length ? `${joinQueue.length} more waiting` : '';
  ($('#join-code') as HTMLInputElement).value = '';
  const err = $('#join-error');
  err.hidden = true;
  err.textContent = '';
  dlg.showModal();
}

async function answerJoin(verdict: 'approve' | 'deny'): Promise<void> {
  if (!can('nodes.admin')) return;
  const req = joinShowing;
  if (!req || joinBusy) return;
  joinBusy = true;
  const buttons = [$('#join-approve') as HTMLButtonElement, $('#join-deny') as HTMLButtonElement];
  for (const button of buttons) button.disabled = true;
  try {
    const res = await fetch(`api/provision/requests/${encodeURIComponent(req.id)}/${verdict}`, {
      method: 'POST', headers: { 'x-tm-console': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ uid: req.uid, pairingCode: ($('#join-code') as HTMLInputElement).value.toUpperCase() }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `failed (HTTP ${res.status})`);
    }
    dropJoin(req.id);
  } catch (cause) {
    if (joinShowing?.id === req.id) {
      const err = $('#join-error');
      err.textContent = cause instanceof Error ? cause.message : 'Cannot reach the edge. Try again.';
      err.hidden = false;
    }
  } finally {
    joinBusy = false;
    for (const button of buttons) button.disabled = false;
  }
}

function initJoin(): void {
  const dlg = $('#join-dialog') as HTMLDialogElement;
  // method=dialog would close the form before the async answer arrived,
  // requeueing it and making a failed request impossible to retry.
  $('#join-approve').addEventListener('click', (event) => { event.preventDefault(); void answerJoin('approve'); });
  $('#join-deny').addEventListener('click', (event) => { event.preventDefault(); void answerJoin('deny'); });
  dlg.addEventListener('cancel', (event) => { if (joinBusy) event.preventDefault(); });
  // Esc closes the dialog without answering; the request stays pending and
  // comes back on the next reload, which is the safe way round.
  dlg.addEventListener('close', () => {
    if (joinShowing && !dlg.open) {
      joinQueue.unshift(joinShowing);
      joinShowing = null;
    }
  });
}

async function command(body: { op: string; param?: string | undefined; value?: number }): Promise<void> {
  if (!can(['set', 'reset-bg', 'identify', 'save'].includes(body.op) ? 'nodes.write' : 'nodes.admin')) { $('#cmd-result').textContent = 'Your access has changed. This action is unavailable.'; return; }
  if (!selected) return;
  if (commandBusy || !connected || !stateRefreshed || lastMessageAt === null || Date.now() - lastMessageAt > 15000 || !last?.nodes.find((node) => node.uid === selected)?.online) { commands?.message('Device controls wait for a refreshed connection and sensor state.'); return; }
  const uid = selected; commandBusy = true; renderDetail(); commands?.message(`${uid} · Requested ${body.op}…`);
  try {
    const res = await fetch(`api/nodes/${encodeURIComponent(selected)}/command`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tm-console': '1' }, body: JSON.stringify(body),
    });
    const j = (await res.json()) as { note?: string; error?: string; receipt?: CommandReceipt };
    if (j.receipt) commands?.show(j.receipt);
    else if (selected === uid) commands?.message(res.ok ? 'Sent — waiting for device. Status unavailable; acknowledgement does not confirm execution or persistence.' : `Failed: ${j.error ?? `HTTP ${res.status}`}`);
  } catch { if (selected === uid) commands?.message('Outcome uncertain. Cannot reach the edge; check device state before sending again.'); }
  finally { commandBusy = false; renderDetail(); }
}

function select(uid: string | null): void {
  if (uid !== selected) liveSource = 'thermal';
  selected = uid;
  commands?.select(uid);
  const params = $('#params');
  delete params.dataset.uid;
  $('#drawer').hidden = !uid;
  $('#sx').classList.toggle('has-drawer', !!uid);
  renderNodes();
  renderThumbs();
  renderDetail();
  if (uid) {
    // Clear the last sensor's picture so its frame never sits under this one's name.
    const big = $<HTMLCanvasElement>('#big');
    big.getContext('2d')?.clearRect(0, 0, big.width, big.height);
    drawBig();
  }
}

function setDrawerTab(tab: 'overview' | 'settings'): void {
  for (const t of ['overview', 'settings'] as const) {
    $(`#tab-${t}`).setAttribute('aria-selected', String(t === tab));
    $(`#pane-${t}`).hidden = t !== tab;
  }
}

/** Per-viewer conveniences only; the page must work when storage throws. */
function remember(key: string, value: string): void {
  try { localStorage.setItem(`tm-sensors.${key}`, value); } catch { /* private window */ }
}
function recall(key: string): string | null {
  try { return localStorage.getItem(`tm-sensors.${key}`); } catch { return null; }
}

function setView(v: 'list' | 'grid'): void {
  view = v;
  remember('view', v);
  $('#view-list').setAttribute('aria-pressed', String(v === 'list'));
  $('#view-grid').setAttribute('aria-pressed', String(v === 'grid'));
  renderNodes();
  renderThumbs();
}

/**
 * Wide screens dock the filters and remember whether they were hidden; a
 * phone opens them over the list, so the same buttons mean "open the
 * overlay" there and closing is never remembered.
 */
function setSide(open: boolean): void {
  const narrow = matchMedia('(max-width: 900px)').matches;
  const sx = $('#sx');
  if (narrow) sx.classList.toggle('side-open', open);
  else {
    sx.classList.toggle('side-hidden', !open);
    remember('side', open ? 'shown' : 'hidden');
  }
  $('#side-open').hidden = narrow ? false : open;
}

function initChrome(): void {
  if (recall('view') === 'grid') view = 'grid';
  setView(view);
  // A phone starts on the list; the docked sidebar's remembered state is a
  // desktop preference and must not open an overlay over everything.
  const narrow = matchMedia('(max-width: 900px)');
  const restore = () => setSide(!narrow.matches && recall('side') !== 'hidden');
  restore();
  narrow.addEventListener('change', () => {
    $('#sx').classList.remove('side-open');
    restore();
  });
  $('#side-collapse').addEventListener('click', () => setSide(false));
  $('#side-open').addEventListener('click', () => setSide(true));
  $('#view-list').addEventListener('click', () => setView('list'));
  $('#view-grid').addEventListener('click', () => setView('grid'));
  $<HTMLInputElement>('#q').addEventListener('input', (e) => {
    query = (e.target as HTMLInputElement).value.trim().toLowerCase();
    renderNodes();
    renderThumbs();
  });
  $('#clear-filters').addEventListener('click', () => {
    filters.clear();
    query = '';
    $<HTMLInputElement>('#q').value = '';
    renderFilters(true);
    renderNodes();
    renderThumbs();
  });
  $('#drawer-close').addEventListener('click', () => select(null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected && !($('#join-dialog') as HTMLDialogElement).open) select(null);
  });
  $('#tab-overview').addEventListener('click', () => setDrawerTab('overview'));
  $('#tab-settings').addEventListener('click', () => setDrawerTab('settings'));
  $('#src-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
    liveSource = b.dataset.src === 'rgb' ? 'rgb' : 'thermal';
    drawBig();
  }));
  $('#mode-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode === 'diff' ? 'diff' : 'temp';
    drawBig();
  }));
  $('#t-overlay').addEventListener('change', drawBig);
}

/** The header names the edge this page is talking to, and nothing more. */
function renderEdge(): void {
  if (!last) return;
  const h = last.health;
  $('#edge-id').textContent = `${h.edgeId} · v${h.version}`;
}

// --- wiring ---------------------------------------------------------------------------

async function connect(): Promise<void> {
  if (disposed) return;
  const conn = $('#conn');
  try {
    const { token } = (await (await fetch('api/ws-token')).json()) as { token: string };
    // Relative to the page: /ws on CONSOLE_PORT, /console-app/ws inside the
    // algo console, which hosts this page under that prefix.
    const wsUrl = new URL(`ws?token=${encodeURIComponent(token)}`, location.href);
    wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsUrl);
    liveSocket = ws;
    ws.onopen = () => {
      stateRefreshed = false;
      connected = true; conn.textContent = 'Connected';
      conn.className = 'chip good';
    };
    ws.onmessage = (e) => {
      if (disposed || liveSocket !== ws) return;
      lastMessageAt = Date.now();
      const msg = JSON.parse(String(e.data)) as { type: string } & Record<string, unknown>;
      if (msg.type === 'state') {
        stateRefreshed = true;
        last = msg as unknown as StateMsg;
        // Every online node's RAW, plus the RGB rigs (their RGB is sent to
        // subscribers only). The node being inspected and the real hardware go
        // first: if the edge ever truncates the list, it must not be the node
        // someone is actually looking at that goes blank.
        const sim = new Set(layout?.nodes.filter((n) => n.simulated).map((n) => n.uid));
        const online = last.nodes.filter((n) => n.online).map((n) => n.uid);
        const uids = [...new Set([
          ...(selected ? [selected] : []),
          ...online.filter((u) => !sim.has(u)),
          ...online,
        ])];
        ws.send(JSON.stringify({ type: 'subscribe', uids }));
        renderEdge();
        renderFilters(false);
        renderNodes();
        renderThumbs();
        renderDetail();
      } else if (msg.type === 'join_request') {
        queueJoin((msg as unknown as { request: JoinRequest }).request);
      } else if (msg.type === 'join_resolved') {
        dropJoin((msg as unknown as { id: string }).id);
      } else if (msg.type === 'report') {
        const m = msg as unknown as { uid: string; at: number; dets: ConsoleDetection[] };
        dets.set(m.uid, { at: Date.now(), dets: m.dets });
        if (m.uid === selected) renderDets();
      } else if (msg.type === 'raw') {
        const raw = msg as unknown as RawFrameMessage;
        raws.set(raw.uid, raw);
        drawThumb(raw);
      } else if (msg.type === 'rgb') {
        const m = msg as unknown as { uid: string; at: number; jpeg: string };
        const prev = rgbFrames.get(m.uid);
        const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(m.jpeg), (ch) => ch.charCodeAt(0))], { type: 'image/jpeg' }));
        rgbFrames.set(m.uid, { at: m.at, url });
        showRgb(m.uid, url);
        if (prev) URL.revokeObjectURL(prev.url);
        if (m.uid === selected) renderLiveMeta();
      }
    };
    ws.onclose = () => {
      connected = false; stateRefreshed = false; conn.textContent = 'Reconnecting'; renderDetail();
      conn.className = 'chip bad';
      if (!disposed) reconnectTimer = setTimeout(() => void connect(), 2000);
    };
  } catch {
    connected = false; stateRefreshed = false; conn.textContent = 'Disconnected';
    conn.className = 'chip bad';
    if (!disposed) reconnectTimer = setTimeout(() => void connect(), 3000);
  }
}

async function start(): Promise<void> {
  commands = new CommandStatus($('#cmd-result')); $('#refresh-command-status').addEventListener('click', () => commands?.refresh());
  const freshnessTimer = setInterval(() => {
    const freshness = $('#data-freshness');
    freshness.textContent = lastMessageAt === null ? 'No device data received.' : `${connected && stateRefreshed && Date.now() - lastMessageAt < 15000 ? 'Live messages current' : 'Last known data — messages stale or disconnected'} · Last message ${new Date(lastMessageAt).toLocaleTimeString()}`;
    renderDetail();
  }, 1000);
  window.addEventListener('pagehide', () => { disposed = true; commands?.dispose(); clearInterval(freshnessTimer); clearTimeout(reconnectTimer); liveSocket?.close(); });
  const identity = await fetch('api/me');
  if (!identity.ok) throw new Error('Access information is unavailable.');
  const me = await identity.json() as { capabilities?: string[] };
  if (!Array.isArray(me.capabilities)) throw new Error('Access information is unavailable.');
  capabilities = me.capabilities;
  const message = document.createElement('p'); message.className = 'console-access-notice'; message.setAttribute('role', 'status');
  message.textContent = can('nodes.admin') ? '' : can('nodes.write') ? 'Engineer or admin access required for firmware and provisioning.' : 'Read-only access. An operator or engineer can change parameters and run training.';
  document.body.prepend(message);
  document.querySelectorAll<HTMLButtonElement>('#controls button[data-op]').forEach((button) => { button.disabled = !can(button.dataset.op === 'reboot' ? 'nodes.admin' : 'nodes.write'); });
  for (const id of ['#join-approve', '#join-deny']) { const button = document.querySelector<HTMLButtonElement>(id); if (button) button.disabled = !can('nodes.admin'); }
  setInterval(() => { void fetch('api/me').then(async (response) => { if (response.status === 401) { capabilities = []; location.reload(); return; } if (response.ok) { const current = await response.json() as { capabilities: string[] }; if (JSON.stringify(current.capabilities) !== JSON.stringify(capabilities)) location.reload(); } }).catch(() => { capabilities = []; }); }, 15000);
  layout = (await (await fetch('api/layout')).json()) as Layout;
  const hasFirmware = !!document.querySelector('#firmware');
  if (hasFirmware && can('firmware.write')) initFirmware();
  initJoin();
  // Requests that arrived while nobody had the console open are still
  // waiting; a live WS event is not the only way one gets answered.
  try {
    const j = (await (await fetch('api/provision/requests')).json()) as { requests: JoinRequest[] };
    for (const r of j.requests) queueJoin(r);
  } catch {
    /* provisioning is optional; the rest of the console works without it */
  }
  initChrome();
  document.querySelectorAll<HTMLButtonElement>('#controls button[data-op]').forEach((b) => b.addEventListener('click', () => {
    const op = b.dataset.op ?? '';
    if (op === 'reboot' && !confirm('Reboot this node?')) return;
    void command({ op, ...(op === 'identify' ? { value: 10 } : {}) });
  }));
  await connect();
  // Ages and the LIVE tag go stale between messages; a sensor that stops
  // sending must visibly stop being live.
  setInterval(() => {
    if (!selected) return;
    renderLiveMeta();
    renderDets();
  }, 1000);
  // The rollout targets are the nodes and floors this console already knows.
  if (hasFirmware) setInterval(() => {
    if (!layout || !last) return;
    setFirmwareTargets({
      floors: layout.floors.map((f) => ({ id: f.id, name: f.name })),
      nodes: last.nodes.filter((n) => n.registered).map((n) => ({ uid: n.uid, label: n.label, floorId: n.floorId, online: n.online })),
    });
  }, 2000);
}

void start().catch(() => {
  $('#conn').textContent = 'cannot load console — reload to retry';
  $('#conn').className = 'chip bad';
});
