import type { BrowserContext } from '@playwright/test';
import { test, expect, openBoard, drawNode } from '../fixtures';
import type { withStack } from '../stack';
import { identityFromClaims } from '../../shared/identity';

type Stack = Parameters<Parameters<typeof withStack>[0]>[0];
const identity = (token: string) => {
  const { iss, sub } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  return identityFromClaims(iss, sub);
};
const principal = (token: string) => ({ __identity__: `0x${identity(token)}` });
async function signIn(context: BrowserContext, token: string) {
  await context.addInitScript(value => { Object.assign(window, { __e2eAccountToken: value }); }, token);
  return context.newPage();
}
async function board(stack: Stack, token: string, workspaceId: unknown, name: string) {
  await stack.callReducer(token, 'create_workspace_board', [workspaceId, name, `membership-${name}`]);
  const [row] = await stack.sql(`SELECT * FROM board WHERE name = '${name}'`);
  return row as { id: number; slug: string };
}
function createNode(stack: Stack, token: string, boardId: number) {
  const none = { none: [] };
  return stack.callReducer(token, 'create_node', [boardId, 'unauthorized', '', 0, 0, 160, 80, 'ink', false, none, none, none, none, none, none, none]);
}

test('member demotion preserves direct board roles, removes inherited access live, and removal revokes the remaining boards', async ({ browser, context, stack }) => {
  test.setTimeout(120_000);
  const dashboard = await stack.startDashboard();
  const ownerToken = stack.accountToken();
  const memberToken = stack.accountToken();
  const owner = await signIn(context, ownerToken);
  const memberContext = await browser.newContext();
  try {
    const memberDashboard = await signIn(memberContext, memberToken);
    await stack.callReducer(ownerToken, 'create_workspace', ['Membership transitions']);
    await stack.callReducer(memberToken, 'ensure_personal_workspace', []);
    const [workspace] = await stack.sql("SELECT * FROM workspace WHERE name = 'Membership transitions'");
    await stack.callReducer(ownerToken, 'set_workspace_member', [workspace.id, principal(memberToken), 'member']);
    await stack.callReducer(ownerToken, 'create_workspace_team', [workspace.id, 'Membership platform']);
    const [team] = await stack.sql("SELECT * FROM workspace_team WHERE name = 'Membership platform'");
    await stack.callReducer(ownerToken, 'set_workspace_team_member', [team.id, principal(memberToken), true]);
    const editorBoard = await board(stack, ownerToken, workspace.id, 'Explicit editor');
    const managerBoard = await board(stack, ownerToken, workspace.id, 'Explicit manager');
    const teamBoard = await board(stack, ownerToken, workspace.id, 'Team editor');
    const workspaceBoard = await board(stack, ownerToken, workspace.id, 'Workspace editor');
    await stack.callReducer(ownerToken, 'set_workspace_board_member', [editorBoard.id, principal(memberToken), 'editor']);
    await stack.callReducer(ownerToken, 'set_workspace_board_member', [managerBoard.id, principal(memberToken), 'manager']);
    await stack.callReducer(ownerToken, 'set_workspace_board_team', [teamBoard.id, team.id, 'editor']);
    await stack.callReducer(ownerToken, 'set_workspace_board_access', [workspaceBoard.id, 'editor']);

    const [editor, manager, teamCanvas, workspaceCanvas] = await Promise.all(
      [editorBoard, managerBoard, teamBoard, workspaceBoard].map(async row => {
        const page = await memberContext.newPage();
        await openBoard(page, `${stack.url}#b=${row.slug}`);
        await expect(page.locator('.add-row[data-kind="service"]')).toBeEnabled();
        return page;
      }),
    );
    await expect(editor.locator('#act-share')).toBeHidden();
    await expect(manager.locator('#act-share')).toBeVisible();
    await expect(stack.callReducer(memberToken, 'set_workspace_board_access', [editorBoard.id, 'editor'])).rejects.toThrow(/only a board manager/);
    await memberDashboard.goto(`${dashboard}/dashboard`);
    const managedCard = memberDashboard.getByTestId('board-card').filter({ hasText: 'Explicit manager' });
    await memberDashboard.getByRole('button', { name: 'Details for Explicit manager', exact: true }).click();
    await expect(managedCard.getByRole('button', { name: 'Rename Explicit manager' })).toBeVisible();
    await expect(managedCard.locator('summary').filter({ hasText: 'Access · Membership transitions' })).toBeVisible();

    await owner.goto(`${dashboard}/workspaces/members?workspace=${workspace.id}`);
    const memberRole = owner.getByRole('combobox', { name: /^Role for / }).last();
    await expect(memberRole).toHaveValue('member');
    await memberRole.selectOption('guest');
    await expect(memberRole).toHaveValue('guest');

    for (const page of [teamCanvas, workspaceCanvas]) {
      await expect(page.getByRole('heading', { name: 'This board is unavailable', exact: true })).toBeVisible();
      await expect(page.locator('#act-share')).toBeHidden();
    }
    await expect(editor.locator('#board-title')).toHaveText('Explicit editor');
    await expect(manager.locator('#board-title')).toHaveText('Explicit manager');
    await expect(manager.locator('#act-share')).toBeVisible();
    await drawNode(editor, 'Editor');
    await drawNode(manager, 'Manager');
    await stack.callReducer(memberToken, 'set_workspace_board_access', [managerBoard.id, 'viewer']);
    await expect(createNode(stack, memberToken, teamBoard.id)).rejects.toThrow(/not authorized/);
    await expect(createNode(stack, memberToken, workspaceBoard.id)).rejects.toThrow(/not authorized/);
    await expect(stack.callReducer(memberToken, 'create_workspace_team', [workspace.id, 'Escalation'])).rejects.toThrow(/only a workspace administrator/);
    expect(await stack.sql(`SELECT * FROM workspace_team_member WHERE team_id = ${team.id}`)).toHaveLength(0);
    await expect(managedCard.getByRole('button', { name: 'Rename Explicit manager' })).toBeVisible();

    // Full removal must clear direct grants too, without either canvas reloading.
    await manager.locator('#act-share').click();
    await expect(manager.locator('#share-pop')).toBeVisible();
    await owner.getByRole('button', { name: /^remove / }).click();
    await expect(createNode(stack, memberToken, editorBoard.id)).rejects.toThrow(/not authorized/);
    await expect(stack.callReducer(memberToken, 'set_workspace_board_access', [managerBoard.id, 'editor'])).rejects.toThrow(/only a board manager/);
    for (const page of [editor, manager]) {
      await expect(page.getByRole('heading', { name: 'This board is unavailable', exact: true })).toBeVisible();
      await expect(page.locator('#act-share')).toBeHidden();
      await expect(page.locator('#share-pop')).toBeHidden();
      await expect(page.locator('#act-share')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#board-title')).not.toHaveClass(/renamable/);
    }
    await expect(managedCard).toHaveCount(0);
    await expect(memberDashboard.getByRole('button', { name: 'Details for Explicit manager', exact: true })).toHaveCount(0);
    await expect(memberDashboard.getByRole('button', { name: 'Details for Explicit editor', exact: true })).toHaveCount(0);
    const grants = await stack.sql(`SELECT * FROM workspace_board_grant WHERE board_id = ${editorBoard.id} OR board_id = ${managerBoard.id}`);
    expect(grants.some(grant => JSON.stringify(grant.member).includes(identity(memberToken)))).toBe(false);
  } finally {
    await memberContext.close();
  }
});

test('a guest board manager can revoke existing collaborators and team grants without listing workspace rosters', async ({ browser, context, stack }) => {
  test.setTimeout(120_000);
  const dashboard = await stack.startDashboard();
  const ownerToken = stack.accountToken();
  const managerToken = stack.accountToken();
  const collaboratorToken = stack.accountToken();
  const hiddenMemberToken = stack.accountToken();
  await stack.callReducer(ownerToken, 'create_workspace', ['Private client roster']);
  const [workspace] = await stack.sql("SELECT * FROM workspace WHERE name = 'Private client roster'");
  await stack.callReducer(hiddenMemberToken, 'ensure_personal_workspace', []);
  await stack.callReducer(ownerToken, 'set_workspace_member', [workspace.id, principal(hiddenMemberToken), 'member']);
  const managed = await board(stack, ownerToken, workspace.id, 'Client guest management');
  const unshared = await board(stack, ownerToken, workspace.id, 'Private internal board');
  await stack.callReducer(ownerToken, 'create_workspace_team', [workspace.id, 'Confidential platform']);
  await stack.callReducer(ownerToken, 'create_workspace_team', [workspace.id, 'Unrelated secret team']);
  const [team] = await stack.sql("SELECT * FROM workspace_team WHERE name = 'Confidential platform'");
  await stack.callReducer(ownerToken, 'set_workspace_board_team', [managed.id, team.id, 'editor']);
  await stack.callReducer(ownerToken, 'create_workspace_invite', [workspace.id, managed.id, 'manager', 'ca'.repeat(16)]);
  await stack.callReducer(managerToken, 'accept_workspace_invite', ['ca'.repeat(16)]);
  await stack.callReducer(ownerToken, 'create_workspace_invite', [workspace.id, managed.id, 'viewer', 'cb'.repeat(16)]);
  await stack.callReducer(collaboratorToken, 'accept_workspace_invite', ['cb'.repeat(16)]);

  const manager = await signIn(context, managerToken);
  const collaboratorContext = await browser.newContext();
  try {
    const collaborator = await signIn(collaboratorContext, collaboratorToken);
    await openBoard(collaborator, `${stack.url}#b=${managed.slug}`);
    await expect(collaborator.locator('#board-title')).toContainText('view only');
    await manager.goto(`${dashboard}/workspaces/members?workspace=${workspace.id}`);
    const members = manager.getByRole('region', { name: 'Members', exact: true });
    await expect(members.locator('tbody tr')).toHaveCount(1);
    await expect(members).toContainText('(you)');
    await expect(manager.getByText('Confidential platform', { exact: true })).toHaveCount(0);
    await expect(manager.getByText('Unrelated secret team', { exact: true })).toHaveCount(0);
    await expect(manager.getByRole('button', { name: 'create team', exact: true })).toHaveCount(0);
    await expect(stack.callReducer(managerToken, 'set_workspace_member', [workspace.id, principal(hiddenMemberToken), 'guest'])).rejects.toThrow(/only a workspace administrator/);
    await expect(stack.callReducer(managerToken, 'set_workspace_board_access', [unshared.id, 'editor'])).rejects.toThrow(/only a board manager/);

    await manager.goto(`${dashboard}/dashboard`);
    await expect(manager.getByRole('article').getByRole('link', { name: 'Client guest management', exact: true })).toBeVisible();
    await expect(manager.getByRole('link', { name: 'Private internal board', exact: true })).toHaveCount(0);
    const card = manager.getByTestId('board-card').filter({ hasText: 'Client guest management' });
    await manager.getByRole('button', { name: 'Details for Client guest management', exact: true }).click();
    await card.locator('summary').filter({ hasText: 'Access · Private client roster' }).click();
    await expect(card.getByRole('combobox', { name: `Board role for Member ${identity(hiddenMemberToken).slice(-8)}`, exact: true })).toHaveCount(0);
    await expect(card.getByRole('combobox', { name: 'Board role for team Confidential platform', exact: true })).toHaveCount(0);
    const collaboratorRole = card.getByRole('combobox', { name: `Board role for Member ${identity(collaboratorToken).slice(-8)}`, exact: true });
    await expect(collaboratorRole).toHaveValue('viewer');
    await collaboratorRole.selectOption('');
    await expect(collaboratorRole).toHaveCount(0);
    await expect(collaborator.getByRole('heading', { name: 'This board is unavailable', exact: true })).toBeVisible();
    await expect(createNode(stack, collaboratorToken, managed.id)).rejects.toThrow(/not authorized/);

    const teamRole = card.getByRole('combobox', { name: `Board role for team Team ${team.id}`, exact: true });
    await expect(teamRole).toHaveValue('editor');
    await teamRole.selectOption('');
    await expect(teamRole).toHaveCount(0);
    expect(await stack.sql(`SELECT * FROM workspace_team_grant WHERE board_id = ${managed.id}`)).toHaveLength(0);
    await expect(card.getByRole('button', { name: 'Rename Client guest management' })).toBeVisible();
  } finally {
    await collaboratorContext.close();
  }
});
