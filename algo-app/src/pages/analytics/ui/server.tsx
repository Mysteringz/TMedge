/** The machine and the back end: processor, memory, storage, network, the processes and what they are passing along. */
import { TimeSeriesChart } from '../../../widgets/charts/index.ts';
import { ago, bytes, bytesText, count, dateTime, duration, percent, RANGE_PHRASE, scaled, thin } from '../lib/format.ts';
import { Facts, Gate, Meter, Metrics, MetricTile, Notice, Panel, SectionHead, ServiceHealth, Status } from './parts.tsx';
import type { ViewProps } from './view.ts';

const MB = 1024 ** 2;

export function Server({ snapshot: s, range, loading, now }: ViewProps) {
  const host = s.host.data, proc = s.process.data, pipe = s.pipeline.data, storage = s.storage.data;
  const pending = 'First reading pending';
  const series = (frame: { series: { key: string; values: (number | null)[] }[] }, key: string) => frame.series.find((x) => x.key === key)?.values;
  const swap = host?.memory.swapTotalBytes ? (host.memory.swapUsedBytes ?? 0) / host.memory.swapTotalBytes * 100 : null;
  const data = storage?.disks.find((d) => d.id === 'data') ?? storage?.disks[0];
  const rss = proc ? bytes(proc.rssBytes) : null;
  const phrase = RANGE_PHRASE[range];

  return (
    <>
      <SectionHead title="Host">The machine itself.</SectionHead>
      <Metrics label="Host">
        <MetricTile label="Processor" value={host?.cpu.busyPercent != null ? percent(host.cpu.busyPercent) : null} unit="%"
          note={host ? `Load ${host.cpu.load1.toFixed(2)} · ${host.cpu.load5.toFixed(2)} · ${host.cpu.load15.toFixed(2)} on ${host.cores} ${host.cores === 1 ? 'core' : 'cores'}` : pending}
          spark={thin(series(s.charts.cpu, 'cpu.busy'))} />
        <MetricTile label="Memory" value={host ? percent(host.memory.usedPercent) : null} unit="%"
          note={host ? `${bytesText(host.memory.usedBytes)} of ${bytesText(host.memory.totalBytes)} in use` : pending} spark={thin(series(s.charts.memory, 'mem.used'))} />
        <MetricTile label="Swap" value={swap === null ? null : percent(swap)} unit="%"
          note={host ? (host.memory.swapTotalBytes ? `${bytesText(host.memory.swapUsedBytes ?? 0)} of ${bytesText(host.memory.swapTotalBytes)}` : host.memory.swapTotalBytes === 0 ? 'No swap configured' : 'Not reported on this system') : pending}
          spark={thin(series(s.charts.memory, 'swap.used'))} />
        <MetricTile label={data ? data.label : 'Storage'} value={data ? percent(data.usedPercent) : null} unit="%"
          note={data ? (data.daysUntilFull !== null && data.daysUntilFull < 365 ? `Full in about ${Math.max(1, Math.round(data.daysUntilFull))} days at this rate` : `${bytesText(data.freeBytes)} free of ${bytesText(data.totalBytes)}`) : pending}
          spark={data ? thin(series(s.charts.disk, `disk.${data.id}.pct`)) : undefined} />
      </Metrics>
      <div className="an-grid">
        <div className="an-span-6">
          <TimeSeriesChart title="Processor" subtitle={`${phrase} · share of all cores${s.charts.cpu.series.length > 1 ? '; stolen time is the host throttling this instance' : ''}`}
            times={s.charts.cpu.times} stepMs={s.charts.cpu.stepMs} series={s.charts.cpu.series} unit="%" max={100} decimals={1} loading={loading} />
        </div>
        <div className="an-span-6">
          <TimeSeriesChart title="Memory" subtitle={`${phrase} · share in use; cache that can be given back is not counted`}
            times={s.charts.memory.times} stepMs={s.charts.memory.stepMs} series={s.charts.memory.series} unit="%" max={100} decimals={1} loading={loading} />
        </div>
        <div className="an-span-6">
          <TimeSeriesChart title="Storage used" subtitle={`${phrase} · share of each volume`}
            times={s.charts.disk.times} stepMs={s.charts.disk.stepMs} series={s.charts.disk.series} unit="%" max={100} decimals={1} loading={loading} colorStart={s.charts.disk.series.length > 1 ? 1 : 2} />
        </div>
        <div className="an-span-6">
          <TimeSeriesChart title="Network" subtitle={`${phrase} · all interfaces but loopback`}
            {...kilobytes(s.charts.network)} unit="kB/s" decimals={1} loading={loading} />
        </div>

        <Panel title="Storage" sub="What each volume holds" className="an-span-6">
          <Gate source={s.storage} name="Storage" unavailable="The first reading has not been taken yet." disabled="">
            {(st) => (
              <div className="an-stack">
                {st.disks.map((disk) => (
                  <Meter key={disk.id} title={disk.label} total={disk.totalBytes} totalText={`${bytesText(disk.usedBytes)} of ${bytesText(disk.totalBytes)}`}
                    parts={[{ key: 'used', label: 'Used', value: disk.usedBytes, text: bytesText(disk.usedBytes) }]}
                    readout={`${bytesText(disk.freeBytes)} free${disk.growthBytesPerDay !== null ? ` · ${disk.growthBytesPerDay >= 0 ? 'growing' : 'shrinking'} ${bytesText(Math.abs(disk.growthBytesPerDay))} a day${disk.daysUntilFull !== null ? ` · full in about ${Math.max(1, Math.round(disk.daysUntilFull))} days` : ''}` : ' · growth not measured yet (needs six hours of history)'}`} />
                ))}
                {st.disks.length === 0 && <Notice kind="warning" title="No volume could be read">Storage figures are left out rather than shown as empty.</Notice>}
                {st.breakdown
                  ? <Meter title="Data directory" total={st.breakdown.entries.reduce((sum, e) => sum + e.bytes, 0)}
                    totalText={`${st.breakdown.truncated ? 'At least ' : ''}${bytesText(st.breakdown.entries.reduce((sum, e) => sum + e.bytes, 0))}`}
                    parts={st.breakdown.entries.map((e) => ({ key: e.name, label: e.name, value: e.bytes, text: bytesText(e.bytes) }))}
                    readout={`Measured ${ago(st.breakdown.scannedAt, now)}${st.breakdown.truncated ? ' · stopped early, so these are lower bounds' : ''} · ${bytesText(st.recordedTodayBytes)} recorded today`} />
                  : <p className="cx-hint">Measuring the data directory. This runs in the background and appears when it finishes.</p>}
              </div>
            )}
          </Gate>
        </Panel>
        <Panel title="This machine" className="an-span-6">
          {host && proc ? <Facts rows={[
            { label: 'Host', value: host.hostname, mono: true },
            { label: 'System', value: `${host.platform} ${host.kernel} (${host.arch})`, mono: true },
            { label: 'Processor', value: `${host.cores} × ${host.cpuModel ?? 'unknown model'}` },
            { label: 'Up for', value: duration(host.uptimeS) },
            { label: 'Release', value: proc.release ?? 'Not a release directory', mono: !!proc.release },
            { label: 'Edge', value: `${proc.edgeId} · version ${proc.version}`, mono: true },
            { label: 'Node.js', value: proc.node, mono: true },
            { label: 'Records kept in', value: proc.persistence === 'postgres' ? 'PostgreSQL' : 'Files' },
            { label: 'History since', value: s.collectingSince === null ? 'Not started' : dateTime(s.collectingSince) },
          ]} /> : <p className="cx-hint">{pending}</p>}
        </Panel>
      </div>

      <SectionHead title="Services">What is running, and how it has held up.</SectionHead>
      <Gate source={s.services} name="Service health" unavailable="The first reading has not been taken yet." disabled="">
        {(rows) => <ServiceHealth rows={rows} />}
      </Gate>
      {s.units.state === 'available' && s.units.data && s.units.data.length > 0 && (
        <Panel title="System units" sub="As systemd reports them, now">
          <div className="cx-table-scroll">
            <table className="table an-table an-table--roomy">
              <thead><tr><th scope="col">Unit</th><th scope="col">State</th><th scope="col">Active since</th><th scope="col" className="an-num">Restarts</th><th scope="col" className="an-num">Memory</th></tr></thead>
              <tbody>{s.units.data.map((unit) => (
                <tr key={unit.unit}>
                  <th scope="row"><span className="cx-mono">{unit.unit}</span></th>
                  <td><Status status={unit.activeState === 'active' ? 'ok' : unit.activeState === 'failed' ? 'err' : unit.activeState === 'inactive' ? 'off' : 'warn'}>{unit.activeState === 'active' ? `Active (${unit.subState})` : unit.activeState === 'failed' ? 'Failed' : unit.activeState === 'inactive' ? `Inactive (${unit.subState})` : unit.activeState}</Status></td>
                  <td>{unit.activeSince === null ? '–' : `${dateTime(unit.activeSince)} · ${ago(unit.activeSince, now)}`}</td>
                  <td className="an-num">{unit.restarts === null ? '–' : count(unit.restarts)}</td>
                  <td className="an-num">{unit.memoryBytes === null ? '–' : bytesText(unit.memoryBytes)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Panel>
      )}
      {s.units.state === 'unavailable' && <Notice kind="warning" title="System units are unavailable">systemd did not answer. Unit states are left out rather than shown as stopped.</Notice>}

      <SectionHead title="Edge process and pipeline">The process that takes in sensor packets and works out occupancy.</SectionHead>
      <Metrics label="Edge process">
        <MetricTile label="Edge memory" value={rss?.value ?? null} unit={rss?.unit} note={proc ? `${bytesText(proc.heapBytes)} of it JavaScript heap` : pending} spark={thin(series(s.charts.edgeMemory, 'edge.rss'))} />
        <MetricTile label="Event-loop delay" value={proc?.eventLoopLagMs != null ? percent(proc.eventLoopLagMs, 1) : null} unit="ms"
          note={proc ? `Running for ${duration(proc.uptimeS)}` : pending} spark={thin(series(s.charts.eventLoop, 'edge.lag'))} />
        <MetricTile label="Sensor packets" value={pipe ? percent(pipe.packetsPerSec, 1) : null} unit="/s"
          note={pipe ? `${bytesText(pipe.bytesPerSec)}/s · ${percent(pipe.rejectedPerMin, 1)} rejected a minute` : pending} spark={thin(series(s.charts.ingest, 'ingest.packets'))} />
        <MetricTile label="Sensors reporting" value={pipe ? count(pipe.nodes.online) : null} unit={pipe ? `of ${count(pipe.nodes.registered)}` : undefined}
          note={pipe ? `${count(pipe.nodes.realOnline)} of ${count(pipe.nodes.real)} physical sensors` : pending} spark={thin(series(s.charts.sensors, 'nodes.online'))} />
      </Metrics>
      <div className="an-grid">
        <div className="an-span-4">
          <TimeSeriesChart title="Edge memory" subtitle={phrase} {...megabytes(s.charts.edgeMemory)} unit="MB" loading={loading} />
        </div>
        <div className="an-span-4">
          <TimeSeriesChart title="Edge processor time" subtitle={`${phrase} · share of one core`}
            times={s.charts.edgeCpu.times} stepMs={s.charts.edgeCpu.stepMs} series={s.charts.edgeCpu.series} unit="%" decimals={1} loading={loading} colorStart={3} />
        </div>
        <div className="an-span-4">
          <TimeSeriesChart title="Event-loop delay" subtitle={`${phrase} · 99th percentile per sample`}
            times={s.charts.eventLoop.times} stepMs={s.charts.eventLoop.stepMs} series={s.charts.eventLoop.series} unit="ms" decimals={1} loading={loading} colorStart={4} />
        </div>
        <div className="an-span-6">
          <TimeSeriesChart title="Sensor packets" subtitle={`${phrase} · accepted packets per second`}
            times={s.charts.ingest.times} stepMs={s.charts.ingest.stepMs} series={s.charts.ingest.series} unit="/s" decimals={1} loading={loading} colorStart={2} />
        </div>
        <div className="an-span-6">
          <TimeSeriesChart title="Sensors reporting" subtitle={`${phrase} · against the number registered`}
            times={s.charts.sensors.times} stepMs={s.charts.sensors.stepMs} series={s.charts.sensors.series} decimals={s.charts.sensors.stepMs > 10_000 ? 1 : 0} loading={loading} />
        </div>
        <div className="an-span-6">
          <TimeSeriesChart title="Rejected packets" subtitle={`${phrase} · per minute; a bad signature, a replay or an unknown sender`}
            times={s.charts.rejected.times} stepMs={s.charts.rejected.stepMs} series={s.charts.rejected.series} unit="/min" decimals={1} loading={loading} />
        </div>
        <Panel title="Pipeline" sub="Now" className="an-span-6">
          {pipe ? <Facts rows={[
            ...pipe.publish.map((target) => ({ label: `Publishing to ${target.target}`, value: <Status status={target.ok ? 'ok' : target.tried ? 'err' : 'off'}>{target.ok ? `Delivered ${ago(target.lastOkAt, now)}` : !target.tried ? 'Starting up' : target.lastOkAt === null ? 'Never delivered' : `Failing · last delivered ${ago(target.lastOkAt, now)}`}</Status> })),
            ...(pipe.publish.length === 0 ? [{ label: 'Publishing', value: 'No web tier configured' }] : []),
            { label: 'Recorder', value: <Status status={pipe.recorder.healthy ? 'ok' : 'err'}>{pipe.recorder.healthy ? `Writing · ${bytesText(pipe.recorder.bytesToday)} today${pipe.recorder.rawEnabled ? ', raw frames included' : ''}` : 'Write errors'}</Status> },
            { label: 'Site gateways connected', value: count(pipe.gateways) },
            { label: 'Direct sensor sessions', value: pipe.directSessions === null ? 'Listener off' : count(pipe.directSessions) },
            ...(pipe.rejectReasons.length > 0 ? [{ label: 'Rejected since start', value: pipe.rejectReasons.map((r) => `${r.reason} (${count(r.count)})`).join(' · ') }] : []),
          ]} /> : <p className="cx-hint">{pending}</p>}
        </Panel>
      </div>
    </>
  );
}

function megabytes(frame: ViewProps['snapshot']['charts']['edgeMemory']) {
  const f = scaled(frame, MB);
  return { times: f.times, stepMs: f.stepMs, series: f.series };
}
function kilobytes(frame: ViewProps['snapshot']['charts']['network']) {
  const f = scaled(frame, 1024);
  return { times: f.times, stepMs: f.stepMs, series: f.series };
}
