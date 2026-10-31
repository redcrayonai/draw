import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const contextDirectory = fileURLToPath(new URL('../../.context/', import.meta.url));
async function screenshot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: `${contextDirectory}${name}.png`, fullPage: true });
}

// Uses the existing signed-in fixture without any provider organization API.
test('native workspaces manage teams, one-use invitations, board destinations, and live permissions', async ({ account, stack }) => {
  test.setTimeout(120_000);
  const dashboard = await stack.startDashboard();
  const owner = await account();
  const member = await account();
  const errors: string[] = [];
  owner.on('pageerror', error => errors.push(error.message));
  member.on('pageerror', error => errors.push(error.message));
  await owner.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await owner.goto(`${dashboard}/workspaces/new`);
  await expect(owner.getByLabel('New workspace name')).toBeEnabled();
  await owner.getByLabel('New workspace name').fill('Acme Architecture');
  await owner.getByRole('button', { name: 'create workspace', exact: true }).click();
  await expect(owner.getByText('Workspace created.', { exact: false })).toBeVisible();
  const workspace = (await stack.sql("SELECT * FROM workspace WHERE name = 'Acme Architecture'"))[0];
  await owner.goto(`${dashboard}/workspaces/members?workspace=${workspace.id}`);
  await owner.getByRole('tab', { name: /^Teams/ }).click();
  await owner.getByLabel('Team name', { exact: true }).fill('Platform');
  await owner.getByRole('button', { name: 'create team', exact: true }).click();
  await expect(owner.locator('summary').filter({ hasText: 'Platform' })).toBeVisible();
  await owner.getByRole('tab', { name: /^Invitations/ }).click();
  await owner.getByRole('button', { name: 'create invitation', exact: true }).click();
  await expect(owner.getByLabel('Invitation link')).toBeVisible();
  await owner.getByRole('button', { name: 'copy invitation', exact: true }).click();
  await expect(owner.getByRole('button', { name: 'copied', exact: true })).toBeVisible();
  const invitation = await owner.getByLabel('Invitation link').inputValue();
  await screenshot(owner, 'workspaces-desktop');
  await member.goto(invitation);
  await expect(member.getByText('Invitation accepted.', { exact: false })).toBeVisible();
  await expect(owner.getByRole('button', { name: 'revoke invitation', exact: true })).toHaveCount(0);
  // A consumed invitation cannot admit a different account.
  const stranger = await account();
  await stranger.goto(invitation);
  await expect(stranger.getByRole('alert')).toContainText(/invitation/i);
  await expect(stranger.getByText('Acme Architecture')).toHaveCount(0);

  await owner.goto(`${dashboard}/dashboard?workspace=${workspace.id}`);
  await owner.getByRole('button', { name: 'new board', exact: true }).first().click();
  await expect(owner.getByRole('combobox', { name: 'Owner', exact: true })).toHaveValue(`workspace:${workspace.id}`);
  await owner.getByLabel('Name', { exact: true }).fill('System overview');
  await owner.getByRole('button', { name: 'create', exact: true }).click();
  await owner.waitForURL(url => url.origin === new URL(stack.url).origin && url.hash.startsWith('#b='));
  const boardUrl = owner.url();
  await owner.goto(`${dashboard}/dashboard`);
  // A tile opens the board's details in the inspector beside the gallery.
  const card = owner.getByTestId('board-card').filter({ hasText: 'System overview' });
  await owner.getByRole('button', { name: 'Details for System overview', exact: true }).click();
  await card.locator('summary').filter({ hasText: 'Access · Acme Architecture' }).click();
  await card.getByRole('combobox', { name: 'Workspace members', exact: true }).selectOption('viewer');
  await expect(card.getByRole('combobox', { name: 'Workspace members', exact: true })).toHaveValue('viewer');
  await screenshot(owner, 'board-workspace-access');
  await member.goto(`${dashboard}/dashboard`);
  await expect(member.getByRole('article').getByRole('link', { name: 'System overview', exact: true })).toBeVisible();
  await expect(member.getByRole('button', { name: 'Rename System overview' })).toHaveCount(0);
  await member.getByRole('article').getByRole('link', { name: 'System overview', exact: true }).click();
  await expect(member.locator('#board-title')).toContainText('view only');

  // Editing is granted by team membership and revoked on the open canvas.
  await owner.goto(`${dashboard}/workspaces/members?workspace=${workspace.id}&tab=teams`);
  await owner.locator('summary').filter({ hasText: 'Platform' }).click();
  await owner.getByRole('checkbox', { name: 'Test account', exact: true }).last().check();
  await owner.goto(`${dashboard}/dashboard?workspace=${workspace.id}`);
  await owner.getByRole('button', { name: 'Details for System overview', exact: true }).click();
  await card.locator('summary').filter({ hasText: 'Access · Acme Architecture' }).click();
  await card.getByRole('combobox', { name: 'Board role for team Platform', exact: true }).selectOption('editor');
  await expect(member.locator('#board-title')).toHaveText('System overview');
  await card.getByRole('combobox', { name: 'Board role for team Platform', exact: true }).selectOption('');
  await expect(member.locator('#board-title')).toContainText('view only');
  await card.getByRole('combobox', { name: 'Workspace members', exact: true }).selectOption('none');
  await expect(member.getByRole('heading', { name: 'This board is unavailable', exact: true })).toBeVisible();

  // A board-scoped invitation grants guest access without membership in the team.
  await card.locator('summary').filter({ hasText: 'Invite someone to this board' }).click();
  await card.getByRole('button', { name: 'create invitation', exact: true }).click();
  const boardInvitation = await card.getByLabel('Invitation link').inputValue();
  await stranger.goto(boardInvitation);
  await expect(stranger.getByText('Invitation accepted.', { exact: false })).toBeVisible();
  await stranger.goto(boardUrl);
  await expect(stranger.locator('#board-title')).toContainText('view only');

  // Explicit moves retain URLs, reset access, and require acknowledgement.
  await card.locator('summary').filter({ hasText: /^Move board$/ }).click();
  const personal = (await stack.sql('SELECT * FROM workspace WHERE personal = true')).find(row => JSON.stringify(row.owner) === JSON.stringify(workspace.owner));
  expect(personal).toBeDefined();
  await card.getByRole('combobox', { name: 'Destination workspace', exact: true }).selectOption(String(personal!.id));
  await expect(card.getByRole('button', { name: 'move board', exact: true })).toBeDisabled();
  await card.getByRole('checkbox', { name: 'I understand that existing access grants will be reset.' }).check();
  await card.getByRole('button', { name: 'move board', exact: true }).click();
  await expect(stranger.getByRole('heading', { name: 'This board is unavailable', exact: true })).toBeVisible();
  await owner.goto(boardUrl);
  await expect(owner.locator('#board-title')).toHaveText('System overview');

  await owner.goto(`${dashboard}/workspaces/members?workspace=${workspace.id}`);
  await owner.setViewportSize({ width: 375, height: 900 });
  // A closed menu is out of the tab order and the accessibility tree, not just off screen.
  const allBoards = owner.getByRole('link', { name: /^All boards/, includeHidden: true });
  await expect(allBoards).toBeHidden();
  await owner.getByRole('button', { name: 'Open navigation' }).click();
  await expect(allBoards).toBeVisible();
  await owner.getByRole('button', { name: 'Close navigation' }).click({ position: { x: 355, y: 450 } }); // the dimmed strip beside the open drawer
  await expect(allBoards).toBeHidden();
  await screenshot(owner, 'workspaces-mobile');
  expect(await owner.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});

test('the real generic OIDC adapter signs in with PKCE and preserves a workspace invitation', async ({ page, stack }) => {
  test.setTimeout(120_000);
  const dashboard = await stack.startDashboard('oidc');
  const ownerToken = stack.accountToken();
  await stack.callReducer(ownerToken, 'create_workspace', ['OIDC Client']);
  const workspace = (await stack.sql("SELECT * FROM workspace WHERE name = 'OIDC Client'"))[0];
  const token = 'ab'.repeat(16);
  await stack.callReducer(ownerToken, 'create_workspace_invite', [workspace.id, 0, 'member', token]);
  await page.goto(`${dashboard}/workspaces?invite=${token}`);
  await page.locator('#auth-gate').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Invitation accepted.', { exact: false })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: /OIDC Client/ })).toHaveCount(1);
  await expect.poll(() => stack.oidcExchanges()).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('New workspace name').fill('OIDC Architecture');
  await page.getByRole('button', { name: 'create workspace', exact: true }).click();
  await expect(page.getByText('Workspace created.', { exact: false })).toBeVisible();
  await expect.poll(async () => (await stack.sql("SELECT * FROM workspace WHERE name = 'OIDC Architecture'" )).length).toBe(1);
  await page.getByRole('link', { name: /^All boards/ }).click();
  await page.getByRole('button', { name: 'new board', exact: true }).first().click();
  const personal = await page.getByRole('combobox', { name: 'Owner', exact: true }).inputValue();
  expect(personal).toMatch(/^workspace:\d+$/);
  const destinationId = personal.slice('workspace:'.length);
  const destination = (await stack.sql(`SELECT * FROM workspace WHERE id = ${destinationId}`))[0];
  expect(destination.personal).toBe(true);
  await screenshot(page, 'workspaces-generic-oidc');
});
