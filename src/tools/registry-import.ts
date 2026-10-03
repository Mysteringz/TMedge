import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RegistrationImportExport } from '../modules/registration/application/registration-import-export.js';
import { PostgresRegistryRepository } from '../infrastructure/postgres/registry-repository.js';
import { loadPostgresConnectionConfig } from '../infrastructure/postgres/config.js';
import { closePostgres, openPostgres } from '../infrastructure/postgres/data-source.js';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const inputPath = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
if (!inputPath) throw new Error('Usage: registry-import <nodes.json> [--apply]');
const sitePath = resolve(process.env.SITE_CONFIG ?? 'config/site.json');
const site = JSON.parse(readFileSync(sitePath, 'utf8')) as unknown;
const nodes = JSON.parse(readFileSync(resolve(inputPath), 'utf8')) as unknown;
const source = await openPostgres(loadPostgresConnectionConfig('runtime'));
try {
  const service = new RegistrationImportExport(new PostgresRegistryRepository(source));
  const result = await service.import(site, nodes, { dryRun: !apply });
  process.stdout.write(`${JSON.stringify({ mode: apply ? 'applied' : 'dry-run', ...result }, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
} finally {
  await closePostgres(source);
}
