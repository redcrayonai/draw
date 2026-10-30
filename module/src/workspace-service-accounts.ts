import { table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import { membership } from './workspaces';
import { workspaceName } from './workspace-policy';
import { apiKeyIsActive, machineScopeRole, scopeIsWithin, serviceScope } from './workspace-service-policy';

const scopeFields = { role: t.string(), allBoards: t.bool(), boardIds: t.array(t.u64()) };
const accountFields = {
  id: t.u64().primaryKey().autoInc(), workspaceId: t.u64().index('btree'), name: t.string(), ...scopeFields,
  disabled: t.bool(), createdAt: t.timestamp(), createdBy: t.identity(),
};
const keyMetadataFields = {
  id: t.string().primaryKey(), serviceAccountId: t.u64().index('btree'), name: t.string(), ...scopeFields,
  expiresAt: t.option(t.timestamp()), revoked: t.bool(), createdAt: t.timestamp(), createdBy: t.identity(),
};
export const workspaceServiceAccountTables = {
  workspaceServiceAccount: table({}, accountFields),
  workspaceApiKey: table({}, { ...keyMetadataFields, keyHash: t.string().unique() }),
  // Keep classifications after revocation: no stale machine token may fall back to public/link access.
  workspaceMachineIdentity: table({}, { identity: t.identity().primaryKey(), keyId: t.string() }),
};
export const workspaceApiKeyExpiry = table({}, {
  id: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), keyId: t.string(),
});

export const isWorkspaceMachine = (ctx: any, identity = ctx.sender): boolean => Boolean(ctx.db.workspaceMachineIdentity.identity.find(identity));

/** Called only after the connection's JWT issuer, audience and machine subject are verified. */
export function registerWorkspaceMachine(ctx: any, keyId: string): void {
  const old = ctx.db.workspaceMachineIdentity.identity.find(ctx.sender);
  if (old && old.keyId !== keyId) throw new SenderError('service account rule: machine identity is already classified');
  if (!old) ctx.db.workspaceMachineIdentity.insert({ identity: ctx.sender, keyId });
}

function machinePolicy(ctx: any, identity: any): any {
  const classified = ctx.db.workspaceMachineIdentity.identity.find(identity);
  if (!classified) return undefined;
  const key = ctx.db.workspaceApiKey.id.find(classified.keyId);
  // Views have no clock. The scheduled expiry updates revoked and invalidates their subscriptions.
  const now = 'timestamp' in ctx ? ctx.timestamp.microsSinceUnixEpoch : undefined;
  if (!apiKeyIsActive(key, now)) return undefined;
  const account = ctx.db.workspaceServiceAccount.id.find(key.serviceAccountId);
  const workspace = account && ctx.db.workspace.id.find(account.workspaceId);
  return account && !account.disabled && workspace && !workspace.personal ? { account, key } : undefined;
}

export function workspaceMachineBoardRole(ctx: any, boardId: bigint, identity = ctx.sender): string {
  const policy = machinePolicy(ctx, identity);
  if (!policy || ctx.db.boardWorkspace.boardId.find(boardId)?.workspaceId !== policy.account.workspaceId) return '';
  return machineScopeRole(policy.account, policy.key, boardId);
}

export function workspaceMachineBoardIds(ctx: any, identity = ctx.sender): Set<bigint> {
  const policy = machinePolicy(ctx, identity);
  if (!policy) return new Set();
  return new Set([...ctx.db.boardWorkspace.workspaceId.filter(policy.account.workspaceId)]
    .filter((row: any) => machineScopeRole(policy.account, policy.key, row.boardId))
    .map((row: any) => row.boardId));
}

