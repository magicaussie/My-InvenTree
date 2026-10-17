import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteExternalsPlugin } from 'vite-plugin-externals';

/**
 * Libraries which are provided by the InvenTree host at runtime.
 *
 * They are *not* bundled into the plugin. Instead, every import of one of
 * these modules is rewritten to a reference to the matching `window` global
 * (assigned in `src/frontend/src/main.tsx` of the host application).
 *
 * This mirrors the layout produced by the official InvenTree plugin creator.
 */
export const externalLibs: Record<string, string> = {
  react: 'React',
  'react-dom': 'ReactDOM',
  'react-dom/client': 'ReactDOMClient',
  '@lingui/core': 'LinguiCore',
  '@lingui/react': 'LinguiReact',
  '@mantine/core': 'MantineCore',
  '@mantine/notifications': 'MantineNotifications'
};

const externalKeys = Object.keys(externalLibs);

/**
 * Production build configuration.
 *
 * The compiled plugin is written into the Python package's `static` directory
 * so that it is collected and served by InvenTree (and located by
 * `InvenTreePlugin.plugin_static_file` through the Vite manifest).
 */
export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'classic',
      babel: {
        plugins: ['macros']
      }
    }),
    viteExternalsPlugin(externalLibs)
  ],
  esbuild: {
    jsx: 'preserve'
  },
  build: {
    target: 'esnext',
    cssCodeSplit: false,
    manifest: true,
    sourcemap: true,
    emptyOutDir: true,
    outDir: '../storage_layout/static',
    rollupOptions: {
      preserveEntrySignatures: 'exports-only',
      input: {
        storage_layout: 'src/storage_layout.tsx'
      },
      external: externalKeys,
      output: {
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        globals: externalLibs
      }
    }
  },
  optimizeDeps: {
    exclude: externalKeys
  }
});
