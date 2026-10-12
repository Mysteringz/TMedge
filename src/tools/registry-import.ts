import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RegistrationImportExport } from '../modules/registration/application/registration-import-export.js';
import { PostgresRegistryRepository } from '../infrastructure/postgres/registry-repository.js';
import { loadPostgresConnectionConfig } from '../infrastructure/postgres/config.js';
import { closePostgres, openPostgres } from '../infrastructure/postgres/data-source.js';
import { PostgresRegistryMutationCoordinator } from '../infrastructure/location-config/postgres-registry-mutation-coordinator.js';

const usage = [
  'Usage: registry-import <nodes.json> [--apply]',
  '',
  'Without --apply, validates the import without writing.',
  'Before --apply, stop the edge service; restart it afterward to load imported registry changes.',
  'This command does not check whether the edge service is stopped.',
].join('\n');

async function main(): Promise<void> {
  const inputArgs = process.argv.slice(2);
  const args = new Set(inputArgs);
  if (args.has('--help') || args.has('-h')) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const apply = args.has('--apply');
  const inputPath = inputArgs.find((arg) => !arg.startsWith('--'));
  if (!inputPath) throw new Error(usage);
  const sitePath = resolve(process.env.SITE_CONFIG ?? 'config/site.json');
  const site = JSON.parse(readFileSync(sitePath, 'utf8')) as unknown;
  const nodes = JSON.parse(readFileSync(resolve(inputPath), 'utf8')) as unknown;
  const source = await openPostgres(loadPostgresConnectionConfig('runtime'));
  try {
    const mutationCoordinator = new PostgresRegistryMutationCoordinator(source);
    const service = new RegistrationImportExport(new PostgresRegistryRepository(source, mutationCoordinator), mutationCoordinator);
    const result = await service.import(site, nodes, { dryRun: !apply });
    process.stdout.write(`${JSON.stringify({ mode: apply ? 'applied' : 'dry-run', ...result }, null, 2)}\n`);
    if (!result.valid) process.exitCode = 1;
  } finally {
    await closePostgres(source);
  }
}

await main();
