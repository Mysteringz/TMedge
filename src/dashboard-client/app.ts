/**
 * HKUMySeat — the student portal. No framework, no bundler: compiled by tsc
 * and served static. Live updates over a WebSocket, falling back to polling.
 *
 * Three screens after sign-in: search (where, and how many of you), spaces
 * (which room fits), live view (which table, with a 3D map and directions).
 *
 * Unknown is never drawn as free. A table whose sensor is down, or a whole
 * floor whose edge has gone quiet, is shown hatched and "No data", is never
 * allocated, and is left out of every count. Sending a group to a table
 * nobody can see is the failure that would cost this system its credibility.
 */
import { allocate, floorIsDark, gridPosition, knownFree, largestTableFree, walkOrder, type Allocation } from '../shared/allocate.js';
import { spaceInfo, VENUES, type Venue } from '../shared/venues.js';
import type { CampusFloor, CampusView, TableState } from '../shared/types.js';

const MAX_SEATS = 16;

type Screen = 'search' | 'spaces' | 'live';

interface State {
  view: CampusView | null;
  screen: Screen;
  seats: number;
  venueId: string | null;
  floorId: string | null;
  showRoute: boolean;
  warn: boolean;
  connection: 'connecting' | 'live' | 'offline';
  lastMessageAt: number;
}

const state: State = {
  view: null,
  screen: 'search',
  seats: 4,
  venueId: null,
  floorId: null,
  showRoute: false,
  warn: false,
  connection: 'connecting',
  lastMessageAt: 0,
};

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

// --- tiny DOM helper -------------------------------------------------------
// Text always goes in as text, never as markup: names and copy from the
// server are data, not HTML.

type Child = Node | string | null | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (v === false) continue;
    // The page's CSP has no 'unsafe-inline' for styles, so a style attribute
    // would be dropped on the floor; the CSSOM is not restricted.
    else if (k === 'style') el.style.cssText = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// --- data helpers ----------------------------------------------------------

function floorsOf(venue: Venue): CampusFloor[] {
  const floors = state.view?.floors ?? [];
  // The venue lists the floor ids it owns; anything the edge publishes that
  // no venue claims still shows up, so a new floor is never invisible.
  return floors.filter((f) => venue.floorIds.includes(f.id));
}

function unclaimedFloors(): CampusFloor[] {
  const claimed = new Set(VENUES.flatMap((v) => v.floorIds));
  return (state.view?.floors ?? []).filter((f) => !claimed.has(f.id));
}

/** Venues, with the live ones first; a venue with no floors online is closed. */
function venues(): { venue: Venue; floors: CampusFloor[]; open: boolean }[] {
  const out = VENUES.map((venue) => {
    const floors = floorsOf(venue);
    return { venue, floors, open: venue.open && floors.length > 0 };
  });
  const extra = unclaimedFloors();
  if (extra.length > 0) {
    out.unshift({
      venue: {
        id: 'other', name: extra[0]?.building ?? 'Other spaces', kicker: 'Campus',
        photo: '', caption: '', floorIds: extra.map((f) => f.id), open: true, entrance: 'Follow the signs to the study area.',
      },
      floors: extra,
      open: true,
    });
  }
  return out;
}

function currentVenue(): { venue: Venue; floors: CampusFloor[]; open: boolean } | null {
  return venues().find((v) => v.venue.id === state.venueId) ?? null;
}

function currentFloor(): CampusFloor | null {
  return (state.view?.floors ?? []).find((f) => f.id === state.floorId) ?? null;
}

/** A floor we cannot see right now: stale edge, or every table unknown. */
function isDark(floor: CampusFloor): boolean {
  return floor.stale || floorIsDark(floor);
}

function allocationFor(floor: CampusFloor): Allocation | null {
  return isDark(floor) ? null : allocate(floor, state.seats);
}

function unknownTables(floor: CampusFloor): TableState[] {
  return floor.tables.filter((t) => t.status === 'unknown' || t.free === null);
}

