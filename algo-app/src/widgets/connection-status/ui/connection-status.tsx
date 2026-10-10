import type { TransportState } from '../../../entities/connection-state/index.ts';
import './connection-status.css';
export function ConnectionStatus({ transport, observedAt, fresh, sensorOnline }: {
  transport: TransportState; observedAt: number | null; fresh: boolean; sensorOnline: boolean | null;
}) {
  return <section className="connection-status" aria-label="Live connection status">
    <span role="status" aria-live="polite">{transport[0]?.toUpperCase()}{transport.slice(1)}</span>
    <span>{observedAt === null ? 'No device data received.' : transport === 'connected' && fresh ? 'Live messages current' : 'Last known data — messages stale or disconnected'}</span>
    {observedAt !== null && <time dateTime={new Date(observedAt).toISOString()}>Last message {new Date(observedAt).toLocaleTimeString()}</time>}
    <span>{sensorOnline === null ? 'Sensor REPORT status unavailable' : sensorOnline ? 'Sensor REPORT current' : 'Sensor REPORT offline or not yet received'}</span>
    {(!fresh || transport !== 'connected') && <span>Device controls wait for a refreshed connection and sensor state.</span>}
  </section>;
}
