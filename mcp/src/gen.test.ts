import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

// The offline drift layer (spec §12): a module or binding change the Worker does not track fails here.
it('reducers.gen.ts and errors.gen.ts match the module and its bindings', () => {
  expect(() => execFileSync('node', [new URL('../scripts/gen.mjs', import.meta.url).pathname, '--check'], { stdio: 'pipe' })).not.toThrow();
});