function capacityOf(floor: CampusFloor): number {
  return Math.max(0, ...floor.tables.map((t) => t.capacity));
}

const searchSummary = (): string => {
  const v = currentVenue();
  return v ? `${plural(state.seats, 'seat')} · ${v.venue.name}` : 'Select a location to continue';
};

// --- navigation ------------------------------------------------------------

function go(screen: Screen, opts: { floorId?: string; push?: boolean } = {}): void {
  state.screen = screen;
  if (opts.floorId) state.floorId = opts.floorId;
  if (screen !== 'live') state.showRoute = false;
  const path = screen === 'search' ? '/search' : screen === 'spaces' ? '/spaces' : `/spaces/${state.floorId ?? ''}`;
  if (opts.push !== false && location.pathname !== path) history.pushState(null, '', path);
  render(true);
}

function readRoute(): void {
  const m = /^\/spaces\/(.+)$/.exec(location.pathname);
  if (m?.[1]) {
    state.floorId = decodeURIComponent(m[1]);
    const floor = currentFloor();
    state.venueId ??= venues().find((v) => v.floors.some((f) => f.id === state.floorId))?.venue.id ?? null;
    state.screen = floor ? 'live' : 'spaces';
  } else if (location.pathname === '/spaces' && state.venueId) {
    state.screen = 'spaces';
  } else {
    state.screen = 'search';
  }
}

// --- chrome ----------------------------------------------------------------

