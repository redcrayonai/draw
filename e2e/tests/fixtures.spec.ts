import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, signIn, signOut, signInOnRequest, providerDown, boardIdOf } from '../fixtures';

// Self-checks for the harness the specs build on (fixtures.ts, stack.ts, auth-provider.mjs).
const signedInAs = (page: Page) => expect(page.locator('#account-name')).toHaveText('Test account');
async function guestHeader(page: Page) {
  await expect(page.locator('#sign-in')).toBeEnabled();
  await expect(page.locator('#account-name')).toHaveCount(0);
}

test('signIn, signOut and a requested sign-in drive the canvas and survive reloads', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await expect(page.locator('#act-connect')).toHaveCount(0); // the default build has no VITE_MCP_URL
  await page.locator('#sign-in').click(); // nothing queued: a cancelled sign-in
  await guestHeader(page);
  signInOnRequest(page, stack.accountToken());
  await page.locator('#sign-in').click();
  await signedInAs(page);
  await page.reload();
  await signedInAs(page);
  await signOut(page); // onSignedOut: the canvas leaves for the guest board
  await guestHeader(page);
  await page.reload();
  await guestHeader(page);
  await signIn(page, stack.accountToken());
  await openBoard(page, `${stack.url}?new=1`);
  await signedInAs(page);
});

test('signIn reaches an open page without reloading it', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await page.evaluate(() => { (window as any).__sameDocument = true; });
  await signIn(page, stack.accountToken());
  // A write on this guest board's connection is a server round trip: a reload from signIn would have landed by now.
  await drawNode(page, 'after sign-in');
  expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true);
  await guestHeader(page);
});

test('providerDown: a guest board while it is down, Sign in once it is back', async ({ guest, stack }) => {
  const page = await guest();
  providerDown(page, true);
  await openBoard(page, stack.url);
  await expect(page.locator('#error-text')).toContainText('Sign-in is temporarily unavailable');
  await page.locator('#sign-in').click();
  await expect(page.locator('#error-text')).toContainText('Sign-in is unavailable');
  providerDown(page, false);
  signInOnRequest(page, stack.accountToken());
  await page.locator('#sign-in').click();
  await signedInAs(page);
});

test('stack: claim overrides meet the issuer rule, a service identity, republish keeps a drawing, boardIdOf', async ({ account, stack }) => {
  const join = (token: string) => stack.callReducer(token, 'join_board', ['e2e', 'human']);
  await join(stack.accountToken());
  await expect(join(stack.accountToken({ azp: 'https://elsewhere.example' }))).rejects.toThrow(/issuer rule/);
  await expect(join(stack.accountToken({ azp: undefined, aud: 'e2e-client' }))).rejects.toThrow(/issuer rule/);
  const service = await stack.serviceIdentity('e2e-fixtures');
  await stack.callReducer(service.token, 'backfill_board_slugs', []);
  await expect(stack.callReducer(stack.accountToken(), 'backfill_board_slugs', [])).rejects.toThrow();

  const page = await account();
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'kept');
  const id = await page.locator('#world g.node').first().getAttribute('data-id');
  const [{ board_id: boardId }] = await stack.sql(`SELECT board_id FROM node WHERE id = ${id}`);
  expect(await boardIdOf(stack, page)).toBe(Number(boardId));
  await stack.republish();
  await page.reload();
  await expect(page.locator('#world')).toContainText('kept');
});
