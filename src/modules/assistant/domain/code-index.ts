/**
 * This repository, cut into pieces Ask AI can be shown.
 *
 * The model reads about eight thousand tokens at a time and the source is a
 * few hundred times that, so nothing here "reads the repo". A question is
 * answered from the handful of pieces whose words match it, and the answer
 * says which files those were. Matching is by words (BM25), not by meaning:
 * it needs no second model on a GPU that barely holds the first, it is the
 * same on every machine, and its misses can be read off a test.
 *
 * Everything in the index leaves the edge inside a prompt, so what goes into
 * it is decided here and nowhere else: an allow-list of source and document
 * folders, never configuration or data, with machine addresses and email
 * addresses struck out.
 */

export interface CodeChunk {
  path: string;
  /** First and last line, counted from 1. */
  from: number; to: number;
  /** The section a piece of a document sits under. */
  heading?: string;
  text: string;
}
export interface CodeIndexData {
  version: 1; files: number;
  /** What a file or a folder (a path ending in "/") is for, in the words of CLAUDE.md's map: path -> one line. */
  about: Record<string, string>;
  chunks: CodeChunk[];
}
/** A piece as it is handed over: with what its file is for, when the map says. */
export interface Excerpt extends CodeChunk { about?: string }
/** What an answer was written from, as the page lists it. */
export interface Source { path: string; from: number; to: number; heading?: string }
export interface CodeSummary { files: number; chunks: number }

/** Whatever finds the pieces. One implementation: the index file built with the release. */
export interface CodeSource {
  /** Null when this build has no index: the assistant then answers from its knowledge base alone. */
  summary(): Promise<CodeSummary | null>;
  /** The pieces that best match a question, the earlier question lending its words to a follow-up, within `roomTokens`. */
  find(question: string, earlier: string, roomTokens: number): Promise<Excerpt[]>;
}

/**
 * Roughly how many tokens the model counts for a text. Measured on the model
 * in use, English and code run 3.8 to 4.4 characters a token; anything outside
 * ASCII is counted a token a character, which is the safe side for Thai and
 * Chinese questions.
 */
export function tokensIn(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 3.5 + (text.length - ascii));
}

// ---- what may be indexed ---------------------------------------------------

const FOLDERS = ['src/', 'algo-app/src/', 'web-app/src/', 'docs/', 'deploy/', 'test/', 'ci/', 'tools/', 'rigs/', 'docker/', '.github/workflows/'];
const ROOT_FILES = new Set(['CLAUDE.md', 'README.md', 'DOCKER.md', 'package.json', '.env.example', 'Dockerfile', 'docker-compose.yml']);
const TEXT = /\.(?:ts|tsx|mts|mjs|js|css|md|py|sh|ya?ml|sql|service|timer|sbatch|html)$/;
const TEST_FILE = /^test\/[^/]+\.test\.(?:ts|mjs)$/;
/** Larger than this is generated or data, whatever its extension says. */
export const MAX_FILE_BYTES = 200_000;

/**
 * Whether a repository path belongs in the index. Source and documents only:
 * `config/` is the site's configuration (and the knowledge base, which the
 * model is sent whole already), and nothing under `data/` or beside `.env`
 * is ever a candidate. Of the tests only the test files themselves, for their
 * titles (see `claimsOf`): their fixtures are full of pretend keys and
 * passwords a model would happily quote as real.
 */
