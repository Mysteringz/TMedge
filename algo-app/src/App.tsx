/**
 * The algo debugger.
 *
 * The thing to keep in view while reading this: the inspector's device
 * parameters are not settings of this page. Pressing Apply sends a signed
 * command to a sensor on a ceiling, and the floor it watches may be one
 * students are looking at right now. The UI therefore always shows three
 * things together -- what the sensor is running, what you have dialled in,
 * and when an uncommitted change will be put back by itself.
 */
import { useCapability } from './entities/admin-session/index.tsx';
import { useConnectionState } from './entities/connection-state/index.ts';
import { ConnectionStatus } from './widgets/connection-status/index.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider,
  addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  api, unpack,
  type Envelope, type NodeSpec, type PendingChange, type Pipeline, type RunResult, type SourceNode,
} from './api.ts';
import { Divider, useCompactLayout, usePaneSize } from './panes.tsx';
import { GridView, Histogram, Json, Plane, PlanView, Table, type HeatJson } from './viewers.tsx';

const PORT_COLOUR: Record<string, string> = {
  thermal: '#ff832b', mask: '#08bdba', detections: '#f1c21b', points: '#33b1ff',
  heatmap: '#a56eff', tables: '#a8a8a8', occupancy: '#42be65', json: '#6f6f6f',
};

interface FlowData extends Record<string, unknown> {
  spec: NodeSpec;
  envelope?: Envelope;
  selected: boolean;
  dirty: boolean;
}

function StageNode({ data, id }: NodeProps) {
  const d = data as FlowData;
  const { spec, envelope } = d;
  return (
    <div className={`stage stage-${spec.domain} ${d.selected ? 'is-selected' : ''} ${envelope?.error ? 'is-error' : ''}`}>
      {spec.inputs.map((p, i) => (
        <Handle key={p.id} type="target" position={Position.Left} id={p.id}
          style={{ top: 42 + i * 18, background: PORT_COLOUR[p.type] ?? '#888' }} title={`${p.label}: ${p.type}`} />
      ))}
      <div className="stage-head">
        <span className={`dot dot-${spec.domain}`} />
        <span className="stage-name">{spec.name}</span>
        {d.dirty && <span className="badge badge-dirty" title="the inspector differs from the sensor">edited</span>}
      </div>
      <div className="stage-where">{spec.domain === 'device' ? 'on the sensor' : spec.domain === 'edge' ? 'on the edge' : 'view only'}</div>
      {envelope?.error
        ? <div className="stage-err">{envelope.error}</div>
        : (
          <div className="stage-metrics">
            {Object.entries(envelope?.metrics ?? {}).slice(0, 3).map(([k, v]) => (
              <div key={k}><span>{k}</span><b>{typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v}</b></div>
            ))}
          </div>
        )}
      <div className="stage-foot">{envelope ? `${envelope.executionTimeMs} ms` : '—'} · {id}</div>
      {spec.outputs.map((p, i) => (
        <Handle key={p.id} type="source" position={Position.Right} id={p.id}
          style={{ top: 42 + i * 18, background: PORT_COLOUR[p.type] ?? '#888' }} title={`${p.label}: ${p.type}`} />
      ))}
    </div>
  );
}

const nodeTypes = { stage: StageNode };

/** The timeline below the output strip, which the drag has to account for. */
const TIMELINE_H = 36;
const MOBILE_PANES = [
  { id: 'graph', label: 'Graph' }, { id: 'stages', label: 'Stages' },
  { id: 'inspector', label: 'Inspector' }, { id: 'output', label: 'Output' },
] as const;
type MobilePane = typeof MOBILE_PANES[number]['id'];

