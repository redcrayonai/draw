import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activateNativePlugin, prepareNativePlugin, runNativeInstall, runNativePermissions } from './native-install';
import { choosePermissions, permissionPath, savePermissions } from './permissions';
import { configureCodexPermissions } from './codex-permissions';
import { installLocalCodex } from './local-install';
vi.mock('./codex-permissions', () => ({ configureCodexPermissions: vi.fn() }));
vi.mock('./local-install', () => ({ installLocalCodex: vi.fn() }));
vi.mock('./permissions', async original => ({ ...await original<typeof import('./permissions')>(), choosePermissions: vi.fn(), savePermissions: vi.fn() }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: vi.fn() }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, cpSync: vi.fn(fs.cpSync), renameSync: vi.fn(fs.renameSync), readFileSync: vi.fn(fs.readFileSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
let directory: string, root: string, destination: string, executable: string;
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
function write(file: string, value: unknown) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
beforeEach(() => {
  vi.mocked(cpSync).mockImplementation(actualFs.cpSync); vi.mocked(renameSync).mockImplementation(actualFs.renameSync);
  vi.mocked(readFileSync).mockImplementation(actualFs.readFileSync);
  directory = mkdtempSync(join(tmpdir(), 'draw-install-test-')); root = join(directory, 'assets'); destination = join(directory, 'prepared');
  executable = join(directory, "native tools' folder", 'draw $(never-execute)');
  vi.mocked(homedir).mockReturnValue(directory);
  vi.mocked(choosePermissions).mockReset().mockResolvedValue({ permissions: { boards: 'ask', conversation: 'ask', snippets: 'deny', uploads: 'deny' }, managedDisabledTools: ['old_tool'] });
  vi.mocked(configureCodexPermissions).mockReset().mockResolvedValue(['read_code']);
  vi.mocked(installLocalCodex).mockReset();
  write(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n'); chmodSync(executable, 0o755);
  for (const file of ['plugin.json', '.codex-plugin/plugin.json']) write(join(root, file), { name: 'draw-local', version: 'old' });
  write(join(root, 'mcp.json'), { mcpServers: {} }); write(join(root, 'skills/local/SKILL.md'), '# local board');
  write(join(root, 'pi-extension.mjs'), 'export default (pi, options) => { pi.loaded = options; };');
  const hosted = join(root, 'hosted-plugin');
  for (const file of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) write(join(hosted, file), { name: 'draw', version: 'old', ...(file.startsWith('.codex') ? { hooks: './codex/hooks.json' } : {}) });
  for (const file of ['hooks/hooks.json', 'codex/hooks.json']) write(join(hosted, file), readFileSync(resolve('../plugin', file), 'utf8'));
  write(join(hosted, '.mcp.json'), { mcpServers: { draw: { type: 'http', url: 'https://test.example/mcp' } } });
  write(join(hosted, 'skills/navigate/SKILL.md'), '# hosted board');
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); rmSync(directory, { recursive: true, force: true }); });

it.each(['codex', 'claude-code', 'pi'] as const)('prepares supported local manifests and native MCP for %s', agent => {
  const { target, name, marketplace } = prepareNativePlugin(root, destination, executable, '1.2.3', agent, 'local');
  expect(name).toBe('draw-local'); expect(marketplace).toBe('draw-local-dev');
  const market = json(join(target, '.claude-plugin/marketplace.json'));
  expect(market.plugins[0].source).toEqual(agent === 'claude-code' ? './' : { source: 'local', path: '.' });
  expect(json(join(target, '.mcp.json'))).toEqual(json(join(target, 'mcp.json')));
  expect(json(join(target, 'mcp.json')).mcpServers['draw-local']).toEqual({ type: 'stdio', command: executable, args: ['local-mcp', '--per-repo'], ...(agent === 'codex' ? { env: { DRAW_PERMISSION_FILE: permissionPath('local'), DRAW_PERMISSION_MODE: 'local' } } : {}) });
  for (const file of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) expect(json(join(target, file))).toMatchObject({ name: 'draw-local', version: expect.stringMatching(/^1\.2\.3\+binary\.[a-f0-9]{16}$/) });
  if (agent === 'claude-code') {
    const hooks = json(join(target, 'hooks/hooks.json')).hooks;
    expect(hooks.PostToolUse[0].matcher).toContain('open_board');
    const command = hooks.SessionStart[0].hooks[0].command;
    expect(command).not.toMatch(/node|\.mjs/);
    expect(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })).toBe('local-claude-hook\n--auto\n');
  }
});

