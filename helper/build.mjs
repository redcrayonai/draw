// Bundles src/cli.ts into one file that needs nothing but Node 20+ built-ins
// and git on PATH: `node build.mjs [outfile]` (default dist/redcrayon.mjs).
import { chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(process.argv[2] ?? resolve(here, 'dist/redcrayon.mjs'));
const { metafile } = await build({
  absWorkingDir: here,
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  banner: { js: '#!/usr/bin/env node' },
  metafile: true,
  logLevel: 'warning',
});
const imports = [...new Set(Object.values(metafile.inputs).flatMap(i => i.imports.filter(x => x.external).map(x => x.path)))];
const foreign = imports.filter(p => !p.startsWith('node:'));
if (foreign.length > 0) {
  console.error(`redcrayon.mjs imports ${foreign.join(', ')}; it may import Node built-ins only`);
  process.exit(1);
}
chmodSync(outfile, 0o755);
