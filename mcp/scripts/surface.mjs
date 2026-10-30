// Prints src/surface.ts's text: everything the Worker says to a client, for scripts/vendor-scan.sh.
import { build } from 'esbuild';

// Written inside mcp/ so its imports resolve from mcp/node_modules.
const outfile = new URL('../dist/surface.mjs', import.meta.url).pathname;
await build({
  entryPoints: [new URL('../src/surface.ts', import.meta.url).pathname],
  bundle: true,
  outfile,
  platform: 'node',
  format: 'esm',
  define: { 'process.browser': 'true' },
  logLevel: 'error',
});
process.stdout.write((await import(outfile)).surface());
