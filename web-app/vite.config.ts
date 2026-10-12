import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicWeb = resolve(here, '..', 'public-web');
const API = 'http://127.0.0.1:8080';

/**
 * A proxied request that the server will read as same-origin.
 *
 * The browser posts with `Origin: http://localhost:5173`. The server refuses
 * a post whose Origin does not match its own Host -- the check that stops
 * another site logging you in -- and behind a proxy the two never match:
 * `changeOrigin` rewrites Host to the target, while Origin still names the
 * dev server. Sign-out then answers 403 and the student is told to try again
 * forever.
 *
 * Both ends are set here, to the target, so the pair agrees. This is a dev
 * entry point for the same-origin guard, and only that: it is Vite's own
 * server, on this machine, running the code in this checkout. Production has
 * no proxy between the browser and the server, so nothing there changes.
 */
function proxyToApi() {
  return {
    target: API,
    changeOrigin: true,
    configure: (proxy: { on(event: 'proxyReq', handler: (req: { setHeader(name: string, value: string): void }) => void): void }) => {
      proxy.on('proxyReq', (outgoing) => outgoing.setHeader('Origin', API));
    },
  };
}

/**
 * The seat logic lives in ../src/shared and is compiled by tsc for the server
 * too, so its imports carry the ".js" extensions Node needs. Point those at
 * the TypeScript sources rather than keeping a second copy of the rules the
 * server uses: the advice a student sees and the plan drawn next to it must
 * come from the same code.
 */
function sharedTypeScript(): Plugin {
  return {
    name: 'shared-ts-imports',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
      const candidate = resolve(dirname(importer), source.replace(/\.js$/, '.ts'));
      return existsSync(candidate) ? candidate : null;
    },
  };
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/**
 * In production the web tier serves public-web itself: index.html, the
 * favicon, the photographs, the floor models and the hand-written 3D viewer
 * all come from one origin. In development Vite serves the React app, so
 * those files have to come from somewhere else. Proxying them to the web tier
 * is not enough: /vendor is answered there with a directory redirect that ends
 * at Vite's SPA fallback, and the icons fall through to it directly, which
 * hands the browser index.html with a text/html type -- a favicon that is
 * silently ignored, and a viewer module that never loads.
 *
 * So dev serves the same directory, with the same paths, straight off disk:
 * /vendor/floor-viewer.js is the real module, not a redirect, and
 * /favicon.svg is an image. Only these directories and the two root icons are
 * claimed; /api, /login, /logout, /auth and /ws still go to their targets.
 */
function publicWebFiles(): Plugin {
  const roots = ['vendor', 'assets'];
  // The icons live at the root, where no directory name distinguishes them.
  const rootFiles = ['favicon.svg', 'icon.svg'];
  return {
    name: 'public-web-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
        const segments = path.split('/').filter(Boolean);
        const [root] = segments;
        const isRootFile = segments.length === 1 && rootFiles.includes(root ?? '');
        if (!root || (!roots.includes(root) && !isRootFile)) return next();
        const file = resolve(publicWeb, `.${path}`);
        // A traversal attempt is a plain miss, never a read outside the tree.
        if (file !== publicWeb && !file.startsWith(publicWeb + sep)) return next();
        let stats;
        try { stats = statSync(file); } catch { return next(); }
        if (!stats.isFile()) return next();
        res.setHeader('Content-Type', MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream');
        res.setHeader('Content-Length', String(stats.size));
        res.setHeader('Cache-Control', 'no-cache');
        if (req.method === 'HEAD') return res.end();
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [sharedTypeScript(), publicWebFiles(), react()],
  root: here,
  // The app is served by the same Express tier that serves the API, from
  // public-web. assets/ and vendor/ there are the photographs, floor models
  // and three.js, so the bundle goes in app/ and nothing else is touched.
  build: {
    outDir: resolve(here, '..', 'public-web'),
    assetsDir: 'app',
    emptyOutDir: false,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Every proxied entry goes through proxyToApi(): the server's
      // same-origin guard reads the Origin header on every POST, not only on
      // the auth routes, so /api/activity and the rest need the same honesty.
      '/api': proxyToApi(),
      // Only the form posts go to the server: a GET of /login/ or /signup/ is
      // a screen of this app, and dev must serve it from here.
      '/login': { ...proxyToApi(), bypass: (req: { method?: string }) => (req.method === 'POST' ? undefined : '/index.html') },
      '/signup': { ...proxyToApi(), bypass: (req: { method?: string }) => (req.method === 'POST' ? undefined : '/index.html') },
      '/logout': proxyToApi(),
      '/auth': proxyToApi(),
      // The same pair for the upgrade, which does not go through the hook
      // above. Vite's own rewriteWsOrigin option cannot do it: its upgrade
      // handler calls proxy.ws(req, socket, head) with no options, so the
      // event that would rewrite the header sees an empty object and the
      // browser's Origin rides through. The feed then answers 403 and the
      // live counts only ever appear after a refresh. Setting both headers on
      // the outgoing handshake is the hook that does fire; they are set
      // together because the server's sameOrigin compares them to each other.
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
        changeOrigin: true,
        configure: (proxy: { on(event: 'proxyReqWs', handler: (out: { setHeader(name: string, value: string): void }) => void): void }) => {
          proxy.on('proxyReqWs', (outgoing) => {
            outgoing.setHeader('Origin', API);
            outgoing.setHeader('Host', '127.0.0.1:8080');
          });
        },
      },
    },
  },
});
