import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DEFAULT_ORIGIN } from './capture';
import { installLocalCodex } from './local-install';
import { localClaudeSettings } from './local-claude-hook';
import { choosePermissionSet, permissionPath, savePermissions } from './permissions';
import { configureCodexPermissions, disableLegacyCodexIntegrations, readCodexUserConfig } from './codex-permissions';
import { disableLegacyClaudePlugins, disableLegacyPiIntegrations, uninstallNativePiPackage } from './native-agent-migration';
import { installedUrl, packagedDefault, promptMcpUrl, resolveMcpUrl, validMcpUrl } from './hosted-url';

type Agent = 'codex' | 'claude-code' | 'pi';
type Mode = 'local' | 'hosted';
const agents: readonly Agent[] = ['codex', 'claude-code', 'pi'];
const nativePlugin = { name: 'draw', marketplace: 'draw-binary' };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? files(directory, path) : entry.isFile() ? [path] : [];
  });
}

export function prepareNativePlugin(root: string, destination: string, executable: string, version: string, agent: Agent, _legacyMode?: Mode, hostedUrl?: string) {
  const { name, marketplace } = nativePlugin;
  const source = join(root, 'hosted-plugin');
  const paths = files(source).filter(file => !file.startsWith('skills/'));
  const contents = new Map(paths.map(file => [file, readFileSync(join(source, file))]));
  contents.set('skills/navigate/SKILL.md', readFileSync(join(root, 'unified/skills/navigate/SKILL.md')));
  contents.set('skills/navigate/references/local.md', Buffer.from(readFileSync(join(root, 'skills/local/SKILL.md'), 'utf8').replaceAll('apply_board', 'apply_local_board').replace('mcpServers.draw-local', 'mcpServers.draw').replace('before `local-mcp`', 'before `mcp`')));
  for (const skill of ['navigate', 'handoff', 'triage', 'make-it-make-sense']) {
    contents.set(`skills/navigate/references/${skill === 'navigate' ? 'hosted' : skill}.md`, Buffer.from(readFileSync(join(source, `skills/${skill}/SKILL.md`), 'utf8').replaceAll('../../references/', '../../../references/')));
  }
  const permissionEnv = agent === 'codex' ? { DRAW_PERMISSION_FILE: permissionPath('local'), DRAW_PERMISSION_MODE: 'local' } : undefined;
  const hash = createHash('sha256').update(JSON.stringify({ executable, version, agent, mode: 'router-v1', ...(permissionEnv ? { permissionEnv, hostedPolicy: permissionPath('hosted'), enforcement: 2 } : {}), ...(hostedUrl ? { hostedUrl } : {}) }));
  for (const [file, data] of contents) hash.update(file).update(data);
  if (agent === 'pi') hash.update(readFileSync(join(root, 'pi-extension.mjs')));
  const id = hash.digest('hex').slice(0, 16), target = join(destination, id);
  if (existsSync(target)) return { target, name, marketplace };
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(destination, '.native-'));
  const write = (path: string, data: string | Buffer, executable = false) => {
    mkdirSync(dirname(join(temp, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(temp, path), data, { mode: executable ? 0o755 : 0o600 });
    if (executable) chmodSync(join(temp, path), 0o755);
  };
  const json = (path: string, value: unknown) => write(path, JSON.stringify(value, null, 2) + '\n');
  try {
    for (const [file, data] of contents) write(file, data);
    const integrationVersion = `${version.split('+')[0]}+binary.${id}`;
    for (const path of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
      const original = existsSync(join(temp, path)) ? JSON.parse(readFileSync(join(temp, path), 'utf8')) : {};
      json(path, { ...original, name, version: integrationVersion, ...(path.startsWith('.codex') ? { skills: './skills/', mcpServers: './mcp.json' } : {}) });
    }
    // The marketplace source stays local and uses each agent's supported schema.
    json('.claude-plugin/marketplace.json', { name: marketplace, owner: { name: 'Red Crayon' }, plugins: [{ name, source: agent === 'claude-code' ? './' : { source: 'local', path: '.' } }] });
    const environment = permissionEnv ? `case "$1" in\n  capture|hook|chat|chat-hook|tap|marks|doctor) export DRAW_PERMISSION_FILE=${quote(permissionPath('hosted'))} DRAW_PERMISSION_MODE=hosted ;;\n  *) export DRAW_PERMISSION_FILE=${quote(permissionPath('local'))} DRAW_PERMISSION_MODE=local ;;\nesac\n` : '';
    const sourceConfig = JSON.parse(readFileSync(join(source, '.mcp.json'), 'utf8'));
    const endpoint = hostedUrl ?? packagedDefault(sourceConfig);
    write('bin/draw', `#!/bin/sh\n${environment}export REDCRAYON_MCP_URL=${quote(endpoint)} REDCRAYON_ORIGIN=${quote(new URL(endpoint).origin)} DRAW_ROUTER=1\nexec ${quote(executable)} "$@"\n`, true);
    const env = { ...permissionEnv, ...(permissionEnv && { DRAW_HOSTED_PERMISSION_FILE: permissionPath('hosted') }), REDCRAYON_MCP_URL: endpoint };
    const config = { mcpServers: { draw: { type: 'stdio', command: executable, args: ['mcp'], env } } };
    json('mcp.json', config); json('.mcp.json', config);
    if (agent === 'claude-code') {
      const hosted = JSON.parse(readFileSync(join(temp, 'hooks/hooks.json'), 'utf8'));
      for (const [event, entries] of Object.entries(localClaudeSettings(['--auto'], [executable]).hooks)) {
        hosted.hooks[event] = [...entries, ...(hosted.hooks[event] ?? [])];
      }
      json('hooks/hooks.json', hosted);
    }
    if (agent === 'codex') {
      const hooks = JSON.parse(readFileSync(join(temp, 'codex/hooks.json'), 'utf8'));
      // Guard every Draw call, including tools added after this release.
      hooks.hooks.PreToolUse[0].matcher = '^mcp__(plugin_draw_)?(?:draw|redcrayon)(-dev)?__.+$';
      hooks.hooks.PreToolUse[0].hooks[0].timeout = 180;
      json('codex/hooks.json', hooks);
    }
    if (agent === 'pi') {
      write('pi/pi-extension.mjs', readFileSync(join(root, 'pi-extension.mjs')));
      write('pi/extension.mjs', `export default async function(pi) {\n  const extension = await import('./pi-extension.mjs');\n  return extension.default(pi, ${JSON.stringify({ mode: 'unified', executable, endpoint })});\n}\n`);
      json('package.json', { name: '@redcrayonai/draw-integration', version, pi: { extensions: ['./pi/extension.mjs'], skills: ['./skills'] } });
    }
    json('draw-runtime.json', { version, protocol: 1, agent, mode: 'unified', executable });
    try { renameSync(temp, target); } catch (error) { if (!existsSync(target)) throw error; }
    return { target, name, marketplace };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** Keep marketplace/package sources stable so upgrades preserve agent settings and credentials. */
export function activateNativePlugin(source: string, target: string, install: () => void = () => {}) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(target), '.activate-')), backup = `${staging}-previous`;
  let activated = false, committed = false;
  try {
    cpSync(source, staging, { recursive: true });
    if (existsSync(target)) renameSync(target, backup);
    renameSync(staging, target); activated = true;
    install(); committed = true;
  } catch (error) {
    if (activated) rmSync(target, { recursive: true, force: true });
    if (existsSync(backup)) renameSync(backup, target);
    throw error;
  } finally { rmSync(staging, { recursive: true, force: true }); if (committed) rmSync(backup, { recursive: true, force: true }); }
}

