import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activateNativePlugin, prepareNativePlugin, runNativeInstall, runNativePermissions, runNativeUninstall } from './native-install';
import { choosePermissionSet, permissionPath, savePermissions } from './permissions';
import { configureCodexPermissions, disableLegacyCodexIntegrations, readCodexUserConfig } from './codex-permissions';
import { installLocalCodex } from './local-install';
vi.mock('./codex-permissions', () => ({ configureCodexPermissions: vi.fn(), disableLegacyCodexIntegrations: vi.fn(), readCodexUserConfig: vi.fn() }));
const answers: string[] = [], asked: string[] = [];
vi.mock('node:readline/promises', () => ({ createInterface: () => ({ question: async (q: string) => { asked.push(q); return answers.shift() ?? ''; }, close() {} }) }));
vi.mock('./local-install', () => ({ installLocalCodex: vi.fn() }));
vi.mock('node:child_process', async original => {
  const child = await original<typeof import('node:child_process')>();
  return { ...child, execFileSync: vi.fn(child.execFileSync) };
});
vi.mock('./permissions', async original => ({ ...await original<typeof import('./permissions')>(), choosePermissionSet: vi.fn(), savePermissions: vi.fn() }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: vi.fn() }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, cpSync: vi.fn(fs.cpSync), renameSync: vi.fn(fs.renameSync), readFileSync: vi.fn(fs.readFileSync), readdirSync: vi.fn(fs.readdirSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
let directory: string, root: string, destination: string, executable: string;
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
function write(file: string, value: unknown) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
beforeEach(() => {
  vi.mocked(cpSync).mockImplementation(actualFs.cpSync); vi.mocked(renameSync).mockImplementation(actualFs.renameSync);
  vi.mocked(readFileSync).mockImplementation(actualFs.readFileSync);
  vi.mocked(readdirSync).mockImplementation(actualFs.readdirSync);
  directory = mkdtempSync(join(tmpdir(), 'draw-install-test-')); root = join(directory, 'assets'); destination = join(directory, 'prepared');
  executable = join(directory, "native tools' folder", 'draw $(never-execute)');
  vi.mocked(homedir).mockReturnValue(directory);
  vi.mocked(choosePermissionSet).mockReset().mockImplementation(async modes => modes.map(mode => ({ mode, editable: true, record: { permissions: { boards: 'ask', conversation: 'ask', snippets: 'deny', uploads: 'deny' }, managedDisabledTools: ['old_tool'] } })));
  vi.mocked(configureCodexPermissions).mockReset().mockImplementation(async choices => choices.map(({ mode, record }) => ({ mode, record: { ...record, managedDisabledTools: ['read_code'], routed: true } })));
  vi.mocked(installLocalCodex).mockReset();
  vi.mocked(execFileSync).mockReset();
  vi.mocked(readCodexUserConfig).mockReset().mockResolvedValue({});
  write(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n'); chmodSync(executable, 0o755);
  for (const file of ['plugin.json', '.codex-plugin/plugin.json']) write(join(root, file), { name: 'draw-local', version: 'old' });
  write(join(root, 'unified/skills/navigate/SKILL.md'), '# unified routing');
  write(join(root, 'mcp.json'), { mcpServers: {} }); write(join(root, 'skills/local/SKILL.md'), '# local board');
  write(join(root, 'pi-extension.mjs'), 'export default (pi, options) => { pi.loaded = options; };');
  const hosted = join(root, 'hosted-plugin');
  for (const file of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) write(join(hosted, file), { name: 'draw', version: 'old', ...(file.startsWith('.codex') ? { hooks: './codex/hooks.json' } : {}) });
  for (const file of ['hooks/hooks.json', 'codex/hooks.json']) write(join(hosted, file), readFileSync(resolve('../plugin', file), 'utf8'));
  write(join(hosted, '.mcp.json'), { mcpServers: { draw: { type: 'http', url: 'https://test.example/mcp' } } });
  for (const skill of ['navigate', 'handoff', 'triage', 'make-it-make-sense']) write(join(hosted, `skills/${skill}/SKILL.md`), '# hosted board [reference](../../references/review.md)');
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); rmSync(directory, { recursive: true, force: true }); });

it.each(['codex', 'claude-code', 'pi'] as const)('prepares supported local manifests and native MCP for %s', agent => {
  const { target, name, marketplace } = prepareNativePlugin(root, destination, executable, '1.2.3', agent, 'local');
  expect(name).toBe('draw'); expect(marketplace).toBe('draw-binary');
  const market = json(join(target, '.claude-plugin/marketplace.json'));
  expect(market.plugins[0].source).toEqual(agent === 'claude-code' ? './' : { source: 'local', path: '.' });
  expect(json(join(target, '.mcp.json'))).toEqual(json(join(target, 'mcp.json')));
  expect(json(join(target, 'mcp.json')).mcpServers.draw).toEqual({ type: 'stdio', command: executable, args: ['mcp'], env: { REDCRAYON_MCP_URL: 'https://test.example/mcp', ...(agent === 'codex' ? { DRAW_PERMISSION_FILE: permissionPath('local'), DRAW_PERMISSION_MODE: 'local', DRAW_HOSTED_PERMISSION_FILE: permissionPath('hosted') } : {}) } });
  for (const file of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) expect(json(join(target, file))).toMatchObject({ name: 'draw', version: expect.stringMatching(/^1\.2\.3\+binary\.[a-f0-9]{16}$/) });
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
  expect(json(join(target, '.mcp.json')).mcpServers.draw.env.REDCRAYON_MCP_URL).toBe('https://test.example/mcp');
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
      expect(hook.command.includes('/bin/draw') || hook.command.includes('local-claude-hook')).toBe(true); expect(hook.command).not.toMatch(/node|\.mjs/);
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
  expect(execFileSync(join(target, 'bin/draw'), [mode === 'local' ? 'local' : 'capture'], { encoding: 'utf8' })).toBe(`${permissionPath(mode)}\n${mode}\n`);
  vi.mocked(homedir).mockReturnValue(join(directory, 'different-home'));
  expect(prepareNativePlugin(root, destination, executable, '1.2.3', 'codex', mode).target).not.toBe(target);
});

it.each([
  ['codex', '--mode', 'hosted', '--permissions-defaults'],
  ['codex', '--permissions-defaults', '--mode', 'hosted'],
])('reconfigures permissions without reinstalling (%j)', async (...args) => {
  expect(await runNativePermissions(args)).toBe(0);
  expect(choosePermissionSet).toHaveBeenCalledWith(['local', 'hosted'], { defaults: true, reconfigure: true });
  expect(configureCodexPermissions).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ mode: 'hosted', record: expect.objectContaining({ managedDisabledTools: ['old_tool'] }) })]));
  expect(savePermissions).toHaveBeenCalledWith('hosted', { permissions: { boards: 'ask', conversation: 'ask', snippets: 'deny', uploads: 'deny' }, managedDisabledTools: ['read_code'], routed: true });
  expect(installLocalCodex).not.toHaveBeenCalled();
  expect(cpSync).not.toHaveBeenCalled();
});

