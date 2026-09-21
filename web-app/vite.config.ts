import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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

export default defineConfig({
  plugins: [sharedTypeScript(), react()],
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
      '/api': 'http://127.0.0.1:8080',
      // Only the form posts go to the server: a GET of /login/ or /signup/ is
      // a screen of this app, and dev must serve it from here.
      '/login': { target: 'http://127.0.0.1:8080', bypass: (req) => (req.method === 'POST' ? undefined : '/index.html') },
      '/signup': { target: 'http://127.0.0.1:8080', bypass: (req) => (req.method === 'POST' ? undefined : '/index.html') },
      '/logout': 'http://127.0.0.1:8080',
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
      '/assets': 'http://127.0.0.1:8080',
      '/vendor': 'http://127.0.0.1:8080',
    },
  },
});
