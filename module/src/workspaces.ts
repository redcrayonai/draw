import { table, t, SenderError } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import { boardRole, roleRank, strongestRole, invitationRole, invitationIsLive, workspaceName } from './workspace-policy';
import { isWorkspaceMachine } from './workspace-service-accounts';

export const workspaceTables = {
  workspaceAccount: table({}, { identity: t.identity().primaryKey(), disabled: t.bool() }),
  workspace: table({}, { id: t.u64().primaryKey().autoInc(), name: t.string(), personal: t.bool(), owner: t.identity().index('btree'), createdAt: t.timestamp() }),
  workspaceMember: table({}, { id: t.u64().primaryKey().autoInc(), workspaceId: t.u64().index('btree'), member: t.identity().index('btree'), role: t.string() }),
  workspaceTeam: table({}, { id: t.u64().primaryKey().autoInc(), workspaceId: t.u64().index('btree'), name: t.string() }),
  workspaceTeamMember: table({}, { id: t.u64().primaryKey().autoInc(), teamId: t.u64().index('btree'), member: t.identity().index('btree') }),
  boardWorkspace: table({}, { boardId: t.u64().primaryKey(), workspaceId: t.u64().index('btree'), defaultRole: t.string() }),
  historyWorkspace: table({}, { historyId: t.u64().primaryKey(), workspaceId: t.u64().index('btree') }),
  workspaceBoardGrant: table({}, { id: t.u64().primaryKey().autoInc(), boardId: t.u64().index('btree'), member: t.identity().index('btree'), role: t.string() }),
  workspaceTeamGrant: table({}, { id: t.u64().primaryKey().autoInc(), boardId: t.u64().index('btree'), teamId: t.u64().index('btree'), role: t.string() }),
  workspaceInvite: table({}, { token: t.string().primaryKey(), workspaceId: t.u64().index('btree'), boardId: t.u64().index('btree'), role: t.string(), expiresAt: t.timestamp(), invitedBy: t.identity().index('btree') }),
  legacyWorkspace: table({}, { orgId: t.string().primaryKey(), workspaceId: t.u64().unique() }),
};

export function membership(ctx: any, workspaceId: bigint, identity = ctx.sender): any {
  return [...ctx.db.workspaceMember.member.filter(identity)].find((m: any) => m.workspaceId === workspaceId);
}

export function nativeBoardRole(ctx: any, boardId: bigint, identity = ctx.sender): string {
  if (isWorkspaceMachine(ctx, identity)) return '';
  if (ctx.db.workspaceAccount.identity.find(identity)?.disabled !== false) return '';
  if (ctx.db.agentLink.agent.find(identity) || ctx.db.serviceAccount.identity.find(identity)) return '';
  const scope = ctx.db.boardWorkspace.boardId.find(boardId);
  if (!scope) return '';
  const member = membership(ctx, scope.workspaceId, identity);
  let team = '';
  if (member?.role === 'member') {
    for (const grant of ctx.db.workspaceTeamGrant.boardId.filter(boardId)) {
      if ([...ctx.db.workspaceTeamMember.teamId.filter(grant.teamId)].some((m: any) => m.member.isEqual(identity))) team = strongestRole(team, grant.role);
    }
  }
  const direct = [...ctx.db.workspaceBoardGrant.boardId.filter(boardId)].find((g: any) => g.member.isEqual(identity))?.role ?? '';
  return boardRole(member?.role ?? '', scope.defaultRole, team, direct);
}

/** Explicit identity argument: service callers must never lend their authority to the person checked. */
export function humanBoardRole(ctx: any, boardId: bigint, identity = ctx.sender): string {
  if (isWorkspaceMachine(ctx, identity)) return '';
  if (ctx.db.workspaceAccount.identity.find(identity)?.disabled) return '';
  const scope = ctx.db.boardWorkspace.boardId.find(boardId);
  const native = nativeBoardRole(ctx, boardId, identity);
  if (scope && !ctx.db.workspace.id.find(scope.workspaceId)?.personal) return native;
  let role = native;
  for (const grant of ctx.db.boardGrant.boardId.filter(boardId)) {
    if (grant.grantee.isEqual(identity) && grant.role === 'owner') role = 'manager';
  }
  for (const grant of ctx.db.teamGrant.boardId.filter(boardId)) {
    const imported = ctx.db.legacyWorkspace.orgId.find(grant.orgId);
    const member = imported ? membership(ctx, imported.workspaceId, identity) : [...ctx.db.orgMember.member.filter(identity)].find((m: any) => m.orgId === grant.orgId);
    if (member && member.role !== 'guest') role = strongestRole(role, 'editor');
  }
  return role;
}