/** Codex runs the copy in its own cache, not our source: fail if that copy names another endpoint. */
function verifyCodexCache(target: string, marketplace: string, name: string, url: string) {
  const version = JSON.parse(readFileSync(join(target, '.codex-plugin/plugin.json'), 'utf8')).version;
  const file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugins', 'cache', marketplace, name, version, '.mcp.json');
  if (!existsSync(file)) return; // shortcut: Codex cache layout is not a contract, so an absent copy is not an error
  const loaded = installedUrl(dirname(file)).url;
  const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers;
  if (Object.keys(servers ?? {}).length !== 1 || servers?.draw?.type !== 'stdio' || loaded !== url) throw new Error(`UNAVAILABLE: Codex loaded ${loaded} instead of ${url}; Codex is still on the new install; run \`codex plugin marketplace remove ${marketplace}\`, then draw install codex again.`);
}

function parseOptions(args: string[], permissionsOnly = false) {
  const [agent, ...rest] = args;
  const usage = `REJECTED: usage: draw ${permissionsOnly ? 'permissions codex' : 'install <codex|claude-code|pi>'} [--mode local|hosted] [--url <https://...>] [--permissions-defaults] (permissions are Codex only)`;
  if (!(permissionsOnly ? ['codex'] : ['codex', 'claude-code', 'pi']).includes(agent)) throw new Error(usage);
  let defaults = false, explicitMode = false, mode: Mode | undefined, url: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--mode' && !explicitMode && ['local', 'hosted'].includes(rest[i + 1])) { mode = rest[++i] as Mode; explicitMode = true; }
    else if (!permissionsOnly && url === undefined && rest[i] === '--url' && rest[i + 1] !== undefined) url = rest[++i];
    else if (!permissionsOnly && url === undefined && rest[i].startsWith('--url=')) url = rest[i].slice(6);
    else if (rest[i] === '--permissions-defaults' && agent === 'codex' && !defaults) defaults = true;
    else throw new Error(usage);
  }
  return { agent: agent as Agent, defaults, mode, url };
}

