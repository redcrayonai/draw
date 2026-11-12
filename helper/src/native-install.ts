import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { installLocalCodex } from './local-install';
import { localClaudeSettings } from './local-claude-hook';
import { choosePermissions, permissionPath, savePermissions } from './permissions';
import { configureCodexPermissions } from './codex-permissions';

type Agent = 'codex' | 'claude-code' | 'pi';
type Mode = 'local' | 'hosted';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? files(directory, path) : entry.isFile() ? [path] : [];
  });
}

export function prepareNativePlugin(root: string, destination: string, executable: string, version: string, agent: Agent, mode: Mode) {
  const name = mode === 'local' ? 'draw-local' : 'draw';
  const marketplace = mode === 'local' ? 'draw-local-dev' : 'draw-binary';
  const source = mode === 'hosted' ? join(root, 'hosted-plugin') : root;
  const paths = mode === 'hosted' ? files(source) : ['plugin.json', '.codex-plugin/plugin.json', 'mcp.json', 'skills/local/SKILL.md'];
  const contents = new Map(paths.map(file => [file, readFileSync(join(source, file))]));
  const permissionEnv = agent === 'codex' ? { DRAW_PERMISSION_FILE: permissionPath(mode), DRAW_PERMISSION_MODE: mode } : undefined;
  const hash = createHash('sha256').update(JSON.stringify({ executable, version, agent, mode, ...(permissionEnv ? { permissionEnv, enforcement: 1 } : {}) }));
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
      json(path, { ...original, name, version: integrationVersion });
    }
    // The marketplace source stays local and uses each agent's supported schema.
    json('.claude-plugin/marketplace.json', { name: marketplace, owner: { name: 'Red Crayon' }, plugins: [{ name, source: agent === 'claude-code' ? './' : { source: 'local', path: '.' } }] });
    const environment = permissionEnv ? `export DRAW_PERMISSION_FILE=${quote(permissionEnv.DRAW_PERMISSION_FILE)} DRAW_PERMISSION_MODE=${quote(mode)}\n` : '';
    write('bin/draw', `#!/bin/sh\n${environment}exec ${quote(executable)} "$@"\n`, true);
    if (mode === 'local') {
      const config = { mcpServers: { 'draw-local': { type: 'stdio', command: executable, args: ['local-mcp', '--per-repo'], ...(permissionEnv ? { env: permissionEnv } : {}) } } };
      json('mcp.json', config); json('.mcp.json', config);
      if (agent === 'claude-code') json('hooks/hooks.json', localClaudeSettings(['--auto'], [executable]));
    }
    if (mode === 'hosted' && agent === 'codex') {
      const hooks = JSON.parse(readFileSync(join(temp, 'codex/hooks.json'), 'utf8'));
      // Guard every Draw call, including tools added after this release.
      hooks.hooks.PreToolUse[0].matcher = '^mcp__(plugin_draw_)?(?:draw|redcrayon)(-dev)?__.+$';
      hooks.hooks.PreToolUse[0].hooks[0].timeout = 180;
      json('codex/hooks.json', hooks);
    }
    if (agent === 'pi') {
      write('pi/pi-extension.mjs', readFileSync(join(root, 'pi-extension.mjs')));
      write('pi/extension.mjs', `export default async function(pi) {\n  const extension = await import('./pi-extension.mjs');\n  return extension.default(pi, ${JSON.stringify({ mode, executable })});\n}\n`);
      json('package.json', { name: `@redcrayonai/draw-${mode}-integration`, version, pi: { extensions: ['./pi/extension.mjs'], skills: ['./skills'] } });
    }
    json('draw-runtime.json', { version, protocol: 1, agent, mode, executable });
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
  const usage = `REJECTED: usage: draw ${permissionsOnly ? 'permissions codex' : 'install <codex|claude-code|pi>'} [--mode local|hosted] [--permissions-defaults] (permissions are Codex only)`;
  if (!(permissionsOnly ? ['codex'] : ['codex', 'claude-code', 'pi']).includes(agent)) throw new Error(usage);
  let mode: Mode = 'local', defaults = false, explicitMode = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--mode' && !explicitMode && ['local', 'hosted'].includes(rest[i + 1])) { mode = rest[++i] as Mode; explicitMode = true; }
    else if (rest[i] === '--permissions-defaults' && agent === 'codex' && !defaults) defaults = true;
    else throw new Error(usage);
  }
  return { agent: agent as Agent, mode, defaults };
}

async function setCodexPermissions(mode: Mode, defaults: boolean, reconfigure = false) {
  const record = await choosePermissions(mode, { defaults, reconfigure });
  const managedDisabledTools = await configureCodexPermissions(mode, record.permissions, record.managedDisabledTools);
  savePermissions(mode, { ...record, managedDisabledTools });
}

export async function runNativePermissions(args: string[]) {
  const { mode, defaults } = parseOptions(args, true);
  await setCodexPermissions(mode, defaults, true);
  process.stderr.write(`Draw ${mode} permissions saved for Codex. Restart Codex to load updated tool approval settings.\n`);
  return 0;
}

export async function runNativeInstall(args: string[], version: string) {
  const { agent, mode, defaults } = parseOptions(args);
  if (agent === 'codex') await setCodexPermissions(mode, defaults);
  const root = dirname(fileURLToPath(import.meta.url));
  const directory = join(homedir(), '.redcrayon', 'plugins');
  const prepared = prepareNativePlugin(root, directory, process.execPath, version, agent, mode);
  const active = join(directory, 'installed', `${agent}-${mode}`);
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
  const receipts = join(homedir(), '.redcrayon', 'integrations');
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const receipt = join(receipts, `${agent}-${mode}.json`), temporary = `${receipt}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ agent, mode, version, protocol: 1, executable: process.execPath }), { mode: 0o600 });
  renameSync(temporary, receipt);
  process.stderr.write(`Draw ${mode} integration installed for ${agent}. Restart the agent to load it. ${mode === 'local' ? 'Ask it to use the local Draw skill to open a board.' : 'Connect the hosted MCP server and authenticate in the agent, then open a Draw board.'}\n`);
  return 0;
}
