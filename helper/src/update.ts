import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const PACKAGE = '@redcrayonai/draw';
const DAY = 24 * 60 * 60 * 1000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
type Channel = 'stable' | 'preview';
type Result = { checkedAt: number; state: 'available' | 'unpublished' | 'unavailable' | 'unsupported'; version?: string };
const cachePath = (channel: Channel) => join(homedir(), '.redcrayon', 'updates', `${process.platform}-${process.arch}-${channel}.json`);

function parse(version: string) {
  const match = typeof version === 'string' && version.length < 128 && VERSION.exec(version);
  if (!match || match[0] !== version || match.slice(1, 4).some(n => !Number.isSafeInteger(Number(n))) || match[4]?.split('.').some(n => /^0\d+$/.test(n))) throw new Error('UNAVAILABLE: invalid release version');
  return { parts: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
}
export function newer(version: string, current: string) {
  const a = parse(version), b = parse(current);
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length && !!b.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return y === undefined;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y);
    if (nx !== ny) return !nx;
    return x > y;
  }
  return false;
}
function valid(value: any): value is Result {
  if (!value || !Number.isFinite(value.checkedAt) || !['available', 'unpublished', 'unavailable', 'unsupported'].includes(value.state)) return false;
  try { if (value.state === 'available') parse(value.version); return true; } catch { return false; }
}
function save(path: string, result: Result) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(result), { mode: 0o600 }); renameSync(temp, path);
  } catch { /* An unwritable cache must not prevent using Draw. */ }
  finally { try { rmSync(temp, { force: true }); } catch {} }
}

export async function checkUpdate(channel: Channel, force = false, cache = cachePath(channel)): Promise<Result> {
  const now = Date.now();
  if (!force) try {
    const text = readFileSync(cache, 'utf8');
    const cached = text.length < 1024 && JSON.parse(text);
    if (valid(cached) && cached.checkedAt <= now && now - cached.checkedAt < DAY) return cached;
  } catch {}
  let result: Result = { checkedAt: now, state: 'unavailable' };
  try {
    const response = await fetch(`https://registry.npmjs.org/@redcrayonai%2fdraw/${channel === 'stable' ? 'latest' : 'next'}`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (response.status === 404) result.state = 'unpublished';
    else if (response.ok && response.body) {
      const reader = response.body.getReader(); let text = '', bytes = 0;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length; if (bytes > 128 * 1024) throw new Error('metadata limit');
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel(); }
      const metadata = JSON.parse(text);
      parse(metadata.version);
      if (metadata.name !== PACKAGE || metadata.drawRuntime?.protocol !== 1) result.state = 'unpublished';
      else if (channel === 'stable' && parse(metadata.version).pre.length) result.state = 'unavailable';
      else if (metadata.optionalDependencies?.[`@redcrayonai/draw-${process.platform}-${process.arch}`] !== metadata.version) result.state = 'unsupported';
      else result = { checkedAt: now, state: 'available', version: metadata.version };
    }
  } catch { /* Update service failures do not affect the board or agent protocols. */ }
  save(cache, result); return result;
}

export function updateMessage(result: Result, current: string, channel: Channel = 'stable') {
  if (result.state === 'unpublished') return 'No native Draw release is published on this channel yet. Keep using this build.';
  if (result.state === 'unsupported') return 'UNAVAILABLE: this release has no executable for your platform.';
  if (result.state === 'unavailable') return 'UNAVAILABLE: could not check for updates; your installed Draw is unchanged.';
  if (!newer(result.version!, current)) return `Draw ${current} is current for this channel.`;
  return `Draw ${result.version} is available (installed ${current}). Run draw update${channel === 'preview' ? ' --channel preview' : ''} to install it.`;
}
export function integrationNotices(current: string, directory = join(homedir(), '.redcrayon', 'integrations')) {
  const notices: string[] = [];
  try {
    for (const file of readdirSync(directory)) {
      if (!/^(codex|claude-code|pi)-(local|hosted)\.json$/.test(file)) continue;
      try {
        const record = JSON.parse(readFileSync(join(directory, file), 'utf8'));
        if (!['codex', 'claude-code', 'pi'].includes(record.agent) || !['local', 'hosted'].includes(record.mode)) continue;
        parse(record.version);
        if (record.version !== current || record.protocol !== 1) notices.push(`Refresh your ${record.agent} ${record.mode} integration for Draw ${current}: draw install ${record.agent} --mode ${record.mode}`);
      } catch { /* An incomplete receipt cannot identify an installed integration. */ }
    }
  } catch {}
  return notices;
}
export async function notifyUpdate(current: string) {
  if (!process.stderr.isTTY || !process.stdin.isTTY || process.env.CI || process.env.DRAW_NO_UPDATE_CHECK) return;
  try {
    for (const notice of integrationNotices(current)) process.stderr.write(`\n${notice}\n`);
    const result = await checkUpdate('stable');
    if (result.state === 'available' && newer(result.version!, current)) process.stderr.write(`\n${updateMessage(result, current)}\n`);
  } catch {}
}

export function detectInstaller(executable: string): 'npm' | 'bun' | undefined {
  const binary = realpathSync(executable);
  for (const manager of ['npm', 'bun'] as const) try {
    const output = execFileSync(manager, manager === 'npm' ? ['root', '-g'] : ['pm', 'bin', '-g'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const launcher = manager === 'npm' ? join(output, PACKAGE, 'bin/draw') : join(output, 'draw');
    if (!existsSync(launcher)) continue;
    const owner = JSON.parse(readFileSync(join(dirname(dirname(realpathSync(launcher))), 'package.json'), 'utf8'));
    if (owner.name !== PACKAGE || owner.drawRuntime?.protocol !== 1 || owner.bin?.draw !== 'bin/draw') continue;
    // Ask the installed launcher where its own executable lives; no update is performed.
    const owned = execFileSync(launcher, ['--executable-path'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (realpathSync(owned) === binary) return manager;
  } catch {}
}

export async function runUpdate(args: string[], current: string, cache?: string) {
  let channel: Channel = 'stable', installer: 'npm' | 'bun' | undefined, check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--channel' && ['stable', 'preview'].includes(args[i + 1])) channel = args[++i] as Channel;
    else if (args[i] === '--installer' && ['npm', 'bun'].includes(args[i + 1])) installer = args[++i] as typeof installer;
    else { process.stderr.write('REJECTED: usage: draw update [--check] [--channel stable|preview] [--installer npm|bun]\n'); return 1; }
  }
  for (const notice of integrationNotices(current)) process.stderr.write(`${notice}\n`);
  const result = await checkUpdate(channel, true, cache);
  process.stderr.write(`${updateMessage(result, current, channel)}\n`);
  if (result.state !== 'available') return result.state === 'unpublished' ? 0 : 1;
  if (check || !newer(result.version!, current)) return 0;
  installer ??= detectInstaller(process.execPath);
  if (!installer) {
    process.stderr.write(`Install method is unknown. Use draw update --installer npm or --installer bun, or download the matching release archive.\n`); return 1;
  }
  try {
    execFileSync(installer, ['install', '--global', '--ignore-scripts', `${PACKAGE}@${result.version}`], { stdio: 'inherit' });
    process.stderr.write('Draw package installed. Use its global draw command for the new version. Running sessions keep their current executable until restarted; rerun draw install for each agent to refresh its integration.\n');
    return 0;
  } catch {
    process.stderr.write('UNAVAILABLE: the package manager could not finish the update. Check its output and reinstall the same package if needed. Running Draw sessions were not restarted.\n'); return 1;
  }
}
