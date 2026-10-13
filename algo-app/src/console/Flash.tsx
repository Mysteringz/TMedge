/**
 * Module 07: TMflash in the browser.
 *
 * What the Mac app does -- write the release firmware, set the node up over
 * its serial console, read the settings back, ask the edge to admit it and
 * watch it come up -- from this page, over the browser's Web Serial, on the
 * board the person picked in the browser's own chooser.
 *
 * Three things to keep in view while reading it:
 * - The board is on *this computer's* USB port. The Wi-Fi password and the
 *   signing key travel from this page to that port: never to the edge, never
 *   to storage, never into the log.
 * - The firmware is the latest release of the TMsense repository on GitHub
 *   (flash/release.ts). There is no way to hand this page some other image.
 * - Nothing is erased. The write plan (src/shared/flasher/images.ts) refuses
 *   anything that would reach the node's saved settings and boot counter.
 * - Admitting the node is still a person's act. The page queues the question
 *   and waits at a button; it never answers for the person at it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useCapability } from '../entities/admin-session/index.tsx';
import {
  FlasherError, NodeConsole, provisionNode,
  type Admission, type NodeInfo, type Provisioned, type ProvisionStage,
} from '../../../src/shared/flasher/node-console.js';
import { EMPTY_SETTINGS, nodeIdProblems, scrub, secretsOf, settingsProblems, type FrameRate, type NodeSettings } from '../../../src/shared/flasher/settings.js';
import { flashApi } from './flash/api.ts';
import { writeFirmware } from './flash/esp.ts';
import { loadRelease, releasePage, type ReleaseBuild } from './flash/release.ts';
import { chooseBoard, describePort, SerialConsole, serialSupported } from './flash/serial.ts';
import './adoption.css';
import './flash.css';

type Uplink = 'gateway' | 'cloud' | 'lora';
type Board =
  | { kind: 'none' }
  | { kind: 'identifying' }
  | { kind: 'tmsense'; info: NodeInfo }
  /** A port, but no TMsense answered on it: a new board, or other firmware. */
  | { kind: 'silent' };

type StepId = 'check' | 'write' | 'boot' | 'settings' | 'admit' | 'wifi' | 'edge';
type StepState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';
interface Step { id: StepId; label: string; state: StepState }
const STEP_OF: Record<ProvisionStage, StepId> = { provisioning: 'settings', 'awaiting-approval': 'admit', 'joining-wifi': 'wifi', 'reaching-edge': 'edge' };
const STATE_WORD: Record<StepState, string> = { waiting: 'Waiting', running: 'In progress', done: 'Done', skipped: 'Not needed', failed: 'Failed' };
const STATE_MARK: Record<StepState, string> = { waiting: '○', running: '◐', done: '✓', skipped: '–', failed: '✕' };

interface Outcome {
  kind: 'ok' | 'check' | 'failed';
  error?: string;
  result?: Provisioned;
  wrote?: string;
}
interface Prompt { id: string; uid: string; code: string; busy: boolean; error: string }

