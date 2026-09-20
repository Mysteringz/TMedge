/**
 * The Firmware panel: upload a TMsense PlatformIO folder, build it on the
 * edge, and roll the image out to one node, one floor, or everything.
 *
 * A rollout is deliberately not a single button that flashes twenty ceilings
 * at once: one node goes first, and the rest only follow once it reports the
 * new image and a working sensor. The panel shows that happening.
 */

interface Build {
  id: string;
  sha256: string;
  size: number;
  version: string;
  state: string;
  builtAt: number | null;
  files: number;
  error?: string;
}

interface NodeUpdate {
  uid: string;
  label: string;
  state: string;
  percent: number;
  error?: string;
}

interface Rollout {
  id: string;
  buildId: string;
  version: string;
  stage: 'pilot' | 'rest' | 'done' | 'stopped';
  note: string;
  startedAt: number;
  nodes: NodeUpdate[];
}

interface FirmwareView {
  pio: boolean;
  builds: Build[];
  building: { startedAt: number; log: string[]; error?: string } | null;
  rollout: Rollout | null;
  history: Rollout[];
  diskBytes: number;
}

export interface FirmwareTargets {
  floors: { id: string; name: string }[];
  nodes: { uid: string; label: string; floorId: string | null; online: boolean }[];
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const kb = (n: number) => `${Math.round(n / 1024)} kB`;
const post = (url: string, body?: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'x-tm-console': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let view: FirmwareView | null = null;
let targets: FirmwareTargets = { floors: [], nodes: [] };
let uploading = false;

export function setFirmwareTargets(next: FirmwareTargets): void {
  targets = next;
  renderTargets();
}

export async function refreshFirmware(): Promise<void> {
  const res = await fetch('/api/firmware');
  if (!res.ok) return;
  view = (await res.json()) as FirmwareView;
  render();
}

function renderTargets(): void {
  const sel = $<HTMLSelectElement>('#fw-target');
  const keep = sel.value;
  const options: { value: string; label: string }[] = [{ value: 'all', label: `Every node (${targets.nodes.filter((n) => n.online).length} online)` }];
  for (const f of targets.floors) {
    const n = targets.nodes.filter((x) => x.floorId === f.id && x.online).length;
    options.push({ value: `floor:${f.id}`, label: `${f.name} — ${n} node${n === 1 ? '' : 's'}` });
  }
  for (const n of targets.nodes) {
    options.push({ value: `node:${n.uid}`, label: `${n.label} (${n.uid})${n.online ? '' : ' — offline'}` });
  }
  sel.replaceChildren(...options.map((o) => new Option(o.label, o.value)));
  if (options.some((o) => o.value === keep)) sel.value = keep;
  updatePlan();
}

function targetFromSelect(): { kind: 'all' } | { kind: 'floor'; floorId: string } | { kind: 'node'; uid: string } {
  const v = $<HTMLSelectElement>('#fw-target').value;
  if (v.startsWith('floor:')) return { kind: 'floor', floorId: v.slice(6) };
  if (v.startsWith('node:')) return { kind: 'node', uid: v.slice(5) };
  return { kind: 'all' };
}

function updatePlan(): void {
  const t = targetFromSelect();
  const online = targets.nodes.filter((n) => n.online);
  const chosen = t.kind === 'all' ? online : t.kind === 'floor' ? online.filter((n) => n.floorId === t.floorId) : online.filter((n) => n.uid === t.uid);
  const pilot = chosen[0];
  $('#fw-plan').textContent = chosen.length === 0
    ? 'No node online matches that target.'
    : chosen.length === 1
      ? `${chosen[0]?.label} only.`
      : `${pilot?.label} goes first. The other ${chosen.length - 1} follow only if it comes back healthy.`;
  const running = view?.rollout && view.rollout.stage !== 'done' && view.rollout.stage !== 'stopped';
  $<HTMLButtonElement>('#fw-start').disabled = chosen.length === 0 || !$<HTMLSelectElement>('#fw-build-pick').value || !!running || uploading;
}

function render(): void {
  if (!view) return;
  const sub = view.pio
    ? `${view.builds.length} image${view.builds.length === 1 ? '' : 's'} · ${kb(view.diskBytes)} on disk`
    : 'PlatformIO is not installed on this edge — uploads can be stored but not built';
  $('#fw-sub').textContent = sub;

  // builds
  const rows = view.builds.map((b) => `<tr><td>${b.version}</td><td class="muted">${b.id}</td><td>${kb(b.size)}</td>` +
    `<td class="muted">${b.builtAt ? new Date(b.builtAt).toLocaleString() : '—'}</td></tr>`).join('');
  $('#fw-builds').innerHTML = rows
    ? `<tr><th>Version</th><th>Image</th><th>Size</th><th>Built</th></tr>${rows}`
    : '<tr><td class="muted">No images yet.</td></tr>';

  const pick = $<HTMLSelectElement>('#fw-build-pick');
  const keep = pick.value;
  pick.replaceChildren(...view.builds.map((b) => new Option(`${b.version} · ${b.id} · ${kb(b.size)}`, b.id)));
  if (view.builds.some((b) => b.id === keep)) pick.value = keep;

  // build in progress
  const building = view.building;
  $('#fw-build-state').textContent = building
    ? (building.error ? `build failed: ${building.error}` : `building… ${Math.round((Date.now() - building.startedAt) / 1000)}s`)
    : '';
  if (building) $('#fw-log').textContent = building.log.join('\n');
  $<HTMLButtonElement>('#fw-build').disabled = uploading || !!building && !building.error
    || !$<HTMLInputElement>('#fw-folder').files?.length;

  // rollout
  const r = view.rollout;
  const running = !!r && r.stage !== 'done' && r.stage !== 'stopped';
  $('#fw-cancel').hidden = !running;
  const box = $('#fw-progress');
  if (!r) {
    box.replaceChildren();
  } else {
    const head = document.createElement('p');
    head.className = 'muted small';
    head.textContent = `${r.version} → ${r.nodes.length} node${r.nodes.length === 1 ? '' : 's'} · ${r.stage} · ${r.note}`;
    const items = r.nodes.map((n) => {
      const el = document.createElement('div');
      el.className = 'fw-node';
      const name = document.createElement('span');
      name.textContent = n.label;
      const state = document.createElement('span');
      state.className = `state${n.state === 'failed' ? ' bad' : n.state === 'confirmed' ? ' good' : ''}`;
      state.textContent = n.error ? `${n.state} — ${n.error}` : n.state;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = `${n.state === 'confirmed' ? 100 : n.percent}%`;
      bar.appendChild(fill);
      el.append(name, state, bar);
      return el;
    });
    box.replaceChildren(head, ...items);
  }
  updatePlan();
}

/** Upload the chosen folder one file at a time, then ask the edge to build. */
async function uploadAndBuild(): Promise<void> {
  const input = $<HTMLInputElement>('#fw-folder');
  const files = [...(input.files ?? [])].filter((f) => !/(^|\/)(\.pio|\.git|node_modules)\//.test(f.webkitRelativePath || f.name));
  if (files.length === 0) return;
  uploading = true;
  render();
  const log = $('#fw-log');
  log.textContent = `uploading ${files.length} files…`;
  try {
    const started = await (await post('/api/firmware/uploads')).json() as { uploadId: string };
    let done = 0;
    for (const file of files) {
      const path = file.webkitRelativePath || file.name;
      const res = await fetch(`/api/firmware/uploads/${started.uploadId}/files?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'x-tm-console': '1', 'content-type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        // A file the edge will not take (a build artefact, something outside
        // the project) is skipped rather than failing the whole upload.
        log.textContent = `skipped ${path}: ${err.error ?? res.status}`;
        continue;
      }
      done += 1;
      if (done % 10 === 0 || done === files.length) log.textContent = `uploaded ${done}/${files.length} files…`;
    }
    const build = await post(`/api/firmware/uploads/${started.uploadId}/build`);
    if (!build.ok) {
      const err = (await build.json()) as { error?: string };
      log.textContent = `build refused: ${err.error ?? build.status}`;
    } else {
      log.textContent = 'building on the edge — this takes a few minutes…';
    }
  } catch (err) {
    log.textContent = `upload failed: ${(err as Error).message}`;
  } finally {
    uploading = false;
    await refreshFirmware();
  }
}

export function initFirmware(): void {
  $('#fw-folder').addEventListener('change', () => render());
  $('#fw-build').addEventListener('click', () => void uploadAndBuild());
  $('#fw-target').addEventListener('change', updatePlan);
  $('#fw-build-pick').addEventListener('change', updatePlan);
  $('#fw-start').addEventListener('click', () => {
    const buildId = $<HTMLSelectElement>('#fw-build-pick').value;
    const target = targetFromSelect();
    const what = target.kind === 'all' ? 'every node' : target.kind === 'floor' ? 'this floor' : 'this node';
    if (!confirm(`Update ${what} to ${buildId}?\n\nOne node goes first; the rest follow only if it comes back healthy.`)) return;
    void post('/api/firmware/rollout', { buildId, target }).then(async (res) => {
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        alert(`Could not start: ${err.error ?? res.status}`);
      }
      await refreshFirmware();
    });
  });
  $('#fw-cancel').addEventListener('click', () => {
    if (!confirm('Stop the rollout? Nodes already flashing will finish.')) return;
    void post('/api/firmware/rollout/cancel').then(() => refreshFirmware());
  });
  void refreshFirmware();
  setInterval(() => void refreshFirmware(), 2000);
}
