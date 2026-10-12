/** Wires the analytics collector and its on-demand sources to a running edge. */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { EDGE_VERSION, type EdgeRuntime } from '../../edge/runtime.js';
import { EdgeAnalyticsCollector } from '../../modules/analytics/application/edge-analytics-collector.js';
import { ReadAnalytics } from '../../modules/analytics/application/read-analytics.js';
import { DEFAULT_ANALYTICS_TIMEZONE } from '../../shared/analytics.js';
import { DirectoryUsageCache } from './directory-usage.js';
import { runtimeAnalyticsSource } from './runtime-analytics-source.js';
import { DEFAULT_UNITS, SystemdProbe } from './systemd-probe.js';
import { WebUsageClient } from './web-usage-client.js';
import { TrainingDatabaseHealth } from './training-database-health.js';

export interface EdgeAnalytics {
  collector: EdgeAnalyticsCollector;
  read: ReadAnalytics;
  stop(): Promise<void>;
}

export function createEdgeAnalytics(runtime: EdgeRuntime, env: NodeJS.ProcessEnv = process.env): EdgeAnalytics {
  const { cfg } = runtime;
  // The edge's own data directory: the volume its recordings fill, and the
  // one place the unit is allowed to write.
  const dataDir = cfg.dataDir;
  const training = new TrainingDatabaseHealth(env);
  const collector = new EdgeAnalyticsCollector({ ...runtimeAnalyticsSource(runtime),
    trainingDatabaseAvailable: training.configured ? () => training.available() : null,
  }, {
    // Its own directory rather than one shared with the web tier's history:
    // the two services may run as different users, and neither should depend
    // on the other having created a parent it can write into.
    dataDir, historyDir: join(dataDir, 'analytics-edge'),
  });
  const read = new ReadAnalytics({
    collector,
    usage: new WebUsageClient(cfg.pushUrls, cfg.pushToken, cfg.edgeId),
    units: new SystemdProbe(cfg.analytics?.units ?? DEFAULT_UNITS),
    directoryUsage: new DirectoryUsageCache(dataDir),
    identity: {
      edgeId: cfg.edgeId, version: EDGE_VERSION, release: releaseId(),
      persistence: cfg.persistenceMode ?? 'file', hasDatabase: runtime.persistenceAvailable !== null,
      hasTrainingDatabase: training.configured,
    },
    timeZone: cfg.analytics?.timeZone ?? DEFAULT_ANALYTICS_TIMEZONE,
  });
  let stopping: Promise<void> | undefined;
  return { collector, read, stop: () => stopping ??= Promise.all([collector.stop(), training.close()]).then(() => undefined) };
}

/**
 * The release this process was started from, when it runs from a release
 * directory (deploy/pipeline.md): the last component of the real path behind
 * the /opt/tmedge link. Null for a checkout or a container.
 */
function releaseId(): string | null {
  try {
    const match = /[/\\]tmedge-releases[/\\]([A-Za-z0-9._-]{1,128})(?:[/\\]|$)/.exec(realpathSync(process.cwd()));
    return match?.[1] ?? null;
  } catch { return null; }
}
