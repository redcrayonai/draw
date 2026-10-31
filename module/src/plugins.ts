// Optional first-party plugins (PLUGINS.md): the ids this module knows and whether each workspace
// turned them on. A plugin is off until a workspace owner or admin turns it on; turning it off
// stops its actions and keeps its data. Whether a deployment offers a plugin at all is the
// operator's configuration (web/src/lib/server/plugins.ts), not a row here.
import { table, t, SenderError } from 'spacetimedb/server';
import { membership } from './workspaces';

export const PLUGINS = ['versions'] as const;
export type PluginId = (typeof PLUGINS)[number];

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
