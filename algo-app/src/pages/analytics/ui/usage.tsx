/** How HKUMySeat is used: who comes, what they do, and how full the rooms they are looking at get. */
import { BarChart, ColumnChart, Heatmap, TimeSeriesChart } from '../../../widgets/charts/index.ts';
import type { StudentUsage } from '../../../entities/analytics/index.ts';
import { ago, bytesText, count, delta, duration, percent, PREVIOUS_PHRASE, RANGE_PHRASE, routeGroupName, zoneName } from '../lib/format.ts';
import { Facts, Gate, Metrics, MetricTile, Panel, SectionHead } from './parts.tsx';
import { counted, type ViewProps } from './view.ts';

export function Usage(props: ViewProps) {
  const { snapshot: s, range, loading } = props;
  const occupancy = s.occupancy.data;
  return (
    <>
      <Gate source={s.usage} name="Student usage"
        unavailable="The web tier did not answer, so nothing below can be counted. The panels are left out rather than filled with zeros."
        disabled="This edge does not publish to a web tier. Set WEB_PUSH_URLS to the student site to see how it is used.">
        {(u) => <Students usage={u} {...props} />}
      </Gate>

      <SectionHead title="Seats">How full the public floors are. A seat no working sensor covers is left out, never counted as free.</SectionHead>
      <Gate source={s.occupancy} name="Occupancy" unavailable="The first reading has not been taken yet." disabled="">
        {(o) => (
          <div className="an-grid">
            <div className="an-span-6">
              <TimeSeriesChart title="Seats taken" subtitle={`${RANGE_PHRASE[range]} · share of covered seats`}
                times={o.occupancy.times} stepMs={o.occupancy.stepMs} series={o.occupancy.series} unit="%" max={100} loading={loading} />
            </div>
            <div className="an-span-6">
              <Heatmap title="Busiest hours" subtitle={o.weekly.days > 0 ? `Average share of seats taken · ${o.weekly.days} ${o.weekly.days === 1 ? 'day' : 'days'} of data · ${zoneName(s.timezone)}` : `${zoneName(s.timezone)}`}
                rows={o.weekly.rows} cols={o.weekly.cols} values={o.weekly.values} seriesName="Seats taken" unit="%" loading={loading} />
            </div>
            <Panel title="Floors right now" sub="As students see them">
              <div className="cx-table-scroll">
                <table className="table an-table an-table--roomy">
                  <thead><tr><th scope="col">Floor</th><th scope="col" className="an-num">Seats</th><th scope="col" className="an-num">Taken</th><th scope="col" className="an-num">Free</th><th scope="col" className="an-num">Not covered</th></tr></thead>
                  <tbody>
                    {occupancy?.floors.map((floor) => (
                      <tr key={floor.id}>
                        <th scope="row">{floor.name}</th><td className="an-num">{count(floor.seats)}</td>
                        <td className="an-num">{floor.occupied === null ? 'Unknown' : count(floor.occupied)}</td>
                        <td className="an-num">{floor.free === null ? 'Unknown' : count(floor.free)}</td>
                        <td className="an-num">{count(floor.unknownSeats)}</td>
                      </tr>
                    ))}
                    {occupancy?.floors.length === 0 && <tr><td colSpan={5}>No public floor is configured.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        )}
      </Gate>
    </>
  );
}

function Students({ usage: u, range, loading, snapshot, now }: ViewProps & { usage: StudentUsage }) {
  const t = u.totals, p = u.previousTotals;
  const versus = PREVIOUS_PHRASE[range];
  const noBefore = 'No earlier period to compare yet';
  const createdInRange = u.accounts.createdPerDay?.reduce((sum, day) => sum + day.created, 0) ?? null;
  const noResultShare = t.searches > 0 ? t.noResultSearches / t.searches * 100 : null;
  const previousNoResultShare = p && p.searches > 0 ? p.noResultSearches / p.searches * 100 : null;
  const failed = t.failedSignIns + t.rateLimitedSignIns;
  const activity = counted(u.activity, u.collectingSince);
  const signIns = counted(u.signIns, u.collectingSince);
  const errors = t.clientErrors + t.serverErrors;
  return (
    <>
      <SectionHead title="Students">Counted on the student site. Each student is counted once, and none is named here.</SectionHead>
      <Metrics label="Students">
        <MetricTile label="Registered students" value={u.accounts.total === null ? null : count(u.accounts.total)}
          note={u.accounts.total === null ? 'Account store did not answer' : createdInRange === null ? '' : `${count(createdInRange)} new in the last ${u.accounts.createdPerDay?.length ?? 0} days`}
          spark={u.accounts.createdPerDay?.map((d) => d.total)} />
        <MetricTile label="Active today" value={count(u.active.today)} note={`${count(u.active.yesterday)} yesterday`} spark={u.active.perDay.map((d) => d.students)} />
        <MetricTile label="Active in 7 days" value={count(u.active.last7Days)}
          note={u.accounts.total ? `${percent(u.active.last7Days / u.accounts.total * 100)}% of registered students` : ''} />
        <MetricTile label="Active in 30 days" value={count(u.active.last30Days)}
          note={u.accounts.total ? `${percent(u.active.last30Days / u.accounts.total * 100)}% of registered students` : ''} />
      </Metrics>
      <Metrics label={`Activity, ${RANGE_PHRASE[range].toLowerCase()}`}>
        <MetricTile label="Seat searches" value={count(t.searches)} delta={delta(t.searches, p?.searches, versus, 'up')} note={noBefore} spark={u.activity.series[0]?.values} />
        <MetricTile label="Searches finding no seat" value={noResultShare === null ? null : percent(noResultShare)} unit="%"
          delta={noResultShare === null || previousNoResultShare === null ? null : delta(noResultShare, previousNoResultShare, versus, 'down', 'points')}
          note={noResultShare === null ? 'No searches in this range' : `${count(t.noResultSearches)} of ${count(t.searches)} searches`} />
        <MetricTile label="Sign-ins" value={count(t.signIns)} delta={delta(t.signIns, p?.signIns, versus, 'up')} note={noBefore} spark={u.signIns.series[0]?.values} />
        <MetricTile label="Failed sign-ins" value={count(failed)} delta={p ? delta(failed, p.failedSignIns + p.rateLimitedSignIns, versus, 'down', 'count') : null}
          note={t.rateLimitedSignIns > 0 ? `${count(t.rateLimitedSignIns)} stopped by the rate limit` : noBefore} />
      </Metrics>

      <div className="an-grid">
        <div className="an-span-6">
          <ColumnChart title="Active students by day" subtitle={`Different students each day · ${zoneName(u.timezone)}`}
            times={u.active.perDay.map(() => 0)} labels={u.active.perDay.map((d) => d.day)} stepMs={86_400_000}
            values={u.active.perDay.map((d) => d.students)} seriesName="Active students" loading={loading} daily />
        </div>
        <div className="an-span-6">
          <TimeSeriesChart title="Students online" subtitle={`${RANGE_PHRASE[range]} · students with the live view open, and how many views`}
            times={u.online.times} stepMs={u.online.stepMs} series={u.online.series} loading={loading} decimals={u.online.stepMs > 10_000 ? 1 : 0} />
        </div>
        <div className="an-span-8">
          <TimeSeriesChart title="What students did" subtitle={`${RANGE_PHRASE[range]} · actions per ${stepName(u.activity)}`}
            times={activity.times} stepMs={activity.stepMs} series={activity.series} loading={loading} daily={u.activity.daily} />
        </div>
        <div className="an-span-4">
          <BarChart title="Seats asked for" subtitle={`${RANGE_PHRASE[range]} · searches by group size`} ordered labelWidth={84}
            items={u.partySizes.map((size) => ({ label: size.seats === '1' ? '1 seat' : size.seats === '6+' ? '6 or more' : `${size.seats} seats`, value: size.searches }))}
            seriesName="Searches" itemName="Group size" loading={loading} empty="No searches in this range." />
        </div>
        <div className="an-span-6">
          <BarChart title="Most viewed spaces" subtitle={`${RANGE_PHRASE[range]} · times a floor was opened`}
            items={u.topFloors.map((floor) => ({ label: floor.name, value: floor.views }))} seriesName="Views" itemName="Space" labelWidth={150} loading={loading} empty="No space was opened in this range." />
        </div>
        <div className="an-span-6">
          <BarChart title="Most chosen tables" subtitle={`${RANGE_PHRASE[range]} · times a table was picked`}
            items={u.topTables.map((table) => ({ label: table.name, value: table.selects, note: snapshot.occupancy.data?.floors.find((f) => f.id === table.floorId)?.name }))}
            seriesName="Selections" itemName="Table" labelWidth={150} colorSlot={4} loading={loading} empty="No table was picked in this range." />
        </div>
        <div className="an-span-6">
          <TimeSeriesChart title="Sign-ins" subtitle={`${RANGE_PHRASE[range]} · attempts per ${stepName(u.signIns)}, by outcome`}
            times={signIns.times} stepMs={signIns.stepMs} series={signIns.series} loading={loading} daily={u.signIns.daily} />
        </div>
        <div className="an-span-6">
          {u.accounts.createdPerDay
            ? <ColumnChart title="New accounts by day" subtitle={`Accounts created · ${zoneName(u.timezone)}`}
              times={u.accounts.createdPerDay.map(() => 0)} labels={u.accounts.createdPerDay.map((d) => d.day)} stepMs={86_400_000}
              values={u.accounts.createdPerDay.map((d) => d.created)} seriesName="New accounts" colorSlot={3} loading={loading} daily />
            : <Panel title="New accounts by day"><p className="an-chart__empty">The account store could not list when accounts were created.</p></Panel>}
        </div>
      </div>

      <SectionHead title="Student site traffic">Requests from students' browsers. The edge's own pushes and health checks are left out.</SectionHead>
      <Metrics label="Traffic">
        <MetricTile label="Requests" value={count(t.requests)} delta={delta(t.requests, p?.requests, versus, 'neither')} note={noBefore} spark={u.requests.series[0]?.values} />
        <MetricTile label="Requests refused or failed" value={t.requests > 0 ? percent(errors / t.requests * 100, 1) : null} unit="%"
          note={t.requests > 0 ? `${count(t.serverErrors)} server errors · ${count(t.clientErrors)} refused` : 'No requests in this range'} />
        <MetricTile label="Web tier memory" value={bytesText(u.process.rssBytes).split(' ')[0] ?? null} unit={bytesText(u.process.rssBytes).split(' ')[1]}
          note={`Running for ${duration(u.process.uptimeS)}`} />
        <MetricTile label="Web tier event-loop delay" value={percent(u.process.eventLoopLagMs, 1)} unit="ms" note="99th percentile, last sample" />
      </Metrics>
      <div className="an-grid">
        <div className="an-span-6">
          <TimeSeriesChart title="Requests per minute" subtitle={`${RANGE_PHRASE[range]} · all student requests, and those refused or failed`}
            times={u.requests.times} stepMs={u.requests.stepMs} series={u.requests.series} unit="/min" decimals={1} loading={loading} />
        </div>
        <div className="an-span-6">
          <TimeSeriesChart title="Response time" subtitle={`${RANGE_PHRASE[range]} · time to answer a student request`}
            times={u.latency.times} stepMs={u.latency.stepMs} series={u.latency.series} unit="ms" decimals={1} loading={loading} />
        </div>
        <Panel title="Requests by kind" sub={RANGE_PHRASE[range]} className="an-span-8">
          {u.routeGroups.length === 0 ? <p className="an-chart__empty">No requests in this range.</p> : (
            <div className="cx-table-scroll">
              <table className="table an-table an-table--roomy">
                <thead><tr><th scope="col">Kind</th><th scope="col" className="an-num">Requests</th><th scope="col" className="an-num">Refused (4xx)</th><th scope="col" className="an-num">Failed (5xx)</th></tr></thead>
                <tbody>{u.routeGroups.map((group) => (
                  <tr key={group.group}><th scope="row">{routeGroupName(group.group)}</th><td className="an-num">{count(group.requests)}</td>
                    <td className="an-num">{count(group.clientErrors)}</td><td className="an-num">{count(group.serverErrors)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="Web tier" sub="The process serving students" className="an-span-4">
          <Facts rows={[
            { label: 'Running for', value: duration(u.process.uptimeS) },
            { label: 'Accounts kept in', value: u.process.accountStorage === 'postgres' ? 'PostgreSQL' : 'A file' },
            { label: 'Node.js', value: u.process.node, mono: true },
            ...u.process.edges.map((edge) => ({ label: `Last snapshot from ${edge.edgeId}`, value: ago(now - edge.ageMs, now) })),
            { label: 'Counting since', value: u.collectingSince === null ? 'Not started' : new Date(u.collectingSince).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) },
          ]} />
        </Panel>
      </div>
    </>
  );
}

function stepName(frame: { daily: boolean; stepMs: number }): string {
  return frame.daily ? 'day' : frame.stepMs >= 3_600_000 ? 'hour' : `${Math.round(frame.stepMs / 60_000)} minutes`;
}
