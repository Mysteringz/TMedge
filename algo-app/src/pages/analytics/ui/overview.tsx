/** The first screen: is anyone using it, is there room, is the machine well. Summary first, then trends, then service health. */
import { TimeSeriesChart } from '../../../widgets/charts/index.ts';
import { bytesText, count, delta, percent, PREVIOUS_PHRASE, RANGE_PHRASE, thin } from '../lib/format.ts';
import { Gate, Metrics, MetricTile, SectionHead, ServiceHealth } from './parts.tsx';
import type { ViewProps } from './view.ts';

export function Overview({ snapshot: s, range, loading }: ViewProps) {
  const usage = s.usage.data;
  const noUsage = s.usage.state === 'disabled' ? 'No web tier set up' : 'Web tier unavailable';
  const floors = s.occupancy.data?.floors ?? [];
  const known = floors.reduce((sum, f) => sum + (f.occupied === null ? 0 : f.seats - f.unknownSeats), 0);
  const taken = floors.reduce((sum, f) => sum + (f.occupied ?? 0), 0);
  const uncovered = floors.reduce((sum, f) => sum + f.unknownSeats, 0);
  const host = s.host.data;
  const disk = [...(s.storage.data?.disks ?? [])].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  const nodes = s.pipeline.data?.nodes;
  const occupancy = s.occupancy.data?.occupancy;
  const series = (frame: { series: { key: string; values: (number | null)[] }[] } | undefined, key: string) => frame?.series.find((x) => x.key === key)?.values;

  return (
    <>
      <SectionHead title="Students">Who is using HKUMySeat, and how much room they are finding.</SectionHead>
      <Metrics label="Student usage">
        <MetricTile label="Students online" value={usage ? count(usage.live.students) : null}
          note={usage ? `${count(usage.live.sockets)} live ${usage.live.sockets === 1 ? 'view' : 'views'} open` : noUsage} spark={thin(series(usage?.online, 'online.students'))} />
        <MetricTile label="Active students today" value={usage ? count(usage.active.today) : null}
          note={usage ? `${count(usage.active.yesterday)} yesterday · ${count(usage.active.last7Days)} in 7 days` : noUsage} spark={usage?.active.perDay.map((d) => d.students)} />
        <MetricTile label={`Seat searches, ${RANGE_PHRASE[range].toLowerCase()}`} value={usage ? count(usage.totals.searches) : null}
          delta={usage ? delta(usage.totals.searches, usage.previousTotals?.searches, PREVIOUS_PHRASE[range], 'up') : null}
          note={usage ? 'No earlier period to compare yet' : noUsage} spark={usage?.activity.series.find((x) => x.key === 'act.seat-search.succeeded')?.values} />
        <MetricTile label="Seats taken now" value={known > 0 ? count(taken) : null} unit={known > 0 ? `of ${count(known)}` : undefined}
          note={floors.length === 0 ? 'No public floor' : known === 0 ? 'No seat is covered by a working sensor' : uncovered > 0 ? `${count(uncovered)} more seats not covered` : `${percent(taken / known * 100)}% of seats`}
          spark={thin(series(occupancy, 'occ.all.pct'))} />
      </Metrics>

      <SectionHead title="Infrastructure">The machine everything runs on, and the sensors feeding it.</SectionHead>
      <Metrics label="Infrastructure">
        <MetricTile label="Processor" value={host?.cpu.busyPercent != null ? percent(host.cpu.busyPercent) : null} unit="%"
          note={host ? `Load ${host.cpu.load1.toFixed(2)} on ${host.cores} ${host.cores === 1 ? 'core' : 'cores'}` : 'First reading pending'} spark={thin(series(s.charts.cpu, 'cpu.busy'))} />
        <MetricTile label="Memory" value={host ? percent(host.memory.usedPercent) : null} unit="%"
          note={host ? `${bytesText(host.memory.usedBytes)} of ${bytesText(host.memory.totalBytes)}` : 'First reading pending'} spark={thin(series(s.charts.memory, 'mem.used'))} />
        <MetricTile label={disk ? disk.label : 'Storage'} value={disk ? percent(disk.usedPercent) : null} unit="%"
          note={disk ? (disk.daysUntilFull !== null && disk.daysUntilFull < 365 ? `Full in about ${Math.max(1, Math.round(disk.daysUntilFull))} days at this rate` : `${bytesText(disk.freeBytes)} free`) : 'First reading pending'}
          spark={disk ? thin(series(s.charts.disk, `disk.${disk.id}.pct`)) : undefined} />
        <MetricTile label="Sensors reporting" value={nodes ? count(nodes.online) : null} unit={nodes ? `of ${count(nodes.registered)}` : undefined}
          note={nodes ? `${count(nodes.realOnline)} of ${count(nodes.real)} physical sensors` : 'First reading pending'} spark={thin(series(s.charts.sensors, 'nodes.online'))} />
      </Metrics>

      <div className="an-grid">
        <div className="an-span-6">
          <Gate source={s.usage} name="Student usage"
            unavailable="The web tier did not answer, so there is no count of students to show. This is not a count of zero."
            disabled="This edge does not publish to a web tier, so there are no students to count.">
            {(u) => <TimeSeriesChart title="Students online" subtitle={`${RANGE_PHRASE[range]} · signed-in students with the live view open`}
              times={u.online.times} stepMs={u.online.stepMs} series={u.online.series.filter((x) => x.key === 'online.students')} loading={loading} colorStart={2} />}
          </Gate>
        </div>
        <div className="an-span-6">
          {occupancy && <TimeSeriesChart title="Seats taken" subtitle={`${RANGE_PHRASE[range]} · share of the seats a working sensor covers`}
            times={occupancy.times} stepMs={occupancy.stepMs} series={occupancy.series} unit="%" max={100} loading={loading} />}
        </div>
        <div>
          <Gate source={s.services} name="Service health" unavailable="The first reading has not been taken yet." disabled="">
            {(rows) => <ServiceHealth rows={rows} />}
          </Gate>
        </div>
      </div>
    </>
  );
}
