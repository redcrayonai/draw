import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, shareBoard, signInOnRequest, providerDown, boardIdOf, type Stack } from '../fixtures';

// Investor-demo resilience: the sign-in provider is unreachable (initAuth rejects).
const OUTAGE = 'Sign-in is temporarily unavailable. Your guest drawing is still available; use Sign in to retry.';
const RETRY_FAILED = 'Sign-in is unavailable. Your drawing is still saved in this browser. Please try again.';
const TROUBLE = 'We’re having trouble connecting. Retrying in';
const NONE = { none: [] };

const identityOf = (page: Page) => page.evaluate(() => (window as any).myIdentityHex as string | undefined);
const storageKeys = (page: Page, storage: 'localStorage' | 'sessionStorage') => page.evaluate(name => Object.keys(window[name]), storage);
const guestBoards = async (stack: Stack) => (await stack.sql('SELECT identity FROM guest_board')).length;

/** The recovery panel instead of a board: never booted, never an anonymous identity. */
async function heldOnRecovery(page: Page) {
  await expect(page.locator('#reconnect')).toContainText(TROUBLE);
  await expect(page.getByRole('button', { name: 'Retry now' })).toBeVisible();
  await expect(page.locator('#live')).toHaveText('Offline');
  await expect(page.locator('#error-strip')).toBeHidden();
  await expect(page.locator('#sign-in')).toHaveCount(0);
  // toPass: the backoff reload can land mid-evaluate.
  await expect(async () => {
    expect(await identityOf(page)).toBeUndefined();
    expect((await storageKeys(page, 'localStorage')).some(key => key.startsWith('stdb_token:'))).toBe(false);
  }).toPass({ timeout: 10_000 });
}

test('a fresh visitor gets a private guest board during an outage, and it persists through recovery', async ({ guest, stack }) => {
  const page = await guest();
  providerDown(page, true);
  await openBoard(page, stack.url);
  await expect(page.locator('#error-text')).toHaveText(OUTAGE);
  await drawNode(page, 'Outage service');
  expect(new URL(page.url()).hash).toMatch(/^#b=[0-9a-f]{20}$/);
  const boardUrl = page.url();
  await expect(page.locator('#sign-in')).toBeVisible();
  await expect(page.locator('#account-bar')).toHaveCount(0);
  await expect(page.locator('#access-line')).toHaveText('private');
  // SERVER: the board on screen is this anonymous identity's guest board.
  const guestHex = (await identityOf(page))!;
  const B = await boardIdOf(stack, page);
  expect((await stack.sql(`SELECT board_id FROM guest_board WHERE identity = 0x${guestHex}`)).map(row => Number(row.board_id))).toEqual([B]);

  await page.reload();
  await expect(page.locator('#world')).toContainText('Outage service');
  await expect(page.locator('#error-text')).toHaveText(OUTAGE);
  await openBoard(page, stack.url);
  await expect(page).toHaveURL(boardUrl);
  await expect(page.locator('#world')).toContainText('Outage service');
  await expect(page.locator('#error-text')).toHaveText(OUTAGE);

  providerDown(page, false);
  await page.reload();
  await expect(page.locator('#world')).toContainText('Outage service');
  await expect(page.locator('#error-strip')).toBeHidden();
  await expect(page).toHaveURL(boardUrl);
  await expect(page.locator('#sign-in')).toBeVisible();
  expect(await identityOf(page)).toBe(guestHex);
});

test('a returning guest keeps the same board and identity during an outage', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'Before outage');
  const boardUrl = page.url();
  const id = await identityOf(page);
  expect(id).toMatch(/^[0-9a-f]{64}$/);

  providerDown(page, true);
  await openBoard(page, stack.url);
  await expect(page).toHaveURL(boardUrl);
  await expect(page.locator('#world')).toContainText('Before outage');
  expect(await identityOf(page)).toBe(id);
  await expect(page.locator('#error-text')).toHaveText(OUTAGE);
});

test('a signed-out provider cookie still gets a guest board during an outage', async ({ guest, stack }) => {
  const page = await guest();
  await page.context().addCookies([{ name: '__client_uat', value: '0', url: stack.url }]);
  providerDown(page, true);
  await openBoard(page, stack.url);
  expect(await page.evaluate(() => document.cookie)).toContain('__client_uat=0');
  await expect(page.locator('#error-text')).toHaveText(OUTAGE);
  await drawNode(page, 'Still a guest');
  expect(new URL(page.url()).hash).toMatch(/^#b=[0-9a-f]{20}$/);
});

test('a known account never becomes a guest during an outage, and recovers signed in', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const page = await account();
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'Account service');
  await expect(page.locator('#account-name')).toHaveText('Test account');
  expect(await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('account_seen:'))?.[1] ?? null)).toBe('1');
  const boardUrl = page.url();
  const before = await guestBoards(stack);

  // A bare root visit is where a silent guest fallback would make a guest board.
  providerDown(page, true);
  await page.goto(stack.url);
  await expect(page.locator('#reconnect')).toContainText(`${TROUBLE} 1s`);
  await heldOnRecovery(page);
  await expect(page.locator('#reconnect')).toContainText(`${TROUBLE} 2s`); // one backoff reload later
  expect(await guestBoards(stack)).toBe(before);
  await page.close();

  // A new tab starts its own backoff (the counter is per tab) on the board link.
  const tab = await page.context().newPage();
  await tab.goto(boardUrl);
  const panel = tab.locator('#reconnect');
  await expect(panel).toContainText(`${TROUBLE} 1s`);
  await expect(panel).toContainText(`${TROUBLE} 2s`);
  // The 4 s wait leaves room to click Retry now before the automatic reload.
  await expect(panel).toContainText(`${TROUBLE} 4s`);
  await heldOnRecovery(tab);
  providerDown(tab, false);
  await tab.getByRole('button', { name: 'Retry now' }).click();
  await expect(tab.locator('#account-name')).toHaveText('Test account');
  await expect(tab.locator('#world')).toContainText('Account service');
  await expect(panel).toHaveCount(0);
  await expect(tab).toHaveURL(boardUrl);
  expect(await guestBoards(stack)).toBe(before);
});

