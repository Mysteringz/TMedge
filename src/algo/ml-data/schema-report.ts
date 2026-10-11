import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

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