it('does not mutate installation or saved choices when policy configuration fails', async () => {
  vi.mocked(configureCodexPermissions).mockRejectedValueOnce(new Error('configuration failed'));
  await expect(runNativeInstall(['codex', '--permissions-defaults'], '1.2.3')).rejects.toThrow('configuration failed');
  expect(choosePermissionSet).toHaveBeenCalledWith(['local', 'hosted'], { defaults: true, reconfigure: false });
  expect(savePermissions).not.toHaveBeenCalled();
  expect(installLocalCodex).not.toHaveBeenCalled();
  expect(existsSync(join(directory, '.redcrayon'))).toBe(false);
});

it('aborts before policy configuration or installation if consent is unavailable', async () => {
  vi.mocked(choosePermissionSet).mockRejectedValueOnce(new Error('consent required'));
  await expect(runNativeInstall(['codex'], '1.2.3')).rejects.toThrow('consent required');
  expect(configureCodexPermissions).not.toHaveBeenCalled();
  expect(savePermissions).not.toHaveBeenCalled();
  expect(installLocalCodex).not.toHaveBeenCalled();
});

it('saves enforced permissions before plugin activation and retains them if installation fails', async () => {
  useBundledAssets();
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
  expect(choosePermissionSet).not.toHaveBeenCalled();
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
  expect(pi.loaded).toEqual({ executable, mode: 'unified', endpoint: 'https://test.example/mcp' });
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

it('installs one skill with both transports and correctly relocated workflow references', () => {
  const { target } = prepareNativePlugin(root, destination, executable, '1.2.3', 'codex');
  expect(readdirSync(join(target, 'skills'))).toEqual(['navigate']);
  expect(readdirSync(join(target, 'skills/navigate/references')).sort()).toEqual(['handoff.md', 'hosted.md', 'local.md', 'make-it-make-sense.md', 'triage.md']);
  expect(readFileSync(join(target, 'skills/navigate/references/hosted.md'), 'utf8')).toContain('../../../references/review.md');
  expect(Object.keys(json(join(target, 'mcp.json')).mcpServers).sort()).toEqual(['draw']);
  expect(prepareNativePlugin(root, destination, executable, '1.2.3', 'codex', 'local').target).toBe(target);
  expect(prepareNativePlugin(root, destination, executable, '1.2.3', 'codex', 'hosted').target).toBe(target);
});

it('configures both policies and replaces competing integrations only after successful installation', async () => {
  useBundledAssets();
  vi.mocked(installLocalCodex).mockImplementationOnce(() => {
    expect(configureCodexPermissions).toHaveBeenCalledOnce();
    expect(savePermissions).toHaveBeenCalledTimes(2);
    expect(disableLegacyCodexIntegrations).not.toHaveBeenCalled();
  });
  await runNativeInstall(['codex'], '1.2.3');
  expect(installLocalCodex).toHaveBeenCalledWith(join(directory, '.redcrayon/plugins/installed/codex-hosted'), 'draw-binary', 'draw');
  expect(disableLegacyCodexIntegrations).toHaveBeenCalledOnce();
  expect(json(join(directory, '.redcrayon/integrations/codex-unified.json'))).toMatchObject({ mode: 'unified' });
});

function useBundledAssets() {
  const sourceRoot = dirname(new URL(import.meta.url).pathname);
  const asset = (file: any) => typeof file === 'string' && file.startsWith(sourceRoot + '/') ? join(root, file.slice(sourceRoot.length + 1)) : file;
  vi.mocked(readFileSync).mockImplementation(((file: any, options: any) => actualFs.readFileSync(asset(file), options)) as typeof readFileSync);
  vi.mocked(readdirSync).mockImplementation(((file: any, options: any) => actualFs.readdirSync(asset(file), options)) as typeof readdirSync);
}

// ---------- hosted endpoint ----------
const active = () => join(directory, '.redcrayon/plugins/installed/codex-hosted');
const installedUrl = () => json(join(active(), '.mcp.json')).mcpServers.draw.env.REDCRAYON_MCP_URL;
const tty = (on: boolean) => { for (const stream of [process.stdin, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: on, configurable: true }); };
let stderr: string[];
beforeEach(() => {
  answers.length = 0; asked.length = 0; stderr = []; tty(false); vi.stubEnv('REDCRAYON_MCP_URL', '');
  vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => { stderr.push(String(text)); return true; }) as any);
  useBundledAssets();
});
afterEach(() => { tty(false); vi.restoreAllMocks(); });
const install = (...args: string[]) => runNativeInstall(['codex', ...args], '1.2.3');

