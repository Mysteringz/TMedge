import { useOperationalHealth } from '../../../entities/operational-health/index.ts';
import { HealthSection } from './health-section.tsx';
import { FirmwareRows, ParameterRows, SensorRows, TrainingRows } from './health-rows.tsx';
import { HealthTime } from './health-time.tsx';
import './health-overview.css';

export function HealthOverview({ user }: { user: string }) {
  const { snapshot, now, error, busy, stale, refresh, announcement } = useOperationalHealth(user);
  return <section className="cx-health" aria-labelledby="system-status-title">
    <div className="cx-card-head"><h2 id="system-status-title">System status</h2><button className="btn btn-ghost" onClick={refresh} disabled={busy} aria-busy={busy}>{busy ? 'Refreshing…' : 'Refresh system status'}</button></div>
    <p>{snapshot ? <HealthTime at={snapshot.generatedAt} now={now} prefix="Snapshot " /> : 'Loading system status…'}</p>
    {error && <p className="cx-health-warning">{error}</p>}
    {stale && <p className="cx-health-warning">Dashboard data is stale. <HealthTime at={snapshot?.generatedAt ?? null} now={now} prefix="Last updated " /></p>}
    <span className="cx-health-announcement" role="status" aria-live="polite">{announcement}</span>
    <div className="cx-health-grid">
      <HealthSection title="Sensors" source={snapshot?.sensors} href="/console" link="Open sensor console" refresh={refresh}>{(data) => <>
        <p>{data.total === 0 ? 'No sensors registered.' : `${data.total} sensors · ${data.offline} offline · ${data.unknown} without reports`}</p>
        {data.total > 0 && data.offline === 0 && data.unknown === 0 && <p>No offline sensors.</p>}
        <SensorRows rows={data.rows} now={now} />{data.rows.length < data.total && <p>Showing {data.rows.length} of {data.total} sensors.</p>}
      </>}</HealthSection>
      <HealthSection title="My training jobs" source={snapshot?.training} href="/train" link="Open my training jobs" refresh={refresh}>{(data) => <>
        <p>{data.total === 0 ? 'No recent jobs.' : `${data.total} jobs · ${data.failed} failed`}</p><TrainingRows rows={data.rows} now={now} />
        {data.rows.length < data.total && <p>Showing {data.rows.length} of {data.total} jobs; failures first.</p>}
      </>}</HealthSection>
      <HealthSection title="Firmware rollout" source={snapshot?.firmware} href="/updates" link="Open firmware updates" refresh={refresh}>{(data) => <FirmwareRows data={data} now={now} />}</HealthSection>
      <HealthSection title="Pending parameter reversions" source={snapshot?.parameters} href="/flow" link="Open parameter details" refresh={refresh}>{(data) => <>
        <p>{data.total === 0 ? 'No pending reversions.' : `${data.total} pending reversions`}</p><ParameterRows rows={data.rows} now={now} />
        {data.rows.length < data.total && <p>Showing {data.rows.length} of {data.total} reversions.</p>}
      </>}</HealthSection>
    </div>
  </section>;
}