it.each(['codex', 'claude-code', 'pi'] as const)('keeps hosted MCP and native hook launchers for %s', agent => {
  const { target } = prepareNativePlugin(root, destination, executable, '1.2.3', agent, 'hosted');
  expect(json(join(target, '.mcp.json')).mcpServers.draw.url).toBe('https://test.example/mcp');
  expect(json(join(target, '.codex-plugin/plugin.json')).hooks).toBe('./codex/hooks.json');
  const originalHooks = json(join(root, 'hosted-plugin/codex/hooks.json'));
  const codexHooks = json(join(target, 'codex/hooks.json'));
  expect(codexHooks.hooks.PostToolUse).toEqual(originalHooks.hooks.PostToolUse);
  if (agent === 'codex') {
    expect(codexHooks.hooks.PreToolUse[0].hooks[0].timeout).toBe(180);
    const matcher = new RegExp(codexHooks.hooks.PreToolUse[0].matcher);
    for (const name of ['mcp__draw__read_code', 'mcp__plugin_draw_draw__delete_node', 'mcp__redcrayon-dev__future_tool']) expect(matcher.test(name)).toBe(true);
    for (const name of ['mcp__plugin_other_draw__read_code', 'mcp__draw-local__read_code', 'mcp__other__delete_node']) expect(matcher.test(name)).toBe(false);
  } else expect(codexHooks).toEqual(originalHooks);
  for (const file of ['hooks/hooks.json', 'codex/hooks.json']) {
    const hooks = json(join(target, file)).hooks;
    for (const group of Object.values(hooks) as any[]) for (const entry of group) for (const hook of entry.hooks) {
      expect(hook.command).toContain('/bin/draw'); expect(hook.command).not.toMatch(/node|\.mjs/);
    }
    const capture = hooks.PreToolUse.flatMap((entry: any) => entry.hooks).find((hook: any) => hook.command.endsWith(" hook'"));
    expect(execFileSync('/bin/sh', ['-c', capture.command], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: target, PLUGIN_ROOT: target } })).toBe('hook\n');
  }
  expect(execFileSync(join(target, 'bin/draw'), ['two words', "one'quote", '$(literal)'], { encoding: 'utf8' })).toBe("two words\none'quote\n$(literal)\n");
});

it.each(['local', 'hosted'] as const)('launches Codex with its %s policy path without shell interpolation', mode => {
  vi.mocked(homedir).mockReturnValue(join(directory, "settings' $(literal)"));
  writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$DRAW_PERMISSION_FILE" "$DRAW_PERMISSION_MODE"\n');
  const { target } = prepareNativePlugin(root, destination, executable, '1.2.3', 'codex', mode);
  expect(execFileSync(join(target, 'bin/draw'), [], { encoding: 'utf8' })).toBe(`${permissionPath(mode)}\n${mode}\n`);
  vi.mocked(homedir).mockReturnValue(join(directory, 'different-home'));
  expect(prepareNativePlugin(root, destination, executable, '1.2.3', 'codex', mode).target).not.toBe(target);
});

