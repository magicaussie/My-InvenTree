/**
 * Copy the freshly built plugin bundle into the harness public directory so the
 * browser integration tests load the exact production artifact.
 *
 * The **entire** static output tree is copied (not just the entry file): the
 * bundle contains dynamic imports for the compiled Lingui catalogs, which Vite
 * emits as separate chunk files that the entry references by relative path.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(here, '..');
const staticDir = join(frontendDir, '..', 'storage_layout', 'static');
const manifestPath = join(staticDir, '.vite', 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error(
    `[harness] missing ${manifestPath} - run 'npm run build' first (harness:prepare does this).`
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entry = manifest['src/storage_layout.tsx'];

if (!entry?.file) {
  console.error('[harness] manifest has no entry for src/storage_layout.tsx');
  process.exit(1);
}

const outDir = join(frontendDir, 'harness', 'public', 'plugin-static');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Copy every emitted file, preserving the directory layout the entry expects.
cpSync(staticDir, outDir, { recursive: true });

writeFileSync(
  join(outDir, 'manifest.json'),
  `${JSON.stringify({ file: entry.file }, null, 2)}\n`
);

// A tiny wrapper loaded as a native module script by the harness. Vite refuses
// to `import()` files from `public/`, so the browser loads this wrapper directly
// and it re-publishes the bundle's exports on `window`.
writeFileSync(
  join(outDir, 'entry.js'),
  `import * as mod from './${entry.file}';\nwindow.__pluginModule = mod;\n`
);

console.log(`[harness] prepared ${entry.file}`);
