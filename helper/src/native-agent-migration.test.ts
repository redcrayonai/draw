import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { disableLegacyClaudePlugins, disableLegacyPiIntegrations } from './native-agent-migration';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:os', async original => ({ ...await original<object>(), homedir: vi.fn() }));
let directory: string, home: string, repo: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'draw-agent-migration-'));
  home = join(directory, 'home'); repo = join(directory, 'repo');
  vi.mocked(homedir).mockReturnValue(home);
  vi.stubEnv('PI_CODING_AGENT_DIR', '');
  vi.spyOn(process, 'cwd').mockReturnValue(repo);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
function write(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }

it('disables only enabled legacy Claude plugins in their recorded scopes', () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify([
    { id: 'draw@old-market', scope: 'user', enabled: true },
    { id: 'draw-local@draw-local-binary', scope: 'project', enabled: true },
    { id: 'draw@other-market', scope: 'local', enabled: true },
    { id: 'draw@draw-binary', scope: 'user', enabled: true },
    { id: 'draw@disabled-market', scope: 'user', enabled: false },
    { id: 'drawing@unrelated', scope: 'user', enabled: true },
  ]));
  disableLegacyClaudePlugins();
  expect(vi.mocked(execFileSync).mock.calls.map(([, args]) => args)).toEqual([
    ['plugin', 'list', '--json'],
    ['plugin', 'disable', 'draw@old-market', '--scope', 'user', '--json'],
    ['plugin', 'disable', 'draw-local@draw-local-binary', '--scope', 'project', '--json'],
    ['plugin', 'disable', 'draw@other-market', '--scope', 'local', '--json'],
  ]);
});
it('does not disable anything with an unsupported Claude inventory or installation scope', () => {
  for (const inventory of [{ plugins: [] }, [{ id: 'draw@old', scope: 'unknown', enabled: true }]]) {
    vi.mocked(execFileSync).mockReset().mockReturnValue(JSON.stringify(inventory));
    expect(disableLegacyClaudePlugins).toThrow('UNAVAILABLE');
    expect(execFileSync).toHaveBeenCalledOnce();
  }
});
it('disables known Pi package resources in both scopes without removing files, custom fields, or MCP settings', () => {
  const global = join(home, '.pi/agent/settings.json'), project = join(repo, '.pi/settings.json');
  const old = join(home, '.redcrayon/plugins/installed/pi-local');
  const active = join(home, '.redcrayon/plugins/installed/pi-hosted');
  write(join(old, 'package.json'), { name: 'old-package' });
  const mcp = { servers: { draw: { url: 'https://example.com' }, 'draw-local': { command: 'custom-command' } } };
  write(global, { packages: [old, active, 'npm:@redcrayonai/draw@1.0.2', 'npm:@redcrayonai/draw-other', { source: 'npm:other', skills: ['custom'] }], mcp, theme: 'custom' });
  write(project, { packages: [{ source: 'npm:@redcrayonai/draw', extensions: ['old'], autoload: false, custom: 'preserve' }, '~/.redcrayon/plugins/installed/pi-local'] });
  disableLegacyPiIntegrations();
  const disabled = { extensions: [], skills: [], prompts: [], themes: [] };
  expect(JSON.parse(readFileSync(global, 'utf8'))).toEqual({ packages: [{ source: old, ...disabled }, active, { source: 'npm:@redcrayonai/draw@1.0.2', ...disabled }, 'npm:@redcrayonai/draw-other', { source: 'npm:other', skills: ['custom'] }], mcp, theme: 'custom' });
  expect(JSON.parse(readFileSync(project, 'utf8')).packages).toEqual([{ source: 'npm:@redcrayonai/draw', ...disabled, autoload: false, custom: 'preserve' }, { source: '~/.redcrayon/plugins/installed/pi-local', ...disabled }]);
  expect(existsSync(join(old, 'package.json'))).toBe(true);
  const once = readFileSync(global, 'utf8');
  disableLegacyPiIntegrations();
  expect(readFileSync(global, 'utf8')).toBe(once);
});
it('leaves unrelated Pi settings byte-for-byte unchanged and does not create missing settings', () => {
  const path = join(home, '.pi/agent/settings.json');
  write(path, { packages: ['npm:unrelated'], extensions: ['custom-extension.ts'] });
  const before = readFileSync(path, 'utf8');
  disableLegacyPiIntegrations();
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(existsSync(join(repo, '.pi/settings.json'))).toBe(false);
});
it('validates both Pi settings files before changing either one', () => {
  const global = join(home, '.pi/agent/settings.json'), project = join(repo, '.pi/settings.json');
  write(global, { packages: ['npm:@redcrayonai/draw'] });
  write(project, { packages: 'invalid' });
  const before = readFileSync(global, 'utf8');
  expect(disableLegacyPiIntegrations).toThrow('UNAVAILABLE');
  expect(readFileSync(global, 'utf8')).toBe(before);
});

it('also disables an enabled project override when the installed user scope is already disabled', () => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args?.[1] === 'list') return JSON.stringify([{ id: 'draw@old', scope: 'user', enabled: true, projectEnabled: true }]);
    if (args?.includes('user')) throw Object.assign(new Error('already disabled'), { stdout: JSON.stringify({ command: 'disable', failureCode: 'already_in_goal_state', alreadyInGoalState: true }) });
    return JSON.stringify({ command: 'disable', outcome: 'ok' });
  });
  disableLegacyClaudePlugins();
  expect(vi.mocked(execFileSync).mock.calls.map(([, args]) => args)).toEqual([
    ['plugin', 'list', '--json'],
    ['plugin', 'disable', 'draw@old', '--scope', 'user', '--json'],
    ['plugin', 'disable', 'draw@old', '--scope', 'project', '--json'],
  ]);
});
it('preserves real Claude disable failures and deduplicates a project installation override', () => {
  const inventory = JSON.stringify([{ id: 'draw@old', scope: 'project', enabled: true, projectEnabled: true }]);
  vi.mocked(execFileSync).mockReturnValueOnce(inventory).mockReturnValue('{}');
  disableLegacyClaudePlugins();
  expect(execFileSync).toHaveBeenCalledTimes(2);
  const denied = Object.assign(new Error('required dependency'), { stdout: JSON.stringify({ failureCode: 'required_dependency' }) });
  vi.mocked(execFileSync).mockReset().mockReturnValueOnce(inventory).mockImplementation(() => { throw denied; });
  expect(disableLegacyClaudePlugins).toThrow(denied);
});
it.each(['absolute', 'tilde', 'relative'])('uses the configured Pi agent directory (%s) and leaves default settings alone', kind => {
  const custom = join(home, 'custom-agent');
  vi.stubEnv('PI_CODING_AGENT_DIR', kind === 'absolute' ? custom : kind === 'tilde' ? '~/custom-agent' : '../home/custom-agent');
  const path = join(custom, 'settings.json'), defaultPath = join(home, '.pi/agent/settings.json');
  write(path, { packages: ['npm:@redcrayonai/draw'], theme: 'custom' });
  write(defaultPath, { packages: ['npm:@redcrayonai/draw'] });
  const original = readFileSync(defaultPath, 'utf8');
  disableLegacyPiIntegrations();
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ packages: [{ source: 'npm:@redcrayonai/draw', extensions: [], skills: [], prompts: [], themes: [] }], theme: 'custom' });
  expect(readFileSync(defaultPath, 'utf8')).toBe(original);
});
