import { writable } from 'svelte/store';
import { setDb } from '$shared/db-target';
import type { MyWorkspace as Workspace, MyWorkspaceMember as WorkspaceMember, WorkspaceTeam, WorkspaceTeamMember, BoardPermission, WorkspaceBoardGrant, WorkspaceTeamGrant, WorkspaceInvite, WorkspaceServiceAccount, WorkspaceApiKeyMetadata as WorkspaceApiKey } from '../module_bindings/types';
export type { Workspace, WorkspaceMember, WorkspaceTeam, WorkspaceTeamMember, BoardPermission, WorkspaceBoardGrant, WorkspaceTeamGrant, WorkspaceInvite, WorkspaceServiceAccount, WorkspaceApiKey };

export const myWorkspaces = writable<Workspace[]>([]);
export const workspaceMembers = writable<WorkspaceMember[]>([]);
export const workspaceTeams = writable<WorkspaceTeam[]>([]);
export const workspaceTeamMembers = writable<WorkspaceTeamMember[]>([]);
export const boardPermissions = writable<Map<bigint, BoardPermission>>(new Map());
export const workspaceBoardGrants = writable<WorkspaceBoardGrant[]>([]);
export const workspaceTeamGrants = writable<WorkspaceTeamGrant[]>([]);
export const workspaceInvites = writable<WorkspaceInvite[]>([]);
export const workspaceServiceAccounts = writable<WorkspaceServiceAccount[]>([]);
export const workspaceApiKeys = writable<WorkspaceApiKey[]>([]);
export const serviceAccountState = writable<'idle' | 'loading' | 'live' | 'unavailable'>('idle');
export const workspaceState = writable<'idle' | 'loading' | 'live' | 'unavailable'>('idle');

export function resetWorkspaces(): void {
  myWorkspaces.set([]);
  workspaceMembers.set([]);
  workspaceTeams.set([]);
  workspaceTeamMembers.set([]);
  boardPermissions.set(new Map());
  workspaceBoardGrants.set([]);
  workspaceTeamGrants.set([]);
  workspaceInvites.set([]);
  workspaceServiceAccounts.set([]);
  workspaceApiKeys.set([]);
  serviceAccountState.set('idle');
  workspaceState.set('idle');
}

/** Optional views use their own subscription: an older server still serves boards. */
export function attachWorkspaces(c: import('../module_bindings').DbConnection, stale: () => boolean): void {
  if (!('myWorkspaces' in c.db)) return;
  workspaceState.set('loading');
  const tables = [
    ['my_workspaces', 'myWorkspaces', myWorkspaces],
    ['my_workspace_members', 'myWorkspaceMembers', workspaceMembers],
    ['my_workspace_teams', 'myWorkspaceTeams', workspaceTeams],
    ['my_workspace_team_members', 'myWorkspaceTeamMembers', workspaceTeamMembers],
    ['my_workspace_board_grants', 'myWorkspaceBoardGrants', workspaceBoardGrants],
    ['my_workspace_team_grants', 'myWorkspaceTeamGrants', workspaceTeamGrants],
    ['my_workspace_invites', 'myWorkspaceInvites', workspaceInvites],
  ] as const;
  const rebuild = () => {
    if (stale()) return;
    for (const [, key, store] of tables) {
      // Each store corresponds to the same-named generated view.
      (store.set as (rows: unknown[]) => void)([...c.db[key].iter()]);
    }
    boardPermissions.set(new Map([...c.db.myBoardPermissions.iter()].map(row => [row.boardId, row])));
  };
  let queued = false;
  const sync = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; rebuild(); });
  };
  for (const table of [...tables.map(([, key]) => c.db[key]), c.db.myBoardPermissions]) {
    table.onInsert(sync);
    table.onUpdate(sync);
    table.onDelete(sync);
  }
  c.subscriptionBuilder()
    .onApplied(() => {
      if (stale()) return;
      rebuild();
      workspaceState.set('live');
    })
    .onError(() => {
      if (stale()) return;
      resetWorkspaces();
      workspaceState.set('unavailable');
    })
    .subscribe([...tables.map(([name]) => `SELECT * FROM ${name}`), 'SELECT * FROM my_board_permissions']);
  attachServiceAccounts(c, stale);
}

function attachServiceAccounts(c: import('../module_bindings').DbConnection, stale: () => boolean): void {
  if (!('myWorkspaceServiceAccounts' in c.db) || !('myWorkspaceApiKeys' in c.db)) {
    serviceAccountState.set('unavailable');
    return;
  }
  serviceAccountState.set('loading');
  const rebuild = () => {
    if (stale()) return;
    workspaceServiceAccounts.set([...c.db.myWorkspaceServiceAccounts.iter()]);
    workspaceApiKeys.set([...c.db.myWorkspaceApiKeys.iter()]);
  };
  for (const table of [c.db.myWorkspaceServiceAccounts, c.db.myWorkspaceApiKeys]) {
    table.onInsert(rebuild);
    table.onUpdate(rebuild);
    table.onDelete(rebuild);
  }
  // Separate from membership views so older servers can still serve workspaces.
  c.subscriptionBuilder()
    .onApplied(() => {
      if (stale()) return;
      rebuild();
      serviceAccountState.set('live');
    })
    .onError(() => {
      if (stale()) return;
      workspaceServiceAccounts.set([]);
      workspaceApiKeys.set([]);
      serviceAccountState.set('unavailable');
    })
    .subscribe(['SELECT * FROM my_workspace_service_accounts', 'SELECT * FROM my_workspace_api_keys']);
}

const INVITE_KEY = 'redcrayon:workspace-invite';
const validToken = (token: string) => /^[a-f0-9]{32}$/.test(token);
export function rememberInvite(token: string): void {
  if (!validToken(token)) return;
  try { sessionStorage.setItem(INVITE_KEY, token); } catch { /* URL remains the handoff when storage is blocked. */ }
}
export function pendingInvite(search: string): string {
  const token = new URLSearchParams(search).get('invite');
  if (token !== null) return validToken(token) ? token : '';
  try {
    const saved = sessionStorage.getItem(INVITE_KEY) ?? '';
    return validToken(saved) ? saved : '';
  } catch { return ''; }
}
export function clearInvite(): void {
  try { sessionStorage.removeItem(INVITE_KEY); } catch { /* No saved handoff. */ }
}
export function inviteHref(token: string, origin: string, database = ''): string {
  const url = new URL('/workspaces', origin);
  if (database) setDb(url, database, import.meta.env.VITE_SPACETIME_DB);
  url.searchParams.set('invite', token);
  return url.href;
}
/** The workspace a settings page shows: the one its link names, else personal, else the first. */
export const settingsWorkspace = (id: string, workspaces: Workspace[]): Workspace | undefined =>
  id ? workspaces.find(workspace => workspace.id.toString() === id) : workspaces.find(workspace => workspace.personal) ?? workspaces[0];
export const managesWorkspace = (workspace: Workspace) => workspace.role === 'owner' || workspace.role === 'admin';
export const memberLabel = (member: WorkspaceMember) => member.name || `Member ${member.member.toHexString().slice(-8)}`;
