/**
 * TMedge debug console (admin only). Shows every node's raw thermal frames,
 * where each detection lands on the floor and whether it was counted, node and
 * edge health, and sends commands to nodes.
 */
import type { ConsoleDetection, EdgeHealth, NodeHealth, NodePose, OccupancySnapshot, Point, RawFrameMessage } from '../shared/types.js';

const SVG = 'http://www.w3.org/2000/svg';
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
  nodes: { uid: string; label: string; floorId: string; pose: NodePose; owns: string[]; simulated: boolean; rgb: boolean; footprint: Point[] }[];
}

interface Dwell { cellCm: number; cols: number; rows: number; max: number; cells: number[] }

interface StateMsg {
  health: EdgeHealth;
  nodes: NodeHealth[];
  snapshot: OccupancySnapshot;
  authorities: Record<string, { authority: string | null; status: string }>;
  dwell: Record<string, Dwell>;
}

let layout: Layout | null = null;
let last: StateMsg | null = null;
let selected: string | null = null;
const dets = new Map<string, { at: number; dets: ConsoleDetection[] }>();
const raws = new Map<string, RawFrameMessage>();
const backgrounds = new Map<string, Float32Array>();
let mode: 'temp' | 'diff' = 'temp';
let floorTab: string | null = null;
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

// --- fusion view -----------------------------------------------------------------

