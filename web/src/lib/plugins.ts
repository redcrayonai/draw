// Optional plugins in the dashboard (PLUGINS.md): which ones this deployment offers (GET /api/plugins),
// which each workspace turned on (my_workspace_plugins).
import { writable } from 'svelte/store';
import type { MyWorkspacePlugin as WorkspacePlugin } from '../module_bindings/types';
import type { PluginInfo } from './api-types';
import { appHref } from './boards';
export type { WorkspacePlugin, PluginInfo };

export const workspacePlugins = writable<WorkspacePlugin[]>([]);
/** null until GET /api/plugins answers; [] when it cannot. */
export const pluginCatalog = writable<PluginInfo[] | null>(null);

export const pluginOn = (rows: WorkspacePlugin[], workspaceId: bigint | undefined, plugin: string) =>
  rows.some((row) => row.workspaceId === workspaceId && row.plugin === plugin && row.enabled);
export const offered = (catalog: PluginInfo[] | null, plugin: string) => Boolean(catalog?.some((p) => p.id === plugin && p.available));

export function resetPlugins(): void {
  workspacePlugins.set([]);
}

/** Its own subscription, as attachWorkspaces: an older server without these views still serves boards. */
export function attachPlugins(c: import('../module_bindings').DbConnection, stale: () => boolean): void {
  void loadCatalog();
  if (!('myWorkspacePlugins' in c.db)) return;
  const rebuild = () => {
    if (stale()) return;
    workspacePlugins.set([...c.db.myWorkspacePlugins.iter()]);
  };
  c.db.myWorkspacePlugins.onInsert(rebuild);
  c.db.myWorkspacePlugins.onUpdate(rebuild);
  c.db.myWorkspacePlugins.onDelete(rebuild);
  c.subscriptionBuilder().onApplied(rebuild).onError(() => { if (!stale()) resetPlugins(); })
    .subscribe(['SELECT * FROM my_workspace_plugins']);
}

async function loadCatalog(): Promise<void> {
  try {
    const r = await fetch(appHref('/api/plugins'));
    pluginCatalog.set(r.ok ? ((await r.json()) as { plugins: PluginInfo[] }).plugins : []);
  } catch {
    pluginCatalog.set([]);
  }
}
