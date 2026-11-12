import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { installLocalCodex } from './local-install';
import { localClaudeSettings } from './local-claude-hook';
import { choosePermissions, permissionPath, savePermissions } from './permissions';
import { configureCodexPermissions, disableLegacyCodexIntegrations } from './codex-permissions';
import { disableLegacyClaudePlugins, disableLegacyPiIntegrations } from './native-agent-migration';

type Agent = 'codex' | 'claude-code' | 'pi';
type Mode = 'local' | 'hosted';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? files(directory, path) : entry.isFile() ? [path] : [];
  });
}

export function prepareNativePlugin(root: string, destination: string, executable: string, version: string, agent: Agent, _legacyMode?: Mode) {
  const name = 'draw', marketplace = 'draw-binary';
  const source = join(root, 'hosted-plugin');
  const paths = files(source).filter(file => !file.startsWith('skills/'));
  const contents = new Map(paths.map(file => [file, readFileSync(join(source, file))]));
  contents.set('skills/navigate/SKILL.md', readFileSync(join(root, 'unified/skills/navigate/SKILL.md')));
  contents.set('skills/navigate/references/local.md', readFileSync(join(root, 'skills/local/SKILL.md')));
  for (const skill of ['navigate', 'handoff', 'triage']) {
    contents.set(`skills/navigate/references/${skill === 'navigate' ? 'hosted' : skill}.md`, Buffer.from(readFileSync(join(source, `skills/${skill}/SKILL.md`), 'utf8').replaceAll('../../references/', '../../../references/')));
  }
  const permissionEnv = agent === 'codex' ? { DRAW_PERMISSION_FILE: permissionPath('local'), DRAW_PERMISSION_MODE: 'local' } : undefined;
  const hash = createHash('sha256').update(JSON.stringify({ executable, version, agent, mode: 'unified', ...(permissionEnv ? { permissionEnv, hostedPolicy: permissionPath('hosted'), enforcement: 2 } : {}) }));
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
    write('bin/draw', `#!/bin/sh\n${environment}exec ${quote(executable)} "$@"\n`, true);
    const config = JSON.parse(readFileSync(join(source, '.mcp.json'), 'utf8'));
    config.mcpServers['draw-local'] = { type: 'stdio', command: executable, args: ['local-mcp', '--per-repo'], ...(permissionEnv ? { env: permissionEnv } : {}) };
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
      write('pi/extension.mjs', `export default async function(pi) {\n  const extension = await import('./pi-extension.mjs');\n  return extension.default(pi, ${JSON.stringify({ mode: 'unified', executable })});\n}\n`);
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

function parseOptions(args: string[], permissionsOnly = false) {
  const [agent, ...rest] = args;
  const usage = `REJECTED: usage: draw ${permissionsOnly ? 'permissions codex [--mode local|hosted]' : 'install <codex|claude-code|pi>'} [--permissions-defaults] (permissions are Codex only)`;
  if (!(permissionsOnly ? ['codex'] : ['codex', 'claude-code', 'pi']).includes(agent)) throw new Error(usage);
  let mode: Mode = 'local', defaults = false, explicitMode = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--mode' && !explicitMode && ['local', 'hosted'].includes(rest[i + 1])) { mode = rest[++i] as Mode; explicitMode = true; }
    else if (rest[i] === '--permissions-defaults' && agent === 'codex' && !defaults) defaults = true;
    else throw new Error(usage);
  }
  return { agent: agent as Agent, mode, defaults, explicitMode };
}

async function setCodexPermissions(mode: Mode, defaults: boolean, reconfigure = false) {
  const record = await choosePermissions(mode, { defaults, reconfigure });
  const managedDisabledTools = await configureCodexPermissions(mode, record.permissions, record.managedDisabledTools);
  savePermissions(mode, { ...record, managedDisabledTools });
}

export async function runNativePermissions(args: string[]) {
  const { mode, defaults, explicitMode } = parseOptions(args, true);
  for (const scope of explicitMode ? [mode] : ['local', 'hosted'] as const) await setCodexPermissions(scope, defaults, true);
  process.stderr.write('Draw permissions saved for Codex. Restart Codex to load updated tool approval settings.\n');
  return 0;
}

export async function runNativeInstall(args: string[], version: string) {
  const { agent, defaults } = parseOptions(args);
  if (agent === 'codex') for (const mode of ['local', 'hosted'] as const) await setCodexPermissions(mode, defaults);
  const root = dirname(fileURLToPath(import.meta.url));
  const directory = join(homedir(), '.redcrayon', 'plugins');
  const prepared = prepareNativePlugin(root, directory, process.execPath, version, agent);
  // Reuse the hosted marketplace path so existing sign-in and plugin identity survive.
  const active = join(directory, 'installed', `${agent}-hosted`);
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
  if (agent === 'codex') await disableLegacyCodexIntegrations();
  if (agent === 'claude-code') disableLegacyClaudePlugins();
  if (agent === 'pi') disableLegacyPiIntegrations();
  const receipts = join(homedir(), '.redcrayon', 'integrations');
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const receipt = join(receipts, `${agent}-unified.json`), temporary = `${receipt}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ agent, mode: 'unified', version, protocol: 1, executable: process.execPath }), { mode: 0o600 });
  renameSync(temporary, receipt);
  for (const mode of ['local', 'hosted']) rmSync(join(receipts, `${agent}-${mode}.json`), { force: true });
  process.stderr.write(`Draw installed for ${agent}. Restart the agent, then ask it to create a Draw board. New boards are local by default; request hosted explicitly or supply a hosted board link.\n`);
  return 0;
}
