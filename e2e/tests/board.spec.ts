import { test, expect, drawNode, openBoard, exportSvg } from '../fixtures';

test('guest drawing is saved, survives reload, and resumes from root', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'Payments');
  const boardUrl = page.url();
  // the address bar only ever shows the board's slug link, never ?boardId=
  expect(new URL(boardUrl).searchParams.has('boardId')).toBe(false);
  expect(new URL(boardUrl).hash).toMatch(/^#b=[0-9a-f]{20}$/);
  await page.reload();
  await expect(page.locator('#world g.node')).toHaveCount(1);
  await expect(page.locator('#world')).toContainText('Payments');
  await openBoard(page, stack.url);
  await expect(page).toHaveURL(boardUrl);
  await expect(page.locator('#world')).toContainText('Payments');
});

test('a private locator does not give a fresh guest access', async ({ guest, stack }) => {
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'Billing');
  const stranger = await guest();
  await stranger.goto(owner.url());
  await expect(stranger.getByRole('heading', { name: 'This board is unavailable' })).toBeVisible();
  await expect(stranger.locator('#world')).not.toContainText('Billing');
  await expect(stranger.locator('#act-share')).toBeHidden();
});

test('SVG export contains the saved drawing', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'Exported service');
  const file = await exportSvg(page);
  expect(file.suggestedFilename()).toMatch(/\.svg$/);
  const stream = await file.createReadStream();
  let svg = '';
  for await (const chunk of stream!) svg += chunk;
  expect(svg).toContain('Exported service');
  expect(svg).not.toContain('id="presence"');
});
