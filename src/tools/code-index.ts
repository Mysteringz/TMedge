/**
 * Builds the index Ask AI finds source in (src/modules/assistant/domain/code-index.ts).
 *
 *   node dist/src/tools/code-index.js [repository root] [output file]
 *
 * Part of `npm run build`. The index is written under dist/src so that it is
 * built from the commit being released and ships inside the release beside
 * the compiled code it describes: what the assistant explains is what runs.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodeIndex, indexable, MAX_FILE_BYTES, type CodeIndexData } from '../modules/assistant/domain/code-index.js';

/**
 * The files git tracks, so a stray copy or an ignored note on a developer's
 * machine never reaches a prompt. Where there is no repository (the container
 * build copies sources in without one) every file present is a tracked one.
 */
function candidates(root: string): string[] {
  try {
    const listed = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const paths = listed.split('\0').filter(Boolean);
    if (paths.length) return paths;
  } catch { /* not a repository, or no git: walk instead */ }
  const found: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path); else if (entry.isFile()) found.push(path);
    }
  };
  walk('');
  return found;
}

export function indexRepository(root: string): CodeIndexData {
  const files: { path: string; text: string }[] = [];
  for (const path of candidates(root)) {
    if (!indexable(path)) continue;
    try {
      const full = join(root, path), stat = statSync(full);
      if (stat.isFile() && stat.size <= MAX_FILE_BYTES) files.push({ path, text: readFileSync(full, 'utf8') });
    } catch { /* listed but not on disk: a deleted file not yet committed */ }
  }
  return buildCodeIndex(files);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // dist/src/tools/ at run time: the repository is three levels up.
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
  const output = resolve(process.argv[3] ?? join(root, 'dist', 'src', 'code-index.json'));
  const index = indexRepository(root);
  if (!index.chunks.length) { console.error(`[code-index] nothing to index under ${root}`); process.exit(1); }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(index));
  console.log(`[code-index] ${index.files} files in ${index.chunks.length} pieces -> ${output}`);
}
