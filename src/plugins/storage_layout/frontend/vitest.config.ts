import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Test configuration.
 *
 * This deliberately does **not** use `vite-plugin-externals` and uses the
 * automatic JSX runtime, so components render under jsdom by resolving React,
 * Mantine and Lingui from `node_modules` (the production build instead uses the
 * classic runtime against the host's `window` globals).
 */
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ['macros']
      }
    })
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/storage_layout.tsx']
    }
  }
});
