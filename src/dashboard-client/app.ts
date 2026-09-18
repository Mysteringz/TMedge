/**
 * Student dashboard. No framework, no bundler: compiled by tsc and served
 * static. Live updates over a WebSocket, falling back to polling.
 *
 * Unknown is never drawn as free: tables with no working sensor are hatched
 * grey, their seats dashed, and they are left out of every free-seat count.
 */
import { findGroup, searchSeats } from '../shared/seats.js';
import type { CampusFloor, CampusView, SeatSuggestion, TableState } from '../shared/types.js';

const SVG = 'http://www.w3.org/2000/svg';
const $ = <T extends Element = HTMLElement>(sel: string) => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

interface State {
  view: CampusView | null;
  floorId: string | null;
  group: number;
  picked: SeatSuggestion | null;
  selectedTable: string | null;
  lastMessageAt: number;
  connection: 'connecting' | 'live' | 'offline';
}

const state: State = {
  view: null,
  floorId: new URLSearchParams(location.search).get('floor'),
  group: 2,
  picked: null,
  selectedTable: null,
  lastMessageAt: 0,
  connection: 'connecting',
};

function currentFloor(): CampusFloor | null {
  const floors = state.view?.floors ?? [];
  return floors.find((f) => f.id === state.floorId) ?? floors[0] ?? null;
}

function level(t: TableState): 'free' | 'mid' | 'full' | 'unknown' {
  if (t.status === 'unknown' || t.occupied === null) return 'unknown';
  const share = t.occupied / t.capacity;
  if (share >= 1) return 'full';
  return share <= 1 / 3 ? 'free' : 'mid';
}

function busyness(share: number): { label: string; cls: string } {
  if (share < 0.34) return { label: 'Quiet', cls: 'quiet' };
  if (share < 0.67) return { label: 'Moderate', cls: 'moderate' };
  return { label: 'Busy', cls: 'busy' };
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

// --- rendering -----------------------------------------------------------------

function renderFloorPicker(): void {
  const select = $<HTMLSelectElement>('#floor');
  const floors = state.view?.floors ?? [];
  const key = floors.map((f) => f.id).join('|');
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.replaceChildren(...floors.map((f) => new Option(`${f.building} — ${f.name}`, f.id)));
  }
  const f = currentFloor();
  if (f) select.value = f.id;
}

function renderOverview(f: CampusFloor): void {
  const t = f.totals;
  const known = t.seats - t.unknownSeats;
  $('#s-free').innerHTML = known > 0 ? `${t.free}<small> of ${known}</small>` : '–';
  $('#s-tables').textContent = known > 0 ? String(t.tablesFullyFree) : '–';
  const share = known > 0 ? t.occupied / known : 0;
  $('#s-busy').textContent = known > 0 ? `${Math.round(share * 100)}%` : '–';
  $('#s-busy-bar').style.width = `${Math.round(share * 100)}%`;
  const people = f.zones.reduce<number | null>((a, z) => (a === null || z.people === null ? null : a + z.people), 0);
  $('#s-people').textContent = people === null ? '–' : String(people);

  const banner = $('#banner');
  if (f.stale) {
    banner.hidden = false;
    banner.textContent = 'We have lost contact with the sensors for this space. Seat availability is unknown until they reconnect.';
  } else if (t.unknownSeats > 0) {
    banner.hidden = false;
    const n = f.tables.filter((x) => x.status === 'unknown').length;
    banner.textContent = `${n} table${n === 1 ? '' : 's'} (${t.unknownSeats} seats) have no working sensor right now and are shown in grey. They are not counted as free.`;
  } else {
    banner.hidden = true;
  }
}