it('prompts with the packaged default and saves it on Enter', async () => {
  tty(true); answers.push('');
  await install('--mode', 'hosted');
  expect(asked).toEqual(['Draw instance URL [https://test.example/mcp]: ']);
  expect(installedUrl()).toBe('https://test.example/mcp');
  expect(stderr.join('')).toContain('Hosted endpoint: https://test.example/mcp');
  expect(stderr.join('')).toContain('restart Codex');
});

it('saves a custom URL, re-asks on an invalid one, and defaults to it on reinstall', async () => {
  tty(true); answers.push('ftp://x', 'http://example.com/mcp', 'https://mine.example/mcp');
  await install();
  expect(installedUrl()).toBe('https://mine.example/mcp');
  expect(asked).toHaveLength(3);
  asked.length = 0; answers.push('');
  await install();
  expect(asked).toEqual(['Draw instance URL [https://mine.example/mcp]: ']);
  expect(installedUrl()).toBe('https://mine.example/mcp');
  expect(installLocalCodex).toHaveBeenLastCalledWith(active(), 'draw-binary', 'draw');
});

it('never waits without a terminal: --url, then env, then installed, then default, and prints the choice', async () => {
  await install(); expect(installedUrl()).toBe('https://test.example/mcp');
  vi.stubEnv('REDCRAYON_MCP_URL', 'https://env.example/mcp');
  await install(); expect(installedUrl()).toBe('https://env.example/mcp');
  expect(stderr.join('')).toContain('Draw instance URL: https://env.example/mcp (REDCRAYON_MCP_URL)');
  await install('--url', 'https://flag.example/mcp'); expect(installedUrl()).toBe('https://flag.example/mcp');
  vi.stubEnv('REDCRAYON_MCP_URL', '');
  await install('--url=http://localhost:8788/mcp'); expect(installedUrl()).toBe('http://localhost:8788/mcp');
  await install(); expect(installedUrl()).toBe('http://localhost:8788/mcp');
  expect(asked).toEqual([]);
});