export function humanBoardIds(ctx: any, identity = ctx.sender): Set<bigint> {
  if (isWorkspaceMachine(ctx, identity)) return new Set();
  const candidates = new Set<bigint>();
  for (const grant of ctx.db.boardGrant.grantee.filter(identity)) candidates.add(grant.boardId);
  const orgs = new Set<string>();
  for (const member of ctx.db.orgMember.member.filter(identity)) if (!ctx.db.legacyWorkspace.orgId.find(member.orgId)) orgs.add(member.orgId);
  for (const member of ctx.db.workspaceMember.member.filter(identity)) {
    for (const scope of ctx.db.boardWorkspace.workspaceId.filter(member.workspaceId)) candidates.add(scope.boardId);
    const legacy = ctx.db.legacyWorkspace.workspaceId.find(member.workspaceId);
    if (legacy && member.role !== 'guest') orgs.add(legacy.orgId);
  }
  for (const org of orgs) for (const grant of ctx.db.teamGrant.orgId.filter(org)) candidates.add(grant.boardId);
  return new Set([...candidates].filter(id => roleRank(humanBoardRole(ctx, id, identity)) > 0));
}

export function assignBoardWorkspace(ctx: any, boardId: bigint, workspaceId: bigint, creator: any, defaultRole = 'none'): void {
  const scope = { boardId, workspaceId, defaultRole };
  if (ctx.db.boardWorkspace.boardId.find(boardId)) ctx.db.boardWorkspace.boardId.update(scope);
  else ctx.db.boardWorkspace.insert(scope);
  for (const g of [...ctx.db.boardGrant.boardId.filter(boardId)]) ctx.db.boardGrant.id.delete(g.id);
  for (const g of [...ctx.db.teamGrant.boardId.filter(boardId)]) ctx.db.teamGrant.id.delete(g.id);
  for (const g of [...ctx.db.workspaceBoardGrant.boardId.filter(boardId)]) ctx.db.workspaceBoardGrant.id.delete(g.id);
  for (const g of [...ctx.db.workspaceTeamGrant.boardId.filter(boardId)]) ctx.db.workspaceTeamGrant.id.delete(g.id);
  for (const g of [...ctx.db.agentGrant.boardId.filter(boardId)]) ctx.db.agentGrant.id.delete(g.id);
  for (const invite of [...ctx.db.workspaceInvite.boardId.filter(boardId)]) ctx.db.workspaceInvite.token.delete(invite.token);
  const creatorMembership = membership(ctx, workspaceId, creator);
  if (creatorMembership && creatorMembership.role !== 'guest') ctx.db.workspaceBoardGrant.insert({ id: 0n, boardId, member: creator, role: 'manager' });
  const workspace = ctx.db.workspace.id.find(workspaceId);
  if (workspace.personal) ctx.db.boardGrant.insert({ id: 0n, boardId, grantee: workspace.owner, role: 'owner' });
}