function renderPlan(f: CampusFloor): void {
  const svg = $<SVGSVGElement>('#plan');
  const xs = f.outline.map((p) => p[0]);
  const ys = f.outline.map((p) => p[1]);
  const pad = 30;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  svg.setAttribute('viewBox', `${minX} ${minY} ${Math.max(...xs) - minX + pad} ${Math.max(...ys) - minY + pad}`);
  const focused = focusedTable(svg);
  svg.replaceChildren();

  const defs = el('defs', {}, svg);
  const hatch = el('pattern', { id: 'hatch', width: 14, height: 14, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('rect', { width: 14, height: 14, class: 'hatch-bg' }, hatch);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 14, class: 'hatch-line' }, hatch);

  el('polygon', { class: 'room', points: f.outline.map((p) => p.join(',')).join(' ') }, svg);
  for (const z of f.zones) {
    const zx = Math.min(...z.polygon.map((p) => p[0]));
    const zy = Math.min(...z.polygon.map((p) => p[1]));
    el('text', { class: 'zone-label', x: zx + 14, y: zy + 30 }, svg).textContent = z.name.toUpperCase();
  }

  const picked = new Set(state.picked?.floorId === f.id ? state.picked.seatIds : []);
  for (const t of f.tables) {
    const lvl = level(t);
    const g = el('g', { class: `table lvl-${lvl}${state.selectedTable === t.id ? ' selected' : ''}`, tabindex: 0, role: 'button', 'data-table': t.id }, svg);
    const label = t.status === 'unknown' || t.free === null ? `${t.name}: no data` : `${t.name}: ${t.free} of ${t.capacity} seats free`;
    g.setAttribute('aria-label', label);
    el('title', {}, g).textContent = label;
    const { x, y, width: w, height: h } = t.rect;
    el('rect', { class: 'top', x, y, width: w, height: h, rx: 10 }, g);
    const cx = x + w / 2;
    el('text', { class: 't-name', x: cx, y: y + h / 2 - 6 }, g).textContent = t.name;
    el('text', { class: 't-free', x: cx, y: y + h / 2 + 22 }, g).textContent =
      t.free === null ? 'no data' : t.free === 0 ? 'full' : `${t.free} free`;
    // How full, as a bar along the table: precise at a glance, and not colour alone.
    if (t.occupied !== null) {
      const bw = w - 24;
      el('rect', { class: 't-bar-bg', x: x + 12, y: y + h - 22, width: bw, height: 9, rx: 4.5 }, g);
      el('rect', { class: 't-bar', x: x + 12, y: y + h - 22, width: (bw * t.occupied) / t.capacity, height: 9, rx: 4.5 }, g);
    }
    for (const s of t.seats) {
      const cls = s.occupied === null ? 'unknown' : s.occupied ? 'taken' : 'free';
      el('circle', { class: `seat ${cls}${picked.has(s.id) ? ' pick' : ''}`, cx: s.x, cy: s.y, r: 17 }, g);
    }
    const select = () => {
      state.selectedTable = state.selectedTable === t.id ? null : t.id;
      render();
    };
    g.addEventListener('click', select);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });
  }
  restoreFocus(svg, focused);
}

// The plan and the table list are rebuilt on every update (every 2 s); without
// this a keyboard user's focus would be thrown back to the top of the page.
function focusedTable(container: Element): string | null {
  const a = document.activeElement;
  return a && container.contains(a) ? a.getAttribute('data-table') : null;
}

function restoreFocus(container: Element, id: string | null): void {
  if (id) container.querySelector<HTMLElement | SVGElement>(`[data-table="${CSS.escape(id)}"]`)?.focus();
}