it.each([
  ['codex', '--mode', 'hosted', '--permissions-defaults'],
  ['codex', '--permissions-defaults', '--mode', 'hosted'],
])('reconfigures permissions without reinstalling (%j)', async (...args) => {
  expect(await runNativePermissions(args)).toBe(0);
  expect(choosePermissions).toHaveBeenCalledWith('hosted', { defaults: true, reconfigure: true });
  expect(configureCodexPermissions).toHaveBeenCalledWith('hosted', expect.objectContaining({ snippets: 'deny' }), ['old_tool']);
  expect(savePermissions).toHaveBeenCalledWith('hosted', { permissions: { boards: 'ask', conversation: 'ask', snippets: 'deny', uploads: 'deny' }, managedDisabledTools: ['read_code'] });
  expect(installLocalCodex).not.toHaveBeenCalled();
  expect(cpSync).not.toHaveBeenCalled();
});

it('does not mutate installation or saved choices when policy configuration fails', async () => {
  vi.mocked(configureCodexPermissions).mockRejectedValueOnce(new Error('configuration failed'));
  await expect(runNativeInstall(['codex', '--permissions-defaults'], '1.2.3')).rejects.toThrow('configuration failed');
  expect(choosePermissions).toHaveBeenCalledWith('local', { defaults: true, reconfigure: false });
  expect(savePermissions).not.toHaveBeenCalled();
  expect(installLocalCodex).not.toHaveBeenCalled();
  expect(existsSync(join(directory, '.redcrayon'))).toBe(false);
});

it('aborts before policy configuration or installation if consent is unavailable', async () => {
  vi.mocked(choosePermissions).mockRejectedValueOnce(new Error('consent required'));
  await expect(runNativeInstall(['codex'], '1.2.3')).rejects.toThrow('consent required');
  expect(configureCodexPermissions).not.toHaveBeenCalled();
  expect(savePermissions).not.toHaveBeenCalled();
  expect(installLocalCodex).not.toHaveBeenCalled();
});

it('saves enforced permissions before plugin activation and retains them if installation fails', async () => {
  const sourceRoot = dirname(new URL(import.meta.url).pathname);
  vi.mocked(readFileSync).mockImplementation(((file: any, options: any) => actualFs.readFileSync(
    typeof file === 'string' && file.startsWith(sourceRoot + '/') ? join(root, file.slice(sourceRoot.length + 1)) : file, options,
  )) as typeof readFileSync);
  vi.mocked(installLocalCodex).mockImplementationOnce(() => {
    expect(savePermissions).toHaveBeenCalledWith('local', expect.objectContaining({ managedDisabledTools: ['read_code'] }));
    throw new Error('agent install failed');
  });
  await expect(runNativeInstall(['codex'], '1.2.3')).rejects.toThrow('agent install failed');
  expect(existsSync(join(directory, '.redcrayon/plugins/installed/codex-local'))).toBe(false);
  expect(existsSync(join(directory, '.redcrayon/integrations/codex-local.json'))).toBe(false);
});

it.each([
  ['codex', '--mode', 'elsewhere'], ['codex', '--mode'],
  ['codex', '--mode', 'local', '--mode', 'hosted'],
  ['codex', '--permissions-defaults', '--permissions-defaults'],
  ['pi', '--permissions-defaults'], ['claude-code', '--permissions-defaults'],
])('rejects malformed install options before mutation (%j)', async (...args) => {
  await expect(runNativeInstall(args, '1.2.3')).rejects.toThrow('usage:');
  expect(choosePermissions).not.toHaveBeenCalled();
  expect(configureCodexPermissions).not.toHaveBeenCalled();
  expect(cpSync).not.toHaveBeenCalled();
});

it.each(['local', 'hosted'] as const)('loads the pi wrapper with the native executable and %s mode', async mode => {
  vi.stubEnv('DRAW_EXECUTABLE', ''); vi.stubEnv('DRAW_MODE', '');
  const { target } = prepareNativePlugin(root, destination, executable, '1.2.3', 'pi', mode);
  const manifest = json(join(target, 'package.json'));
  expect(manifest.pi).toEqual({ extensions: ['./pi/extension.mjs'], skills: ['./skills'] });
  const extension = await import(pathToFileURL(join(target, 'pi/extension.mjs')).href);
  const pi: any = {}; await extension.default(pi);
  expect(pi.loaded).toEqual({ executable, mode });
  expect(process.env.DRAW_EXECUTABLE).toBe(''); expect(process.env.DRAW_MODE).toBe('');
});

