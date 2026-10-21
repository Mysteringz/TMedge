import { createPostgresDataSource, closePostgres } from '../postgres/data-source.js';
import type { PostgresConnectionConfig } from '../postgres/config.js';
import { PostgresStudentAccountRepository } from '../postgres/student-account-repository.js';
import { PostgresStudentActivityRepository } from '../postgres/student-activity-repository.js';
import { StudentActivityLog } from '../../modules/student-auth/application/student-activity-log.js';
import { PostgresSiteTrafficGuard, type SiteIdentity } from '../postgres/site-leadership.js';

/** Opens only the runtime pool; schema changes and account import are explicit tools. */
export async function openStudentPostgresStorage(
  config: PostgresConnectionConfig,
  allowedDomains: readonly string[],
  retentionDays = 90,
  siteIdentity: SiteIdentity | null = null,
) {
  const source = createPostgresDataSource(config);
  source.setOptions({ extra: { max: 10, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000 } });
  try {
    await source.initialize();
    const accounts = new PostgresStudentAccountRepository(source, allowedDomains);
    await accounts.count();
    await source.query('SELECT id FROM public.student_activity_events LIMIT 0');
    const activity = new StudentActivityLog(new PostgresStudentActivityRepository(source), { retentionDays });
    const siteTraffic = siteIdentity ? new PostgresSiteTrafficGuard(source, siteIdentity) : undefined;
    return { accounts, activity, siteTraffic, closePersistence: () => closePostgres(source) };
  } catch {
    await closePostgres(source).catch(() => undefined);
    throw new Error('Student PostgreSQL storage unavailable; check runtime credentials and apply migrations');
  }
}
