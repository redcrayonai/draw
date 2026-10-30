import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';

async function workspaceSnapshot(page: Page) {
  return page.evaluate(async ({ workspaceModule, connectionModule }) => {
    const workspace = await import(workspaceModule);
    const connection = await import(connectionModule);
    const read = (store: { subscribe(cb: (value: any) => void): () => void }) => {
      let value: any;
      store.subscribe(next => { value = next; })();
      return value;
    };
    return {
      identity: read(connection.identityHex) as string,
      status: read(workspace.workspaceState) as string,
      workspaces: read(workspace.myWorkspaces).map((row: any) => ({ id: String(row.id), name: row.name })),
      members: read(workspace.workspaceMembers).map((row: any) => ({ workspaceId: String(row.workspaceId), name: row.name })),
      teams: read(workspace.workspaceTeams).map((row: any) => ({ workspaceId: String(row.workspaceId), name: row.name })),
      teamMembers: read(workspace.workspaceTeamMembers).map((row: any) => String(row.teamId)),
      boardGrants: read(workspace.workspaceBoardGrants).map((row: any) => String(row.boardId)),
      teamGrants: read(workspace.workspaceTeamGrants).map((row: any) => String(row.boardId)),
      invites: read(workspace.workspaceInvites).map((row: any) => row.token as string),
      permissions: [...read(workspace.boardPermissions).values()].map((row: any) => ({ boardId: String(row.boardId), role: row.role, canManage: row.canManage })),
      boards: read(connection.myBoards).map((row: any) => row.name as string),
      cachedAccounts: Object.keys(localStorage).filter(key => key.startsWith('dash_rows:')).length,
    };
  }, { workspaceModule: '/src/lib/workspaces.ts', connectionModule: '/src/lib/stdb.ts' });
}

async function switchAccount(page: Page, token: string) {
  await page.evaluate(value => {
    Object.assign(window, { __e2eAccountToken: value });
    window.dispatchEvent(new Event('e2e-account-change'));
  }, token);
}