it('reuses identical extraction and invalidates cached versions when runtime or assets change', () => {
  const prepare = (version = '1.2.3', command = executable) => prepareNativePlugin(root, destination, command, version, 'codex', 'local').target;
  const first = prepare(); expect(prepare()).toBe(first);
  expect(prepare('1.2.4')).not.toBe(first); expect(prepare('1.2.3', executable + '-new')).not.toBe(first);
  write(join(root, 'skills/local/SKILL.md'), '# updated instructions');
  const changed = prepare(); expect(changed).not.toBe(first);
  expect(json(join(changed, 'plugin.json')).version).not.toBe(json(join(first, 'plugin.json')).version);
});

it('activates updates at the stable path and leaves the previous installation intact until copying succeeds', () => {
  const target = join(directory, 'installed/pi-local'), first = join(directory, 'first'), next = join(directory, 'next');
  write(join(first, 'version'), 'first'); write(join(next, 'version'), 'next');
  activateNativePlugin(first, target);
  vi.mocked(cpSync).mockImplementationOnce(() => { expect(readFileSync(join(target, 'version'), 'utf8')).toBe('first'); throw new Error('copy failed'); });
  expect(() => activateNativePlugin(next, target)).toThrow('copy failed');
  expect(readFileSync(join(target, 'version'), 'utf8')).toBe('first');
  activateNativePlugin(next, target); expect(readFileSync(join(target, 'version'), 'utf8')).toBe('next');
  expect(readdirSync(dirname(target))).toEqual(['pi-local']);
});

it('restores the previous installation when the activation rename fails', () => {
  const target = join(directory, 'installed/pi-local'), source = join(directory, 'source');
  write(join(target, 'version'), 'old'); write(join(source, 'version'), 'new');
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(from).includes('.activate-') && !String(from).endsWith('-previous') && to === target) throw new Error('activation failed'); actualFs.renameSync(from, to); });
  expect(() => activateNativePlugin(source, target)).toThrow('activation failed');
  expect(readFileSync(join(target, 'version'), 'utf8')).toBe('old');
});

it('preserves the backup if both activation and rollback fail', () => {
  const target = join(directory, 'installed/pi-local'), source = join(directory, 'source');
  write(join(target, 'version'), 'old'); write(join(source, 'version'), 'new');
  vi.mocked(renameSync).mockImplementation((from, to) => { if (to === target) throw new Error('rename unavailable'); actualFs.renameSync(from, to); });
  expect(() => activateNativePlugin(source, target)).toThrow('rename unavailable');
  expect(existsSync(target)).toBe(false);
  const backup = readdirSync(dirname(target)).find(name => name.endsWith('-previous'));
  expect(backup).toBeDefined(); expect(readFileSync(join(dirname(target), backup!, 'version'), 'utf8')).toBe('old');
});

it('restores existing plugin files when the agent rejects the new install', () => {
  const target = join(directory, 'installed/pi-local'), source = join(directory, 'source');
  write(join(target, 'version'), 'old'); write(join(source, 'version'), 'new');
  expect(() => activateNativePlugin(source, target, () => {
    expect(readFileSync(join(target, 'version'), 'utf8')).toBe('new');
    throw new Error('agent install failed');
  })).toThrow('agent install failed');
  expect(readFileSync(join(target, 'version'), 'utf8')).toBe('old');
  expect(readdirSync(dirname(target))).toEqual(['pi-local']);
});

it('invalidates pi extraction when only extension code changes at the same release version', () => {
  const prepare = () => prepareNativePlugin(root, destination, executable, '1.2.3', 'pi', 'local').target;
  const before = prepare();
  write(join(root, 'pi-extension.mjs'), 'export default () => "new extension";');
  const after = prepare(); expect(after).not.toBe(before);
  expect(readFileSync(join(after, 'pi/pi-extension.mjs'), 'utf8')).toContain('new extension');
});