function renderChrome(): void {
  $('#crumb').textContent = state.screen === 'search' ? 'Search' : state.screen === 'spaces' ? 'Available spaces' : 'Live view';
  const live = $('#live');
  const floor = currentFloor();
  const clock = new Date(state.lastMessageAt || Date.now());
  const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`;
  let status: string;
  let text: string;
  if (state.connection === 'offline') {
    status = 'offline';
    text = 'Reconnecting…';
  } else if (!state.view) {
    status = 'connecting';
    text = 'Connecting…';
  } else if (floor?.stale || (state.screen !== 'search' && (currentVenue()?.floors ?? []).every(isDark) && (currentVenue()?.floors.length ?? 0) > 0)) {
    status = 'stale';
    text = 'Sensors offline';
  } else {
    status = 'live';
    text = `Live · ${hhmm}`;
  }
  live.dataset.state = status;
  $('#live-text').textContent = text;
}

// --- screen: search --------------------------------------------------------

function screenSearch(): HTMLElement {
  const all = venues();
  const picked = currentVenue();
  const root = h('div', { class: 'screen' });

  root.append(
    h('div', { class: 'screen-head' },
      h('h1', {}, 'Find a seat'),
      h('span', { class: 'note text-muted' }, 'Step 1 of 2 — choose where, and for how many')),
    h('hr', { class: 'hr' }));

  if (picked && picked.venue.photo) {
    const free = picked.floors.reduce((sum, f) => sum + (isDark(f) ? 0 : knownFree(f)), 0);
    const anyDark = picked.floors.some(isDark);
    root.append(h('figure', { class: 'venue-photo' },
      h('img', { class: 'grayscale', src: picked.venue.photo, alt: picked.venue.name }),
      h('figcaption', { class: 'text-muted' },
        h('span', {}, picked.venue.caption),
        h('span', {}, anyDark && free === 0 ? 'Live data unavailable' : `${free} seats free now`))));
  }

  root.append(h('div', { class: 'section-label' }, 'Location'));
  const tiles = h('div', { class: 'venues' });
  for (const v of all) {
    const selected = state.venueId === v.venue.id;
    const meta = !v.open
      ? (v.venue.open ? 'Sensors offline' : 'Sensors coming soon')
      : `${plural(v.floors.length, 'public space')} · ${plural(v.floors.reduce((n, f) => n + f.tables.length, 0), 'table')}`;
    tiles.append(h('button', {
      type: 'button',
      class: 'venue',
      'aria-pressed': String(selected),
      disabled: !v.open,
      onclick: () => {
        state.venueId = v.venue.id;
        state.warn = false;
        render(true);
      },
    },
      h('span', { class: 'kicker' }, v.venue.kicker),
      h('span', { class: 'vname' }, v.venue.name),
      h('span', { class: selected ? 'meta' : 'meta text-muted' }, selected ? `Selected · ${meta}` : meta)));
  }
  root.append(tiles);

  root.append(h('div', { class: 'section-label' }, 'Seats needed'));
  root.append(h('div', { class: 'seatrow' },
    h('div', { class: 'stepper' },
      h('button', { type: 'button', 'aria-label': 'One fewer seat', onclick: () => setSeats(state.seats - 1) }, '−'),
      h('div', { class: 'value', 'aria-live': 'polite' }, String(state.seats)),
      h('button', { type: 'button', 'aria-label': 'One more seat', onclick: () => setSeats(state.seats + 1) }, '+')),
    h('div', { class: 'quick' },
      h('span', { class: 'text-muted' }, 'Quick pick'),
      h('div', { class: 'chips' }, ...[1, 2, 4, 6, 8].map((n) =>
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => setSeats(n) }, String(n))))),
    h('div', { class: 'seathint text-muted' }, 'We only return seats that sit together — one table, or tables side by side.')));

  root.append(h('hr', { class: 'hr' }));
  if (state.warn && !picked) {
    root.append(h('div', { class: 'alert', role: 'alert' },
      h('span', { class: 'badge' }, '!'),
      h('span', { class: 'text' }, 'Please select the location before searching.')));
  }
  root.append(h('div', { class: 'actions' },
    h('button', {
      type: 'button', class: 'btn btn-primary btn-cta',
      onclick: () => {
        if (!currentVenue()) {
          state.warn = true;
          render(true);
          return;
        }
        state.warn = false;
        go('spaces');
      },
    }, 'Search'),
    h('span', { class: 'text-muted' }, searchSummary())));
  return root;
}

function setSeats(n: number): void {
  state.seats = Math.min(MAX_SEATS, Math.max(1, n));
  render(true);
}

// --- screen: spaces --------------------------------------------------------

function screenSpaces(): HTMLElement {
  const picked = currentVenue();
  const root = h('div', { class: 'screen' });
  root.append(h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => go('search') }, '← Change search'));
  if (!picked) {
    root.append(h('p', { class: 'text-muted' }, 'Choose a location first.'));
    return root;
  }
  root.append(
    h('div', { class: 'screen-head' },
      h('h1', {}, picked.venue.name),
      h('span', { class: 'note text-muted' }, searchSummary())),
    h('hr', { class: 'hr' }));

  const cards = h('div', { class: 'spaces' });
  let anyFits = false;
  for (const floor of picked.floors) {
    const info = spaceInfo(floor.id);
    const dark = isDark(floor);
    const alloc = allocationFor(floor);
    const free = knownFree(floor);
    const cap = capacityOf(floor);
    if (alloc) anyFits = true;

    const head = h('div', { class: 'space-head' },
      h('div', {},
        h('div', { class: 'floor' }, info.floorLabel || floor.building),
        h('div', { class: 'sname' }, floor.name)),
      h('div', { class: 'count' },
        h('div', { class: 'n' }, dark ? '—' : String(free)),
        h('div', { class: 'k text-muted' }, 'Free seats')));

    const body = h('div', { class: 'space-body' });
    if (dark) {
      body.append(
        h('div', { class: 'flag flag-no' },
          h('div', { class: 'k' }, 'No live data'),
          h('div', { class: 'h' }, 'Sensors offline')),
        h('p', { class: 'detail text-muted' },
          'Nobody is counting this space at the moment, so no seats are offered. Nothing here is shown as free.'));
    } else if (alloc) {
      body.append(
        h('div', { class: 'flag flag-yes' },
          h('div', { class: 'k' }, 'Available'),
          h('div', { class: 'h' }, `${alloc.label} — ${plural(state.seats, 'seat')} together`)),
        h('p', { class: 'detail text-muted' },
          `${cap}-seat tables · ${plural(alloc.shares.length, 'table')} for your group, nearest the entrance.`));
    } else {
      body.append(
        h('div', { class: 'flag flag-no' },
          h('div', { class: 'k' }, 'No space available'),
          h('div', { class: 'h' }, `No block of ${state.seats} adjacent seats`)),
        h('p', { class: 'detail text-muted' },
          `${plural(free, 'seat')} free here but scattered — the largest single table has ${largestTableFree(floor)} free of ${cap}.`));
    }
    const unknown = unknownTables(floor);
    if (!dark && unknown.length > 0) {
      body.append(h('p', { class: 'detail text-muted' },
        `${plural(unknown.length, 'table')} here have no working sensor and are never counted as free.`));
    }
    body.append(h('div', { class: 'spacer' }));
    body.append(h('button', {
      type: 'button',
      class: alloc ? 'btn btn-primary' : 'btn btn-secondary',
      onclick: () => go('live', { floorId: floor.id }),
    }, alloc ? 'Inspect live view →' : 'View floor anyway'));
    cards.append(h('div', { class: 'space' }, head, body));
  }
  root.append(cards);
  if (picked.floors.length === 0) {
    root.append(h('p', { class: 'text-muted' }, 'No sensed spaces are online in this venue right now.'));
  }
  root.append(h('p', { class: 'results-note text-muted' }, anyFits
    ? 'Availability is recalculated every time the sensors report. Tables are not held, so head over now — the live view keeps updating while you walk.'
    : 'Nothing fits right now. Try a smaller group, or check back after the hour when classes change over.'));
  return root;
}

// --- screen: live ----------------------------------------------------------

let viewer: (HTMLElement & { resetView?: () => void; zoomToSeat?: () => void }) | null = null;

function screenLive(): HTMLElement {
  const floor = currentFloor();
  const root = h('div', { class: 'screen' });
  root.append(h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => go('spaces') }, '← Back to spaces'));
  if (!floor) {
    root.append(h('p', { class: 'text-muted' }, 'That space is not online.'));
    return root;
  }
  const info = spaceInfo(floor.id);
  const venue = currentVenue()?.venue ?? null;
  const dark = isDark(floor);
  const alloc = allocationFor(floor);
  const free = knownFree(floor);
  const cap = capacityOf(floor);
  const ordered = walkOrder(floor.tables);
  const mine = new Map((alloc?.shares ?? []).map((s) => [s.tableId, s.take]));

  root.append(
    h('div', { class: 'screen-head' },
      h('h1', {}, floor.name),
      h('span', { class: 'note text-muted' },
        [info.floorLabel || floor.building, 'live view', searchSummary()].filter(Boolean).join(' · '))),
    h('hr', { class: 'hr' }));

  // Assignment
  if (alloc) {
    root.append(h('div', { class: 'assign' },
      h('div', {},
        h('div', { class: 'k' }, 'Your assignment'),
        h('div', { class: 'h' }, `Sit at ${alloc.label}`)),
      h('div', { class: 'side' },
        `Walk in — ${alloc.label.toLowerCase()} ${alloc.shares.length === 1 ? 'is' : 'are'} marked in red on the plan below.`)));
  } else if (dark) {
    root.append(h('div', { class: 'assign-no' },
      h('div', { class: 'k' }, 'No live data'),
      h('div', { class: 'h' }, 'Sensors offline for this space'),
      h('div', { class: 'side text-muted' },
        'The plan below shows the room, but every table is unknown until the sensors report again. None of them is shown as free.')));
  } else {
    root.append(h('div', { class: 'assign-no' },
      h('div', { class: 'k' }, 'No assignment'),
      h('div', { class: 'h' }, `No adjacent block for ${plural(state.seats, 'seat')}`),
      h('div', { class: 'side text-muted' },
        `${plural(free, 'seat')} free but scattered across the floor. Reduce the group size or try another space.`)));
  }

  // 3D map
  if (info.model) {
    const grid = info.model;
    const index = (id: string) => ordered.findIndex((t) => t.id === id) + 1;
    if (!viewer) viewer = document.createElement('floor-viewer');
    viewer.setAttribute('src', grid.src);
    viewer.setAttribute('room', grid.room);
    viewer.setAttribute('columns', String(grid.columns));
    viewer.setAttribute('rows', String(grid.rows));
    viewer.setAttribute('highlight', (alloc?.shares ?? []).map((s) => index(s.tableId)).join(','));
    viewer.setAttribute('occupied', ordered.map((t, i) => (t.free === 0 && t.status !== 'unknown' ? i + 1 : 0)).filter(Boolean).join(','));
    viewer.setAttribute('dark', ordered.map((t, i) => (t.status === 'unknown' || t.free === null ? i + 1 : 0)).filter(Boolean).join(','));
    viewer.style.width = '100%';
    viewer.style.height = '100%';
    root.append(h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('div', { class: 'panel-title' }, '3D map — drag to rotate, scroll to zoom'),
        h('div', { class: 'panel-tools' },
          h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => viewer?.zoomToSeat?.() }, 'Zoom to my table'),
          h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => viewer?.resetView?.() }, 'Reset view'))),
      h('div', { class: 'viewport' }, viewer),
      h('div', { class: 'caption text-muted' },
        `Red pin and disc mark your table inside ${floor.name}; grey discs are occupied tables, outlined discs are free, faint discs have no sensor data. Model: ${venue?.name ?? floor.building}, ${info.floorLabel || floor.name}.`)));
  }

  // 2D plan
  const columns = gridPosition(floor.tables, ordered[0]?.id ?? '')?.columns ?? 5;
  const plan = h('div', { class: 'plan', style: `grid-template-columns: repeat(${columns}, minmax(0, 1fr))` });
  for (const t of ordered) {
    const take = mine.get(t.id);
    const unknown = t.status === 'unknown' || t.free === null;
    const cls = take ? 'cell cell-mine' : unknown ? 'cell cell-dark' : t.free === 0 ? 'cell cell-full' : 'cell';
    const meta = take ? `${take} of yours` : unknown ? 'No data' : t.free === 0 ? 'Occupied' : `${t.free} of ${t.capacity} free`;
    plan.append(h('div', { class: cls },
      h('div', { class: 't' }, t.name),
      h('div', { class: take ? 'm' : 'm text-muted' }, meta)));
  }
  const unknown = unknownTables(floor);
  root.append(h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('div', { class: 'panel-title' }, 'Floor plan — top-down'),
      h('div', { class: 'legend' },
        h('span', {}, h('i', { class: 'mine' }), 'Yours'),
        h('span', {}, h('i', { class: 'free' }), 'Free'),
        h('span', {}, h('i', { class: 'full' }), 'Occupied'),
        h('span', {}, h('i', { class: 'dark' }), 'No data'))),
    plan,
    h('div', { class: 'plan-foot' },
      h('span', { class: 'text-muted' }, `↑ ${info.entranceNote} Sensor data ${floor.stale ? 'last seen' : 'refreshed'} ${new Date(floor.updatedAt).toLocaleTimeString()}.`),
      h('span', { class: 'text-muted' }, dark
        ? 'No live counts for this space'
        : `${free} of ${floor.totals.seats} seats free · ${cap} seats per table${unknown.length > 0 ? ` · ${plural(unknown.length, 'table')} without data` : ''}`))));

  // Directions
  if (alloc && state.showRoute) {
    const steps = directions(floor, alloc, venue);
    root.append(h('div', { class: 'route' },
      h('div', { class: 'route-head' },
        h('h2', {}, `Directions to ${alloc.label}`),
        h('span', { class: 'meta text-muted' },
          `${floor.name} · ${info.floorLabel || floor.building} · about ${info.walkMinutes} min walk from the entrance`)),
      h('div', { class: 'steps' }, ...steps.map((t, i) =>
        h('div', { class: 'step' }, h('span', { class: 'n' }, String(i + 1)), h('span', { class: 't' }, t))))));
  }

  const actions = h('div', { class: 'live-actions' });
  if (alloc && !state.showRoute) {
    actions.append(h('button', {
      type: 'button', class: 'btn btn-primary',
      onclick: () => {
        state.showRoute = true;
        render(true);
      },
    }, 'Find my seat — get directions'));
  }
  actions.append(h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => go('search') }, 'New search'));
  root.append(actions);
  return root;
}

/** The walk from the building entrance to the assigned table. */
function directions(floor: CampusFloor, alloc: Allocation, venue: Venue | null): string[] {
  const info = spaceInfo(floor.id);
  const first = alloc.shares[0];
  const pos = first ? gridPosition(floor.tables, first.tableId) : null;
  const rowText = !pos || pos.rows < 2
    ? 'into the room'
    : pos.row === 0 ? 'to the first row of tables' : 'to the far row at the back of the room';
  const side = !pos
    ? ''
    : pos.column < pos.columns / 3 ? ' — towards the left-hand wall'
      : pos.column < (pos.columns * 2) / 3 ? ' — in the middle of the row'
        : ' — towards the right-hand windows';
  return [
    venue?.entrance || 'Enter the building and follow the signs to the study area.',
    info.approach,
    `From the doorway, walk ${rowText}.`,
    `${alloc.label}${side}, marked red on the plan.`,
  ];
}

// --- render ----------------------------------------------------------------

let lastKey = '';

/** What the current screen actually shows: re-render only when it changes. */
function screenKey(): string {
  const floor = currentFloor();
  const relevant = state.screen === 'live' && floor
    ? [floor.id, floor.stale, floor.updatedAt, floor.tables.map((t) => `${t.id}:${t.status}:${t.free}`).join()]
    : (currentVenue()?.floors ?? []).map((f) => `${f.id}:${f.stale}:${knownFree(f)}:${f.tables.map((t) => t.free ?? 'u').join()}`);
  return JSON.stringify([state.screen, state.seats, state.venueId, state.floorId, state.showRoute, state.warn,
    (state.view?.floors ?? []).map((f) => f.id), relevant]);
}

function render(force = false): void {
  renderChrome();
  const key = screenKey();
  if (!force && key === lastKey) return;
  lastKey = key;
  const host = $('#screen');
  const next = state.screen === 'search' ? screenSearch() : state.screen === 'spaces' ? screenSpaces() : screenLive();
  host.replaceChildren(next);
}

// --- data ------------------------------------------------------------------

function accept(view: CampusView): void {
  state.view = view;
  state.lastMessageAt = Date.now();
  // A floor can vanish (its edge went away): fall back rather than show a
  // dead screen.
  if (state.screen === 'live' && !currentFloor()) state.screen = 'spaces';
  render();
}

let retry = 1000;
function connect(): void {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    state.connection = 'live';
    retry = 1000;
    renderChrome();
  };
  ws.onmessage = (e) => accept(JSON.parse(String(e.data)) as CampusView);
  ws.onclose = () => {
    state.connection = 'offline';
    renderChrome();
    // Session expired: the upgrade is refused, and the page must go to login.
    fetch('/api/me').then((r) => {
      if (r.status === 401) location.href = '/login';
    }).catch(() => undefined);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30_000);
  };
}

async function start(): Promise<void> {
  const me = await fetch('/api/me');
  if (me.status === 401) {
    location.href = '/login';
    return;
  }
  const who = (await me.json()) as { name?: string; email?: string };
  $('#user-name').textContent = who.name ?? who.email ?? '';

  const res = await fetch('/api/occupancy');
  if (res.ok) {
    state.view = (await res.json()) as CampusView;
    state.lastMessageAt = Date.now();
  }
  readRoute();
  render(true);
  window.addEventListener('popstate', () => {
    readRoute();
    render(true);
  });
  connect();
  // The "Live · HH:MM" clock and the age of the data keep ticking between pushes.
  setInterval(renderChrome, 10_000);
}

void start();
