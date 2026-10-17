import InventreeHmrPlugin from '@inventreedb/ui/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteExternalsPlugin } from 'vite-plugin-externals';

import { externalLibs } from './vite.config';

/**
 * Development server configuration.
 *
 * Runs the plugin source on port 5174 and loads it directly into the host
 * frontend when the backend is configured with:
 *
 * ```yaml
 * plugin_dev:
 *   slug: 'storage-layout'
 *   host: "http://localhost:5174"
 * ```
 */
export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'classic',
      babel: {
        plugins: ['macros']
      }
    }),
    viteExternalsPlugin(externalLibs),
    InventreeHmrPlugin()
  ],
  esbuild: {
    jsx: 'preserve'
  },
  server: {
    port: 5174,
    strictPort: true,
    cors: {
      preflightContinue: true,
      origin: '*'
    }
  },
  optimizeDeps: {
    exclude: Object.keys(externalLibs)
  }
});