export default function App() {
  const canWrite = useCapability('algo.write');
  const connection = useConnectionState();
  const connectionRef = useRef(connection); connectionRef.current = connection;
  const [parameterBusy, setParameterBusy] = useState(false);
  const parameterInFlight = useRef(false);
  const [specs, setSpecs] = useState<NodeSpec[]>([]);
  const [revertMs, setRevertMs] = useState(15 * 60_000);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [sources, setSources] = useState<SourceNode[]>([]);
  const [sourceObservedAt, setSourceObservedAt] = useState<number | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [selected, setSelected] = useState<string>('bg-1');
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [live, setLive] = useState(true);
  const [frames, setFrames] = useState<{ frame: number; at: number; detections: number | null }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, number>>({});
  /** Where the thumb is while dragging, before any request has come back. */
  const [scrub, setScrub] = useState<number | null>(null);
  const runSeq = useRef(0);
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const ws = useRef<WebSocket | null>(null);
  const deviceReady = connection.transport === 'connected' && sourceObservedAt !== null && connection.now - sourceObservedAt < 15000 && sources.some((source) => source.uid === pipeline?.uid && source.online);
  const flow = useReactFlow();
  const compact = useCompactLayout();
  const [mobilePane, setMobilePane] = useState<MobilePane>('graph');
  // Panes people can size themselves. The output strip is tall by default
  // because a 32x24 frame drawn at a readable size is about 400 px, and a
  // viewer that clips the picture it exists to show is no viewer.
  const lib = usePaneSize('lib', 190, { min: 150, max: 420 });
  const insp = usePaneSize('insp', 330, { min: 260, max: 620 });
  const out = usePaneSize('out', 480, { min: 140, max: 1200 });
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const cat = await api.catalogue();
      setSpecs(cat.nodes);
      setRevertMs(cat.revertMs);
      if (!cat.preview.available) setNotice(`Preview is off: ${cat.preview.reason}`);
      const p = await api.pipeline();
      setPipeline(p.pipeline);
      setSources((await api.sources()).nodes);
      setFrames((await api.frames(p.pipeline.uid)).frames);
    })().catch((e: Error) => setNotice(e.message));
  }, []);

  // Live frames arrive over the socket; the token is short-lived, so it is
  // fetched each time the socket is opened.
  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const open = async () => {
      if (closed) return;
      try {
        const { token } = await api.wsToken();
        if (closed) return;
        const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`);
        socket = sock;
        ws.current = sock;
        sock.onopen = () => { if (!closed && socket === sock) { setSourceObservedAt(null); connectionRef.current.setTransport('connected'); } };
        sock.onmessage = (ev) => {
          if (closed || socket !== sock) return;
          let msg: RunResult & { type: string; pipeline?: Pipeline; live?: boolean; pending?: PendingChange[] };
          try { msg = JSON.parse(String(ev.data)) as typeof msg; } catch { setNotice('The console received an unreadable live message.'); return; }
          if (!msg || typeof msg.type !== 'string') return;
          connectionRef.current.received();
          if (msg.type === 'frame') {
            // A live frame must not overwrite the one being looked at.
            setScrub((s) => { if (s === null) { setRun(msg); if (msg.pending) setPending(msg.pending); } return s; });
          } else if (msg.type === 'pipeline_state') {
            if (msg.pipeline) setPipeline((cur) => (cur && cur.updatedAt >= msg.pipeline!.updatedAt ? cur : msg.pipeline!));
            if (typeof msg.live === 'boolean') setLive(msg.live);
            if (msg.pending) setPending(msg.pending);
          }
        };
        sock.onclose = () => { if (!closed && socket === sock) { connectionRef.current.setTransport('reconnecting'); retryTimer = setTimeout(() => void open(), 2000); } };
        sock.onerror = () => { if (!closed) connectionRef.current.setTransport('disconnected'); };
      } catch {
        if (!closed) connectionRef.current.setTransport('disconnected');
        if (!closed) retryTimer = setTimeout(() => void open(), 3000);
      }
    };
    void open();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      socket?.close();
      if (ws.current === socket) ws.current = null;
    };
  }, []);

  useEffect(() => {
    let stopped = false, busy = false; let request: AbortController | null = null;
    const refresh = async (): Promise<void> => {
      if (stopped || busy || document.hidden) return; busy = true; request = new AbortController();
      const timeout = setTimeout(() => request?.abort(), 10000);
      try { const [source, params] = await Promise.all([api.sources(request.signal), api.params(request.signal)]);
        if (!stopped && !request.signal.aborted) { setSources(source.nodes); setPending(params.pending); setSourceObservedAt(Date.now()); }
      } catch { if (!stopped) setSourceObservedAt(null); }
      finally { clearTimeout(timeout); busy = false; }
    };
    const visible = (): void => { if (document.hidden) request?.abort(); else void refresh(); };
    const timer = setInterval(() => void refresh(), 5000); document.addEventListener('visibilitychange', visible); void refresh();
    return () => { stopped = true; request?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, []);

  useEffect(() => () => { if (scrubTimer.current) clearTimeout(scrubTimer.current); runSeq.current++; }, []);

  // The ring shifts under us as frames arrive, so an index into a list fetched
  // at mount stops meaning what it did. Refresh it while live; never mid-drag,
  // which would move the thumb out from under the pointer.
  useEffect(() => {
    if (!pipeline || !live) return;
    const id = setInterval(() => {
      if (scrub !== null) return;
      void api.frames(pipeline.uid).then((f) => setFrames(f.frames)).catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, [pipeline, live, scrub]);

  // The shape of the graph, and only that. Rebuilding this on every frame --
  // which is what depending on `run` did -- throws away React Flow's measured
  // sizes once a second and re-mounts every node. A measurement that lands
  // while the tab is hidden or the pane is mid-resize then leaves the nodes
  // sized zero, and the canvas stays blank until a reload.
  const shape = useMemo(() => (pipeline
    ? pipeline.nodes.map((n) => `${n.id}:${n.type}:${n.position.x},${n.position.y}`).join('|')
      + '#' + pipeline.edges.map((e) => e.id).join('|')
    : ''), [pipeline]);

  useEffect(() => {
    if (!pipeline || specs.length === 0) return;
    setNodes(pipeline.nodes.flatMap((n) => {
      const spec = specs.find((s) => s.type === n.type);
      return spec ? [{ id: n.id, type: 'stage', position: n.position, data: { spec } } as unknown as Node] : [];
    }));
    setEdges(pipeline.edges.map((e) => {
      const spec = specs.find((s) => s.type === pipeline.nodes.find((n) => n.id === e.sourceNode)?.type);
      const type = spec?.outputs.find((o) => o.id === e.sourcePort)?.type ?? 'json';
      return {
        id: e.id, source: e.sourceNode, target: e.targetNode,
        sourceHandle: e.sourcePort, targetHandle: e.targetPort,
        style: { stroke: PORT_COLOUR[type] ?? '#666', strokeWidth: 2 },
      } as Edge;
    }));
    // `shape` is the identity of the graph; results are applied separately below.
  }, [shape, specs, pipeline, setNodes, setEdges]);

  // A whole pipeline fitted into a phone makes every label tiny. Open around
  // the selected stage; the fit control still provides the complete overview.
  // Wait for measurement after a reset, rotation or returning to the graph.
  const focusNode = compact ? selected : undefined;
  useEffect(() => {
    if (compact && mobilePane !== 'graph') return;
    const timer = setTimeout(() => {
      void flow.fitView({ padding: 0.12, duration: 200,
        ...(focusNode ? { nodes: [{ id: focusNode }], minZoom: 0.75, maxZoom: 1 } : {}),
      });
    }, 60);
    return () => clearTimeout(timer);
  }, [shape, compact, mobilePane, focusNode, flow]);

  // Results, selection and edits change every second, so they only patch the
  // data of nodes that already exist.
  useEffect(() => {
    const dirty = new Set(run?.dirty ?? []);
    setNodes((cur) => cur.map((node) => {
      const d = node.data as FlowData;
      const spec = d.spec;
      const envelope = run?.envelopes.find((e) => e.nodeId === node.id);
      const isDirty = spec.params.some((p) =>
        (p.binding.kind === 'device' && dirty.has(p.binding.param)) || edits[`${node.id}.${p.id}`] !== undefined);
      if (d.envelope === envelope && d.selected === (node.id === selected) && d.dirty === isDirty) return node;
      return { ...node, data: { spec, envelope, selected: node.id === selected, dirty: isDirty } satisfies FlowData };
    }));
  }, [run, selected, edits, setNodes]);

  useEffect(() => {
    setEdges((cur) => cur.map((e) => (e.animated === live ? e : { ...e, animated: live })));
  }, [live, setEdges]);

  const push = useCallback(async (next: Pipeline) => {
    if (!canWrite) return;
    try {
      const out = await api.putPipeline(next);
      setPipeline(out.pipeline);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }, [canWrite]);

  const onConnect = useCallback((c: Connection) => {
    if (!pipeline || !c.source || !c.target) return;
    const next: Pipeline = {
      ...pipeline,
      edges: [...pipeline.edges.filter((e) => !(e.targetNode === c.target && e.targetPort === c.targetHandle)), {
        id: `${c.source}.${c.sourceHandle}->${c.target}.${c.targetHandle}`,
        sourceNode: c.source, sourcePort: c.sourceHandle ?? '', targetNode: c.target, targetPort: c.targetHandle ?? '',
      }],
    };
    setEdges((eds) => addEdge(c, eds));
    void push(next);
  }, [pipeline, push, setEdges]);

  const spec = useMemo(() => {
    const n = pipeline?.nodes.find((x) => x.id === selected);
    return specs.find((s) => s.type === n?.type) ?? null;
  }, [pipeline, specs, selected]);
  const envelope = run?.envelopes.find((e) => e.nodeId === selected) ?? null;
  const source = sources.find((s) => s.uid === pipeline?.uid) ?? null;

  /**
   * Ask for one frame. Dragging the slider fires an event per pixel, and each
   * run replays the ring through the detector, so the request is debounced to
   * the end of the gesture and only the newest answer is allowed to land --
   * otherwise a slow early reply overwrites the frame you stopped on.
   */
  const showFrame = useCallback((frame: number, immediate = false) => {
    setScrub(frame);
    if (scrubTimer.current) clearTimeout(scrubTimer.current);
    const fire = async () => {
      const seq = ++runSeq.current;
      try {
        await api.mode('step', frame);
        if (seq !== runSeq.current) return;
        const result = await api.run(frame);
        if (seq === runSeq.current) {
          setRun(result);
          setScrub(null);
        }
      } catch (e) {
        if (seq === runSeq.current) setNotice((e as Error).message);
      }
    };
    if (immediate) void fire();
    else scrubTimer.current = setTimeout(() => void fire(), 140);
  }, []);

  const applyParam = async (paramId: string, value: number) => {
    if (!pipeline || parameterInFlight.current) return;
    const binding = specs.find((item) => item.type === pipeline.nodes.find((node) => node.id === selected)?.type)?.params.find((item) => item.id === paramId)?.binding;
    if (binding?.kind === 'device' && !deviceReady) { setNotice('Device controls wait for a refreshed connection and sensor state.'); return; }
    parameterInFlight.current = true; setParameterBusy(true);
    try {
      await api.apply(selected, paramId, value, pipeline.uid);
      const p = await api.params();
      setPending(p.pending);
      // Drop the local edit only once a run has come back carrying the new
      // value, otherwise the box shows the node's last report -- the old
      // number -- for the frame in between, and the change looks discarded.
      setRun(await api.run());
      setEdits((e) => { const { [`${selected}.${paramId}`]: _drop, ...rest } = e; return rest; });
    } catch (e) {
      setNotice((e as Error).message);
    } finally { parameterInFlight.current = false; setParameterBusy(false); }
  };

  const step = (delta: number) => {
    const list = frames.map((f) => f.frame);
    const current = scrub ?? run?.frameId;
    const at = current === undefined ? list.length - 1 : list.indexOf(current);
    const next = list[Math.max(0, Math.min(list.length - 1, (at < 0 ? list.length - 1 : at) + delta))];
    if (next === undefined) return;
    setLive(false);
    showFrame(next, true);
  };

  return (
    <div className="app">
      <ConnectionStatus transport={connection.transport} observedAt={connection.observedAt} fresh={connection.fresh} sensorOnline={sources.find((source) => source.uid === pipeline?.uid)?.online ?? null} />
      {!canWrite && <p role="status">Read-only access. An engineer can change parameters and run training.</p>}
      <header className="bar">
        <div className="brand"><span className="mark" /> Algo debugger</div>
        <div className="source">
          <select disabled={!canWrite} aria-label="Sensor source" value={pipeline?.uid ?? ''} onChange={(e) => {
            if (!pipeline) return;
            void push({ ...pipeline, uid: e.target.value });
            void api.frames(e.target.value).then((f) => setFrames(f.frames)).catch((e: Error) => setNotice(e.message));
          }}>
            {sources.map((s) => (
              <option key={s.uid} value={s.uid}>
                {s.label} · {s.uid.slice(-5)} {s.simulated ? '(sim)' : '(real)'} {s.frames ? `· ${s.frames} frames` : '· no frames'}
              </option>
            ))}
          </select>
          {source?.published && <span className="badge badge-warn" title="students see this floor">public floor</span>}
          {source && source.rawEvery === 0 && (
            <button disabled={!canWrite} className="btn" onClick={() => void applyParam('raw_every', 4)}>
              Turn on RAW (needed to see frames)
            </button>
          )}
        </div>
        <div className="modes">
          <button disabled={!canWrite} className={`btn ${live ? 'on' : ''}`} onClick={() => void api.mode('live').then(() => setLive(true)).catch((e: Error) => setNotice(e.message))}>● Live</button>
          <button disabled={!canWrite} className={`btn ${live ? '' : 'on'}`} onClick={() => void api.mode('pause', run?.frameId).then(() => setLive(false)).catch((e: Error) => setNotice(e.message))}>Pause</button>
          <button disabled={!canWrite} className="btn" onClick={() => step(-1)}>◀ Prev</button>
          <button disabled={!canWrite} className="btn" onClick={() => step(1)}>Next ▶</button>
          <button disabled={!canWrite} className="btn" onClick={() => void api.resetPipeline().then((r) => setPipeline(r.pipeline)).catch((e: Error) => setNotice(e.message))}>Reset graph</button>
          <button disabled={!canWrite} className="btn" onClick={() => {
            const name = prompt('Save this pipeline as:');
            if (name) void api.savePipeline(name).catch((e: Error) => setNotice(e.message));
          }}>Save</button>
        </div>
      </header>

      {notice && <div className="notice" onClick={() => setNotice(null)}>{notice} <span className="x">dismiss</span></div>}
      {run?.previewUnavailable && <div className="notice">{run.previewUnavailable}</div>}

      {compact && <div className="mobile-panes" role="tablist" aria-label="Debugger panels">
        {MOBILE_PANES.map((pane, index) => (
          <button key={pane.id} id={`tab-${pane.id}`} role="tab" aria-controls={`pane-${pane.id}`}
            aria-selected={mobilePane === pane.id} tabIndex={mobilePane === pane.id ? 0 : -1}
            onClick={() => setMobilePane(pane.id)} onKeyDown={(event) => {
              let next = index;
              if (event.key === 'ArrowRight') next = (index + 1) % MOBILE_PANES.length;
              else if (event.key === 'ArrowLeft') next = (index + MOBILE_PANES.length - 1) % MOBILE_PANES.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = MOBILE_PANES.length - 1;
              else return;
              event.preventDefault();
              const target = MOBILE_PANES[next]!;
              setMobilePane(target.id);
              document.getElementById(`tab-${target.id}`)?.focus();
            }}>{pane.label}</button>
        ))}
      </div>}
      <div className="mobile-stage" hidden={!compact || (mobilePane !== 'inspector' && mobilePane !== 'output')}>
        <label htmlFor="mobile-selected-stage">Stage</label>
        <select id="mobile-selected-stage" value={selected} onChange={(event) => setSelected(event.target.value)}>
          {pipeline?.nodes.map((node) => <option key={node.id} value={node.id}>
            {specs.find((entry) => entry.type === node.type)?.name ?? node.type} · {node.id}
          </option>)}
        </select>
      </div>

      <div
        className="body"
        ref={bodyRef}
        style={{ gridTemplateColumns: `min(${lib.size}px, 25vw) 6px minmax(0, 1fr) 6px min(${insp.size}px, 35vw)` }}
      >
        <aside className="library" id="pane-stages" hidden={compact && mobilePane !== 'stages'}
          role={compact ? 'tabpanel' : undefined} aria-labelledby={compact ? 'tab-stages' : undefined}>
          <h3>Stages</h3>
          {['device', 'edge', 'view'].map((domain) => (
            <div key={domain} className="lib-group">
              <div className="lib-title">{domain === 'device' ? 'On the sensor' : domain === 'edge' ? 'On the edge' : 'View'}</div>
              {specs.filter((s) => s.domain === domain).map((s) => (
                <div key={s.type} className="lib-item" title={s.summary}>
                  <span className={`dot dot-${s.domain}`} /> {s.name}
                </div>
              ))}
            </div>
          ))}
          <TrainingData />
          <p className="hint">
            Device stages run on the ESP32. Changing one sends it a signed command;
            it is put back automatically after {Math.round(revertMs / 60000)} minutes
            unless you commit it.
          </p>
        </aside>

        <Divider
          axis="x" label="Stage list width"
          onDrag={(x) => lib.set(x - (bodyRef.current?.getBoundingClientRect().left ?? 0))}
          onCommit={(x) => lib.commit(x - (bodyRef.current?.getBoundingClientRect().left ?? 0))}
          onNudge={(d) => lib.commit(lib.size + d)}
          onReset={lib.reset}
        />

        <main className="canvas" id="pane-graph" hidden={compact && mobilePane !== 'graph'}
          role={compact ? 'tabpanel' : undefined} aria-labelledby={compact ? 'tab-graph' : undefined}>
          {compact && <div className="mobile-graph-hint">Pinch to zoom · Tap a stage to inspect</div>}
          <ReactFlow
            nodesDraggable={canWrite} nodesConnectable={canWrite} edgesReconnectable={canWrite}
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => { setSelected(n.id); if (compact) setMobilePane('inspector'); }}
            onNodeDragStop={(_, n) => {
              if (!pipeline) return;
              void push({ ...pipeline, nodes: pipeline.nodes.map((x) => (x.id === n.id ? { ...x, position: n.position } : x)) });
            }}
            minZoom={compact ? 0.1 : 0.5} fitView proOptions={{ hideAttribution: true }}
          >
            <Background color="#393939" gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </main>

        <Divider
          axis="x" label="Inspector width"
          onDrag={(x) => insp.set((bodyRef.current?.getBoundingClientRect().right ?? window.innerWidth) - x)}
          onCommit={(x) => insp.commit((bodyRef.current?.getBoundingClientRect().right ?? window.innerWidth) - x)}
          onNudge={(d) => insp.commit(insp.size - d)}
          onReset={insp.reset}
        />

        <aside className="inspector" id="pane-inspector" hidden={compact && mobilePane !== 'inspector'}
          role={compact ? 'tabpanel' : undefined} aria-labelledby={compact ? 'tab-inspector' : undefined}>
          {spec ? (
            <>
              <h3>{spec.name} <span className="ver">v{spec.version}</span></h3>
              <p className="summary">{spec.summary}</p>
              <div className={`where where-${spec.domain}`}>
                {spec.domain === 'device' ? 'Parameters here change the sensor itself.'
                  : spec.domain === 'edge' ? 'Parameters here change live occupancy for everyone.'
                    : 'Nothing here leaves the debugger.'}
              </div>

              {spec.params.map((p) => {
                const key = `${selected}.${p.id}`;
                const liveValue = envelope?.parameters[p.id];
                const value = edits[key] ?? liveValue ?? p.min;
                const changed = edits[key] !== undefined && edits[key] !== liveValue;
                const held = pending.find((c) => c.param === (p.binding.kind === 'device' ? p.binding.param : p.binding.kind === 'edge' ? p.binding.path : ''));
                return (
                  <div key={p.id} className="param">
                    <label>
                      {p.label}
                      {p.unit && <span className="unit"> ({p.unit})</span>}
                    </label>
                    <div className="param-row">
                      <input disabled={!canWrite} type="range" aria-label={p.label} min={p.min} max={p.max} step={p.step} value={value}
                        onChange={(e) => setEdits((s) => ({ ...s, [key]: Number(e.target.value) }))} />
                      <input disabled={!canWrite} type="number" aria-label={`${p.label} value`} min={p.min} max={p.max} step={p.step} value={value}
                        onChange={(e) => setEdits((s) => ({ ...s, [key]: Number(e.target.value) }))} />
                    </div>
                    <div className="param-foot">
                      <span className="live">
                        sensor: {liveValue ?? '—'}
                        {p.scale && liveValue !== undefined ? ` (${(liveValue * p.scale).toFixed(2)}${p.unit ?? ''})` : ''}
                      </span>
                      {p.binding.kind !== 'local' && changed && (
                        <button disabled={!canWrite || parameterBusy || p.binding.kind === 'device' && !deviceReady} className="btn btn-apply" onClick={() => void applyParam(p.id, value)}>
                          {parameterBusy ? 'Requested…' : `Apply to ${p.binding.kind === 'device' ? 'sensor' : 'edge'}`}
                        </button>
                      )}
                      {p.binding.kind === 'local' && changed && (
                        <button disabled={!canWrite} className="btn" onClick={() => void applyParam(p.id, value)}>Set</button>
                      )}
                    </div>
                    {held && held.binding === 'device' && held.confirmedAt === null && (
                      // A command is a datagram to a ceiling and the node only
                      // reports every 10s. Saying so beats showing the old
                      // number back, which read as the change being dropped.
                      <div className="held held-waiting">
                        {held.restoring ? 'Restoring previous value — waiting for device confirmation' : 'Sent — waiting for device'} · {held.uid} · sequence {held.cmdSeq ?? 'unavailable'} · asked for {held.to}
                        {Date.now() - held.at > 30_000 && (
                          <strong> — no confirmation in {Math.round((Date.now() - held.at) / 1000)}s; it may be offline or refusing this value</strong>
                        )}
                      </div>
                    )}
                    {held && (
                      <div className="held">
                        was {held.from ?? '—'}
                        {held.binding === 'device' && held.confirmedAt !== null && ` · Device confirmed at ${new Date(held.confirmedAt).toLocaleTimeString()}`}
                        {' '}· goes back in {Math.max(0, Math.round((held.revertAt - Date.now()) / 60000))} min
                        <button disabled={!canWrite || held.binding === 'device' && !deviceReady} className="link" onClick={() => void api.commit(held.param, pipeline?.uid).then(async () => setPending((await api.params()).pending)).catch((e: Error) => setNotice(e.message))}>keep</button>
                        <button disabled={!canWrite || held.binding === 'device' && !deviceReady} className="link" onClick={() => void api.revert(held.param, pipeline?.uid).then(async () => { setPending((await api.params()).pending); setRun(await api.run()); }).catch((e: Error) => setNotice(e.message))}>undo now</button>
                      </div>
                    )}
                    {p.help && <div className="help">{p.help}</div>}
                  </div>
                );
              })}

              {spec.domain === 'device' && (
                <div className="danger">
                  {!deviceReady && <p>Device controls wait for a refreshed connection and sensor state.</p>}
                  <button disabled={!canWrite || !deviceReady} className="btn" onClick={() => void api.resetBackground(pipeline?.uid).catch((e: Error) => setNotice(e.message))}>Relearn background</button>
                  <button disabled={!canWrite || !deviceReady} className="btn btn-warn" onClick={() => {
                    if (confirm('Write the sensor’s current parameters to its flash? This survives a reboot and is not on a timer.')) {
                      void api.persist(pipeline?.uid).catch((e: Error) => setNotice(e.message));
                    }
                  }}>Save to flash…</button>
                </div>
              )}

              <h4>Metrics</h4>
              <Table rows={[Object.fromEntries(Object.entries(envelope?.metrics ?? {}))]} />
            </>
          ) : <p className="hint">Select a stage.</p>}
        </aside>
      </div>

      <Divider
        axis="y" label="Output height"
        onDrag={(y) => out.set(window.innerHeight - y - TIMELINE_H)}
        onCommit={(y) => out.commit(window.innerHeight - y - TIMELINE_H)}
        onNudge={(d) => out.commit(out.size - d)}
        onReset={out.reset}
      />

      <section className="output" id="pane-output" style={{ height: out.size }} hidden={compact && mobilePane !== 'output'}
        role={compact ? 'tabpanel' : undefined} aria-labelledby={compact ? 'tab-output' : undefined}>
        <div className="output-head">
          <b>{spec?.name ?? 'Output'}</b>
          <span className="muted">frame {run?.frameId ?? '—'} · {run ? new Date(run.timestamp).toLocaleTimeString() : ''}</span>
        </div>
        <div className="output-body">{envelope ? <Output envelope={envelope} live={live} /> : <div className="empty">no result yet</div>}</div>
      </section>

      <Timeline
        frames={frames} live={live} at={scrub ?? run?.frameId}
        onScrub={(frame) => { setLive(false); showFrame(frame); }}
        onLive={() => { setScrub(null); setLive(true); void api.mode('live'); }}
      />
    </div>
  );
}

/**
 * The rig's own camera, beside the thermal frame it was taken with.
 *
 * Only for a dual-cam node, and deliberately labelled live rather than
 * pretending to be the frame you are scrubbed to: the edge keeps one RGB
 * frame in memory, not a history, so when you go back in time the thermal
 * is from then and this is from now. Saying so is better than implying a
 * pairing that does not exist -- the paired ones are what the recorder
 * writes for training.
 */
function LiveCamera({ uid, live }: { uid: string; live: boolean }) {
  const [tick, setTick] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // The rig pushes about twice a second; asking at 1 Hz is plenty.
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (failed) return null;
  return (
    <figure>
      <img
        className="rgbview"
        src={`/api/nodes/${encodeURIComponent(uid)}/rgb.jpg?t=${tick}`}
        alt="the rig's camera"
        onError={() => setFailed(true)}
      />
      <figcaption>
        rig camera · <span className="livenow">live now</span>
        {live ? '' : ' (the thermal beside it is from the past)'}
      </figcaption>
    </figure>
  );
}

/**
 * The scrubber, in the shape people already know from a live stream: pinned
 * to the right while it is live, and the moment you drag back it stops being
 * live and tells you the time you are looking at rather than a frame number.
 * A frame number is the right thing for the envelope and the wrong thing for
 * a person deciding whether they are watching now or two minutes ago.
 */
function Timeline({ frames, live, at, onScrub, onLive }: {
  frames: { frame: number; at: number; detections: number | null }[];
  live: boolean;
  at: number | undefined;
  onScrub: (frame: number) => void;
  onLive: () => void;
}) {
  const canWrite = useCapability('algo.write');
  // Re-render on a tick so "1 min ago" keeps up while nothing else changes.
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const last = frames.length - 1;
  const index = live ? last : Math.max(0, frames.findIndex((f) => f.frame === at));
  const selected = frames[index] ?? frames[last];
  const newest = frames[last];
  const behind = selected && newest ? Math.max(0, Math.round((newest.at - selected.at) / 1000)) : 0;
  const span = frames.length > 1 && newest && frames[0]
    ? Math.round((newest.at - frames[0].at) / 1000)
    : 0;

  return (
    <footer className="timeline">
      <span className="muted">{span >= 120 ? `${Math.round(span / 60)} min` : `${span} s`} of history</span>
      <input
        type="range" aria-label="Frame history" min={0} max={Math.max(0, last)} value={index}
        disabled={frames.length === 0}
        onChange={(e) => {
          const i = Number(e.target.value);
          // Dragged back to the newest frame: that is what going live means.
          if (i >= last) { onLive(); return; }
          const f = frames[i];
          if (f) onScrub(f.frame);
        }}
      />
      <button disabled={!canWrite} className={`livepill ${live ? 'on' : ''}`} onClick={onLive} title={live ? 'watching now' : 'back to now'}>
        {live
          ? <><span className="livedot" />LIVE</>
          : (
            <>
              <span className="clock">{selected ? new Date(selected.at).toLocaleTimeString() : '—'}</span>
              <span className="behind">{behind >= 60 ? `−${Math.round(behind / 60)} min` : `−${behind}s`}</span>
            </>
          )}
      </button>
    </footer>
  );
}

/**
 * Pair recording. Off unless someone asks: it writes pictures of a room to
 * disk, which is a different thing from the occupancy numbers this system
 * normally keeps.
 */
function TrainingData() {
  const canRecord = useCapability('algo.write');
  const [s, setS] = useState<Awaited<ReturnType<typeof api.pairs>> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void api.pairs().then((next) => { setS(next); setError(''); }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);
  if (!s) return error ? <p className="notice">{error}</p> : null;
  const mb = (s.bytes / 1048576).toFixed(0);
  return (
    <div className="lib-group training">
      <div className="lib-title">Training data</div>
      {error && <p className="notice" role="alert">{error}</p>}
      {s.rgbNodes.length === 0
        ? <p className="hint">No node here has an RGB camera, so there is nothing to learn from.</p>
        : (
          <>
            <div className="counts">
              <div><span>pairs</span><b>{s.samples}</b></div>
              <div><span>with people</span><b>{s.withPeople}</b></div>
              <div><span>on disk</span><b>{mb} MB</b></div>
            </div>
            <button className={`btn ${s.recording ? 'on' : ''}`} disabled={!canRecord || busy} onClick={() => {
              setBusy(true);
              setError('');
              void api.record(!s.recording).then((result) => {
                setS((current) => current ? { ...current, recording: result.recording, samples: result.samples } : current);
                refresh();
              }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
            }}>
              {s.recording ? '● Recording' : 'Start recording'}
            </button>
            {s.lastSkipped && <p className="hint">last skip: {s.lastSkipped}</p>}
          </>
        )}
    </div>
  );
}

/** Pick the viewer from what the node produced. */
function Output({ envelope, live }: { envelope: Envelope; live: boolean }) {
  const o = envelope.outputs;
  const d = envelope.debug;
  if (envelope.error) return <div className="error-box">{envelope.error}</div>;
  const warning = typeof d.warning === 'string' ? d.warning : null;
  return (
    <>
      {warning && <div className="warn-box">{warning}</div>}
      <Viewer envelope={envelope} o={o} d={d} live={live} />
    </>
  );
}

function Viewer({ envelope, o, d, live }: {
  envelope: Envelope; o: Record<string, unknown>; d: Record<string, unknown>; live: boolean;
}) {
  // This sensor is mounted left-right reversed, so the picture it sends is a
  // mirror of the room. Everything else on screen -- the floor plan, the
  // tables, the projected people -- is in room coordinates, so the thermal
  // views are flipped to match and say so underneath.
  const mirror = d.mirror === true;
  const mirrorNote = mirror ? ' · mirrored to match the room' : '';
  switch (envelope.type) {
    case 'thermal_input': {
      const f = o.frame as { pixels: string; min: number; max: number; mean: number } | undefined;
      if (f && !unpack(f.pixels)) return <div className="empty">invalid thermal frame</div>;
      return f ? (
        <div className="views">
          <figure><GridView pixels={unpack(f.pixels)} mirror={mirror} /><figcaption>raw thermal{mirrorNote}</figcaption></figure>
          {d.rgb === true && <LiveCamera uid={String(d.uid ?? '')} live={live} />}
          <div className="facts">
            <div><span>min</span><b>{f.min.toFixed(2)} °C</b></div>
            <div><span>max</span><b>{f.max.toFixed(2)} °C</b></div>
            <div><span>mean</span><b>{f.mean.toFixed(2)} °C</b></div>
          </div>
        </div>
      ) : <div className="empty">no frame</div>;
    }
    case 'background_subtraction':
      return (
        <div className={`views${d.rgb === true ? ' with-camera' : ''}`}>
          <figure><Plane data={o.background as never} colour="grey" mirror={mirror} /><figcaption>background model{mirrorNote}</figcaption></figure>
          <figure><Plane data={o.diff as never} mirror={mirror} /><figcaption>difference{mirrorNote}</figcaption></figure>
          <figure><Plane data={o.foreground as never} colour="mask" mirror={mirror} /><figcaption>foreground mask{mirrorNote}</figcaption></figure>
          {d.rgb === true && <LiveCamera uid={String(d.uid ?? '')} live={live} />}
        </div>
      );
    case 'human_detection': {
      const blobs = (o.detections ?? []) as never[];
      return (
        <div className="views">
          <figure>
            <Plane data={o.labels as never} colour="label" blobs={blobs} observed={(d.observed ?? []) as never[]} labelled mirror={mirror} />
            <figcaption>blobs (solid) vs what the sensor reported (dashed){mirrorNote}</figcaption>
          </figure>
          <div className="grow"><Table rows={blobs} /></div>
        </div>
      );
    }
    case 'projection': {
      const floor = d.floor as { width: number; height: number } | null;
      return floor ? (
        <PlanView width={floor.width} height={floor.height}
          tables={(d.tables ?? []) as never[]} points={(o.points ?? []) as never[]} />
      ) : <Json value={o} />;
    }
    case 'heatmap':
      return <PlanView width={((o.heat as HeatJson | null)?.cols ?? 0) * ((o.heat as HeatJson | null)?.cellCm ?? 25)}
        height={((o.heat as HeatJson | null)?.rows ?? 0) * ((o.heat as HeatJson | null)?.cellCm ?? 25)}
        heat={o.heat as HeatJson | null} />;
    case 'desk_estimator': {
      const stages = d.stages as { clusters: never[]; candidates: never[] } | undefined;
      const configured = (d.configured ?? []) as { x: number; y: number; width: number; height: number }[];
      const w = Math.max(100, ...configured.map((t) => t.x + t.width + 100));
      const h = Math.max(100, ...configured.map((t) => t.y + t.height + 100));
      return (
        <div className="views">
          <figure>
            <PlanView width={w} height={h} tables={configured as never[]}
              candidates={(stages?.candidates ?? []) as never[]} clusters={(stages?.clusters ?? []) as never[]} />
            <figcaption>grey = configured tables · green = proposed · orange dashed = rejected · dots = seat clusters</figcaption>
          </figure>
          <div className="grow"><Table rows={(stages?.candidates ?? []) as never[]} /></div>
        </div>
      );
    }
    case 'human_location_ml': {
      const m = d.model as { trainedAt: number; samples: number; metrics: Record<string, number>; notes: string | null } | undefined;
      if (d.untrained) {
        return (
          <div className="untrained">
            <b>No model for this node yet.</b>
            <p>
              Turn on pair recording below, leave it running while the room is used, then train off the box:
              <code>python3 tools/train_human_location.py data/algo/pairs --out data/algo/models</code>
              and drop the result at <code>{String(d.expects)}</code>.
            </p>
            <p className="muted">{String(d.how)}</p>
          </div>
        );
      }
      return (
        <div className="views">
          <figure>
            <Plane data={o.probabilities as never} blobs={(d.detections ?? []) as never[]}
              observed={(d.observed ?? []) as never[]} labelled mirror={d.mirror === true} />
            <figcaption>
              person probability · solid = this model, dashed = the sensor's own detector
              {d.mirror === true ? ' · mirrored to match the room' : ''}
            </figcaption>
          </figure>
          <div className="grow">
            <Table rows={(d.detections ?? []) as never[]} />
            {m && (
              <p className="muted" style={{ marginTop: 10 }}>
                fitted {new Date(m.trainedAt).toLocaleString()} on {m.samples} pairs ·
                held-out F1 {m.metrics?.f1} (precision {m.metrics?.precision}, recall {m.metrics?.recall}) ·
                median error {m.metrics?.medianErrorPx} px{m.notes ? ` · ${m.notes}` : ''}
              </p>
            )}
          </div>
        </div>
      );
    }
    case 'occupancy':
      return <Table rows={(d.why ?? []) as never[]} />;
    case 'frame_stats':
      return <Histogram bins={(d.histogram ?? []) as number[]} min={d.min as number} max={d.max as number} />;
    case 'final_map': {
      const floor = d.floor as { width: number; height: number } | null;
      return floor ? <PlanView width={floor.width} height={floor.height} tables={(d.tables ?? []) as never[]} /> : <Json value={d} />;
    }
    default:
      return <Json value={{ outputs: o, debug: d }} />;
  }
}

export function Root() {
  return <ReactFlowProvider><App /></ReactFlowProvider>;
}