export function removeWorkspaceMember(ctx: any, workspaceId: bigint, identity: any, preserveBoardGrants = false): void {
  const member = membership(ctx, workspaceId, identity);
  if (member) ctx.db.workspaceMember.id.delete(member.id);
  for (const team of ctx.db.workspaceTeam.workspaceId.filter(workspaceId)) {
    for (const row of [...ctx.db.workspaceTeamMember.teamId.filter(team.id)]) if (row.member.isEqual(identity)) ctx.db.workspaceTeamMember.id.delete(row.id);
  }
  const boards = new Set([...ctx.db.boardWorkspace.workspaceId.filter(workspaceId)].map((b: any) => b.boardId));
  // Legacy personal boards shared with an imported workspace also carry delegated access.
  const legacy = ctx.db.legacyWorkspace.workspaceId.find(workspaceId);
  if (legacy) for (const g of ctx.db.teamGrant.orgId.filter(legacy.orgId)) boards.add(g.boardId);
  for (const id of boards) {
    if (!preserveBoardGrants && ctx.db.boardWorkspace.boardId.find(id)?.workspaceId === workspaceId) {
      for (const g of [...ctx.db.workspaceBoardGrant.boardId.filter(id)]) if (g.member.isEqual(identity)) ctx.db.workspaceBoardGrant.id.delete(g.id);
    }
    for (const g of [...ctx.db.agentGrant.boardId.filter(id)]) if (g.grantedBy.isEqual(identity)) ctx.db.agentGrant.id.delete(g.id);
  }
  for (const invite of [...ctx.db.workspaceInvite.invitedBy.filter(identity)]) if (invite.workspaceId === workspaceId) ctx.db.workspaceInvite.token.delete(invite.token);
}