function svgEl<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function renderFusion(): void {
  if (!layout || !last) return;
  const floor = layout.floors.find((f) => f.id === floorTab) ?? layout.floors[0];
  if (!floor) return;
  renderTabs(floor.id);
  const svg = $<SVGSVGElement>('#fusion');
  const pad = 40;
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${floor.width + 2 * pad} ${floor.height + 2 * pad}`);
  svg.replaceChildren();

  if (($<HTMLInputElement>('#t-dwell')).checked) {
    const d = last.dwell[floor.id];
    if (d && d.max > 0) {
      for (let r = 0; r < d.rows; r++) {
        for (let c = 0; c < d.cols; c++) {
          const v = d.cells[r * d.cols + c] ?? 0;
          if (v <= d.max * 0.02) continue;
          const [R, G, B] = inferno(0.25 + 0.75 * Math.sqrt(v / d.max));
          svgEl('rect', { x: c * d.cellCm, y: r * d.cellCm, width: d.cellCm, height: d.cellCm, fill: `rgb(${R | 0},${G | 0},${B | 0})`, 'fill-opacity': 0.55 }, svg);
        }
      }
    }
  }

  svgEl('polygon', { class: 'room', points: floor.outline.map((p) => p.join(',')).join(' ') }, svg);
  const tables = last.snapshot.floors.find((f) => f.id === floor.id)?.tables ?? [];
  for (const t of floor.tables) {
    const st = last.authorities[t.id]?.status ?? 'unknown';
    svgEl('rect', { class: `tbl ${st}`, x: t.rect.x, y: t.rect.y, width: t.rect.width, height: t.rect.height, rx: 8 }, svg);
    const live = tables.find((x) => x.id === t.id);
    // Label at the top edge: the node marker sits at the table's centre.
    svgEl('text', { class: 'tlabel', x: t.rect.x + t.rect.width / 2, y: t.rect.y + 28 }, svg).textContent =
      `${t.name} ${live?.occupied ?? '?'}/${live?.capacity ?? '?'}`;
    for (const s of live?.seats ?? []) svgEl('circle', { class: `seat${s.occupied ? ' taken' : ''}`, cx: s.x, cy: s.y, r: 15 }, svg);
  }

  const online = new Set(last.nodes.filter((n) => n.online).map((n) => n.uid));
  if (($<HTMLInputElement>('#t-footprints')).checked) {
    for (const n of layout.nodes) {
      if (n.floorId !== floor.id) continue;
      svgEl('polygon', { class: `fp${n.uid === selected ? ' sel' : ''}`, points: n.footprint.map((p) => p.join(',')).join(' ') }, svg);
    }
  } else if (selected) {
    const n = layout.nodes.find((x) => x.uid === selected);
    if (n) svgEl('polygon', { class: 'fp sel', points: n.footprint.map((p) => p.join(',')).join(' ') }, svg);
  }

  if (($<HTMLInputElement>('#t-dets')).checked) {
    const now = Date.now();
    // Each node's detections are in its own floor's plan coordinates: never draw them on another floor.
    const here = new Set(layout.nodes.filter((n) => n.floorId === floor.id).map((n) => n.uid));
    for (const [uid, d] of dets) {
      if (now - d.at > 3000 || !here.has(uid)) continue;
      for (const x of d.dets) {
        if (!Number.isFinite(x.floorX)) continue;
        const c = svgEl('circle', { class: `det ${x.counted ? 'counted' : 'ignored'}`, cx: x.floorX, cy: x.floorY, r: x.counted ? 13 : 18 }, svg);
        svgEl('title', {}, c).textContent = `${uid}: +${x.contrast.toFixed(1)} C, heat ${x.heat.toFixed(1)}, ${x.counted ? 'counted' : 'not counted'}`;
      }
    }
  }

  for (const n of layout.nodes) {
    if (n.floorId !== floor.id) continue;
    const c = svgEl('rect', { class: `node${online.has(n.uid) ? '' : ' offline'}${n.uid === selected ? ' sel' : ''}`, x: n.pose.x - 11, y: n.pose.y - 11, width: 22, height: 22, rx: 4 }, svg);
    c.style.cursor = 'pointer';
    c.addEventListener('click', () => select(n.uid));
    svgEl('title', {}, c).textContent = `${n.label} (${n.uid}) h=${n.pose.heightCm} cm`;
  }
}

function renderTabs(active: string): void {
  if (!layout) return;
  const wrap = $('#floor-tabs');
  if (wrap.childElementCount !== layout.floors.length) {
    wrap.replaceChildren(...layout.floors.map((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.floor = f.id;
      b.textContent = f.visibility === 'console' ? `${f.name} · console only` : f.name;
      b.addEventListener('click', () => {
        floorTab = f.id;
        const rig = layout?.nodes.find((n) => n.floorId === f.id && n.rgb);
        if (rig) select(rig.uid);
        renderFusion();
        renderDemo();
      });
      return b;
    }));
  }
  wrap.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.floor === active)));
}

/** The RGB + thermal pair, shown only on a floor that has an RGB verification rig. */
function renderDemo(): void {
  if (!layout) return;
  const floorId = floorTab ?? layout.floors[0]?.id;
  const rig = layout.nodes.find((n) => n.floorId === floorId && n.rgb);
  const box = $('#demo');
  box.hidden = !rig;
  if (!rig) return;
  $('#demo-title').textContent = rig.label;
  $('#demo-sub').textContent = `${rig.uid} · h=${rig.pose.heightCm} cm${rig.pose.mirror ? ' · mirrored' : ''}`;
  const f = rgbFrames.get(rig.uid);
  $('#demo-rgb-age').textContent = f ? `· ${fmtAge(f.at)}` : '· waiting for the rig';
  const raw = raws.get(rig.uid);
  const d = dets.get(rig.uid)?.dets ?? [];
  $('#demo-blobs').textContent = String(d.length);
  if (raw) {
    // Draw mirrored when the rig is mounted mirrored, so the two images line up.
    const c = $<HTMLCanvasElement>('#demo-thermal');
    const flipped = rig.pose.mirror
      ? { ...raw, pixels: raw.pixels.map((_, i) => raw.pixels[Math.floor(i / 32) * 32 + (31 - (i % 32))] ?? 0) }
      : raw;
    const flippedDets = rig.pose.mirror ? d.map((x) => ({ ...x, x: 32 - x.x })) : d;
    drawThermal(c, flipped, flippedDets, true);
  }
}

// --- panels -------------------------------------------------------------------------

function fmtAge(ms: number | null): string {
  if (ms === null) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

function metric(label: string, value: string, cls = ''): string {
  return `<div class="metric ${cls}"><b>${value}</b><span>${label}</span></div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderHealth(): void {
  if (!last) return;
  const h = last.health;
  const online = last.nodes.filter((n) => n.online).length;
  const reg = last.nodes.filter((n) => n.registered).length;
  const pub = h.publish.every((p) => p.ok);
  $('#edge-id').textContent = `${h.edgeId} · v${h.version} · ${h.platform} · node ${h.node}`;
  $('#health').innerHTML = [
    metric('nodes online', `${online}/${reg}`, online === reg ? 'good' : online === 0 ? 'bad' : 'warn'),
    metric('packets / s', h.packetsPerSec.toFixed(1)),
    metric('ingress', `${(h.bytesPerSec / 1024).toFixed(1)} kB/s`),
    metric('rejected / min', h.rejectedPerMin.toFixed(0), h.rejectedPerMin > 0 ? 'warn' : ''),
    metric('event loop p99', `${h.eventLoopLagMs} ms`, h.eventLoopLagMs > 100 ? 'bad' : ''),
    metric('memory', `${h.memRssMb} MB`),
    metric('load (1 min)', `${h.cpuLoad1.toFixed(2)} / ${h.cpus}`),
    metric('uptime', `${Math.floor(h.uptimeS / 3600)}h ${Math.floor((h.uptimeS % 3600) / 60)}m`),
    metric('publish', pub ? 'ok' : 'failing', pub ? 'good' : 'bad'),
    metric('recorded today', `${(h.recorder.bytesToday / 1048576).toFixed(1)} MB`),
  ].join('');

  $('#edge-detail').innerHTML = `
    <div><h3>Web tier</h3><ul>${h.publish.map((p) => `<li>${esc(p.target)}: ${p.ok ? 'ok' : `<span style="color:var(--bad)">${esc(p.lastError ?? 'not yet')}</span>`} · last ok ${fmtAge(p.lastOkAt)}</li>`).join('') || '<li>none configured</li>'}</ul></div>
    <div><h3>Rejected packets by reason</h3><ul>${Object.entries(h.rejectReasons).map(([k, v]) => `<li>${esc(k)}: ${v}</li>`).join('') || '<li>none</li>'}</ul></div>
    <div><h3>Rejected sources</h3><ul>${h.unknownSources.map((s) => `<li>${esc(s.address)} ${esc(s.uid ?? '')} ×${s.count} — ${esc(s.reason)} (${fmtAge(s.lastSeen)})</li>`).join('') || '<li>none</li>'}</ul></div>
    <div><h3>Access gateways${h.gatewayPort ? ` (TCP ${h.gatewayPort})` : ' (disabled: no TMGW_TOKEN)'}</h3><ul>${h.gateways.map((g) => `<li><b>${esc(g.id)}</b> over ${g.transport === 'websocket' ? 'WebSocket' : 'TCP'} from ${esc(g.remote)} · up ${g.uplink} · down ${g.downlink} · rtt ${g.rttMs ?? '–'} ms · connected ${fmtAge(g.connectedAt)}${g.stats && typeof g.stats.nodes === 'number' ? ` · ${g.stats.nodes} local node(s)` : ''}</li>`).join('') || '<li>none connected</li>'}</ul></div>
    <div><h3>Ingest</h3><ul><li>UDP ${esc(String(h.udp.iface))}:${h.udp.port}</li><li>recording to ${esc(h.recorder.dir)}${h.recorder.rawEnabled ? ' (with raw)' : ''}</li><li>host ${esc(h.hostname)}, ${h.sysFreeMb}/${h.sysTotalMb} MB free</li></ul></div>`;
}

function renderNodes(): void {
  if (!last) return;
  const rows = last.nodes.map((n) => {
    const s = n.status;
    const auth = Object.entries(last?.authorities ?? {}).filter(([, a]) => a.authority === n.uid).map(([t]) => t).join(' ');
    return `<tr data-uid="${n.uid}" class="${n.uid === selected ? 'sel' : ''}">
      <td><span class="dotc ${n.online ? 'on' : ''}"></span>${esc(n.label)}</td>
      <td>${n.uid}</td><td>${n.fps.toFixed(2)}</td><td>${(n.lossRate * 100).toFixed(1)}%</td>
      <td>${n.lastPeople ?? '–'}</td><td>${auth || '–'}</td>
      <td>${n.backgroundReady ? (n.globalShift ? 'shift' : 'ready') : 'learning'}</td>
      <td>${n.sceneMin?.toFixed(1) ?? '–'}–${n.sceneMax?.toFixed(1) ?? '–'} °C</td>
      <td>${s ? `${s.rssi} dBm` : '–'}</td><td>${s ? `${(s.heap / 1024).toFixed(0)} kB` : '–'}</td>
      <td>${s?.fw ?? '–'}</td><td>${n.lastSeen === null ? '–' : n.signed ? 'signed' : '<b style="color:var(--bad)">UNSIGNED</b>'}</td>
      <td>${n.address ?? '–'}</td><td>${fmtAge(n.lastSeen)}</td></tr>`;
  }).join('');
  $('#nodes').innerHTML = `<thead><tr><th>Node</th><th>MAC</th><th>fps</th><th>loss</th><th>blobs</th><th>counting</th><th>background</th><th>scene</th><th>RSSI</th><th>heap</th><th>firmware</th><th>auth</th><th>address</th><th>last seen</th></tr></thead><tbody>${rows}</tbody>`;
  $('#nodes').querySelectorAll('tr[data-uid]').forEach((tr) => tr.addEventListener('click', () => select(tr.getAttribute('data-uid'))));
  $('#nodes-sub').textContent = `${last.nodes.filter((n) => !n.registered).length} unregistered`;
}

function renderThumbs(): void {
  if (!last) return;
  const wrap = $('#thumbs');
  for (const n of last.nodes) {
    let card = wrap.querySelector<HTMLElement>(`[data-uid="${n.uid}"]`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'thumb';
      card.dataset.uid = n.uid;
      card.innerHTML = `<canvas width="192" height="144"></canvas><div class="cap"><span class="name"></span><span class="info"></span></div>`;
      card.addEventListener('click', () => select(n.uid));
      wrap.appendChild(card);
    }
    card.classList.toggle('sel', n.uid === selected);
    (card.querySelector('.name') as HTMLElement).textContent = n.label;
    const raw = raws.get(n.uid);
    (card.querySelector('.info') as HTMLElement).textContent = raw ? `${n.lastPeople ?? 0} blob(s) · ${fmtAge(raw.receivedAt)}` : n.online ? 'no RAW (raw_every=0?)' : 'offline';

    // Verification rigs also get an RGB tile, right after their thermal one.
    // Only nodes flagged "rgb" in nodes.json ever have one.
    if (layout?.nodes.some((x) => x.uid === n.uid && x.rgb)) {
      let rgbCard = wrap.querySelector<HTMLElement>(`[data-rgb-uid="${n.uid}"]`);
      if (!rgbCard) {
        rgbCard = document.createElement('div');
        rgbCard.className = 'thumb rgb';
        rgbCard.dataset.rgbUid = n.uid;
        rgbCard.innerHTML = `<img alt="Live RGB camera"><div class="cap"><span class="name"></span><span class="info"></span></div>`;
        rgbCard.addEventListener('click', () => select(n.uid));
        card.after(rgbCard);
      }
      rgbCard.classList.toggle('sel', n.uid === selected);
      (rgbCard.querySelector('.name') as HTMLElement).textContent = `${n.label} · RGB`;
      const f = rgbFrames.get(n.uid);
      (rgbCard.querySelector('.info') as HTMLElement).textContent = f ? fmtAge(f.at) : 'waiting for camera';
    }
  }
}

/** Show the latest RGB frame everywhere it appears: grid tile, detail panel, demo tab. */
function showRgb(uid: string, url: string): void {
  const tile = document.querySelector<HTMLImageElement>(`#thumbs [data-rgb-uid="${uid}"] img`);
  if (tile) tile.src = url;
  if (uid === selected) $<HTMLImageElement>('#rgb-detail-img').src = url;
  const rig = layout?.nodes.find((n) => n.uid === uid);
  if (rig && rig.floorId === (floorTab ?? layout?.floors[0]?.id)) $<HTMLImageElement>('#demo-rgb').src = url;
}

function drawThumb(raw: RawFrameMessage): void {
  const canvas = document.querySelector<HTMLCanvasElement>(`#thumbs [data-uid="${raw.uid}"] canvas`);
  if (canvas) drawThermal(canvas, raw, dets.get(raw.uid)?.dets ?? null, false);
  if (raw.uid === selected) drawBig();
}

function drawBig(): void {
  if (!selected) return;
  const raw = raws.get(selected);
  if (!raw) return;
  const overlay = ($<HTMLInputElement>('#t-overlay')).checked ? dets.get(selected)?.dets ?? [] : null;
  const [lo, hi] = drawThermal($<HTMLCanvasElement>('#big'), raw, overlay, true);
  $('#scale-lo').textContent = `${lo.toFixed(1)} °C`;
  $('#scale-hi').textContent = `${hi.toFixed(1)} °C`;
}

function renderDetail(): void {
  const n = last?.nodes.find((x) => x.uid === selected);
  if (!n) return;
  $('#detail-title').textContent = n.label;
  const isRig = layout?.nodes.some((x) => x.uid === n.uid && x.rgb) ?? false;
  $('#rgb-detail').hidden = !isRig;
  const f = isRig ? rgbFrames.get(n.uid) : undefined;
  if (f) $<HTMLImageElement>('#rgb-detail-img').src = f.url;
  $('#detail-sub').textContent = `${n.uid}${n.pose ? ` · h=${n.pose.heightCm} cm` : ''}`;
  const s = n.status;
  const rows: [string, string][] = [
    ['online', n.online ? 'yes' : 'NO'],
    ['owns', n.owns.join(', ') || '–'],
    ['frames/s · loss', `${n.fps.toFixed(2)} · ${(n.lossRate * 100).toFixed(1)}%`],
    ['reports · raws · rejected', `${n.reports} · ${n.raws} · ${n.rejected}`],
    ['boot', String(n.boot ?? '–')],
    ['sensor Ta', n.ta !== null ? `${n.ta.toFixed(1)} °C` : '–'],
    ['one-person heat', n.refHeat !== null ? `${n.refHeat.toFixed(2)} °C·m²` : 'learning'],
    ['Wi-Fi', s ? `${s.ip} · ${s.rssi} dBm · ch ${s.channel} · drops ${s.wifiDrops}` : '–'],
    ['memory', s ? `heap ${(s.heap / 1024).toFixed(0)} kB (min ${(s.minHeap / 1024).toFixed(0)}) · stack free ${s.stackFree} B` : '–'],
    ['sensor', s ? `Vdd ${s.vdd.toFixed(2)} V · errors ${s.sensorErrors} · frames ${s.frames}` : '–'],
    ['last command applied', s ? (s.lastCmd ? new Date(s.lastCmd * 1000).toLocaleTimeString() : 'none') : '–'],
  ];
  $('#detail-kv').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  const controls = $('#controls');
  // Heard through a local proxy (the RGB rig via userspace Tailscale): there is
  // no route back, so offering commands would only produce errors.
  const proxied = n.address !== null && /^(127\.|::1$|::ffff:127\.)/.test(n.address);
  controls.hidden = !n.online || proxied;
  $('#cmd-result').textContent = proxied ? 'Commands unavailable: this node is reached through a local proxy.' : $('#cmd-result').textContent;
  const params = $('#params');
  if (s && params.dataset.uid !== n.uid) {
    params.dataset.uid = n.uid;
    params.innerHTML = Object.entries(s.params).map(([k, v]) => `<label>${k}<input data-param="${k}" type="number" step="1" value="${v}"></label>`).join('');
    params.querySelectorAll<HTMLInputElement>('input').forEach((inp) => inp.addEventListener('change', () => {
      void command({ op: 'set', param: inp.dataset.param, value: Number(inp.value) });
    }));
  }
}

async function command(body: { op: string; param?: string | undefined; value?: number }): Promise<void> {
  if (!selected) return;
  const res = await fetch(`/api/nodes/${selected}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tm-console': '1' }, body: JSON.stringify(body),
  });
  const j = (await res.json()) as { note?: string; error?: string };
  $('#cmd-result').textContent = res.ok ? `sent ${body.op}${body.param ? ` ${body.param}=${body.value}` : ''} — ${j.note}` : `failed: ${j.error}`;
}

function select(uid: string | null): void {
  selected = uid;
  const params = $('#params');
  delete params.dataset.uid;
  renderNodes();
  renderThumbs();
  renderDetail();
  renderFusion();
  drawBig();
}

// --- wiring ---------------------------------------------------------------------------

async function connect(): Promise<void> {
  const conn = $('#conn');
  try {
    const { token } = (await (await fetch('/api/ws-token')).json()) as { token: string };
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      conn.textContent = 'live';
      conn.className = 'chip good';
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { type: string } & Record<string, unknown>;
      if (msg.type === 'state') {
        last = msg as unknown as StateMsg;
        // Every online node's RAW, plus the RGB rigs (their RGB is sent to subscribers only).
        ws.send(JSON.stringify({ type: 'subscribe', uids: last.nodes.filter((n) => n.online).map((n) => n.uid) }));
        if (!selected) {
          // Default to a real node if one is online: that is usually what someone opening the console is checking.
          const real = new Set(layout?.nodes.filter((n) => !n.simulated).map((n) => n.uid));
          selected = last.nodes.find((n) => n.online && real.has(n.uid))?.uid ?? last.nodes.find((n) => n.online)?.uid ?? null;
        }
        renderHealth();
        renderNodes();
        renderThumbs();
        renderDetail();
        renderFusion();
      } else if (msg.type === 'report') {
        const m = msg as unknown as { uid: string; at: number; dets: ConsoleDetection[] };
        dets.set(m.uid, { at: Date.now(), dets: m.dets });
      } else if (msg.type === 'raw') {
        const raw = msg as unknown as RawFrameMessage;
        raws.set(raw.uid, raw);
        drawThumb(raw);
        if (layout?.nodes.some((n) => n.uid === raw.uid && n.rgb)) renderDemo();
      } else if (msg.type === 'rgb') {
        const m = msg as unknown as { uid: string; at: number; jpeg: string };
        const prev = rgbFrames.get(m.uid);
        const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(m.jpeg), (ch) => ch.charCodeAt(0))], { type: 'image/jpeg' }));
        rgbFrames.set(m.uid, { at: m.at, url });
        showRgb(m.uid, url);
        if (prev) URL.revokeObjectURL(prev.url);
        if (m.uid === selected) $('#rgb-detail-age').textContent = `· ${fmtAge(m.at)}`;
        renderDemo();
      }
    };
    ws.onclose = () => {
      conn.textContent = 'disconnected — retrying';
      conn.className = 'chip bad';
      setTimeout(() => void connect(), 2000);
    };
  } catch {
    conn.textContent = 'cannot reach edge';
    conn.className = 'chip bad';
    setTimeout(() => void connect(), 3000);
  }
}

async function start(): Promise<void> {
  layout = (await (await fetch('/api/layout')).json()) as Layout;
  for (const id of ['#t-footprints', '#t-dwell', '#t-dets']) $(id).addEventListener('change', renderFusion);
  $('#t-overlay').addEventListener('change', drawBig);
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
    mode = r.value === 'diff' ? 'diff' : 'temp';
    drawBig();
  }));
  document.querySelectorAll<HTMLButtonElement>('#controls button[data-op]').forEach((b) => b.addEventListener('click', () => {
    const op = b.dataset.op ?? '';
    if (op === 'reboot' && !confirm('Reboot this node?')) return;
    void command({ op, ...(op === 'identify' ? { value: 10 } : {}) });
  }));
  await connect();
  setInterval(renderFusion, 1000);
}

void start();