// What is worth not typing twice, and is not a secret. The password and the
// key are deliberately absent: they live in this component's memory and go
// when the page does.
const REMEMBERED = 'tmflash-web:network';
interface Remembered { uplink: Uplink; ssid: string; gateway: string; cloudUrl: string }
function recall(): Partial<Remembered> {
  try { return JSON.parse(localStorage.getItem(REMEMBERED) ?? '{}') as Partial<Remembered>; } catch { return {}; }
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : 'something went wrong';
const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function Flash() {
  const canCommission = useCapability('nodes.admin');
  const supported = serialSupported();
  const remembered = useMemo(recall, []);

  const [port, setPort] = useState<SerialPort | null>(null);
  const [board, setBoard] = useState<Board>({ kind: 'none' });
  const [boardError, setBoardError] = useState('');
  const [build, setBuild] = useState<ReleaseBuild | null>(null);
  const [buildError, setBuildError] = useState('');
  const [fetching, setFetching] = useState(false);
  const [writeImage, setWriteImage] = useState(true);
  const [adopt, setAdopt] = useState(true);

  const [nodeId, setNodeId] = useState('');
  const [uplink, setUplink] = useState<Uplink>(remembered.uplink === 'cloud' || remembered.uplink === 'lora' ? remembered.uplink : 'gateway');
  const [ssid, setSsid] = useState(typeof remembered.ssid === 'string' ? remembered.ssid : '');
  const [password, setPassword] = useState('');
  const [gateway, setGateway] = useState(typeof remembered.gateway === 'string' ? remembered.gateway : '');
  const [cloudUrl, setCloudUrl] = useState(typeof remembered.cloudUrl === 'string' ? remembered.cloudUrl : '');
  const [key, setKey] = useState('');
  const [frameRate, setFrameRate] = useState<FrameRate | null>(null);

  const [steps, setSteps] = useState<Step[]>([]);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const answer = useRef<((admission: Admission) => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // The newest line is the one being waited on.
  const logEnd = useRef<HTMLPreElement>(null);
  useEffect(() => { if (logEnd.current) logEnd.current.scrollTop = logEnd.current.scrollHeight; }, [log]);

  const settings = useMemo<NodeSettings>(() => ({
    ...EMPTY_SETTINGS,
    mode: uplink === 'lora' ? 'lora' : 'wifi',
    transport: uplink === 'cloud' ? 'wss' : 'udp',
    // Fields that do not apply to the chosen uplink are left out of the
    // write, not cleared on the node; what was typed in them is kept here.
    ssid: uplink === 'lora' ? '' : ssid, password: uplink === 'lora' ? '' : password,
    gateway, cloudUrl: uplink === 'cloud' ? cloudUrl : '', key, frameRate,
  }), [uplink, ssid, password, gateway, cloudUrl, key, frameRate]);

  useEffect(() => {
    try { localStorage.setItem(REMEMBERED, JSON.stringify({ uplink, ssid, gateway, cloudUrl } satisfies Remembered)); } catch { /* private window: nothing is remembered, nothing breaks */ }
  }, [uplink, ssid, gateway, cloudUrl]);

  // An unplugged board is not a connected one.
  useEffect(() => {
    if (!supported || !port) return;
    const gone = (event: Event) => {
      if (event.target !== port) return;
      setPort(null); setBoard({ kind: 'none' });
      if (!running) setBoardError('The board was unplugged.');
    };
    navigator.serial.addEventListener('disconnect', gone);
    return () => navigator.serial.removeEventListener('disconnect', gone);
  }, [supported, port, running]);

  const identify = useCallback(async (chosen: SerialPort) => {
    setBoard({ kind: 'identifying' }); setBoardError('');
    let link: SerialConsole | null = null;
    try {
      link = await SerialConsole.open(chosen);
      await link.restart();
      const info = await new NodeConsole(link, () => undefined).waitUntilReady(8000).catch(() => null);
      if (!mounted.current) return;
      setBoard(info ? { kind: 'tmsense', info } : { kind: 'silent' });
      if (info) {
        // The number already on the enclosure is the likeliest one wanted.
        if (info.nodeId) setNodeId((current) => current || String(info.nodeId));
        // Start from how the node is set up now. The uplink is always written,
        // so a default that differed would quietly move an installed node
        // from the cloud to a gateway it has never heard of.
        setUplink(info.mode === 'lora' ? 'lora' : info.transport === 'wss' ? 'cloud' : 'gateway');
      }
    } catch (error) {
      if (!mounted.current) return;
      setPort(null); setBoard({ kind: 'none' }); setBoardError(sentence(errorText(error)));
    } finally {
      await link?.close();
    }
  }, []);

  async function connect() {
    setBoardError('');
    try {
      const chosen = await chooseBoard();
      if (!chosen) return;
      setPort(chosen); setOutcome(null); setSteps([]); setLog([]);
      await identify(chosen);
    } catch (error) {
      setBoardError(sentence(errorText(error)));
    }
  }

  async function disconnect() {
    const current = port;
    setPort(null); setBoard({ kind: 'none' }); setBoardError('');
    // Hands the permission back as well, where the browser can.
    try { await current?.forget?.(); } catch { /* an older browser keeps it until the tab closes */ }
  }

  // The firmware is fetched, never chosen. A release that cannot be read or
  // does not check out leaves nothing to write: the last good one is dropped
  // rather than left on screen looking current.
  const fetchRelease = useCallback(async (signal?: AbortSignal) => {
    setFetching(true); setBuildError('');
    try {
      const latest = await loadRelease(signal);
      if (!signal?.aborted && mounted.current) setBuild(latest);
    } catch (error) {
      if (!signal?.aborted && mounted.current) { setBuild(null); setBuildError(sentence(errorText(error))); }
    } finally {
      if (!signal?.aborted && mounted.current) setFetching(false);
    }
  }, []);
  useEffect(() => {
    if (!supported) return;
    const controller = new AbortController();
    void fetchRelease(controller.signal);
    return () => controller.abort();
  }, [supported, fetchRelease]);

  const known = board.kind === 'tmsense' ? board.info : null;
  const id = /^\d+$/.test(nodeId.trim()) ? Number(nodeId.trim()) : null;
  const problems = useMemo(() => {
    const out: string[] = [];
    if (!port || board.kind === 'identifying' || board.kind === 'none') out.push('Connect a board');
    if (writeImage && !build) out.push(fetching ? 'Wait for the firmware release to load' : 'No firmware release to write: see step 2');
    if (!writeImage && board.kind === 'silent') out.push('This board is not running TMsense: turn on “Write firmware”');
    out.push(...nodeIdProblems(nodeId.trim() === '' ? null : id ?? Number.NaN), ...settingsProblems(settings));
    if (uplink === 'cloud' && !cloudUrl.trim() && !known?.cloudUrl) out.push('Enter the TMedge node URL for direct cloud');
    return out;
  }, [port, board.kind, writeImage, build, fetching, nodeId, id, settings, uplink, cloudUrl, known]);

  const say = useCallback((line: string) => setLog((lines) => [...lines, line].slice(-400)), []);
  const enter = useCallback((next: StepId) => setSteps((list) => list.map((step) =>
    step.id === next ? { ...step, state: 'running' } : step.state === 'running' ? { ...step, state: 'done' } : step)), []);

  // While the page waits at "Admit this board", somebody else may answer in
  // Adoption instead. Either answer ends the wait.
  useEffect(() => {
    if (!prompt) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void flashApi.state(controller.signal).then((state) => {
        if (state.nodes.some((node) => node.uid === prompt.uid)) settle({ state: 'registered' });
        else if (!state.requests.some((request) => request.id === prompt.id)) settle({ state: 'denied' });
      }).catch(() => undefined);   // a missed poll is retried; the buttons still work
    }, 2000);
    return () => { controller.abort(); clearInterval(timer); };
    // Keyed on the request, not on its busy flag: pressing a button must not restart the poll.
  }, [prompt?.id, prompt?.uid]);

  function settle(admission: Admission) {
    const resolve = answer.current;
    answer.current = null;
    setPrompt(null);
    resolve?.(admission);
  }

  async function decide(verdict: 'approve' | 'deny') {
    if (!prompt || prompt.busy) return;
    setPrompt({ ...prompt, busy: true, error: '' });
    try {
      await flashApi.answer(prompt.id, verdict, prompt.uid, prompt.code);
      settle({ state: verdict === 'approve' ? 'registered' : 'denied' });
    } catch (error) {
      setPrompt((current) => current && { ...current, busy: false, error: sentence(errorText(error)) });
    }
  }

  async function run() {
    if (!port || id === null || problems.length > 0 || running) return;
    const chosen = port, plan = writeImage ? build?.plan ?? null : null, applied = settings, asking = adopt;
    const secrets = secretsOf(applied);
    const cloud = applied.mode === 'wifi' && applied.transport === 'wss';
    setSteps(([
      asking && { id: 'check', label: 'Check the console can register a node' },
      plan && { id: 'write', label: `Write ${plan.version}` },
      { id: 'boot', label: 'Wait for the node to start' },
      { id: 'settings', label: 'Write the settings and read them back' },
      asking && { id: 'admit', label: 'Admit the node to TMedge' },
      applied.mode === 'wifi' && { id: 'wifi', label: 'See it join Wi-Fi' },
      cloud && { id: 'edge', label: 'See TMedge accept a report' },
    ] as (false | null | { id: StepId; label: string })[]).flatMap((step) => step ? [{ ...step, state: 'waiting' as StepState }] : []));
    setLog([]); setProgress(0); setOutcome(null); setRunning(true);
    const note = (line: string) => say(scrub(line, secrets));
    let wrote: string | undefined;
    try {
      if (asking) {
        // Before the USB port is touched: a board flashed for an edge that
        // cannot register it is a board somebody has to come back to.
        enter('check');
        if (!(await flashApi.state()).ready) throw new FlasherError('the console cannot keep a new registration right now (persistent node storage is unavailable), so nothing was written to the board');
        note('Console access verified; persistent node registration is ready');
      }
      if (plan) {
        enter('write');
        const mac = await writeFirmware(chosen, plan, { log: note, progress: setProgress });
        wrote = plan.version;
        note(`wrote ${plan.version} to ${mac}`);
      }
      enter('boot');
      const link = await SerialConsole.open(chosen);
      let result: Provisioned;
      try {
        await link.restart();
        result = await provisionNode(link, id, applied, {
          log: note,
          stage: (stage) => enter(STEP_OF[stage]),
          ...(asking ? {
            admit: async (info: NodeInfo): Promise<Admission> => {
              const uid = info.uid;
              if (!uid) return { state: 'failed', reason: 'the node did not report its identity' };
              try {
                // The number this page gave the board. Whoever places the node renames it to where it ends up.
                const asked = await flashApi.ask({ uid, label: `Node ${id}`, firmware: info.firmware });
                if (asked.status === 'registered') { note(`TMedge already knows ${uid}`); return { state: 'registered' }; }
                note(`asked TMedge to admit ${uid} (request code ${asked.pairingCode})`);
                return await new Promise<Admission>((resolve) => {
                  answer.current = resolve;
                  setPrompt({ id: asked.id, uid: asked.uid, code: asked.pairingCode, busy: false, error: '' });
                });
              } catch (error) {
                return { state: 'failed', reason: errorText(error) };
              }
            },
          } : {}),
        });
      } finally {
        await link.close();
      }
      setSteps((list) => list.map((step) => step.state === 'running' ? { ...step, state: 'done' } : step.state === 'waiting' ? { ...step, state: 'skipped' } : step));
      setOutcome({ kind: result.warnings.length > 0 ? 'check' : 'ok', result, wrote });
      setBoard({ kind: 'tmsense', info: result.info });
    } catch (error) {
      const message = scrub(errorText(error), secrets);
      note(`✕ ${message}`);
      setSteps((list) => list.map((step) => step.state === 'running' ? { ...step, state: 'failed' } : step));
      setOutcome({ kind: 'failed', error: message, wrote });
    } finally {
      answer.current = null; setPrompt(null); setRunning(false);
    }
  }

  function another() {
    setOutcome(null); setSteps([]); setLog([]); setProgress(0);
    setPort(null); setBoard({ kind: 'none' });
    // Boards in a row get numbers in a row, as in the Mac app's batch mode.
    if (id !== null && id < 65535) setNodeId(String(id + 1));
  }

  const locked = running || !canCommission;
  const keeps = (value: string | null | undefined) => value ? `keeps ${value}` : 'unchanged if left blank';

  if (!supported) {
    return <main className="cx-adoption cx-flash">
      <h1>TMflash web</h1>
      <section className="dv-panel">
        <h2>This browser cannot reach USB devices</h2>
        <p>Flashing from the web uses Web Serial, which Chrome and Edge have on a computer. Safari, Firefox and phone browsers do not.</p>
        <p className="dv-hint">Open this page in Chrome or Edge on the computer the board is plugged into, or use the TMflash app on a Mac.</p>
      </section>
    </main>;
  }

  return <main className="cx-adoption cx-flash">
    <h1>TMflash web</h1>
    {!canCommission && <p className="dv-hint" role="status">Read-only access. Engineer or Admin access is required to flash and commission devices.</p>}
    <p className="dv-lead">Plug a TMsense board into this computer, choose it, and set it up. The firmware is the latest TMsense release from GitHub. The Wi-Fi password and the signing key go from this page to the board’s USB port, and are never sent to the server.</p>

    <section className="dv-panel" aria-labelledby="fl-board">
      <h2 id="fl-board">1 · Board</h2>
      {board.kind === 'none' && <p>Your browser will ask which USB device this page may use. Only the one you pick becomes reachable, and only until you disconnect it or close the tab.</p>}
      {board.kind === 'identifying' && <p role="status">Asking the board what it runs… this restarts it.</p>}
      {port && board.kind === 'tmsense' && <div className="fl-board" role="status">
        <p><b>{board.info.nodeId ? `TMsense #${board.info.nodeId}` : 'TMsense, no node ID yet'}</b> · <code>{board.info.uid}</code> · {board.info.firmware}</p>
        <dl>
          <div><dt>Uplink</dt><dd>{board.info.mode === 'lora' ? 'LoRa' : board.info.transport === 'wss' ? 'Wi-Fi, direct to cloud' : 'Wi-Fi, local gateway'}</dd></div>
          <div><dt>Network</dt><dd>{board.info.ssid ?? 'Not set'}</dd></div>
          <div><dt>Signing key</dt><dd>{board.info.keySet ? 'Set' : 'Not set'}</dd></div>
          <div><dt>Frame rate</dt><dd>{board.info.frameRate ? `${board.info.frameRate} fps` : 'Not reported'}</dd></div>
        </dl>
        <p className="dv-hint">{describePort(port)}</p>
      </div>}
      {port && board.kind === 'silent' && <div className="fl-board" role="status">
        <p><b>No TMsense firmware answered.</b> A new board, or one running something else: it will be flashed.</p>
        <p className="dv-hint">{describePort(port)}</p>
      </div>}
      {boardError && <p className="dv-error" role="alert">{boardError}</p>}
      <div className="dv-match">
        {!port
          ? <button className="dv-primary" disabled={locked || board.kind === 'identifying'} onClick={() => void connect()}>Connect a board</button>
          : <>
            <button disabled={locked || board.kind === 'identifying'} onClick={() => void identify(port)}>Read it again</button>
            <button disabled={running || board.kind === 'identifying'} onClick={() => void disconnect()}>Disconnect</button>
          </>}
      </div>
      <p className="dv-hint">Opening a board’s serial port restarts it. A node that is installed and reporting will stop for a few seconds.</p>
    </section>

    <section className="dv-panel" aria-labelledby="fl-firmware">
      <h2 id="fl-firmware">2 · Firmware</h2>
      <label className="fl-check"><input type="checkbox" checked={writeImage} disabled={locked} onChange={(event) => setWriteImage(event.target.checked)} />
        <span>Write firmware <small>Off: only the settings change, on a board that already runs TMsense.</small></span></label>
      {writeImage && <>
        <p>The latest release of the TMsense repository on GitHub. This console downloads it and checks every file against the release’s own SHA-256 list; no other image can be written from this page.</p>
        {fetching && !build && <p className="dv-hint" role="status">Getting the latest release from GitHub…</p>}
        {buildError && <p className="dv-error" role="alert">{buildError}</p>}
        {build && <div className="fl-build" role="status">
          <p><b>{build.plan.version}</b> · release <a href={releasePage(build.release)} target="_blank" rel="noreferrer">{build.release.tag}</a> · commit <code>{build.release.commit.slice(0, 7)}</code> · checked with GitHub {new Date(build.release.checkedAt).toLocaleTimeString()}</p>
          <table>
            <thead><tr><th scope="col">Written at</th><th scope="col">Image</th><th scope="col">Bytes</th></tr></thead>
            <tbody>{build.plan.segments.map((segment) => <tr key={segment.name}>
              <td><code>0x{segment.address.toString(16).padStart(5, '0')}</code></td><td>{sentence(segment.name)}</td><td>{segment.data.length.toLocaleString()}</td>
            </tr>)}</tbody>
          </table>
          <p className="dv-hint">Left untouched: {build.plan.preserved.map((kept) => `${kept.label} (0x${kept.offset.toString(16)}–0x${(kept.offset + kept.size).toString(16)})`).join(', ')}, where the node keeps its settings and boot counter. Nothing is erased.</p>
        </div>}
        <div className="dv-match"><button disabled={running || fetching} onClick={() => void fetchRelease()}>{fetching ? 'Checking…' : build ? 'Check for a newer release' : 'Try again'}</button></div>
      </>}
    </section>

    <section className="dv-panel" aria-labelledby="fl-settings">
      <h2 id="fl-settings">3 · Settings</h2>
      <p className="dv-hint">A field left blank keeps what the node already has.</p>
      <div className="fl-fields">
        <label>Node ID<input inputMode="numeric" value={nodeId} disabled={locked} onChange={(event) => setNodeId(event.target.value)} placeholder="1–65535" autoComplete="off" />
          <small>Write the same number on the enclosure.</small></label>
        <Choice legend="Frame rate" value={frameRate === null ? 'keep' : String(frameRate)} disabled={locked}
          options={[['keep', 'Keep current'], ['1', '1 fps'], ['2', '2 fps'], ['4', '4 fps']]}
          onChange={(value) => setFrameRate(value === 'keep' ? null : Number(value) as FrameRate)} />
      </div>
      <Choice legend="Uplink" value={uplink} disabled={locked} onChange={(value) => setUplink(value as Uplink)}
        options={[['gateway', 'Wi-Fi · local gateway'], ['cloud', 'Wi-Fi · direct to cloud'], ['lora', 'LoRa']]} />
      {uplink === 'lora' && <p className="dv-notice" role="status">This firmware has no LoRa uplink yet. The node stores the setting and sends nothing until it does.</p>}
      <div className="fl-fields">
        {uplink !== 'lora' && <>
          <label>Wi-Fi network (2.4 GHz)<input value={ssid} disabled={locked} onChange={(event) => setSsid(event.target.value)} placeholder={keeps(known?.ssid)} autoComplete="off" spellCheck={false} />
            <small>A browser cannot scan for networks: type the name exactly.</small></label>
          <label>Wi-Fi password<input type="password" value={password} disabled={locked} onChange={(event) => setPassword(event.target.value)}
            placeholder={known?.passwordSet ? 'keeps the one on the node' : 'unchanged if left blank'} autoComplete="new-password" /></label>
        </>}
        {uplink === 'cloud' && <label>TMedge node URL<input value={cloudUrl} disabled={locked} onChange={(event) => setCloudUrl(event.target.value)}
          placeholder={known?.cloudUrl ? `keeps ${known.cloudUrl}` : 'wss://sense.example.com/tmnode'} autoComplete="off" spellCheck={false} /></label>}
        <label>{uplink === 'lora' ? 'TMLAccess IP' : uplink === 'cloud' ? 'TMWAccess IP (kept for a rollback)' : 'TMWAccess IP'}
          <input inputMode="decimal" value={gateway} disabled={locked} onChange={(event) => setGateway(event.target.value.trim())}
            placeholder={keeps(uplink === 'lora' ? known?.loraGateway : known?.edge)} autoComplete="off" /></label>
        <label>Signing key<input type="password" value={key} disabled={locked} onChange={(event) => setKey(event.target.value)}
          placeholder={known?.keySet ? 'keeps the one on the node' : 'TMedge’s TM_KEY'} autoComplete="new-password" />
          <small>Typed here, sent to the board, kept nowhere.</small></label>
      </div>
      <label className="fl-check"><input type="checkbox" checked={adopt} disabled={locked} onChange={(event) => setAdopt(event.target.checked)} />
        <span>Ask TMedge to admit this node <small>A node the edge has not admitted is refused when it connects. You approve it here, once its identity has been read from the board.</small></span></label>
    </section>

    <section className="dv-panel" aria-labelledby="fl-run">
      <h2 id="fl-run">4 · {writeImage ? 'Flash' : 'Set up'}</h2>
      {!running && !outcome && problems.length > 0 && <ul className="fl-problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      {!outcome && <div className="dv-match">
        <button className="dv-primary" disabled={locked || problems.length > 0} onClick={() => void run()}>
          {running ? 'Working…' : writeImage ? 'Flash and set up' : 'Write settings'}</button>
      </div>}
      {running && <p className="dv-hint">Keep this tab open and the board plugged in until this finishes.</p>}
      {steps.length > 0 && <ol className="fl-steps">{steps.map((step) => <li key={step.id} className={`is-${step.state}`}>
        <span className="fl-mark" aria-hidden="true">{STATE_MARK[step.state]}</span>
        <span className="fl-step-label">{step.label}</span>
        <span className="fl-step-state">{step.id === 'write' && step.state === 'running' ? `${Math.round(progress * 100)}%` : STATE_WORD[step.state]}</span>
        {step.id === 'write' && step.state === 'running' && <progress value={progress} max={1} aria-label="Firmware written" />}
      </li>)}</ol>}

      {prompt && <div className="fl-admit" role="alertdialog" aria-labelledby="fl-admit-title">
        <h3 id="fl-admit-title">Admit this board to TMedge?</h3>
        <p>Its settings are saved. It can connect once TMedge knows it. It will be registered as an identity only — unplaced, counting nothing — until someone places it on a floor.</p>
        <dl><div><dt>UID read from the board</dt><dd><code>{prompt.uid}</code></dd></div><div><dt>Request code</dt><dd><code>{prompt.code}</code></dd></div></dl>
        {prompt.error && <p className="dv-error" role="alert">{prompt.error}</p>}
        <div className="dv-match">
          <button className="dv-primary" disabled={prompt.busy} onClick={() => void decide('approve')}>Admit this board</button>
          <button disabled={prompt.busy} onClick={() => void decide('deny')}>Deny</button>
          <button disabled={prompt.busy} onClick={() => settle({ state: 'pending' })}>Decide later in Adoption</button>
        </div>
      </div>}

      {outcome && <div className={`fl-outcome is-${outcome.kind}`} role={outcome.kind === 'failed' ? 'alert' : 'status'}>
        <h3><span aria-hidden="true">{outcome.kind === 'failed' ? '✕' : outcome.kind === 'check' ? '!' : '✓'}</span> {outcome.kind === 'failed' ? 'Failed' : outcome.kind === 'check' ? 'Set up, with something to check' : 'Done'}</h3>
        {outcome.error && <p>{sentence(outcome.error)}</p>}
        {outcome.kind === 'failed' && outcome.wrote && <p className="dv-hint">{outcome.wrote} was written before this failed. The node’s saved settings were not erased.</p>}
        {outcome.result && <>
          <dl>
            <div><dt>Node</dt><dd>#{outcome.result.info.nodeId} · <code>{outcome.result.info.uid}</code></dd></div>
            <div><dt>Firmware</dt><dd>{outcome.result.info.firmware}{outcome.wrote ? ' (just written)' : ''}</dd></div>
            <div><dt>Wi-Fi</dt><dd>{outcome.result.info.mode === 'lora' ? 'LoRa mode' : outcome.result.ip ? `Joined ${outcome.result.info.ssid} as ${outcome.result.ip}` : 'Did not join'}</dd></div>
            <div><dt>TMedge</dt><dd>{outcome.result.edgeAccepted ? 'Accepted a report' : outcome.result.admission?.state === 'registered' ? 'Admitted, unplaced' : outcome.result.admission?.state === 'pending' ? 'Waiting for approval in Adoption' : 'Not asked'}</dd></div>
          </dl>
          {outcome.result.warnings.length > 0 && <ul className="fl-problems">{outcome.result.warnings.map((warning) => <li key={warning}>{sentence(warning)}</li>)}</ul>}
        </>}
        <div className="dv-match">
          <button className="dv-primary" onClick={another}>Set up another board</button>
          {outcome.kind === 'failed' && <button onClick={() => { setOutcome(null); setSteps([]); }}>Try this board again</button>}
        </div>
      </div>}

      {log.length > 0 && <details className="fl-log" open={running || outcome?.kind === 'failed'}>
        <summary>Log</summary>
        <pre ref={logEnd} role="log" aria-label="Flashing log">{log.join('\n')}</pre>
      </details>}
    </section>
  </main>;
}

function Choice({ legend, value, options, disabled, onChange }: { legend: string; value: string; options: [string, string][]; disabled: boolean; onChange(value: string): void }): ReactNode {
  return <fieldset className="fl-choice" disabled={disabled}>
    <legend>{legend}</legend>
    <div>{options.map(([option, label]) => <label key={option} className={option === value ? 'is-on' : ''}>
      <input type="radio" name={legend} checked={option === value} onChange={() => onChange(option)} />{label}</label>)}</div>
  </fieldset>;
}