it('--url skips the prompt even in a terminal; env only becomes the editable default', async () => {
  tty(true); await install('--url', 'https://flag.example/mcp');
  expect(asked).toEqual([]);
  vi.stubEnv('REDCRAYON_MCP_URL', 'https://env.example/mcp'); answers.push('');
  await install();
  expect(asked).toEqual(['Draw instance URL [https://env.example/mcp]: ']);
});

it.each([['ftp://x/mcp'], ['http://example.com/mcp'], ['/mcp'], ['https://u:p@example.com/mcp'], ['${REDCRAYON_MCP_URL:-http://localhost:8788/mcp}']])('rejects %s before changing anything', async bad => {
  await expect(install('--url', bad)).rejects.toThrow('REJECTED');
  vi.stubEnv('REDCRAYON_MCP_URL', bad);
  await expect(install()).rejects.toThrow('REJECTED');
  expect(choosePermissionSet).not.toHaveBeenCalled(); expect(installLocalCodex).not.toHaveBeenCalled();
  expect(existsSync(active())).toBe(false);
});

it('repairs the legacy placeholder from the packaged default and keeps unrelated settings', async () => {
  write(join(active(), '.mcp.json'), { mcpServers: { draw: { type: 'http', url: '${REDCRAYON_MCP_URL:-http://localhost:8788/mcp}' }, other: { type: 'http', url: 'https://other.example' } } });
  await install();
  expect(installedUrl()).toBe('https://test.example/mcp');
  expect(stderr.join('')).toContain('Replacing an unusable saved Draw endpoint');
  expect(JSON.stringify(json(join(active(), 'mcp.json')))).not.toContain('${');
  expect(configureCodexPermissions).toHaveBeenCalledOnce(); // permissions flow is untouched
});

it('local mode ignores a bad REDCRAYON_MCP_URL and still writes a concrete URL', async () => {
  vi.stubEnv('REDCRAYON_MCP_URL', 'not a url');
  await install('--mode', 'local');
  expect(installedUrl()).toBe('https://test.example/mcp');
  await expect(install('--mode', 'local', '--url', 'nope')).rejects.toThrow('REJECTED');
});

it.each([['claude-code'], ['pi']] as const)('writes the chosen URL into the %s plugin and changes its version', agent => {
  const a = prepareNativePlugin(root, destination, executable, '1.2.3', agent, undefined, 'https://a.example/mcp');
  const b = prepareNativePlugin(root, destination, executable, '1.2.3', agent, undefined, 'https://b.example/mcp');
  expect(a.target).not.toBe(b.target);
  expect(json(join(a.target, '.mcp.json')).mcpServers.draw.env.REDCRAYON_MCP_URL).toBe('https://a.example/mcp');
  expect(json(join(b.target, 'mcp.json')).mcpServers.draw.env.REDCRAYON_MCP_URL).toBe('https://b.example/mcp');
});

it.each([[['--url']], [['--url', 'https://a.example', '--url', 'https://b.example']], [['--url=']]])('rejects malformed %j', async args => {
  await expect(install(...args)).rejects.toThrow(/REJECTED/);
  expect(installLocalCodex).not.toHaveBeenCalled();
});