async function setCodexPermissions(modes: readonly Mode[], defaults: boolean, reconfigure = false) {
  const choices = await choosePermissionSet(modes, { defaults, reconfigure });
  for (const { mode, record } of await configureCodexPermissions(choices)) savePermissions(mode, record);
}

export async function runNativePermissions(args: string[]) {
  const { defaults } = parseOptions(args, true);
  await setCodexPermissions(['local', 'hosted'], defaults, true);
  process.stderr.write('Draw permissions saved for Codex. Restart Codex to load updated tool approval settings.\n');
  return 0;
}

async function uninstallCodex(active: string) {
  const { name, marketplace } = nativePlugin;
  const id = `${name}@${marketplace}`;
  const config = await readCodexUserConfig();
  const source = config.marketplaces?.[marketplace];
  const installed = Object.hasOwn(config.plugins ?? {}, id);
  if (source !== undefined && (source?.source_type !== 'local' ||
      (source.source !== active && !(existsSync(active) && source.source === realpathSync(active))))) {
    throw new Error(`REJECTED: ${marketplace} is registered from another source`);
  }
  execFileSync('codex', ['plugin', 'remove', id], { stdio: installed ? 'inherit' : 'pipe' });
  if (source) execFileSync('codex', ['plugin', 'marketplace', 'remove', marketplace], { stdio: 'inherit' });
  return installed || !!source;
}

