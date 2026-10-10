/** The running edge, read the way the analytics collector needs it. Reads only; nothing here sends or changes anything. */
import type { EdgeRuntime } from '../../edge/runtime.js';
import type { EdgeAnalyticsSource } from '../../modules/analytics/application/edge-analytics-collector.js';

export function runtimeAnalyticsSource(runtime: EdgeRuntime): EdgeAnalyticsSource {
  return {
    pipeline(now) {
      // Not runtime.health(): that also samples the host monitor, whose
      // event-loop figure resets on every read and belongs to the console.
      const nodes = runtime.nodes(now).filter((node) => node.registered);
      const real = nodes.filter((node) => !runtime.reg.nodes.get(node.uid)?.simulated);
      const recorder = runtime.recorder.health();
      return {
        ...runtime.ingest.rates(),
        rejectReasons: [...runtime.ingest.rejectReasons]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count).slice(0, 8),
        nodes: {
          registered: nodes.length, online: nodes.filter((node) => node.online).length,
          real: real.length, realOnline: real.filter((node) => node.online).length,
        },
        // The host is enough to tell targets apart; a URL can carry a path nobody needs to see.
        publish: runtime.publisher.status.map((target) => ({
          target: hostOf(target.target), ok: target.ok, lastOkAt: target.lastOkAt,
          tried: target.ok || target.lastOkAt !== null || target.lastError !== null,
        })),
        gateways: runtime.gateways?.gateways().length ?? 0,
        directSessions: runtime.direct ? runtime.direct.stats().sessions : null,
        recorder: {
          bytesToday: runtime.recorder.bytesToday(), rawEnabled: runtime.recorder.rawEnabled,
          healthy: recorder.detections.healthy && recorder.occupancy.healthy && (recorder.raw?.healthy ?? true),
        },
      };
    },
    floors() {
      return runtime.publicSnapshot(runtime.latest).floors.map((floor) => {
        // "Silence is never emptiness": with no covered seat there is no count to give.
        const known = floor.totals.seats - floor.totals.unknownSeats > 0;
        return {
          id: floor.id, name: floor.name, seats: floor.totals.seats, unknownSeats: floor.totals.unknownSeats,
          occupied: known ? floor.totals.occupied : null, free: known ? floor.totals.free : null,
        };
      });
    },
    databaseAvailable: runtime.persistenceAvailable,
  };
}

function hostOf(target: string): string {
  try { return new URL(target).host; } catch { return 'web tier'; }
}