it('fails when the Codex cache names another endpoint, and local mode stays non-interactive', async () => {
  vi.stubEnv('CODEX_HOME', join(directory, 'codex'));
  vi.mocked(installLocalCodex).mockImplementationOnce((plugin: string) => {
    const version = json(join(plugin, '.codex-plugin/plugin.json')).version;
    write(join(directory, 'codex/plugins/cache/draw-binary/draw', version, '.mcp.json'), { mcpServers: { draw: { url: 'https://stale.example/mcp' } } });
  });
  await expect(install()).rejects.toThrow('Codex loaded https://stale.example/mcp');
  vi.stubEnv('CODEX_HOME', join(directory, 'empty')); tty(true);
  await install('--mode', 'local');
  expect(asked).toEqual([]); expect(stderr.join('')).not.toContain('Hosted endpoint');
});

function registerCodexMarketplace(source = active()) {
  vi.mocked(readCodexUserConfig).mockResolvedValue({
    marketplaces: { 'draw-binary': { source_type: 'local', source } },
    plugins: { 'draw@draw-binary': { enabled: true } },
  });
}

it('removes the configured Codex integration even if the marketplace folder is missing', async () => {
  const receipts = join(directory, '.redcrayon/integrations');
  const retained = [join(receipts, 'pi-unified.json'), permissionPath('local'), join(directory, '.redcrayon/local/repo/boards.json')];
  for (const file of retained) write(file, 'keep');
  for (const mode of ['local', 'hosted', 'unified']) write(join(receipts, `codex-${mode}.json`), 'installed');
  const run = vi.mocked(execFileSync);
  registerCodexMarketplace();
  expect(existsSync(active())).toBe(false);
  run.mockReturnValue('');
  expect(await runNativeUninstall(['codex'])).toBe(0);
  expect(stderr.join('')).toContain('Removed the Draw integration from Codex.');
  expect(stderr.join('')).toContain('npm uninstall -g @redcrayonai/draw');
  expect(run.mock.calls.map(call => call.slice(0, 2))).toEqual([
    ['codex', ['plugin', 'remove', 'draw@draw-binary']],
    ['codex', ['plugin', 'marketplace', 'remove', 'draw-binary']],
  ]);
  expect(readdirSync(receipts)).toEqual(['pi-unified.json']);
  for (const file of retained) expect(readFileSync(file, 'utf8')).toBe('keep');
});

it('can be rerun after Codex removes the marketplace', async () => {
  const run = vi.mocked(execFileSync);
  run.mockReturnValue('');
  expect(await runNativeUninstall(['codex'])).toBe(0);
  expect(stderr.join('')).toContain('No Draw integrations found.');
  expect(stderr.join('')).not.toContain('Removed the Draw integration');
  expect(stderr.join('')).toContain('npm uninstall -g @redcrayonai/draw');
  expect(run.mock.calls.map(call => call[1])).toEqual([
    ['plugin', 'remove', 'draw@draw-binary'],
  ]);
});

it('reports removing the leftover Codex plugin entry after the marketplace was removed', async () => {
  vi.mocked(readCodexUserConfig).mockResolvedValue({ plugins: { 'draw@draw-binary': { enabled: false } } });
  const run = vi.mocked(execFileSync);
  run.mockReturnValue('');
  expect(await runNativeUninstall(['codex'])).toBe(0);
  expect(stderr.join('')).toContain('Removed the Draw integration from Codex.');
  expect(run.mock.calls.map(call => call[1])).toEqual([['plugin', 'remove', 'draw@draw-binary']]);
});

it('keeps the integration receipt when Codex fails to remove the plugin', async () => {
  const receipt = join(directory, '.redcrayon/integrations/codex-unified.json');
  write(receipt, 'installed');
  const run = vi.mocked(execFileSync);
  registerCodexMarketplace();
  run.mockImplementationOnce(() => { throw new Error('plugin removal failed'); });
  await expect(runNativeUninstall(['codex'])).rejects.toThrow('plugin removal failed');
  expect(run).toHaveBeenCalledTimes(1);
  expect(readFileSync(receipt, 'utf8')).toBe('installed');
});

it('leaves a marketplace from another source in place', async () => {
  const run = vi.mocked(execFileSync);
  registerCodexMarketplace('/another/source');
  await expect(runNativeUninstall(['codex'])).rejects.toThrow('REJECTED');
  expect(run).not.toHaveBeenCalled();
});