export function indexable(path: string): boolean {
  if (path.includes('..') || path.startsWith('/') || /(^|\/)\.env(?!\.example$)/.test(path)) return false;
  if (/(^|\/)(node_modules|dist|data)\//.test(path) || path.startsWith('docs/superpowers/')) return false;
  if (ROOT_FILES.has(path)) return true;
  if (path.startsWith('test/')) return TEST_FILE.test(path);
  return FOLDERS.some((folder) => path.startsWith(folder)) && TEXT.test(path);
}

const KEPT_ADDRESS = /^(?:127\.\d+\.\d+\.\d+|0\.0\.0\.0|255\.\d+\.\d+\.\d+)$/;
const KEPT_MAIL = /@(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$|\.(?:invalid|test|example)$/i;

/**
 * Strikes out what the assistant is never shown, wherever it was written
 * down: an address of a machine, the name of one of ours, somebody's email.
 * Loopback and the unspecified address stay; they say how the code binds, not
 * where anything is.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (address) => (KEPT_ADDRESS.test(address) ? address : '<address>'))
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:compute\.amazonaws\.com|ts\.net)\b/gi, '<host>')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, (mail) => (KEPT_MAIL.test(mail) ? mail : '<email>'));
}

// ---- cutting a file into pieces --------------------------------------------

const TARGET = 800, MAX = 1500, MAX_LINE = 600;

/**
 * A test file as the list of what it claims. Tests here are named as
 * sentences about behaviour, so the titles alone answer "is that tested, and
 * what is promised?" without a line of fixture.
 */
function claimsOf(path: string, text: string): CodeChunk[] {
  const lines = text.split('\n'), out: CodeChunk[] = [];
  let from = 0, to = 0, body = '';
  const flush = () => { if (body) out.push({ path, from, to, heading: 'Claims this file tests', text: body.trimEnd() }); body = ''; };
  lines.forEach((line, index) => {
    const title = /\btest\(\s*(?:`([^`]{8,400})`|'((?:[^'\\]|\\.){8,400})'|"((?:[^"\\]|\\.){8,400})")/.exec(line);
    const words = (title?.[1] ?? title?.[2] ?? title?.[3])?.replace(/\\(['"])/g, '$1');
    if (!words) return;
    if (!body) from = index + 1;
    to = index + 1;
    body += `- ${words}\n`;
    if (body.length >= TARGET) flush();
  });
  flush();
  return out;
}

/**
 * Cuts where the author did: at a heading in a document, at a blank line
 * before something that starts in the first column in code. A piece is half
 * a screenful, so five or six fit beside a question, and a declaration
 * keeps the comment that explains it.
 */
export function chunksOf(path: string, raw: string): CodeChunk[] {
  if (TEST_FILE.test(path)) return claimsOf(path, raw);
  const markdown = /\.md$/i.test(path);
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} ...` : line));
  const out: CodeChunk[] = [];
  let start = 0, size = 0, fenced = false, heading: string | undefined, startHeading: string | undefined;
  const flush = (end: number) => {
    const text = lines.slice(start, end).join('\n').replace(/\s+$/, '');
    // Line numbers are for a person opening the file: leading blank lines are not part of the piece.
    const lead = lines.slice(start, end).findIndex((line) => line.trim() !== '');
    if (text.trim()) out.push({ path, from: start + 1 + Math.max(lead, 0), to: start + text.split('\n').length, ...(startHeading ? { heading: startHeading } : {}), text: text.replace(/^(?:\s*\n)+/, '') });
    start = end; size = 0; startHeading = heading;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (markdown && /^(?:```|~~~)/.test(line)) fenced = !fenced;
    const title = markdown && !fenced ? /^#{1,4}\s+(.+?)\s*#*$/.exec(line)?.[1] : undefined;
    const blankBefore = i > 0 && (lines[i - 1] ?? '').trim() === '';
    const cut = size >= MAX
      || (title !== undefined && size >= 400)
      || (size >= TARGET && blankBefore && !fenced && (markdown || /^[^\s})\]]/.test(line)));
    if (cut && i > start) flush(i);
    if (title !== undefined) { heading = title.replace(/[`*_]/g, ''); if (size === 0) startHeading = heading; }
    size += line.length + 1;
  }
  flush(lines.length);
  // A two-line tail is no piece of its own: it is the end of the one before it.
  for (let i = out.length - 1; i > 0; i--) {
    const tail = out[i], before = out[i - 1];
    if (!tail || !before || tail.text.length >= 250) continue;
    out.splice(i - 1, 2, { ...before, to: tail.to, text: `${before.text}${'\n'.repeat(Math.max(1, Math.min(2, tail.from - before.to)))}${tail.text}` });
  }
  return out;
}

/**
 * CLAUDE.md opens with a map: a path, then what lives there, one line each.
 * It is the team's own answer to "which file is that in", in the words people
 * ask with ("HMAC, replay", where the code says tag and cursor), so every
 * piece of a file is also findable by its line of the map.
 */
function mapOf(claude: string): [prefix: string, about: string][] {
  const block = /^## Map\s*\n+```\n([\s\S]*?)\n```/m.exec(claude)?.[1] ?? '';
  const entries: [string, string][] = [];
  for (const line of block.split('\n')) {
    const entry = /^(\S+)\s+(\S.*)$/.exec(line);
    const last = entries[entries.length - 1];
    if (entry?.[1] && entry[2] && /[/.]/.test(entry[1])) entries.push([entry[1], entry[2].trim()]);
    // An indented line carries on the entry above it.
    else if (last && /^\s+\S/.test(line)) last[1] += ` ${line.trim().replace(/^--\s*/, '')}`;
  }
  return entries;
}

/** The index of a set of files: only what `indexable` admits, redacted, in a fixed order so the same sources always build the same file. */
export function buildCodeIndex(files: Iterable<{ path: string; text: string }>): CodeIndexData {
  const chunks: CodeChunk[] = [];
  const about: Record<string, string> = {};
  let count = 0;
  const sorted = [...files].filter((file) => indexable(file.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const map = mapOf(redact(sorted.find((file) => file.path === 'CLAUDE.md')?.text ?? ''));
  for (const file of sorted) {
    // A private key in a tracked file is somebody's mistake; it does not also get sent to a model.
    if (Buffer.byteLength(file.text) > MAX_FILE_BYTES || file.text.includes('\0') || /PRIVATE KEY-{5}/.test(file.text)) continue;
    const pieces = chunksOf(file.path, redact(file.text));
    if (!pieces.length) continue;
    count++;
    chunks.push(...pieces);
  }
  // Only the lines that name something indexed, in a fixed order.
  for (const [prefix, line] of [...map].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (chunks.some((chunk) => (prefix.endsWith('/') ? chunk.path.startsWith(prefix) : chunk.path === prefix))) about[prefix] = line.slice(0, 300);
  }
  return { version: 1, files: count, about, chunks };
}

/** Reads back what `buildCodeIndex` wrote; anything else is no index at all. */
export function parseCodeIndex(value: unknown): CodeIndexData | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<CodeIndexData>;
  if (data.version !== 1 || !Number.isInteger(data.files) || !Array.isArray(data.chunks)) return null;
  if (!data.about || typeof data.about !== 'object' || Object.values(data.about).some((line) => typeof line !== 'string')) return null;
  for (const chunk of data.chunks as Partial<CodeChunk>[]) {
    if (!chunk || typeof chunk.path !== 'string' || typeof chunk.text !== 'string' || !Number.isInteger(chunk.from) || !Number.isInteger(chunk.to)
      || (chunk.heading !== undefined && typeof chunk.heading !== 'string')) return null;
  }
  return data as CodeIndexData;
}

// ---- finding the pieces for a question -------------------------------------

/** Words that say nothing about which file: English's, a question's, and the keywords every source file is made of. */
const STOP = new Set(('a an and are as at be been but by can could did do does doing for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to '
  + 'was we were what when where which who whom whose why will with would you your about after again all also any because before between both each few many more most much other over same some such too very '
  + 'explain describe tell show give work works working happen happens use used using please mean means exactly actually get gets '
  + 'const let var function return import export default class interface type extends implements new null undefined true false void string number boolean async await readonly public private '
  + 'else try catch throw typeof instanceof').split(' '));

/**
 * A light stemmer. It only has to send "smoothing", "smoothed" and "smooths"
 * to one place, and does not have to be right about English.
 */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 6 && w.endsWith('ation')) w = w.slice(0, -5);
  else if (w.length > 5 && w.endsWith('ion')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 5 && /(?:er|or)$/.test(w)) w = w.slice(0, -2);
  if (w.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(w) && !/(?:ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/**
 * The words of a text as they are matched: identifiers split where a
 * programmer reads them split (replayWindow, replay_window), each part
 * stemmed, and the whole identifier kept too so its exact name still finds it.
 */
export function termsOf(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(/[A-Za-z0-9_$]+/g) ?? []) {
    // Only where lower case meets upper: TMflash, TMedge and TMWAccess are each one word here.
    const parts = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_$]+/).filter(Boolean);
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower.length < 2 || STOP.has(lower)) continue;
      out.push(/^\d+$/.test(lower) ? lower : stem(lower));
    }
    if (parts.length > 1 && word.length <= 48) out.push(word.replace(/[_$]/g, '').toLowerCase());
  }
  // "sign-in" is one thing, and not every signature and every "in".
  for (const joined of text.match(/\b[A-Za-z]{2,}(?:-[A-Za-z]{2,}){1,2}\b/g) ?? []) out.push(joined.replace(/-/g, '').toLowerCase());
  return out;
}

