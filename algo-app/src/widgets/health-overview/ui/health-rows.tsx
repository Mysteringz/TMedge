import type { FirmwareSummary, ParameterHealth, SensorHealth, TrainingHealth } from '../../../entities/operational-health/index.ts';
import { HealthTime } from './health-time.tsx';

export function SensorRows({ rows, now }: { rows: SensorHealth[]; now: number }) {
  return <ul>{rows.map((node) => <li key={node.uid}>
    <strong>{node.label}</strong> <span className="cx-dim">{node.uid} · {node.floorId ?? 'No floor'}</span>
    <p>{node.reportReceivedAt === null ? 'No report received' : node.online ? 'Online' : 'Offline'} · <HealthTime at={node.reportReceivedAt} now={now} prefix="REPORT " /></p>
    <p>{node.statusReceivedAt === null ? 'Status unavailable' : now - node.statusReceivedAt > 60_000 ? 'STATUS data stale' : 'STATUS current'} · <HealthTime at={node.statusReceivedAt} now={now} /></p>
  </li>)}</ul>;
}
export function TrainingRows({ rows, now }: { rows: TrainingHealth[]; now: number }) {
  return <ul>{rows.map((job) => <li key={job.id}><strong>{job.name}</strong> · {job.status}
    <p><HealthTime at={job.updatedAt} now={now} prefix="Updated " /> · <HealthTime at={job.lastPolledAt} now={now} prefix="Status last checked " /></p>
    {job.remoteObservationRequired && (job.lastPolledAt === null || now - job.lastPolledAt > 60_000) && <p>Remote status stale or not yet checked. Open training to check your HPC connection.</p>}
  </li>)}</ul>;
}
export function FirmwareRows({ data, now }: { data: FirmwareSummary; now: number }) {
  const rollout = data.rollout;
  return <><p>Build: {data.build.state}{data.build.startedAt !== null && <> · <HealthTime at={data.build.startedAt} now={now} prefix="Started " /></>}</p>
    {!rollout ? <p>No rollout available.</p> : <>
      <p>Version {rollout.version} · {rollout.interrupted ? 'Interrupted' : rollout.stage} · {rollout.confirmed}/{rollout.total} confirmed · {rollout.failed} failed · {rollout.uncertain} uncertain</p>
      <p><HealthTime at={rollout.finishedAt ?? rollout.startedAt} now={now} prefix={rollout.finishedAt === null ? 'Started ' : 'Finished '} /></p>
      <ul>{rollout.rows.map((node) => <li key={node.uid}><strong>{node.label}</strong> · {node.outcomeUncertain ? 'Outcome uncertain' : node.state} · {node.percent}%</li>)}</ul>
      {rollout.rows.length < rollout.total && <p>Showing {rollout.rows.length} of {rollout.total} nodes.</p>}
    </>}<p className="cx-dim">Current or most recent retained rollout.</p></>;
}
export function ParameterRows({ rows, now }: { rows: ParameterHealth[]; now: number }) {
  return <ul>{rows.map((change) => <li key={`${change.uid}:${change.param}`}><strong>{change.uid} · {change.param}</strong>
    <p>{change.restoring ? 'Restoring previous value; awaiting confirmation' : change.confirmedAt === null ? 'Awaiting device confirmation' : 'Confirmed'} · {change.binding}</p>
    <p>{change.revertAt > now ? `Auto-revert in ${Math.ceil((change.revertAt - now) / 1000)}s` : 'Auto-revert due'} · <time dateTime={new Date(change.revertAt).toISOString()}>{new Date(change.revertAt).toLocaleString()}</time></p>
  </li>)}</ul>;
}
