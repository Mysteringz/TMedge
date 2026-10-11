/**
 * Six figures from the last hour of Analytics, so the landing page answers
 * "is everything all right" before anyone opens a module.
 *
 * The same rule as the page they come from: a source that did not answer has
 * no figure. A tile then shows a dash and says why, never a zero.
 */
import { useAnalytics, type AnalyticsSnapshot } from '../../../entities/analytics/index.ts';
import { navigate } from '../../../console/router.ts';
import { ArrowRight } from '../../../console/icons.tsx';
import { Sparkline } from '../../charts/index.ts';

interface Tile { label: string; value: string | null; unit?: string; note: string; spark?: (number | null)[] }

const count = (value: number) => value.toLocaleString();
const whole = (value: number) => Math.round(value).toLocaleString();
function size(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toLocaleString(undefined, { maximumFractionDigits: gb >= 100 ? 0 : 1 })} GB` : `${Math.round(bytes / 1024 ** 2).toLocaleString()} MB`;
}
/** About forty points is all a sparkline this small can show; shape is what it has to keep. */
function thin(values: (number | null)[] | undefined): (number | null)[] | undefined {
  if (!values || values.length <= 40) return values;
  const every = Math.ceil(values.length / 40), out: (number | null)[] = [];
  for (let i = values.length - 1; i >= 0; i -= every) out.unshift(values[i] ?? null);
  return out;
}
const series = (frame: { series: { key: string; values: (number | null)[] }[] } | undefined, key: string) => thin(frame?.series.find((s) => s.key === key)?.values);

function tiles(s: AnalyticsSnapshot): Tile[] {
  const nodes = s.pipeline.data?.nodes, host = s.host.data, usage = s.usage.data;
  const floors = s.occupancy.data?.floors ?? [];
  // Seats a working sensor covers; the rest are unknown, which is not the same as free.
  const known = floors.reduce((sum, f) => sum + (f.occupied === null ? 0 : f.seats - f.unknownSeats), 0);
  const taken = floors.reduce((sum, f) => sum + (f.occupied ?? 0), 0);
  const uncovered = floors.reduce((sum, f) => sum + f.unknownSeats, 0);
  const disk = [...(s.storage.data?.disks ?? [])].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  const pending = 'First reading pending';
  return [
    { label: 'Sensors reporting', value: nodes ? count(nodes.online) : null, unit: nodes ? `of ${count(nodes.registered)}` : undefined,
      note: nodes ? `${count(nodes.realOnline)} of ${count(nodes.real)} physical` : pending, spark: series(s.charts.sensors, 'nodes.online') },
    { label: 'Seats taken now', value: known > 0 ? count(taken) : null, unit: known > 0 ? `of ${count(known)}` : undefined,
      note: floors.length === 0 ? 'No public floor' : known === 0 ? 'No seat is covered by a working sensor' : uncovered > 0 ? `${count(uncovered)} more not covered` : `${whole(taken / known * 100)}% of seats`,
      spark: series(s.occupancy.data?.occupancy, 'occ.all.pct') },
    { label: 'Students online', value: usage ? count(usage.live.students) : null,
      note: usage ? `${count(usage.live.sockets)} live ${usage.live.sockets === 1 ? 'view' : 'views'} open` : s.usage.state === 'disabled' ? 'No web tier set up' : 'Web tier unavailable',
      spark: series(usage?.online, 'online.students') },
    { label: 'Processor', value: host?.cpu.busyPercent != null ? whole(host.cpu.busyPercent) : null, unit: '%',
      note: host ? `Load ${host.cpu.load1.toFixed(2)} on ${host.cores} ${host.cores === 1 ? 'core' : 'cores'}` : pending, spark: series(s.charts.cpu, 'cpu.busy') },
    { label: 'Memory', value: host ? whole(host.memory.usedPercent) : null, unit: '%',
      note: host ? `${size(host.memory.usedBytes)} of ${size(host.memory.totalBytes)}` : pending, spark: series(s.charts.memory, 'mem.used') },
    { label: disk ? disk.label : 'Storage', value: disk ? whole(disk.usedPercent) : null, unit: '%',
      note: disk ? (disk.daysUntilFull !== null && disk.daysUntilFull < 365 ? `Full in about ${Math.max(1, Math.round(disk.daysUntilFull))} days` : `${size(disk.freeBytes)} free`) : pending,
      spark: disk ? series(s.charts.disk, `disk.${disk.id}.pct`) : undefined },
  ];
}

const EMPTY: Tile[] = ['Sensors reporting', 'Seats taken now', 'Students online', 'Processor', 'Memory', 'Storage'].map((label) => ({ label, value: null, note: '' }));

/** A landing page is left open all day; twice a minute is plenty for six figures. */
const REFRESH_MS = 30_000;

export function SystemTiles() {
  const { snapshot, loading, error, now } = useAnalytics('1h', REFRESH_MS);
  const age = snapshot ? Math.max(0, Math.round((now - snapshot.generatedAt) / 1000)) : null;
  // Three missed readings and the figures are history, and are labelled as such.
  const stale = age !== null && age > 90;
  return (
    <section className="ws-system" aria-labelledby="ws-system-title">
      <div className="ws-head">
        <h2 id="ws-system-title" className="ws-head__title">System now</h2>
        {/* Not a live region: once stale this counts up, and nobody wants that read out. */}
        <span className="ws-head__note">
          {!snapshot ? (loading ? 'Loading…' : 'Not available') : stale || error ? `Last reading ${age !== null && age >= 120 ? `${Math.round(age / 60)} min` : `${age} s`} ago` : 'Live'}
        </span>
        <a className="ws-link" href="/analytics" onClick={(event) => { event.preventDefault(); navigate('/analytics'); }}>Analytics<ArrowRight /></a>
      </div>
      <div className={`ws-tiles ${stale || error ? 'is-stale' : ''}`} role="group" aria-label="System figures">
        {(snapshot ? tiles(snapshot) : EMPTY).map((tile) => (
          <div className="ws-tile" key={tile.label}>
            <div className="ws-tile__label">{tile.label}</div>
            <div className="ws-tile__figure">
              <div className="ws-tile__value">
                {tile.value ?? <span className="ws-tile__unknown" title="Not known">–</span>}
                {tile.value !== null && tile.unit && <span className="ws-tile__unit">{tile.unit}</span>}
              </div>
              {tile.value !== null && tile.spark && <Sparkline values={tile.spark} />}
            </div>
            <div className="ws-tile__note">{tile.note || (snapshot ? ' ' : loading ? 'Loading…' : 'Analytics could not be read')}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