/** Documents explain; tests and stylesheets seldom answer "how does it work". */
function weightOf(path: string): number {
  if (path.startsWith('test/')) return 0.6;
  if (path.endsWith('.css')) return 0.5;
  if (path.endsWith('.md')) return 1.1;
  if (/^(?:deploy|ci|tools|rigs|docker|\.github)\//.test(path)) return 0.8;
  return 1;
}

const DECLARED = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|enum|def)\s+([A-Za-z_$][\w$]*)/gm;
/** A method: indented, a name, its parameters, and the brace that opens it at the end of the line. */
const METHOD = /^\s+(?:(?:private|public|protected|static|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\([^\n]*\)\s*(?::\s*[^\n{]+)?\{\s*$/gm;
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor']);
/**
 * How much the question's own words must say before any source is looked up
 * (the sum of how rare they are). "What is on the board?" names nothing a
 * file could be found by; every file about some board would be handed over
 * as if it were the answer, and the model would believe it.
 */
const ENOUGH_TO_GO_ON = 4;
/** A question that leans on the one before it: it opens by carrying on, or says "it", "that", "there". */
const POINTS_BACK = /^\s*(?:and|but|so|then|also|why|how come|what about|how about)\b|\b(?:it|its|that|this|those|these|they|them|there|same|else)\b/i;
const K1 = 1.2, B = 0.6;

/**
 * BM25 over the pieces. A piece's file name, the section it sits under and
 * the names it declares count several times over: "how does ingest reject a
 * replay" should find ingest.ts before a file that merely mentions it.
 */
export class CodeSearch {
  private readonly postings = new Map<string, number[]>();
  private readonly lengths: number[] = [];
  private readonly weights: number[] = [];
  private total = 0;
  /** What each file says it is at its top: a piece from the middle of a file is about that too. */
  private readonly opening = new Map<string, string>();
  /** The map's folders, the deepest first. */
  private readonly folders: string[];

  constructor(readonly data: CodeIndexData) {
    this.folders = Object.keys(data.about).filter((prefix) => prefix.endsWith('/')).sort((a, b) => b.length - a.length);
    for (const chunk of data.chunks) {
      if (!this.opening.has(chunk.path)) this.opening.set(chunk.path, chunk.from <= 3 ? (/^\s*(?:\/\*\*?[\s\S]*?\*\/|(?:(?:\/\/|#).*\n?)+)/.exec(chunk.text)?.[0] ?? '').slice(0, 400) : '');
    }
  }

  get summary(): CodeSummary { return { files: this.data.files, chunks: this.data.chunks.length }; }

  /**
   * Reads pieces `from` up to `to` into the index. In slices because it runs
   * inside the edge, on the thread that is also taking sensor packets: the
   * caller yields between them.
   */
  ingest(from: number, to: number): void {
    for (let id = from; id < Math.min(to, this.data.chunks.length); id++) {
      const chunk = this.data.chunks[id];
      if (!chunk) continue;
      const name = chunk.path.slice(chunk.path.lastIndexOf('/') + 1).replace(/\.[a-z]+$/i, '').replace(/\.test$/, '');
      const declared = [...chunk.text.matchAll(DECLARED), ...chunk.text.matchAll(METHOD)].map((match) => match[1] ?? '').filter((name) => !NOT_A_NAME.has(name)).join(' ');
      const bag = new Map<string, number>();
      const add = (text: string, times: number) => { for (const term of termsOf(text)) bag.set(term, (bag.get(term) ?? 0) + times); };
      add(chunk.text, 1); add(declared, 2); add(name, 3); add(chunk.path.slice(0, chunk.path.lastIndexOf('/') + 1), 1);
      // The map's line for the file itself, and more faintly the line for the folder it is in.
      add(this.data.about[chunk.path] ?? '', 2);
      add(this.data.about[this.folders.find((folder) => chunk.path.startsWith(folder)) ?? ''] ?? '', 1);
      if (chunk.from > 3) add(this.opening.get(chunk.path) ?? '', 1);
      if (chunk.heading) add(chunk.heading, 3);
      let length = 0;
      for (const [term, count] of bag) {
        length += count;
        let list = this.postings.get(term);
        if (!list) this.postings.set(term, list = []);
        list.push(id, count);
      }
      // The top of a file is where it says what it is for and why: the best single piece to explain it.
      this.lengths[id] = length; this.weights[id] = weightOf(chunk.path) * (chunk.from <= 3 && !chunk.path.endsWith('.md') ? 1.15 : 1);
      this.total += length;
    }
  }

  /** Every piece that shares a word with the question, best first. */
  rank(question: string, earlier: string): [id: number, score: number][] {
    const count = this.lengths.length;
    if (!count) return [];
    const wanted = new Map<string, number>();
    for (const term of termsOf(question)) wanted.set(term, 1);
    // "And when is it not?" is about whatever the question before it was
    // about, so that question lends its words -- but only to one that points
    // back at it. "What is on the board?" after a question about replays is a
    // new subject, and must not be handed the replay code.
    if (POINTS_BACK.test(question)) for (const term of termsOf(earlier)) if (!wanted.has(term)) wanted.set(term, 0.4);
    // Asked about the tests, the tests are the answer; otherwise they are the last place to look.
    const aboutTests = wanted.get('test') === 1 || wanted.get('claim') === 1;
    const average = this.total / count;
    const scores = new Map<number, number>(), hits = new Map<number, number>();
    let known = 0, said = 0;
    for (const [term, weight] of wanted) {
      const list = this.postings.get(term);
      if (!list) continue;
      if (weight === 1) known++;
      const idf = Math.log(1 + (count - list.length / 2 + 0.5) / (list.length / 2 + 0.5));
      said += idf * weight;
      for (let i = 0; i < list.length; i += 2) {
        const id = list[i] ?? 0, tf = list[i + 1] ?? 0;
        scores.set(id, (scores.get(id) ?? 0) + idf * weight * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (this.lengths[id] ?? average) / average)));
        if (weight === 1) hits.set(id, (hits.get(id) ?? 0) + 1);
      }
    }
    const ranked: [number, number][] = [];
    if (said < ENOUGH_TO_GO_ON) return ranked;
    for (const [id, score] of scores) {
      const path = this.data.chunks[id]?.path ?? '';
      // One shared word is how unrelated files look related: a piece is worth
      // more the more of the question's own words it holds.
      const cover = known ? (hits.get(id) ?? 0) / known : 0;
      ranked.push([id, score * (0.35 + 0.65 * cover) * (aboutTests && path.startsWith('test/') ? 1.6 : this.weights[id] ?? 1)]);
    }
    return ranked.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  }

  find(question: string, earlier: string, roomTokens: number): Excerpt[] {
    const ranked = this.rank(question, earlier);
    const best = ranked[0]?.[1] ?? 0;
    const taken: number[] = [], perFile = new Map<string, number>();
    let room = roomTokens;
    const take = (most: number, files = Infinity) => {
      for (const [id, score] of ranked) {
        if (taken.length >= 7 || perFile.size >= files || score < best * 0.5) break;
        const chunk = this.data.chunks[id];
        if (!chunk || taken.includes(id) || (perFile.get(chunk.path) ?? 0) >= most) continue;
        // The line that names it, and what its file is for, are sent too.
        const cost = tokensIn(chunk.text) + tokensIn(this.data.about[chunk.path] ?? '') + 40;
        if (cost > room) continue;
        room -= cost;
        taken.push(id); perFile.set(chunk.path, (perFile.get(chunk.path) ?? 0) + 1);
      }
    };
    // The best piece of the two best files first, so that neither a document
    // nor the code crowds the other out (the scores of the first few are
    // always close); then whatever ranks next, a file's second piece before any file's third.
    take(1, 2); take(2); take(3);
    // Shown file by file and top to bottom, the best file first: easier to read than best-piece-first.
    const order = [...new Set(taken.map((id) => this.data.chunks[id]?.path ?? ''))];
    return taken.sort((a, b) => order.indexOf(this.data.chunks[a]?.path ?? '') - order.indexOf(this.data.chunks[b]?.path ?? '') || a - b)
      .flatMap((id) => { const chunk = this.data.chunks[id]; return chunk ? [{ ...chunk, ...(this.data.about[chunk.path] ? { about: this.data.about[chunk.path] } : {}) }] : []; });
  }
}