test('workspace data and board management permissions stay isolated through account switches and sign-out', async ({ page, stack }) => {
  test.setTimeout(120_000);
  const dashboard = await stack.startDashboard();
  const alice = stack.accountToken(), bob = stack.accountToken(), colleague = stack.accountToken();
  await stack.callReducer(alice, 'create_workspace', ['Alice confidential workspace']);
  await stack.callReducer(alice, 'create_workspace', ['Shared workspace']);
  const existingPeople = new Set((await stack.sql('SELECT * FROM workspace WHERE personal = true')).map(row => String(row.id)));
  await stack.callReducer(bob, 'ensure_personal_workspace', []);
  const bobWorkspace = (await stack.sql('SELECT * FROM workspace WHERE personal = true')).find(row => !existingPeople.has(String(row.id)))!;
  existingPeople.add(String(bobWorkspace.id));
  await stack.callReducer(colleague, 'ensure_personal_workspace', []);
  await stack.callReducer(colleague, 'join_board', ['Confidential colleague', 'human']);
  const workspaces = await stack.sql('SELECT * FROM workspace');
  const privateWorkspace = workspaces.find(row => row.name === 'Alice confidential workspace')!;
  const sharedWorkspace = workspaces.find(row => row.name === 'Shared workspace')!;
  const colleagueWorkspace = workspaces.find(row => row.personal && !existingPeople.has(String(row.id)))!;
  await stack.callReducer(alice, 'set_workspace_member', [privateWorkspace.id, colleagueWorkspace.owner, 'member']);
  await stack.callReducer(alice, 'set_workspace_member', [sharedWorkspace.id, bobWorkspace.owner, 'member']);
  await stack.callReducer(alice, 'create_workspace_team', [privateWorkspace.id, 'Confidential platform team']);
  const team = (await stack.sql("SELECT * FROM workspace_team WHERE name = 'Confidential platform team'"))[0];
  await stack.callReducer(alice, 'set_workspace_team_member', [team.id, colleagueWorkspace.owner, true]);
  await stack.callReducer(alice, 'create_workspace_board', [privateWorkspace.id, 'Alice private architecture', 'identity-private']);
  await stack.callReducer(alice, 'create_workspace_board', [sharedWorkspace.id, 'Shared architecture', 'identity-shared']);
  const privateBoard = (await stack.sql("SELECT * FROM board WHERE name = 'Alice private architecture'"))[0];
  const sharedBoard = (await stack.sql("SELECT * FROM board WHERE name = 'Shared architecture'"))[0];
  await stack.callReducer(alice, 'create_node', [privateBoard.id, 'Confidential architecture contents', '', 0, 0, 160, 80, 'ink', false, ...Array(7).fill({ none: [] })]);
  await stack.callReducer(alice, 'set_workspace_board_team', [privateBoard.id, team.id, 'editor']);
  await stack.callReducer(alice, 'set_workspace_board_access', [sharedBoard.id, 'viewer']);
  const invitation = 'ac'.repeat(16);
  await stack.callReducer(alice, 'create_workspace_invite', [privateWorkspace.id, 0, 'member', invitation]);

  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(token => Object.assign(window, { __e2eAccountToken: token }), alice);
  await page.goto(`${dashboard}/workspaces/members?workspace=${privateWorkspace.id}`);
  await expect(page.getByRole('combobox', { name: 'Role for Confidential colleague', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /^Invitations/ }).click();
  await expect(page.getByLabel('Invitation link')).toHaveValue(new RegExp(invitation));
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await expect(page.locator('summary').filter({ hasText: 'Confidential platform team' })).toBeVisible();
  const aliceState = await workspaceSnapshot(page);
  expect(aliceState.permissions).toContainEqual({ boardId: String(sharedBoard.id), role: 'manager', canManage: true });
  expect(aliceState.teamMembers).toContain(String(team.id));
  expect(aliceState.teamGrants).toContain(String(privateBoard.id));

  // No document reload: exercise the same provider callback and mounted stores as a real account switch.
  await switchAccount(page, bob);
  await expect.poll(async () => (await workspaceSnapshot(page)).identity).not.toBe(aliceState.identity);
  await expect.poll(async () => (await workspaceSnapshot(page)).permissions).toContainEqual({ boardId: String(sharedBoard.id), role: 'viewer', canManage: false });
  await expect(page.getByRole('button', { name: /Alice confidential workspace/ })).toHaveCount(0);
  await expect(page.getByLabel('Invitation link')).toHaveCount(0);
  await expect(page.getByText('Confidential colleague', { exact: true })).toHaveCount(0);
  await expect(page.locator('summary').filter({ hasText: 'Confidential platform team' })).toHaveCount(0);
  const bobState = await workspaceSnapshot(page);
  expect(bobState.workspaces.some(row => row.id === String(privateWorkspace.id))).toBe(false);
  expect(bobState.members.some(row => row.workspaceId === String(privateWorkspace.id))).toBe(false);
  expect(bobState.teams).toEqual([]);
  expect(bobState.teamMembers).toEqual([]);
  expect(bobState.boardGrants).not.toContain(String(privateBoard.id));
  expect(bobState.teamGrants).toEqual([]);
  expect(bobState.invites).toEqual([]);
  expect(bobState.permissions.some(row => row.boardId === String(privateBoard.id))).toBe(false);
  await page.getByRole('link', { name: /^All boards/ }).click();
  await expect(page.getByRole('article').getByRole('link', { name: 'Shared architecture', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Details for Shared architecture', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rename Shared architecture', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Alice private architecture', exact: true })).toHaveCount(0);
  const privateCanvas = await page.context().newPage();
  await privateCanvas.addInitScript(token => Object.assign(window, { __e2eAccountToken: token }), bob);
  await privateCanvas.goto(`${stack.url}#b=${privateBoard.slug}`);
  await expect(privateCanvas.getByRole('heading', { name: 'This board is unavailable', exact: true })).toBeVisible();
  await expect(privateCanvas.locator('#world')).not.toContainText('Confidential architecture contents');
  await privateCanvas.close();

  // Updates to Alice's old subscription cannot repopulate Bob's stores.
  await stack.callReducer(alice, 'rename_workspace_team', [team.id, 'Confidential renamed platform']);
  await expect.poll(async () => (await workspaceSnapshot(page)).teams).toEqual([]);
  await switchAccount(page, alice);
  await page.getByRole('button', { name: 'Details for Shared architecture', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rename Shared architecture', exact: true })).toBeVisible();
  await page.goto(`${dashboard}/workspaces/members?workspace=${privateWorkspace.id}&tab=invitations`);
  await expect(page.getByLabel('Invitation link')).toHaveValue(new RegExp(invitation));
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await expect(page.locator('summary').filter({ hasText: 'Confidential renamed platform' })).toBeVisible();
  expect((await workspaceSnapshot(page)).cachedAccounts).toBeGreaterThan(0);

  await page.getByRole('link', { name: 'Account settings', exact: true }).click();
  await page.getByRole('button', { name: 'sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'sign in to continue', exact: true })).toBeVisible();
  expect(await workspaceSnapshot(page)).toEqual({
    identity: '', status: 'idle', workspaces: [], members: [], teams: [], teamMembers: [], boardGrants: [], teamGrants: [], invites: [], permissions: [], boards: [], cachedAccounts: 0,
  });
  expect(errors).toEqual([]);
});
