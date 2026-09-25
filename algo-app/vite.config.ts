import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Built into public-algo, which the edge serves on ALGO_PORT. Kept apart from
// the student app: this one shows thermal imagery and writes to sensors.
export default defineConfig({
  plugins: [react()],
  root: here,
  build: { outDir: resolve(here, '..', 'public-algo'), emptyOutDir: true, sourcemap: true },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8091',
      '/ws': { target: 'ws://127.0.0.1:8091', ws: true },
    },
  },
});
