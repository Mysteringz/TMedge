import express from 'express';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';

export const DIAGRAM_FILE = 'diagrams/summary/relationships.real.large.png';
export function schemaDiagram(dir: string) {
  try {
    const file = resolve(dir, DIAGRAM_FILE), info = statSync(file);
    if (!info.isFile() || info.size > 8 * 1024 ** 2) throw new Error('invalid diagram');
    const bytes = readFileSync(file);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('invalid PNG');
    let generatedAt = info.mtimeMs;
    try {
      const metadata: unknown = JSON.parse(readFileSync(resolve(dir, 'generated.json'), 'utf8'));
      if (metadata && typeof metadata === 'object' && 'generatedAt' in metadata
        && typeof metadata.generatedAt === 'number' && Number.isSafeInteger(metadata.generatedAt) && metadata.generatedAt > 0) generatedAt = metadata.generatedAt;
    } catch { /* Legacy reports can still show their file timestamp. */ }
    return { available: true, generatedAt, revision: `${generatedAt}-${createHash('sha256').update(bytes).digest('hex')}`, error: null };
  } catch {
    return { available: false, generatedAt: null, revision: null, error: 'The Graphviz diagram has not been published yet.' };
  }
}

/** These bundled libraries/fonts contain no database metadata, like the login bundle. */
export function schemaAssets(dir: string) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });
  for (const folder of ['bower', 'fonts']) router.use(`/${folder}`, express.static(resolve(dir, folder), { dotfiles: 'deny', index: false, fallthrough: false }));
  return router;
}

/** Keep opaque sandbox resources usable without exposing any schema or requiring cookies in subresources. */
export function schemaHtml(root: string, file: string): string {
  const base = resolve(root);
  const local = (name: string) => {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(name)) return null;
    const path = resolve(dirname(file), name);
    return path.startsWith(base + sep) && existsSync(path) ? { path, name: relative(base, path).split(sep).join('/') } : null;
  };
  const attribute = (tag: string, name: string) => new RegExp(`\\b${name}=["']([^"']+)["']`, 'i').exec(tag)?.[1];
  const html = readFileSync(file, 'utf8')
    .replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag: string, name: string) => {
      const asset = local(name); if (!asset) return tag;
      if (asset.name.startsWith('bower/')) return `<script src="/ml-schema-assets/${asset.name}"></script>`;
      return `<script>${readFileSync(asset.path, 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`;
    })
    .replace(/<link\b[^>]*>/gi, (tag: string) => {
      if (attribute(tag, 'rel') !== 'stylesheet') return tag;
      const name = attribute(tag, 'href'); const asset = name ? local(name) : null; if (!asset) return tag;
      if (asset.name.startsWith('bower/') || asset.name.startsWith('fonts/')) return tag.replace(name ?? '', `/ml-schema-assets/${asset.name}`);
      return `<style>${readFileSync(asset.path, 'utf8').replace(/<\/style/gi, '<\\/style')}</style>`;
    })
    .replace(/<img\b[^>]*>/gi, (tag: string) => {
      const name = attribute(tag, 'src'); const asset = name ? local(name) : null; if (!asset) return tag;
      const mime = /\.png$/i.test(asset.name) ? 'image/png' : /\.svg$/i.test(asset.name) ? 'image/svg+xml' : null;
      return mime ? tag.replace(name ?? '', `data:${mime};base64,${readFileSync(asset.path).toString('base64')}`) : tag;
    });
  // Only the originating frame can request navigation; the parent validates
  // its URL against the authenticated report prefix before setting src.
  const bridge = `<script>document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href],area[href]');if(!a)return;var u=new URL(a.href,location.href);if(u.origin!==location.origin)return;if(u.pathname===location.pathname&&u.hash)return;if(!u.pathname.startsWith('/api/ml-data/schema/report/'))return;e.preventDefault();parent.postMessage({type:'schemaspy-navigate',url:u.href},'*');});</script>`;
  return html.replace('</body>', bridge + '</body>');
}
