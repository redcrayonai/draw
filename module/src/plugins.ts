// Optional first-party plugins (PLUGINS.md): the ids this module knows and whether each workspace
// turned them on. A plugin is off until a workspace owner or admin turns it on; turning it off
// stops its actions and keeps its data. Whether a deployment offers a plugin at all is the
// operator's configuration (web/src/lib/server/plugins.ts), not a row here.
import { table, t, SenderError } from 'spacetimedb/server';
import { membership } from './workspaces';
import type { ModuleApi, ModulePart } from './plugin-api';
import { PLUGIN_IDS, PLUGIN_TABLES, type PluginId } from './plugin-meta.generated';

export const PLUGINS = PLUGIN_IDS;
export type { PluginId } from './plugin-meta.generated';

export const workspacePlugin = table({}, {
  key: t.string().primaryKey(), // `<workspaceId>:<plugin>`
  workspaceId: t.u64().index('btree'),
  plugin: t.string(),
  enabled: t.bool(),
  updatedBy: t.identity(),
  updatedAt: t.timestamp(),
});

const pluginKey = (workspaceId: bigint, plugin: string) => `${workspaceId}:${plugin}`;

export const pluginEnabled = (ctx: any, workspaceId: bigint, plugin: PluginId): boolean =>
  ctx.db.workspacePlugin.key.find(pluginKey(workspaceId, plugin))?.enabled === true;

export function pluginFeatures(db: any, hooks: { reducer: any; isHuman: (ctx: any) => boolean }): any {
  const reducer = hooks.reducer;
  const MyWorkspacePlugin = t.row('MyWorkspacePlugin', { key: t.string().primaryKey(), workspaceId: t.u64(), plugin: t.string(), enabled: t.bool(), updatedAt: t.timestamp() });
  return {
    setWorkspacePlugin: reducer({ workspaceId: t.u64(), plugin: t.string(), enabled: t.bool() }, (ctx: any, { workspaceId, plugin, enabled }: any) => {
      if (!hooks.isHuman(ctx)) throw new SenderError('plugin rule: sign in with a human account');
      if (!ctx.db.workspace.id.find(workspaceId) || !['owner', 'admin'].includes(membership(ctx, workspaceId)?.role)) {
        throw new SenderError('plugin rule: only a workspace owner or admin can turn plugins on or off');
      }
      if (!(PLUGINS as readonly string[]).includes(plugin)) throw new SenderError(`plugin rule: there is no plugin '${String(plugin).slice(0, 40)}'`);
      const row = { key: pluginKey(workspaceId, plugin), workspaceId, plugin, enabled, updatedBy: ctx.sender, updatedAt: ctx.timestamp };
      if (ctx.db.workspacePlugin.key.find(row.key)) ctx.db.workspacePlugin.key.update(row);
      else ctx.db.workspacePlugin.insert(row);
    }),
    // Every member sees which plugins their workspaces use; only owners and admins change them.
    myWorkspacePlugins: db.view({ name: 'my_workspace_plugins', public: true }, t.array(MyWorkspacePlugin), (ctx: any) => {
      if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return [];
      return [...ctx.db.workspaceMember.member.filter(ctx.sender)].flatMap((m: any) =>
        [...ctx.db.workspacePlugin.workspaceId.filter(m.workspaceId)].map((p: any) => ({ key: p.key, workspaceId: p.workspaceId, plugin: p.plugin, enabled: p.enabled, updatedAt: p.updatedAt })));
    }),
  };
}

// Validate ownership before spreading tables into the SDK schema.
export function checkPlugins(coreTables: string[], parts: Record<string, ModulePart>): void {
  const expected = new Map<string, { plugin: string }>(Object.entries(PLUGIN_TABLES));
  const found = new Map<string, string>();
  for (const [id, part] of Object.entries(parts)) for (const name of Object.keys(part.tables)) {
    if (coreTables.includes(name)) throw new Error(`plugin rule: table '${name}' collides with core`);
    if (found.has(name)) throw new Error(`plugin rule: table '${name}' belongs to multiple parts`);
    if (expected.get(name)?.plugin !== id) {
      throw new Error(`plugin rule: table '${name}' does not match the manifest for '${id}'`);
    }
    found.set(name, id);
  }
  for (const name of Object.keys(PLUGIN_TABLES)) if (!found.has(name)) throw new Error(`plugin rule: manifest table '${name}' is missing`);
}

export function pluginActions(parts: Record<string, ModulePart>, db: any, api: ModuleApi, taken: string[]): Record<string, unknown> {
  const actions: Record<string, unknown> = Object.create(null);
  const names = new Set(taken);
  // Factory errors must abort publication rather than publish a module missing actions.
  for (const [id, part] of Object.entries(parts)) for (const [name, action] of Object.entries(part.features?.(db, api) ?? {})) {
    if (names.has(name)) throw new Error(`plugin rule: action '${name}' from '${id}' is already taken`);
    names.add(name);
    actions[name] = action;
  }
  return actions;
}
