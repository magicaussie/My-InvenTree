import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const frontendDir = fileURLToPath(new URL('..', import.meta.url));

/**
 * Vite dev-server config for the Playwright integration harness.
 *
 * Serves `harness/index.html` (with SPA fallback so deep paths like
 * `/cabinets/cab-1/design` resolve) and the prepared plugin bundle from
 * `harness/public/plugin-static/`. No backend is required.
 */
export default defineConfig({
  root,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    fs: {
      allow: [root, frontendDir]
    }
  }
});