it('removes all managed integrations and only those integrations when no agent is specified', async () => {
  const installs = join(directory, '.redcrayon/plugins/installed');
  const receipts = join(directory, '.redcrayon/integrations');
  const claude = join(installs, 'claude-code-hosted'), pi = join(installs, 'pi-hosted');
  const piDir = join(directory, '.pi-custom');
  vi.stubEnv('PI_CODING_AGENT_DIR', piDir);
  write(join(piDir, 'settings.json'), { packages: [{ source: '../.redcrayon/plugins/installed/pi-hosted', skills: [] }, 'npm:other'] });
  for (const agent of ['codex', 'claude-code', 'pi']) write(join(receipts, `${agent}-unified.json`), 'installed');
  const run = vi.mocked(execFileSync);
  registerCodexMarketplace();
  run.mockReturnValueOnce('').mockReturnValueOnce('')
    .mockReturnValueOnce(JSON.stringify([{ name: 'draw-binary', source: 'directory', path: claude }]))
    .mockReturnValueOnce(JSON.stringify([{ id: 'draw@draw-binary', scope: 'user' }, { id: 'draw@other', scope: 'user' }]))
    .mockReturnValue('');
  expect(await runNativeUninstall([])).toBe(0);
  for (const agent of ['Codex', 'Claude Code', 'Pi']) {
    expect(stderr.join('')).toContain(`Removed the Draw integration from ${agent}.`);
  }
  expect(run.mock.calls.map(call => call.slice(0, 2))).toEqual([
    ['codex', ['plugin', 'remove', 'draw@draw-binary']],
    ['codex', ['plugin', 'marketplace', 'remove', 'draw-binary']],
    ['claude', ['plugin', 'marketplace', 'list', '--json']],
    ['claude', ['plugin', 'list', '--json']],
    ['claude', ['plugin', 'uninstall', 'draw@draw-binary', '--scope', 'user', '--keep-data']],
    ['claude', ['plugin', 'marketplace', 'remove', 'draw-binary', '--scope', 'user', '--json']],
    ['pi', ['remove', pi]],
  ]);
  expect(readdirSync(receipts)).toEqual([]);
});

it.each(['not_configured', 'permission_denied'])('handles Claude marketplace removal failure %s', async failureCode => {
  const receipt = join(directory, '.redcrayon/integrations/claude-code-unified.json');
  write(receipt, 'installed');
  const path = join(directory, '.redcrayon/plugins/installed/claude-code-hosted');
  const failure = Object.assign(new Error('marketplace removal failed'), {
    stdout: JSON.stringify({ command: 'marketplace-remove', marketplace: 'draw-binary', outcome: 'failed', failureCode }),
  });
  const run = vi.mocked(execFileSync);
  run.mockReturnValueOnce(JSON.stringify([{ name: 'draw-binary', source: 'directory', path }]))
    .mockReturnValueOnce(JSON.stringify([{ id: 'draw@draw-binary', scope: 'project' }]))
    .mockImplementationOnce(() => { throw failure; });
  if (failureCode === 'not_configured') {
    expect(await runNativeUninstall(['claude-code'])).toBe(0);
    expect(stderr.join('')).toContain('No Draw integrations found.');
  } else await expect(runNativeUninstall(['claude-code'])).rejects.toThrow(failure);
  expect(run.mock.calls.map(call => call[1])).toEqual([
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'list', '--json'],
    ['plugin', 'marketplace', 'remove', 'draw-binary', '--scope', 'user', '--json'],
  ]);
  expect(existsSync(receipt)).toBe(failureCode !== 'not_configured');
});

it('skips absent agents and continues after an agent fails', async () => {
  const receipts = join(directory, '.redcrayon/integrations');
  write(join(receipts, 'codex-unified.json'), 'installed');
  write(join(receipts, 'pi-unified.json'), 'installed');
  vi.stubEnv('PI_CODING_AGENT_DIR', join(directory, 'no-pi-settings'));
  const run = vi.mocked(execFileSync);
  vi.mocked(readCodexUserConfig).mockRejectedValueOnce(new Error('unavailable'));
  await expect(runNativeUninstall([])).rejects.toThrow('codex: unavailable');
  expect(run).not.toHaveBeenCalled();
  expect(readdirSync(receipts)).toEqual(['codex-unified.json']);
});
