import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
import { prepareLocalPlugin, runLocalInstall, installLocalCodex } from './local-install';

it('writes a native launcher without Node and versions changed executable paths separately', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'draw-install-'));
  try {
    const source = join(temporary, 'source'), target = join(temporary, 'plugins');
    cpSync(new URL('../../plugin/local/', import.meta.url), source, { recursive: true });
    const executable = '/Applications/Draw local/draw';
    const result = prepareLocalPlugin(source, target, executable);
    const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
    expect(json(join(result, 'mcp.json')).mcpServers['draw-local']).toEqual({ type: 'stdio', command: executable, args: ['local-mcp', '--per-repo'] });
    expect(json(join(result, 'plugin.json')).version).toBe(json(join(result, '.codex-plugin/plugin.json')).version);
    expect(readFileSync(join(result, 'skills/local/SKILL.md'), 'utf8')).toContain('CODEX_THREAD_ID');
    expect(prepareLocalPlugin(source, target, executable)).toBe(result);
    expect(prepareLocalPlugin(source, target, '/new/location/draw')).not.toBe(result);
    expect(readdirSync(target).some(name => name.startsWith('.install-'))).toBe(false);
    expect(json(join(source, 'mcp.json')).mcpServers['draw-local'].command).toBe('node');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
it('rejects unsupported install targets before touching agent configuration', () => {
  expect(() => runLocalInstall(['unknown'])).toThrow('REJECTED: usage: draw install codex');
});

it('upgrades a local Codex marketplace and restores its source if registration fails', () => {
  const run = vi.mocked(execFileSync);
  const previous = { name: 'draw-local-dev', root: '/old', marketplaceSource: { sourceType: 'local' } };
  run.mockReset().mockReturnValueOnce(JSON.stringify({ marketplaces: [previous] }));
  installLocalCodex('/new');
  expect(run.mock.calls.map(call => call[1])).toEqual([
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'marketplace', 'remove', 'draw-local-dev'],
    ['plugin', 'marketplace', 'add', '/new'],
    ['plugin', 'add', 'draw-local@draw-local-dev'],
  ]);
  run.mockReset().mockReturnValueOnce(JSON.stringify({ marketplaces: [previous] }))
    .mockReturnValueOnce('').mockImplementationOnce(() => { throw new Error('registration failed'); });
  expect(() => installLocalCodex('/new')).toThrow('registration failed');
  expect(run.mock.calls.at(-1)?.[1]).toEqual(['plugin', 'marketplace', 'add', '/old']);
});
it('installs fresh, reuses the same source, and refuses to replace a remote marketplace', () => {
  const run = vi.mocked(execFileSync);
  for (const marketplaces of [[], [{ name: 'draw-local-dev', root: '/same' }]]) {
    run.mockReset().mockReturnValueOnce(JSON.stringify({ marketplaces }));
    installLocalCodex('/same');
    expect(run.mock.calls.some(call => call[1]?.includes('remove'))).toBe(false);
    expect(run.mock.calls.at(-1)?.[1]).toEqual(['plugin', 'add', 'draw-local@draw-local-dev']);
  }
  run.mockReset().mockReturnValueOnce(JSON.stringify({ marketplaces: [{ name: 'draw-local-dev', root: '/remote', marketplaceSource: { sourceType: 'git' } }] }));
  expect(() => installLocalCodex('/new')).toThrow('REJECTED');
  expect(run).toHaveBeenCalledTimes(1);
});

it('restores the previous Codex marketplace when plugin installation fails after registration', () => {
  const run = vi.mocked(execFileSync);
  run.mockReset().mockReturnValueOnce(JSON.stringify({ marketplaces: [{ name: 'draw-local-dev', root: '/old', marketplaceSource: { sourceType: 'local' } }] }))
    .mockReturnValueOnce('').mockReturnValueOnce('').mockImplementationOnce(() => { throw new Error('plugin rejected'); });
  expect(() => installLocalCodex('/new')).toThrow('plugin rejected');
  expect(run.mock.calls.slice(-2).map(call => call[1])).toEqual([
    ['plugin', 'marketplace', 'remove', 'draw-local-dev'], ['plugin', 'marketplace', 'add', '/old'],
  ]);
});
