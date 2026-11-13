import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Run after the unified installation succeeds; keep old packages and credentials available. */
export function disableLegacyClaudePlugins(): void {
  const plugins = JSON.parse(execFileSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8' }));
  if (!Array.isArray(plugins)) throw new Error('UNAVAILABLE: Claude plugin inventory could not be read');
  const legacy = plugins.filter(plugin => typeof plugin?.id === 'string' && /^draw(?:-local)?@[^@\s]+$/.test(plugin.id) && plugin.id !== 'draw@draw-binary' && plugin.enabled === true);
  if (legacy.some(plugin => !['user', 'project', 'local'].includes(plugin.scope))) throw new Error('UNAVAILABLE: Claude plugin installation scope could not be read');
  for (const plugin of legacy) {
    // Installation scope is separate from the project's enabled override.
    for (const scope of new Set([plugin.scope, ...(plugin.projectEnabled === true ? ['project'] : [])])) {
      try { execFileSync('claude', ['plugin', 'disable', plugin.id, '--scope', scope, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }); }
      catch (error) {
        let result;
        try { result = JSON.parse(String((error as { stdout?: unknown }).stdout ?? '').trim().split('\n').at(-1)!); } catch { /* Preserve the original command failure. */ }
        if (result?.failureCode !== 'already_in_goal_state' || result.alreadyInGoalState !== true) throw error;
      }
    }
  }
}

export function disableLegacyPiIntegrations(): void {
  const home = homedir(), oldLocal = join(home, '.redcrayon/plugins/installed/pi-local');
  const configured = process.env.PI_CODING_AGENT_DIR || join(home, '.pi/agent');
  const agentDirectory = resolve(process.cwd(), configured.startsWith('~/') ? join(home, configured.slice(2)) : configured);
  const changes: { path: string; content: string; mode: number }[] = [];
  for (const path of new Set([join(agentDirectory, 'settings.json'), join(process.cwd(), '.pi/settings.json')])) {
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || (settings.packages !== undefined && !Array.isArray(settings.packages))) throw new Error(`UNAVAILABLE: Pi package settings could not be read: ${path}`);
    let changed = false;
    const packages = settings.packages?.map((entry: any) => {
      const source = typeof entry === 'string' ? entry : entry?.source;
      if (typeof source !== 'string' || (!/^npm:@redcrayonai\/draw(?:@[^\s/]+)?$/.test(source) && resolve(dirname(path), source.startsWith('~/') ? join(home, source.slice(2)) : source) !== oldLocal)) return entry;
      const disabled = { ...(typeof entry === 'string' ? { source } : entry), extensions: [], skills: [], prompts: [], themes: [] };
      if (JSON.stringify(entry) !== JSON.stringify(disabled)) changed = true;
      return disabled;
    });
    if (changed) changes.push({ path, content: JSON.stringify({ ...settings, packages }, null, 2) + '\n', mode: statSync(path).mode & 0o777 });
  }
  for (const { path, content, mode } of changes) {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { mode, flag: 'wx' });
    try { renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
  }
}
