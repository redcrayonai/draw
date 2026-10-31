// Optional plugins in the dashboard (PLUGINS.md): which ones this deployment offers (GET /api/plugins),
// which each workspace turned on (my_workspace_plugins), and the Versions list (my_board_versions).
import { writable } from 'svelte/store';
import type { MyBoardVersion as BoardVersion, MyWorkspacePlugin as WorkspacePlugin } from '../module_bindings/types';
import type { PluginInfo } from './api-types';
import { appHref } from './boards';
export type { BoardVersion, WorkspacePlugin, PluginInfo };

export const workspacePlugins = writable<WorkspacePlugin[]>([]);
export const boardVersions = writable<BoardVersion[]>([]);
/** null until GET /api/plugins answers; [] when it cannot. */
export const pluginCatalog = writable<PluginInfo[] | null>(null);

export const pluginOn = (rows: WorkspacePlugin[], workspaceId: bigint | undefined, plugin: string) =>
  rows.some((row) => row.workspaceId === workspaceId && row.plugin === plugin && row.enabled);
export const offered = (catalog: PluginInfo[] | null, plugin: string) => Boolean(catalog?.some((p) => p.id === plugin && p.available));

export function resetPlugins(): void {
  workspacePlugins.set([]);
  boardVersions.set([]);
}

/** Its own subscription, as attachWorkspaces: an older server without these views still serves boards. */
export function attachPlugins(c: import('../module_bindings').DbConnection, stale: () => boolean): void {
  if (!('myWorkspacePlugins' in c.db) || !('myBoardVersions' in c.db)) return;
  const rebuild = () => {
    if (stale()) return;
    workspacePlugins.set([...c.db.myWorkspacePlugins.iter()]);
    boardVersions.set([...c.db.myBoardVersions.iter()].sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch)));
  };
  for (const table of [c.db.myWorkspacePlugins, c.db.myBoardVersions]) {
    table.onInsert(rebuild);
    table.onUpdate(rebuild);
    table.onDelete(rebuild);
  }
  c.subscriptionBuilder().onApplied(rebuild).onError(() => { if (!stale()) resetPlugins(); })
    .subscribe(['SELECT * FROM my_workspace_plugins', 'SELECT * FROM my_board_versions']);
  void loadCatalog();
}

async function loadCatalog(): Promise<void> {
  try {
    const r = await fetch(appHref('/api/plugins'));
    pluginCatalog.set(r.ok ? ((await r.json()) as { plugins: PluginInfo[] }).plugins : []);
  } catch {
    pluginCatalog.set([]);
  }
}
