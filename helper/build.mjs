// Bundles src/cli.ts into one file that needs nothing but Node 20+ built-ins
// and git on PATH: `node build.mjs [outfile]` (default dist/redcrayon.mjs).
import { chmodSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { isBuiltin } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const wsLicense = readFileSync(resolve(here, 'node_modules/ws/LICENSE'), 'utf8');
const outfile = resolve(process.argv[2] ?? resolve(here, 'dist/redcrayon.mjs'));
const { metafile } = await build({
  absWorkingDir: here,
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  banner: { js: `#!/usr/bin/env node\n/*! ws (MIT)\n${wsLicense}*/\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);` },
  define: { 'process.env.WS_NO_BUFFER_UTIL': '\"1\"', 'process.env.WS_NO_UTF_8_VALIDATE': '\"1\"' },
  metafile: true,
  logLevel: 'warning',
});
const imports = [...new Set(Object.values(metafile.inputs).flatMap(i => i.imports.filter(x => x.external).map(x => x.path)))];
const foreign = imports.filter(p => !isBuiltin(p));
if (foreign.length > 0) {
  console.error(`redcrayon.mjs imports ${foreign.join(', ')}; it may import Node built-ins only`);
  process.exit(1);
}
chmodSync(outfile, 0o755);
// The plugin's chat hook runs on every batch of terminal text, so it stays small and starts fast.
await build({ absWorkingDir: here, entryPoints: ['src/chat-hook.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: resolve(dirname(outfile), 'chat-hook.mjs'), logLevel: 'warning' });