function uninstallClaude(active: string) {
  const { name, marketplace } = nativePlugin;
  const id = `${name}@${marketplace}`;
  const marketplaces = JSON.parse(execFileSync('claude', ['plugin', 'marketplace', 'list', '--json'], { encoding: 'utf8' }));
  const existing = marketplaces.find((item: { name: string }) => item.name === marketplace);
  if (existing && (existing.source !== 'directory' || existing.path !== active)) {
    throw new Error(`REJECTED: ${marketplace} is registered from another source`);
  }
  const plugins = JSON.parse(execFileSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8' }));
  const installed = plugins.some((plugin: { id: string; scope: string }) => plugin.id === id && plugin.scope === 'user');
  if (installed) {
    execFileSync('claude', ['plugin', 'uninstall', id, '--scope', 'user', '--keep-data'], { stdio: 'inherit' });
  }
  if (existing) {
    try {
      execFileSync('claude', ['plugin', 'marketplace', 'remove', marketplace, '--scope', 'user', '--json'], { encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch (error) {
      let result;
      try { result = JSON.parse(String((error as { stdout?: unknown }).stdout ?? '').trim().split('\n').at(-1)!); }
      catch { throw error; }
      if (result?.command !== 'marketplace-remove' || result.marketplace !== marketplace || result.failureCode !== 'not_configured') throw error;
    }
  }
  return installed;
}

export async function runNativeUninstall(args: string[]) {
  const target = agents.find(agent => agent === args[0]);
  if (args.length > 1 || (args.length && !target)) throw new Error('REJECTED: usage: draw uninstall [codex|claude-code|pi]');
  const directory = join(homedir(), '.redcrayon');
  const failures: string[] = [];
  let removed = false;
  for (const agent of target ? [target] : agents) {
    const active = join(directory, 'plugins', 'installed', `${agent}-hosted`);
    const receipts = ['local', 'hosted', 'unified'].map(mode => join(directory, 'integrations', `${agent}-${mode}.json`));
    if (!target && !existsSync(active) && !receipts.some(path => existsSync(path))) continue;
    try {
      const changed = agent === 'codex' ? await uninstallCodex(active)
        : agent === 'claude-code' ? uninstallClaude(active)
        : uninstallNativePiPackage(active);
      for (const receipt of receipts) rmSync(receipt, { force: true });
      if (!changed) continue;
      const name = { codex: 'Codex', 'claude-code': 'Claude Code', pi: 'Pi' }[agent];
      const restart = agent === 'codex' ? 'Fully quit and restart' : 'Restart';
      process.stderr.write(`Removed the Draw integration from ${name}. ${restart} ${name} to apply the change.\n`);
      removed = true;
    } catch (error) {
      if (target) throw error;
      failures.push(`${agent}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  if (!removed) process.stderr.write('No Draw integrations found.\n');
  process.stderr.write('The Draw CLI is still installed. If you installed it with npm, remove it with:\n  npm uninstall -g @redcrayonai/draw\n');
  return 0;
}

export async function runNativeInstall(args: string[], version: string) {
  const { agent, defaults, mode, url: flag } = parseOptions(args);
  const directory = join(homedir(), '.redcrayon', 'plugins');
  // Reuse the hosted marketplace path so existing sign-in and plugin identity survive.
  const active = join(directory, 'installed', `${agent}-hosted`);
  const root = dirname(fileURLToPath(import.meta.url));
  const installed = installedUrl(active);
  // Local mode never fails on hosted settings: an unusable env value or packaged default is skipped.
  const local = mode === 'local';
  let resolved: ReturnType<typeof resolveMcpUrl> | undefined;
  try {
    resolved = resolveMcpUrl({
      flag, env: local && !validMcpUrl(process.env.REDCRAYON_MCP_URL) ? undefined : process.env.REDCRAYON_MCP_URL, installed: installed.url,
      fallback: () => packagedDefault(JSON.parse(readFileSync(join(root, 'hosted-plugin', '.mcp.json'), 'utf8'))),
    });
  } catch (error) { if (!local || flag !== undefined) throw error; resolved = { url: DEFAULT_ORIGIN + '/mcp', source: 'local development' }; }
  // Prompt only for a person at a terminal; --url and local mode never wait for input.
  const ask = flag === undefined && !local && !!process.stdin.isTTY && !!process.stderr.isTTY;
  const hostedUrl = ask ? await promptMcpUrl(resolved!.url) : resolved?.url;
  if (!ask && !local) process.stderr.write(`Draw instance URL: ${hostedUrl} (${resolved!.source})\n`);
  if (installed.legacy) process.stderr.write('Replacing an unusable saved Draw endpoint with a concrete URL.\n');
  if (agent === 'codex') await setCodexPermissions(['local', 'hosted'], defaults);
  const prepared = prepareNativePlugin(root, directory, process.execPath, version, agent, mode, hostedUrl);
  if (agent === 'claude-code') {
    const marketplaces = JSON.parse(execFileSync('claude', ['plugin', 'marketplace', 'list', '--json'], { encoding: 'utf8' }));
    const existing = marketplaces.find((item: { name: string }) => item.name === prepared.marketplace);
    if (existing && (existing.source !== 'directory' || existing.path !== active)) throw new Error(`REJECTED: ${prepared.marketplace} is registered from another source; keep that install or choose its existing setup`);
  }
  activateNativePlugin(prepared.target, active, () => {
    if (agent === 'codex') installLocalCodex(active, prepared.marketplace, prepared.name);
    if (agent === 'claude-code') {
      execFileSync('claude', ['plugin', 'marketplace', 'add', active], { stdio: 'inherit' });
      // install is idempotent; update refreshes the cached version without removing saved options.
      execFileSync('claude', ['plugin', 'install', `${prepared.name}@${prepared.marketplace}`], { stdio: 'inherit' });
      execFileSync('claude', ['plugin', 'update', `${prepared.name}@${prepared.marketplace}`], { stdio: 'inherit' });
    }
    if (agent === 'pi') execFileSync('pi', ['install', active], { stdio: 'inherit' });
  });
  // After commit, not inside it: Codex has already switched, so a rollback would only make the two disagree.
  if (agent === 'codex' && hostedUrl) verifyCodexCache(prepared.target, prepared.marketplace, prepared.name, hostedUrl);
  if (agent === 'codex') await disableLegacyCodexIntegrations();
  if (agent === 'claude-code') disableLegacyClaudePlugins();
  if (agent === 'pi') disableLegacyPiIntegrations();
  const receipts = join(homedir(), '.redcrayon', 'integrations');
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const receipt = join(receipts, `${agent}-unified.json`), temporary = `${receipt}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ agent, mode: 'unified', version, protocol: 1, executable: process.execPath }), { mode: 0o600 });
  renameSync(temporary, receipt);
  for (const mode of ['local', 'hosted']) rmSync(join(receipts, `${agent}-${mode}.json`), { force: true });
  const restart = agent === 'pi' ? 'Restart Pi' : agent === 'codex' ? 'Fully quit and restart Codex' : 'Restart Claude Code';
  process.stderr.write(`Draw installed for ${agent}.${local || !hostedUrl ? '' : ` Hosted endpoint: ${hostedUrl}`}\n${restart} so it loads the new settings, then ask it to create a Draw board. New boards are local by default; for a hosted board ask for one explicitly or give a hosted board link. Draw opens a browser to sign in the first time a hosted tool runs; sign in again if the endpoint changed. The endpoint is fixed at install time; to change it, run draw install ${agent} --url <https://...> again.\n`);
  return 0;
}
