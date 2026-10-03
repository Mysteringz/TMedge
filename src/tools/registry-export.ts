import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RegistrationImportExport } from '../modules/registration/application/registration-import-export.js';
import { PostgresRegistryRepository } from '../infrastructure/postgres/registry-repository.js';
import { loadPostgresConnectionConfig } from '../infrastructure/postgres/config.js';
import { closePostgres, openPostgres } from '../infrastructure/postgres/data-source.js';

const sitePath = resolve(process.env.SITE_CONFIG ?? 'config/site.json');
const outputPath = process.env.NODES_EXPORT_PATH;
if (!outputPath) throw new Error('NODES_EXPORT_PATH must name the recovery JSON output file');

const source = await openPostgres(loadPostgresConnectionConfig('runtime'));
try {
  const site = JSON.parse(readFileSync(sitePath, 'utf8')) as unknown;
  const nodes = await new RegistrationImportExport(new PostgresRegistryRepository(source)).export(site);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(nodes, null, 2)}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  process.stdout.write(`Exported ${nodes.nodes.length} registered node(s) to ${target}\n`);
} finally {
  await closePostgres(source);
}
