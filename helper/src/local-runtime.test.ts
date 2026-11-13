import { afterEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

afterEach(() => vi.unstubAllGlobals());

it('uses the current CLI entry or a supplied sibling entry under Node', async () => {
  vi.stubGlobal('Bun', undefined);
  vi.resetModules();
  const { localCommand } = await import('./local-runtime');
  expect(localCommand()).toEqual([process.execPath, resolve(process.argv[1])]);
  expect(localCommand('plugin/bin/redcrayon.mjs')).toEqual([process.execPath, resolve('plugin/bin/redcrayon.mjs')]);
});

it('runs a compiled executable directly, regardless of the JavaScript entry', async () => {
  vi.stubGlobal('Bun', { isStandaloneExecutable: true });
  vi.resetModules();
  const { localCommand } = await import('./local-runtime');
  expect(localCommand()).toEqual([process.execPath]);
  expect(localCommand('/$bunfs/root/redcrayon.mjs')).toEqual([process.execPath]);
});
