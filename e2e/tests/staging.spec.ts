import { test as base, expect, type BrowserContext } from '@playwright/test';
import { drawNode, openBoard, shareBoard } from '../fixtures';

// Uses the deployed app and its real providers; no local stack or auth alias.

// An access proxy in front of the deployment (Cloudflare Access on staging) takes a
// service token. It goes to E2E_ACCESS_ORIGINS only, never to the identity provider or the database.
const accessOrigins = (process.env.E2E_ACCESS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => new URL(s).origin);
const accessHeaders = { 'cf-access-client-id': process.env.CF_ACCESS_CLIENT_ID ?? '', 'cf-access-client-secret': process.env.CF_ACCESS_CLIENT_SECRET ?? '' };
async function viaAccess(context: BrowserContext) {
  if (accessOrigins.length) {
    await context.route(url => accessOrigins.includes(url.origin), route => route.continue({ headers: { ...route.request().headers(), ...accessHeaders } }));
  }
  return context;
}
const test = base.extend({ context: async ({ context }, use) => { await use(await viaAccess(context)); } });

test('deployed canvas retains nodes and edges after reload', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const entry = new URL(baseURL!);
  entry.searchParams.set('new', '1');
  await openBoard(page, entry.href);
  await drawNode(page, 'API');
  await drawNode(page, 'Database');
  await page.locator('#world g.node').nth(0).click();
  await page.locator('#world g.node').nth(1).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  const destination = page.url();
  await page.reload();
  await expect(page.locator('#world g.node')).toHaveCount(2);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  await expect(page.locator('#world')).toContainText('API');
  await expect(page.locator('#world')).toContainText('Database');
  await expect(page).toHaveURL(destination);
  expect(errors).toEqual([]);
});

test('deployed private locator rejects an unrelated browser', async ({ page, browser, baseURL }) => {
  await openBoard(page, new URL('?new=1', baseURL).href);
  await drawNode(page, 'Private');
  const context = await viaAccess(await browser.newContext());
  try {
    const stranger = await context.newPage();
    await stranger.goto(page.url());
    await expect(stranger.getByRole('heading', { name: 'This board is unavailable' })).toBeVisible();
    await expect(stranger.locator('#world g.node')).toHaveCount(0);
  } finally { await context.close(); }
});

test('deployed edit link stays read-only for guests and revokes live', async ({ page, browser, baseURL }) => {
  await openBoard(page, new URL('?new=1', baseURL).href);
  await drawNode(page, 'Shared');
  const link = await shareBoard(page, 'edit');
  const context = await viaAccess(await browser.newContext());
  try {
    const visitor = await context.newPage();
    await openBoard(visitor, link);
    await expect(visitor.getByRole('button', { name: 'sign in to edit', exact: true })).toBeVisible();
    await visitor.keyboard.press('1');
    await visitor.locator('#board').click({ position: { x: 650, y: 350 } });
    await visitor.keyboard.press('Escape');
    await visitor.reload();
    await expect(visitor.locator('#world g.node')).toHaveCount(1);
    await expect(visitor.locator('#world')).toContainText('Shared');
    await page.getByRole('switch', { name: 'Share with link' }).uncheck();
    await expect(visitor.getByText('This link is no longer shared.', { exact: false })).toBeVisible();
    await expect(page.locator('#world')).toContainText('Shared');
  } finally { await context.close(); }
});
