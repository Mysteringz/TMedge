import { readFile, stat } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CodeSearch, parseCodeIndex, type CodeSource, type CodeSummary, type Excerpt } from '../../modules/assistant/domain/code-index.js';

/**
 * The index of this repository as a file in the release, built by
 * `npm run build` (src/tools/code-index.ts). Read the first time the landing
 * page asks whether there is one, not at start-up: an edge nobody is signed
 * in to has a gigabyte of memory to do everything else in.
 *
 * A build without the file (a checkout that was compiled but never built)
 * has no index, and the assistant answers from its knowledge base alone.
 */
export class CodeIndexFile implements CodeSource {
  private loaded: Promise<CodeSearch | null> | null = null;
  private seen = '';
  constructor(readonly path: string) {}

  async summary(): Promise<CodeSummary | null> { return (await this.search())?.summary ?? null; }

  async find(question: string, earlier: string, roomTokens: number): Promise<Excerpt[]> {
    return (await this.search())?.find(question, earlier, roomTokens) ?? [];
  }

  private async search(): Promise<CodeSearch | null> {
    let stamp: string;
    try { const info = await stat(this.path, { bigint: true }); stamp = `${info.ino}:${info.mtimeNs}:${info.size}`; }
    catch { stamp = 'missing'; }
    if (!this.loaded || stamp !== this.seen) { this.seen = stamp; this.loaded = stamp === 'missing' ? Promise.resolve(null) : this.load(); }
    return this.loaded;
  }

  private async load(): Promise<CodeSearch | null> {
    try {
      const data = parseCodeIndex(JSON.parse(await readFile(this.path, 'utf8')));
      if (!data) return null;
      const search = new CodeSearch(data);
      // A few milliseconds at a time: this thread is also the one taking sensor packets.
      for (let from = 0; from < data.chunks.length; from += 64) { search.ingest(from, from + 64); await nextTurn(); }
      return search;
    } catch { return null; }
  }
}
