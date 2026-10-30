import { build } from 'esbuild';
import { expect, it } from 'vitest';

// What the Worker bundles from agent/ and shared/ (spec §1 Bundle): no
// node:fs, no child_process, no DB SDK. Exact, so any new import is a decision.
// Buffer is the global nodejs_compat provides, not an import.
it('the session flows, the snapshot and the capture path bundle with nothing but these imports', async () => {
  const { metafile } = await build({
    entryPoints: [
      'src/snapshot.ts',
      'src/capture-deps.ts',
      '../shared/capture.ts',
      '../agent/src/session.ts',
      '../agent/src/ids.ts',
      '../agent/src/results.ts',
      '../agent/src/routes.ts',
    ],
    absWorkingDir: new URL('..', import.meta.url).pathname,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outdir: 'out',
  });
  const imports = Object.values(metafile.inputs).flatMap(input => input.imports.filter(i => i.external).map(i => i.path));
  expect([...new Set(imports)].sort()).toEqual(['node:crypto', 'node:path', 'typescript']);
});
