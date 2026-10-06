import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DataSource } from 'typeorm';
import { loadPostgresConnectionConfig } from '../infrastructure/postgres/config.js';
import { closePostgres, openPostgres } from '../infrastructure/postgres/data-source.js';
import { PostgresStudentAccountRepository } from '../infrastructure/postgres/student-account-repository.js';
import { PostgresStudentActivityRepository } from '../infrastructure/postgres/student-activity-repository.js';
import { StudentAccountImportExport } from '../modules/student-auth/application/student-account-import-export.js';
import { ApplicationError } from '../modules/shared/application/contracts.js';

interface CliOptions {
  command: 'import' | 'export' | 'activity' | 'summary' | 'prune';
  path?: string;
  apply: boolean;
  limit: number;
  days: number;
  userId?: string;
}

const USAGE = 'Usage: student-accounts import <path> [--apply] | export <new-path> | activity [--limit 1..1000] [--user-id UUID] | summary [--limit 1..1000] | prune [--days N] [--apply]';

function parseOptions(args: string[]): CliOptions {
  const command = args.shift();
  if (command !== 'import' && command !== 'export' && command !== 'activity' && command !== 'summary' && command !== 'prune') throw usage();
  const options: CliOptions = { command, apply: false, limit: 100, days: 90 };
  if (command === 'import' || command === 'export') {
    const path = args.shift();
    if (!path || path.startsWith('--')) throw usage();
    options.path = resolve(path);
  }
  parseFlags(args, options);
  return options;
}

function parseFlags(args: string[], options: CliOptions): void {
  while (args.length) {
    const flag = args.shift();
    if (flag === '--apply' && (options.command === 'import' || options.command === 'prune')) options.apply = true;
    else if (flag === '--limit' && (options.command === 'activity' || options.command === 'summary')) options.limit = positiveInteger(args.shift(), 1000);
    else if (flag === '--user-id' && options.command === 'activity') {
      const userId = args.shift();
      if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw usage();
      options.userId = userId;
    }
    else if (flag === '--days' && options.command === 'prune') options.days = positiveInteger(args.shift(), 36500);
    else throw usage();
  }
}

function positiveInteger(value: string | undefined, maximum: number): number {
  if (!value || !/^\d+$/.test(value)) throw usage();
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw usage();
  return number;
}

function usage(): ApplicationError {
  return new ApplicationError('validation', USAGE);
}

async function run(options: CliOptions, source: DataSource): Promise<unknown> {
  const transfer = new StudentAccountImportExport(new PostgresStudentAccountRepository(source));
  const activity = new PostgresStudentActivityRepository(source);
  if (options.command === 'import') {
    if (!options.path) throw usage();
    const value: unknown = JSON.parse(await readFile(options.path, 'utf8'));
    return transfer.import(value, { dryRun: !options.apply });
  }
  if (options.command === 'export') return exportFile(options.path, transfer);
  if (options.command === 'activity') return { events: await activity.list(options.limit, options.userId) };
  if (options.command === 'summary') return { students: await activity.summary(options.limit) };
  const before = Date.now() - options.days * 24 * 3600 * 1000;
  return { dryRun: !options.apply, days: options.days,
    count: options.apply ? await activity.prune(before) : await activity.countBefore(before) };
}

async function exportFile(path: string | undefined, transfer: StudentAccountImportExport): Promise<{ count: number }> {
  if (!path) throw usage();
  const users = await transfer.export();
  // Exclusive creation avoids replacing a recovery file or following an existing symlink.
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(users, null, 2) + '\n', 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  return { count: users.length };
}

let source: DataSource | undefined;
try {
  const options = parseOptions(process.argv.slice(2));
  source = await openPostgres(loadPostgresConnectionConfig('runtime'));
  process.stdout.write(JSON.stringify(await run(options, source), null, 2) + '\n');
} catch (error) {
  // Adapter and validation messages are fixed and contain no credentials; raw SQL/JSON errors are never printed.
  const message = error instanceof ApplicationError ? error.message : 'Student account command failed. Check configuration and input file.';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
} finally {
  if (source) await closePostgres(source);
}