export function workspaceServiceAccountFeatures(db: any, hooks: any): any {
  const reducer = hooks.reducer;
  const admin = (ctx: any, workspaceId: bigint) => {
    if (!hooks.isHuman(ctx)) throw new SenderError('service account rule: sign in with a human account');
    const workspace = ctx.db.workspace.id.find(workspaceId);
    if (!workspace || !['owner', 'admin'].includes(membership(ctx, workspaceId)?.role)) throw new SenderError('service account rule: only a workspace administrator can manage service accounts');
    if (workspace.personal) throw new SenderError('service account rule: create service accounts in a shared workspace');
    return workspace;
  };
  const account = (ctx: any, id: bigint) => {
    const row = ctx.db.workspaceServiceAccount.id.find(id);
    if (!row) throw new SenderError('service account rule: service account is unavailable');
    admin(ctx, row.workspaceId);
    return row;
  };
  const label = (value: string) => { try { return workspaceName(value); } catch (e) { throw new SenderError((e as Error).message); } };
  const scope = (ctx: any, workspaceId: bigint, args: any, validateBoards = true) => {
    let desired;
    try { desired = serviceScope(args.role, args.allBoards, args.boardIds); } catch (e) { throw new SenderError((e as Error).message); }
    for (const boardId of validateBoards ? desired.boardIds : []) if (!ctx.db.board.id.find(boardId) || ctx.db.boardWorkspace.boardId.find(boardId)?.workspaceId !== workspaceId) throw new SenderError('service account rule: selected boards must belong to the same workspace');
    return desired;
  };
  const administered = (ctx: any) => {
    if (isWorkspaceMachine(ctx) || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return [];
    return [...ctx.db.workspaceMember.member.filter(ctx.sender)].filter((row: any) => ['owner', 'admin'].includes(row.role));
  };
  const accounts = (ctx: any) => administered(ctx).flatMap((row: any) => [...ctx.db.workspaceServiceAccount.workspaceId.filter(row.workspaceId)]);
  const WorkspaceServiceAccount = workspaceServiceAccountTables.workspaceServiceAccount.rowType;
  const WorkspaceApiKey = t.row('WorkspaceApiKeyMetadata', keyMetadataFields);
  const ServiceWorkspaceApiKey = t.row('ServiceWorkspaceApiKey', {
    keyId: t.string().primaryKey(), keyHash: t.string(), workspaceId: t.u64(), serviceAccountId: t.u64(),
    name: t.string(), role: t.string(), expiresAt: t.option(t.timestamp()),
  });
  return {
    createWorkspaceServiceAccount: reducer({ workspaceId: t.u64(), name: t.string(), ...scopeFields }, (ctx: any, args: any) => {
      admin(ctx, args.workspaceId);
      if ([...ctx.db.workspaceServiceAccount.workspaceId.filter(args.workspaceId)].length >= 100) throw new SenderError('service account rule: this workspace has reached its 100 service account limit');
      ctx.db.workspaceServiceAccount.insert({ id: 0n, workspaceId: args.workspaceId, name: label(args.name), ...scope(ctx, args.workspaceId, args), disabled: false, createdAt: ctx.timestamp, createdBy: ctx.sender });
    }),
    updateWorkspaceServiceAccount: reducer({ serviceAccountId: t.u64(), name: t.string(), ...scopeFields, disabled: t.bool() }, (ctx: any, args: any) => {
      const old = account(ctx, args.serviceAccountId);
      ctx.db.workspaceServiceAccount.id.update({ ...old, name: label(args.name), ...scope(ctx, old.workspaceId, args, !args.disabled), disabled: args.disabled });
    }),
    createWorkspaceApiKey: reducer({ serviceAccountId: t.u64(), keyId: t.string(), keyHash: t.string(), name: t.string(), ...scopeFields, expiresAt: t.option(t.timestamp()) }, (ctx: any, args: any) => {
      const owner = account(ctx, args.serviceAccountId), desired = scope(ctx, owner.workspaceId, args);
      if (owner.disabled) throw new SenderError('service account rule: enable this service account before creating a key');
      if (!scopeIsWithin(owner, desired)) throw new SenderError('service account rule: key permissions must not exceed the service account');
      if (!/^[0-9a-f]{32}$/.test(args.keyId) || !/^[0-9a-f]{64}$/.test(args.keyHash)) throw new SenderError('service account rule: invalid key ID or SHA-256 digest');
      if (ctx.db.workspaceApiKey.id.find(args.keyId) || ctx.db.workspaceApiKey.keyHash.find(args.keyHash)) throw new SenderError('service account rule: API key is already in use');
      if (args.expiresAt && args.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('service account rule: key expiry must be in the future');
      const keys = [...ctx.db.workspaceApiKey.serviceAccountId.filter(owner.id)];
      if (keys.length >= 1000 || keys.filter((key: any) => apiKeyIsActive(key, ctx.timestamp.microsSinceUnixEpoch)).length >= 20) throw new SenderError('service account rule: revoke an existing key before creating another');
      ctx.db.workspaceApiKey.insert({ id: args.keyId, serviceAccountId: owner.id, keyHash: args.keyHash, name: label(args.name), ...desired, expiresAt: args.expiresAt, revoked: false, createdAt: ctx.timestamp, createdBy: ctx.sender });
      if (args.expiresAt) ctx.db.workspaceApiKeyExpiry.insert({ id: 0n, scheduledAt: ScheduleAt.time(args.expiresAt.microsSinceUnixEpoch), keyId: args.keyId });
    }),
    revokeWorkspaceApiKey: reducer({ keyId: t.string() }, (ctx: any, args: any) => {
      const old = ctx.db.workspaceApiKey.id.find(args.keyId);
      if (!old) throw new SenderError('service account rule: API key is unavailable');
      account(ctx, old.serviceAccountId);
      if (!old.revoked) ctx.db.workspaceApiKey.id.update({ ...old, revoked: true });
    }),
    expireWorkspaceApiKey: db.reducer({ onSchedule: workspaceApiKeyExpiry }, { arg: workspaceApiKeyExpiry.rowType }, (ctx: any, { arg }: any) => {
      if (!ctx.sender.isEqual(ctx.databaseIdentity)) throw new SenderError('service account rule: only the database scheduler can expire keys');
      const scheduled = ctx.db.workspaceApiKeyExpiry.id.find(arg.id);
      if (!scheduled || scheduled.keyId !== arg.keyId || scheduled.scheduledAt.tag !== 'Time') throw new SenderError('service account rule: expiry schedule is unavailable');
      const key = ctx.db.workspaceApiKey.id.find(scheduled.keyId), expiresAt = key?.expiresAt?.microsSinceUnixEpoch;
      if (expiresAt === undefined || expiresAt !== scheduled.scheduledAt.value.microsSinceUnixEpoch || expiresAt > ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('service account rule: API key has not expired');
      if (!key.revoked) ctx.db.workspaceApiKey.id.update({ ...key, revoked: true });
      ctx.db.workspaceApiKeyExpiry.id.delete(scheduled.id);
    }),
    myWorkspaceServiceAccounts: db.view({ name: 'my_workspace_service_accounts', public: true }, t.array(WorkspaceServiceAccount), accounts),
    myWorkspaceApiKeys: db.view({ name: 'my_workspace_api_keys', public: true }, t.array(WorkspaceApiKey), (ctx: any) => accounts(ctx).flatMap((row: any) => [...ctx.db.workspaceApiKey.serviceAccountId.filter(row.id)].map(({ keyHash: _keyHash, ...key }: any) => key))),
    serviceWorkspaceApiKeys: db.view({ name: 'service_workspace_api_keys', public: true }, t.array(ServiceWorkspaceApiKey), (ctx: any) => {
      try { hooks.assertService(ctx); } catch { return []; }
      return [...ctx.db.workspaceApiKey.iter()].filter((key: any) => apiKeyIsActive(key)).flatMap((key: any) => {
        const account = ctx.db.workspaceServiceAccount.id.find(key.serviceAccountId), workspace = account && ctx.db.workspace.id.find(account.workspaceId);
        if (!account || account.disabled || !workspace || workspace.personal) return [];
        return [{ keyId: key.id, keyHash: key.keyHash, workspaceId: account.workspaceId, serviceAccountId: account.id, name: account.name, role: account.role === 'viewer' || key.role === 'viewer' ? 'viewer' : 'editor', expiresAt: key.expiresAt }];
      });
    }),
  };
}