test('a session cookie or a provider callback route blocks the guest fallback', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const before = await guestBoards(stack);
  for (const [name, value] of [['__session', 'e2e'], ['__session_abc', 'e2e'], ['__client_uat', '1760000000']]) {
    const page = await guest();
    await page.context().addCookies([{ name, value, url: stack.url }]);
    providerDown(page, true);
    await page.goto(stack.url);
    await heldOnRecovery(page);
    await page.close();
  }

  // A provider route keeps its URL for the provider's router instead of becoming a guest board.
  const callback = await guest();
  providerDown(callback, true);
  await callback.goto(`${stack.url}#/sso-callback`);
  await heldOnRecovery(callback);
  await expect(callback.locator('#reconnect')).toContainText(`${TROUBLE} 2s`); // one backoff reload later
  await expect(callback).toHaveURL(/#\/sso-callback$/);
  expect(await guestBoards(stack)).toBe(before);
});

test('sign-in during an outage fails gently, and a later sign-in keeps the drawing', async ({ guest, stack }) => {
  const page = await guest();
  providerDown(page, true);
  await openBoard(page, stack.url);
  await drawNode(page, 'Outage draft');
  const boardUrl = page.url();
  const guestHex = (await identityOf(page))!;
  const B = await boardIdOf(stack, page);
  const grantOf = (hex: string) => stack.sql(`SELECT role FROM board_grant WHERE board_id = ${B} AND grantee = 0x${hex}`);
  expect(await grantOf(guestHex)).toEqual([{ role: 'owner' }]);

  // A reload would drop this marker.
  await page.evaluate(() => { (window as any).__samePage = true; });
  await page.locator('#sign-in').click();
  await expect(page.locator('#error-text')).toHaveText(RETRY_FAILED);
  expect(await page.evaluate(() => (window as any).__samePage)).toBe(true);
  await expect(page.locator('#sign-in')).toBeEnabled();
  await expect(page).toHaveURL(boardUrl);
  await expect(page.locator('#world')).toContainText('Outage draft');
  expect((await storageKeys(page, 'sessionStorage')).some(key => key.startsWith('guest_claim:'))).toBe(false);
  expect(await stack.sql(`SELECT code FROM guest_claim_offer WHERE board_id = ${B}`)).toEqual([]);

  providerDown(page, false);
  signInOnRequest(page, stack.accountToken());
  await page.locator('#sign-in').click();
  await expect(page.locator('#account-name')).toHaveText('Test account');
  await expect(page).toHaveURL(boardUrl);
  await expect(page.locator('#world')).toContainText('Outage draft');
  const accountHex = (await identityOf(page))!;
  expect(accountHex).not.toBe(guestHex);
  // The account now owns the board, and the outage guest holds nothing on it.
  expect(await grantOf(accountHex)).toEqual([{ role: 'owner' }]);
  expect(await grantOf(guestHex)).toEqual([]);
});

test('during an outage a share link still opens with its permissions', async ({ guest, stack }) => {
  const owner = await guest();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Owner service');
  const B = await boardIdOf(stack, owner);
  const link = await shareBoard(owner, 'edit');

  const recipient = await guest();
  providerDown(recipient, true);
  await openBoard(recipient, link);
  await expect(recipient.locator('#world')).toContainText('Owner service');
  await expect(recipient.locator('#error-text')).toHaveText(OUTAGE);
  await expect(recipient.locator('#access-line')).toHaveText('link sharing on · signed-in people with the link can edit');
  // An edit link lets only signed-in people edit, outage or not: the guest's own token is refused.
  const anonymous = await recipient.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('stdb_token:'))?.[1]);
  expect(anonymous).toBeTruthy();
  await expect(stack.callReducer(anonymous!, 'create_node', [B, 'Guest write', '', 300, 600, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]))
    .rejects.toThrow('not authorized: board is read only');

  const button = recipient.getByRole('button', { name: 'sign in to edit', exact: true });
  await button.click();
  await expect(recipient.locator('#error-text')).toHaveText(RETRY_FAILED);
  await expect(button).toBeEnabled();
  await expect(recipient).toHaveURL(link);
  await expect(recipient.locator('#world')).toContainText('Owner service');

  // The same link as a view link, opened fresh during the outage.
  await owner.getByRole('button', { name: 'Can view', exact: true }).click();
  await expect(owner.locator('#access-line')).toHaveText('link sharing on · anyone with the link can view');
  await recipient.reload();
  await expect(recipient.locator('#world')).toContainText('Owner service');
  await expect(recipient.locator('#error-text')).toHaveText(OUTAGE);
  await expect(recipient.locator('#access-line')).toHaveText('link sharing on · anyone with the link can view');
  await expect(recipient.locator('#sign-in')).toHaveText('sign in');
  await expect(stack.callReducer(anonymous!, 'create_node', [B, 'Guest write', '', 300, 600, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]))
    .rejects.toThrow('not authorized: board is read only');
});
