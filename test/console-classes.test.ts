/**
 * Class names an ad blocker hides.
 *
 * Adoption and TMflash once named their classes `ad-…` (for adoption).
 * EasyList, which uBlock Origin and most blockers load by default, hides any
 * element whose class is `ad-panel`, `ad-hint`, `ad-notice` or `ad-primary`
 * -- so for anyone running one, both pages rendered a heading and nothing
 * else: no panels, no primary buttons, no error. The lists cannot be vendored
 * here (they change daily), so this refuses the shape of name they target.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES = ['algo-app/src', 'web-app/src', 'src/console-client', 'public-console'];
// ad-, ads-, adv-, advert…, sponsor… at the start; -ad or -ads at the end; or the bare words.
const HIDDEN = /^(?:ad|ads|adv|advert\w*|sponsor\w*)(?:[-_].*)?$|[-_]ads?$/i;

function files(directory: string): string[] {
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  return names.flatMap((name) => {
    const path = join(directory, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return files(path);
    // "name 2.ext" is a stray copy the operating system left; .gitignore keeps those out, and so does this.
    return /\.(css|tsx|html)$/.test(name) && !/ \d+\.[^.]+$/.test(name) ? [path] : [];
  });
}

function classNames(path: string, text: string): string[] {
  if (path.endsWith('.css')) return [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((match) => match[1] ?? '');
  // class="…", className="…", className={`…`}: the static words, not what is interpolated.
  return [...text.matchAll(/class(?:Name)?=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)]
    .flatMap((match) => (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)).filter(Boolean);
}

test('no page names a class the way an advertisement would, because ad blockers hide those elements', () => {
  const paths = SOURCES.flatMap((source) => files(join(root, source)));
  assert.ok(paths.length > 20, 'the sources were found');
  const hidden = paths.flatMap((path) => [...new Set(classNames(path, readFileSync(path, 'utf8')))].filter((name) => HIDDEN.test(name)).map((name) => `${relative(root, path)}: .${name}`));
  assert.deepEqual(hidden, [], 'rename these: an ad blocker removes the element, silently');
  // The four that took the panels off Adoption and TMflash, and names that only look close.
  for (const name of ['ad-panel', 'ad-hint', 'ad-notice', 'ad-primary', 'ads', 'ad_box', 'advert', 'sponsored-links', 'banner-ad', 'side-ads']) assert.ok(HIDDEN.test(name), name);
  for (const name of ['dv-panel', 'cx-adoption', 'admin-table', 'add-row', 'header', 'load-more', 'badge', 'an-notice']) assert.ok(!HIDDEN.test(name), name);
});