function renderSearch(f: CampusFloor): void {
  $('#group-size').textContent = `${state.group} ${state.group === 1 ? 'person' : 'people'}`;
  $<HTMLButtonElement>('#group-dec').disabled = state.group <= 1;
  $<HTMLButtonElement>('#group-inc').disabled = state.group >= 12;

  const results = searchSeats([f], state.group).slice(0, 6);
  // Keep the suggestion the student picked if it still fits; otherwise drop it.
  if (state.picked) {
    const still = results.find((r) => r.tableIds.join() === state.picked?.tableIds.join());
    state.picked = still ?? null;
  }
  const list = $('#results');
  list.replaceChildren(...results.map((r) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'result';
    b.setAttribute('aria-pressed', String(state.picked?.tableIds.join() === r.tableIds.join()));
    const busy = busyness(r.busyness);
    const where = r.tableIds.length > 1 ? 'Two neighbouring tables' : r.seatIds.length > 1 ? 'Seats next to each other' : 'Free seat';
    b.innerHTML = `<span class="result-title"></span><span class="badge ${busy.cls}">${busy.label}</span><span class="result-meta"></span>`;
    (b.querySelector('.result-title') as HTMLElement).textContent = `Table ${r.tableName}`;
    (b.querySelector('.result-meta') as HTMLElement).textContent = `${where} · ${r.freeAtTable} of ${r.capacity} free`;
    b.addEventListener('click', () => {
      state.picked = state.picked?.tableIds.join() === r.tableIds.join() ? null : r;
      state.selectedTable = state.picked ? (r.tableIds[0] ?? null) : null;
      render();
      if (state.picked && window.matchMedia('(max-width: 980px)').matches) {
        $('#plan').scrollIntoView({ behavior: 'smooth', block: 'center' });
        // On a phone the plan scrolls sideways too: bring the suggested table into view.
        document.querySelector(`#plan [data-table="${CSS.escape(r.tableIds[0] ?? '')}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    });
    li.appendChild(b);
    return li;
  }));
  const empty = $('#results-empty');
  empty.hidden = results.length > 0;
  empty.textContent = f.totals.unknownSeats === f.totals.seats
    ? 'No live data for this space right now.'
    : `No table has ${state.group} free seats together right now. Try a smaller group, or check back soon.`;
}

function renderDetail(f: CampusFloor): void {
  const box = $('#detail');
  const t = f.tables.find((x) => x.id === state.selectedTable);
  if (!t) {
    box.hidden = true;
    $('#plan-hint').textContent = 'Select a table for details';
    return;
  }
  box.hidden = false;
  const h = document.createElement('h3');
  h.textContent = `Table ${t.name}`;
  const p = document.createElement('p');
  if (t.status === 'unknown' || t.free === null || t.occupied === null) {
    p.textContent = 'No sensor data for this table right now.';
  } else {
    const together = findGroup(t, Math.max(1, t.free));
    p.textContent = `${t.free} of ${t.capacity} seats free` +
      (t.free > 1 && together ? ` — all ${t.free} together` : t.free > 1 ? ' — not all together' : '') +
      (t.status === 'fallback' ? '. Counted by a neighbouring sensor.' : '.');
  }
  box.replaceChildren(h, p);
  $('#plan-hint').textContent = `Table ${t.name} selected`;
}

function renderTables(f: CampusFloor): void {
  const wrap = $('#tables');
  const focused = focusedTable(wrap);
  wrap.replaceChildren(...f.tables.map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.table = t.id;
    b.className = `tcard lvl-${level(t)}${state.selectedTable === t.id ? ' selected' : ''}`;
    const top = document.createElement('div');
    top.className = 'tcard-top';
    const name = document.createElement('span');
    name.className = 'tcard-name';
    name.textContent = t.name;
    const free = document.createElement('span');
    free.className = 'tcard-free';
    free.textContent = t.free === null ? 'no data' : t.free === 0 ? 'full' : `${t.free}/${t.capacity} free`;
    top.append(name, free);
    const dots = document.createElement('div');
    dots.className = 'seatdots';
    dots.setAttribute('aria-hidden', 'true');
    for (const s of t.seats) {
      const d = document.createElement('i');
      d.className = `dot ${s.occupied === null ? 'unknown' : s.occupied ? 'taken' : 'free'}`;
      dots.appendChild(d);
    }
    b.append(top, dots);
    b.setAttribute('aria-label', t.free === null ? `${t.name}, no data` : `${t.name}, ${t.free} of ${t.capacity} free`);
    b.addEventListener('click', () => {
      state.selectedTable = state.selectedTable === t.id ? null : t.id;
      render();
    });
    return b;
  }));
  restoreFocus(wrap, focused);
  const free = f.tables.filter((t) => t.free !== null && t.free > 0).length;
  $('#tables-hint').textContent = `${free} of ${f.tables.length} with a free seat`;
}

function renderLive(): void {
  const live = $('#live');
  const f = currentFloor();
  const age = Math.max(0, Math.round((Date.now() - (f?.updatedAt ?? state.lastMessageAt)) / 1000));
  let s: string;
  let text: string;
  if (state.connection === 'offline') {
    s = 'offline';
    text = 'Reconnecting…';
  } else if (!f) {
    s = 'connecting';
    text = state.view ? 'No study spaces online' : 'Connecting…';
  } else if (f.stale) {
    s = 'stale';
    text = 'Sensors offline';
  } else {
    s = 'live';
    text = age <= 3 ? 'Live' : `Updated ${age}s ago`;
  }
  live.dataset.state = s;
  $('#live-text').textContent = text;
}

function render(): void {
  renderFloorPicker();
  renderLive();
  const f = currentFloor();
  if (!f) return;
  renderOverview(f);
  renderPlan(f);
  renderSearch(f);
  renderDetail(f);
  renderTables(f);
}

// --- data ------------------------------------------------------------------------

function accept(view: CampusView): void {
  state.view = view;
  state.lastMessageAt = Date.now();
  render();
}

let retry = 1000;
function connect(): void {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    state.connection = 'live';
    retry = 1000;
    renderLive();
  };
  ws.onmessage = (e) => accept(JSON.parse(String(e.data)) as CampusView);
  ws.onclose = () => {
    state.connection = 'offline';
    renderLive();
    // Session expired: the upgrade is refused, and the page must go to login.
    fetch('/api/me').then((r) => {
      if (r.status === 401) location.href = '/login';
    }).catch(() => undefined);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30_000);
  };
}

function bindControls(): void {
  $<HTMLSelectElement>('#floor').addEventListener('change', (e) => {
    state.floorId = (e.target as HTMLSelectElement).value;
    state.picked = null;
    state.selectedTable = null;
    const url = new URL(location.href);
    url.searchParams.set('floor', state.floorId);
    history.replaceState(null, '', url);
    render();
  });
  $('#group-dec').addEventListener('click', () => {
    state.group = Math.max(1, state.group - 1);
    state.picked = null;
    render();
  });
  $('#group-inc').addEventListener('click', () => {
    state.group = Math.min(12, state.group + 1);
    state.picked = null;
    render();
  });
}

async function start(): Promise<void> {
  bindControls();
  const me = await fetch('/api/me');
  if (me.status === 401) {
    location.href = '/login';
    return;
  }
  const who = (await me.json()) as { name?: string; email?: string };
  $('#user-name').textContent = who.name ?? who.email ?? '';
  const res = await fetch('/api/occupancy');
  if (res.ok) accept((await res.json()) as CampusView);
  connect();
  setInterval(renderLive, 1000);
}

void start();