export function workspaceFeatures(db: any, hooks: any): any {
  const reducer = hooks.reducer;
  const human = (ctx: any) => {
    if (!hooks.isHuman(ctx)) throw new SenderError('workspace rule: sign in with a human account');
    // Existing sockets survive module upgrades without rerunning onConnect.
    if (!ctx.db.workspaceAccount.identity.find(ctx.sender)) ctx.db.workspaceAccount.insert({ identity: ctx.sender, disabled: false });
  };
  const workspace = (ctx: any, id: bigint) => { const w = ctx.db.workspace.id.find(id); if (!w || !membership(ctx, id)) throw new SenderError('workspace rule: workspace is unavailable'); return w; };
  const admin = (ctx: any, id: bigint) => { human(ctx); const w = workspace(ctx, id); if (!['owner', 'admin'].includes(membership(ctx, id)?.role)) throw new SenderError('workspace rule: only a workspace administrator can manage members and teams'); return w; };
  const manage = (ctx: any, boardId: bigint) => { human(ctx); if (humanBoardRole(ctx, boardId) !== 'manager') throw new SenderError('workspace rule: only a board manager can change access'); const s = ctx.db.boardWorkspace.boardId.find(boardId); if (!s) throw new SenderError('workspace rule: move this board into a workspace first'); return s; };
  const name = (v: string) => { try { return workspaceName(v); } catch (e) { throw new SenderError((e as Error).message); } };
  const role = (v: string, empty = true) => { if (!(empty && !v) && roleRank(v) === 0) throw new SenderError('workspace rule: board role must be viewer, editor or manager'); };
  const memberRows = (ctx: any) => [...ctx.db.workspaceMember.member.filter(ctx.sender)];
  const canListMembers = (m: any) => m.role !== 'guest';
  const newWorkspace = (ctx: any, label: string, personal: boolean) => {
    const w = ctx.db.workspace.insert({ id: 0n, name: label, personal, owner: ctx.sender, createdAt: ctx.timestamp });
    ctx.db.workspaceMember.insert({ id: 0n, workspaceId: w.id, member: ctx.sender, role: 'owner' });
    return w;
  };
  const upsertGrant = (ctx: any, key: string, boardId: bigint, valueKey: string, value: any, desired: string) => {
    const existing = [...ctx.db[key].boardId.filter(boardId)].find((g: any) => valueKey === 'member' ? g.member.isEqual(value) : g[valueKey] === value);
    if (existing) ctx.db[key].id.delete(existing.id);
    if (desired) ctx.db[key].insert({ id: 0n, boardId, [valueKey]: value, role: desired });
  };
  const MyWorkspace = t.row('MyWorkspace', { id: t.u64().primaryKey(), name: t.string(), personal: t.bool(), role: t.string(), createdAt: t.timestamp() });
  const MyWorkspaceMember = t.row('MyWorkspaceMember', { id: t.u64().primaryKey(), workspaceId: t.u64(), member: t.identity(), role: t.string(), name: t.string() });
  const Permission = t.row('BoardPermission', { boardId: t.u64().primaryKey(), workspaceId: t.u64(), role: t.string(), canEdit: t.bool(), canManage: t.bool(), defaultRole: t.string() });
  return {
    ensurePersonalWorkspace: reducer({}, (ctx: any) => {
      human(ctx);
      let w = [...ctx.db.workspace.owner.filter(ctx.sender)].find((w: any) => w.personal);
      if (!w) w = newWorkspace(ctx, 'Personal', true);
      for (const grant of ctx.db.boardGrant.grantee.filter(ctx.sender)) {
        if (grant.role !== 'owner' || ctx.db.boardWorkspace.boardId.find(grant.boardId)) continue;
        ctx.db.boardWorkspace.insert({ boardId: grant.boardId, workspaceId: w.id, defaultRole: 'none' });
      }
    }),
    createWorkspace: reducer({ name: t.string() }, (ctx: any, args: any) => { human(ctx); newWorkspace(ctx, name(args.name), false); }),
    renameWorkspace: reducer({ workspaceId: t.u64(), name: t.string() }, (ctx: any, args: any) => { const w = admin(ctx, args.workspaceId); ctx.db.workspace.id.update({ ...w, name: name(args.name) }); }),
    setWorkspaceMember: reducer({ workspaceId: t.u64(), member: t.identity(), role: t.string() }, (ctx: any, args: any) => {
      human(ctx); const w = workspace(ctx, args.workspaceId), actor = membership(ctx, w.id), previous = membership(ctx, w.id, args.member);
      const leaving = !args.role && args.member.isEqual(ctx.sender);
      if (!leaving) admin(ctx, w.id);
      if (!['', 'owner', 'admin', 'member', 'guest'].includes(args.role)) throw new SenderError('workspace rule: unknown membership role');
      if (args.role && (isWorkspaceMachine(ctx, args.member) || ctx.db.agentLink.agent.find(args.member) || ctx.db.serviceAccount.identity.find(args.member))) throw new SenderError('workspace rule: invite people as members and grant agents individual boards');
      if (args.role && !previous && ctx.db.workspaceAccount.identity.find(args.member)?.disabled !== false) throw new SenderError('workspace rule: use an invitation for a person who has not signed in');
      if (w.personal && (args.role && args.role !== 'guest' || previous?.role === 'owner')) throw new SenderError('workspace rule: a personal workspace keeps its single owner');
      if (!leaving && (['owner', 'admin'].includes(args.role) || ['owner', 'admin'].includes(previous?.role)) && actor.role !== 'owner') throw new SenderError('workspace rule: only an owner can change administrators');
      if (previous?.role === 'owner' && args.role !== 'owner' && [...ctx.db.workspaceMember.workspaceId.filter(w.id)].filter((m: any) => m.role === 'owner').length === 1) throw new SenderError('workspace rule: keep at least one owner');
      if (previous?.role === args.role) return;
      if (!args.role || args.role === 'guest') removeWorkspaceMember(ctx, w.id, args.member, args.role === 'guest');
      else if (previous) ctx.db.workspaceMember.id.delete(previous.id);
      if (args.role) ctx.db.workspaceMember.insert({ id: 0n, workspaceId: w.id, member: args.member, role: args.role });
    }),
    createWorkspaceTeam: reducer({ workspaceId: t.u64(), name: t.string() }, (ctx: any, args: any) => { const w = admin(ctx, args.workspaceId); if (w.personal) throw new SenderError('workspace rule: create teams in a shared workspace'); ctx.db.workspaceTeam.insert({ id: 0n, workspaceId: w.id, name: name(args.name) }); }),
    renameWorkspaceTeam: reducer({ teamId: t.u64(), name: t.string() }, (ctx: any, args: any) => { const team = ctx.db.workspaceTeam.id.find(args.teamId); if (!team) throw new SenderError('workspace rule: team is unavailable'); admin(ctx, team.workspaceId); ctx.db.workspaceTeam.id.update({ ...team, name: name(args.name) }); }),
    deleteWorkspaceTeam: reducer({ teamId: t.u64() }, (ctx: any, args: any) => {
      const team = ctx.db.workspaceTeam.id.find(args.teamId); if (!team) throw new SenderError('workspace rule: team is unavailable'); admin(ctx, team.workspaceId);
      for (const row of [...ctx.db.workspaceTeamMember.teamId.filter(team.id)]) ctx.db.workspaceTeamMember.id.delete(row.id);
      for (const row of [...ctx.db.workspaceTeamGrant.teamId.filter(team.id)]) ctx.db.workspaceTeamGrant.id.delete(row.id);
      ctx.db.workspaceTeam.id.delete(team.id);
    }),
    setWorkspaceTeamMember: reducer({ teamId: t.u64(), member: t.identity(), enabled: t.bool() }, (ctx: any, args: any) => {
      const team = ctx.db.workspaceTeam.id.find(args.teamId); if (!team) throw new SenderError('workspace rule: team is unavailable'); admin(ctx, team.workspaceId);
      const m = membership(ctx, team.workspaceId, args.member); if (!m || m.role === 'guest') throw new SenderError('workspace rule: teams require a full workspace member');
      const old = [...ctx.db.workspaceTeamMember.teamId.filter(team.id)].find((m: any) => m.member.isEqual(args.member));
      if (old && !args.enabled) ctx.db.workspaceTeamMember.id.delete(old.id);
      if (!old && args.enabled) ctx.db.workspaceTeamMember.insert({ id: 0n, teamId: team.id, member: args.member });
    }),
    createWorkspaceBoard: reducer({ workspaceId: t.u64(), name: t.string(), requestKey: t.string() }, (ctx: any, args: any) => {
      human(ctx); const w = workspace(ctx, args.workspaceId); if (membership(ctx, w.id).role === 'guest') throw new SenderError('workspace rule: guests cannot create workspace boards');
      hooks.createBoard(ctx, args, w);
    }),
    moveBoardToWorkspace: reducer({ boardId: t.u64(), workspaceId: t.u64() }, (ctx: any, args: any) => {
      human(ctx); const w = workspace(ctx, args.workspaceId); if (membership(ctx, w.id).role === 'guest') throw new SenderError('workspace rule: guests cannot move boards'); hooks.moveBoard(ctx, args.boardId, w);
    }),
    setWorkspaceBoardAccess: reducer({ boardId: t.u64(), role: t.string() }, (ctx: any, args: any) => {
      const scope = manage(ctx, args.boardId); if (!['none', 'viewer', 'editor'].includes(args.role)) throw new SenderError('workspace rule: workspace access must be none, viewer or editor'); ctx.db.boardWorkspace.boardId.update({ ...scope, defaultRole: args.role });
    }),
    setWorkspaceBoardMember: reducer({ boardId: t.u64(), member: t.identity(), role: t.string() }, (ctx: any, args: any) => {
      const scope = manage(ctx, args.boardId); role(args.role); if (args.role && !membership(ctx, scope.workspaceId, args.member)) throw new SenderError('workspace rule: invite this person to the workspace first'); upsertGrant(ctx, 'workspaceBoardGrant', args.boardId, 'member', args.member, args.role);
    }),
    setWorkspaceBoardTeam: reducer({ boardId: t.u64(), teamId: t.u64(), role: t.string() }, (ctx: any, args: any) => {
      const scope = manage(ctx, args.boardId); role(args.role); const team = ctx.db.workspaceTeam.id.find(args.teamId); if (!team || team.workspaceId !== scope.workspaceId) throw new SenderError('workspace rule: board and team must belong to the same workspace'); upsertGrant(ctx, 'workspaceTeamGrant', args.boardId, 'teamId', args.teamId, args.role);
    }),
    createWorkspaceInvite: reducer({ workspaceId: t.u64(), boardId: t.u64(), role: t.string(), token: t.string() }, (ctx: any, args: any) => {
      human(ctx); const w = workspace(ctx, args.workspaceId);
      if (args.boardId === 0n) { admin(ctx, w.id); if (w.personal) throw new SenderError('workspace rule: share a personal board through a board invitation'); if (args.role === 'admin' && membership(ctx, w.id).role !== 'owner') throw new SenderError('workspace rule: only an owner can invite administrators'); }
      else if (manage(ctx, args.boardId).workspaceId !== w.id) throw new SenderError('workspace rule: board and invitation must belong to the same workspace');
      if (!invitationRole(args.boardId, args.role) || !/^[0-9a-f]{32}$/.test(args.token)) throw new SenderError('workspace rule: invalid invitation role or token');
      for (const invite of [...ctx.db.workspaceInvite.workspaceId.filter(w.id)]) if (!invitationIsLive(invite.expiresAt.microsSinceUnixEpoch, ctx.timestamp.microsSinceUnixEpoch)) ctx.db.workspaceInvite.token.delete(invite.token);
      if ([...ctx.db.workspaceInvite.workspaceId.filter(w.id)].length >= 100) throw new SenderError('workspace rule: revoke an outstanding invitation before creating another');
      if (ctx.db.workspaceInvite.token.find(args.token)) throw new SenderError('workspace rule: invitation token is already in use');
      ctx.db.workspaceInvite.insert({ ...args, expiresAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + 604800000000n), invitedBy: ctx.sender });
    }),
    acceptWorkspaceInvite: reducer({ token: t.string() }, (ctx: any, args: any) => {
      human(ctx); const invite = ctx.db.workspaceInvite.token.find(args.token);
      if (!invite || !invitationIsLive(invite.expiresAt.microsSinceUnixEpoch, ctx.timestamp.microsSinceUnixEpoch)) throw new SenderError('workspace rule: invitation has expired or is unavailable');
      const inviter = membership(ctx, invite.workspaceId, invite.invitedBy);
      const valid = invite.boardId === 0n
        ? inviter && ['owner', 'admin'].includes(inviter.role) && (invite.role !== 'admin' || inviter.role === 'owner')
        : ctx.db.boardWorkspace.boardId.find(invite.boardId)?.workspaceId === invite.workspaceId && humanBoardRole(ctx, invite.boardId, invite.invitedBy) === 'manager';
      if (!valid) throw new SenderError('workspace rule: invitation is no longer authorized');
      const current = membership(ctx, invite.workspaceId);
      const desired = invite.boardId === 0n ? invite.role : 'guest';
      const ranks: Record<string, number> = { guest: 0, member: 1, admin: 2, owner: 3 };
      if (!current) ctx.db.workspaceMember.insert({ id: 0n, workspaceId: invite.workspaceId, member: ctx.sender, role: desired });
      else if (ranks[desired] > ranks[current.role]) ctx.db.workspaceMember.id.update({ ...current, role: desired });
      if (invite.boardId !== 0n) {
        const old = [...ctx.db.workspaceBoardGrant.boardId.filter(invite.boardId)].find((g: any) => g.member.isEqual(ctx.sender));
        upsertGrant(ctx, 'workspaceBoardGrant', invite.boardId, 'member', ctx.sender, strongestRole(old?.role ?? '', invite.role));
      }
      ctx.db.workspaceInvite.token.delete(invite.token);
    }),
    revokeWorkspaceInvite: reducer({ token: t.string() }, (ctx: any, args: any) => { const invite = ctx.db.workspaceInvite.token.find(args.token); if (!invite) return; if (invite.boardId === 0n) admin(ctx, invite.workspaceId); else manage(ctx, invite.boardId); ctx.db.workspaceInvite.token.delete(args.token); }),
    migrateLegacyWorkspaces: db.reducer({}, (ctx: any) => {
      hooks.assertService(ctx);
      const orgs = new Set([...ctx.db.orgMember.iter()].map((m: any) => m.orgId));
      for (const orgId of orgs) {
        if (ctx.db.legacyWorkspace.orgId.find(orgId)) continue;
        const members = [...ctx.db.orgMember.orgId.filter(orgId)]; if (members.length === 0) continue;
        const first = members.find((m: any) => /(^|:)admin$/.test(m.role)) ?? members[0];
        const w = ctx.db.workspace.insert({ id: 0n, name: orgId, personal: false, owner: first.member, createdAt: ctx.timestamp });
        ctx.db.legacyWorkspace.insert({ orgId, workspaceId: w.id });
        const seen = new Set<string>();
        for (const m of members) {
          if (seen.has(m.member.toHexString())) continue; seen.add(m.member.toHexString());
          ctx.db.workspaceMember.insert({ id: 0n, workspaceId: w.id, member: m.member, role: m.member.isEqual(first.member) ? 'owner' : /(^|:)admin$/.test(m.role) ? 'admin' : 'member' });
        }
      }
    }),
    deactivateWorkspaceIdentity: db.reducer({ member: t.identity() }, (ctx: any, args: any) => {
      hooks.assertService(ctx);
      const row = { identity: args.member, disabled: true };
      if (ctx.db.workspaceAccount.identity.find(args.member)) ctx.db.workspaceAccount.identity.update(row); else ctx.db.workspaceAccount.insert(row);
      for (const m of [...ctx.db.workspaceMember.member.filter(args.member)]) removeWorkspaceMember(ctx, m.workspaceId, args.member);
      for (const link of [...ctx.db.agentLink.owner.filter(args.member)]) {
        for (const grant of [...ctx.db.agentGrant.agent.filter(link.agent)]) ctx.db.agentGrant.id.delete(grant.id);
        ctx.db.agentLink.agent.delete(link.agent);
      }
      for (const visit of [...ctx.db.linkVisit.viewer.filter(args.member)]) ctx.db.linkVisit.id.delete(visit.id);
    }),
    myWorkspaces: db.view({ name: 'my_workspaces', public: true }, t.array(MyWorkspace), (ctx: any) => memberRows(ctx).flatMap(m => { const w = ctx.db.workspace.id.find(m.workspaceId); return w ? [{ id: w.id, name: w.name, personal: w.personal, role: m.role, createdAt: w.createdAt }] : []; })),
    myWorkspaceMembers: db.view({ name: 'my_workspace_members', public: true }, t.array(MyWorkspaceMember), (ctx: any) => memberRows(ctx).flatMap(m => (canListMembers(m) ? [...ctx.db.workspaceMember.workspaceId.filter(m.workspaceId)] : [m]).map(row => ({ ...row, name: ctx.db.participant.identity.find(row.member)?.displayName ?? '' })))),
    myWorkspaceTeams: db.view({ name: 'my_workspace_teams', public: true }, t.array(workspaceTables.workspaceTeam.rowType), (ctx: any) => memberRows(ctx).filter(canListMembers).flatMap(m => [...ctx.db.workspaceTeam.workspaceId.filter(m.workspaceId)])),
    myWorkspaceTeamMembers: db.view({ name: 'my_workspace_team_members', public: true }, t.array(workspaceTables.workspaceTeamMember.rowType), (ctx: any) => memberRows(ctx).filter(canListMembers).flatMap(m => [...ctx.db.workspaceTeam.workspaceId.filter(m.workspaceId)].flatMap(team => [...ctx.db.workspaceTeamMember.teamId.filter(team.id)]))),
    myBoardPermissions: db.view({ name: 'my_board_permissions', public: true }, t.array(Permission), (ctx: any) => [...hooks.readableBoardIds(ctx)].map((boardId: bigint) => { const scope = ctx.db.boardWorkspace.boardId.find(boardId), role = hooks.effectiveRole(ctx, boardId); return { boardId, workspaceId: scope?.workspaceId ?? 0n, role, canEdit: roleRank(role) >= 2, canManage: role === 'manager', defaultRole: scope?.defaultRole ?? 'none' }; })),
    myWorkspaceBoardGrants: db.view({ name: 'my_workspace_board_grants', public: true }, t.array(workspaceTables.workspaceBoardGrant.rowType), (ctx: any) => [...humanBoardIds(ctx)].filter(id => humanBoardRole(ctx, id) === 'manager').flatMap(id => [...ctx.db.workspaceBoardGrant.boardId.filter(id)])),
    myWorkspaceTeamGrants: db.view({ name: 'my_workspace_team_grants', public: true }, t.array(workspaceTables.workspaceTeamGrant.rowType), (ctx: any) => [...humanBoardIds(ctx)].filter(id => humanBoardRole(ctx, id) === 'manager').flatMap(id => [...ctx.db.workspaceTeamGrant.boardId.filter(id)])),
    myWorkspaceInvites: db.view({ name: 'my_workspace_invites', public: true }, t.array(workspaceTables.workspaceInvite.rowType), (ctx: any) => memberRows(ctx).flatMap(m => [...ctx.db.workspaceInvite.workspaceId.filter(m.workspaceId)].filter(i => i.boardId === 0n ? ['owner', 'admin'].includes(m.role) : humanBoardRole(ctx, i.boardId) === 'manager'))),
  };
}
