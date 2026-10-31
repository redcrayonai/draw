import { test, expect, openBoard, drawNode, drawEdge, shareBoard, marker } from '../fixtures';
import type { Browser, Page } from '@playwright/test';

const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SNIPPET = 'export function verify() {}';

/** An account page whose token the test also uses for reducer calls. */
async function owner(browser: Browser, token: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(value => { Object.assign(window, { __e2eAccountToken: value }); }, token);
  return context.newPage();
}

/** Owner's board: two nodes, a cited edge, a threat and a code ref on the first node. */
async function sensitiveBoard(page: Page, stack: { url: string; sql(q: string): Promise<Record<string, unknown>[]>; callReducer(t: string, r: string, a: unknown[]): Promise<void> }, token: string) {
  await openBoard(page, stack.url);
  await drawNode(page, 'auth-svc');
  await drawNode(page, 'users-db');
  await drawEdge(page, 0, 1);
  const ids = await page.locator('#world g.node').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-id'))));
  const [{ board_id: boardId }] = await stack.sql(`SELECT board_id FROM node WHERE id = ${ids[0]}`);
  const B = Number(boardId);
  await stack.callReducer(token, 'add_threat', [B, ids[0], 'compromised', 'critical', 'Forged session tokens', 'jsonwebtoken lets anyone forge tokens.', '', '', '', '[]', '', 'e2e']);
  await stack.callReducer(token, 'set_code_consent', [true]); // the board keeps the snippet (RC-690)
  await stack.callReducer(token, 'add_repo_files', [B, ['src/auth.ts']]);
  await stack.callReducer(token, 'add_code_ref', [B, 'node', ids[0], 'src/auth.ts', 'verify', 1, 1, SHA, SNIPPET, 'e2e']);
  await expect(page.locator('#world .board-marker[role="button"]')).toHaveCount(1);
}

/** Selects auth-svc and returns the inspector, which lists its code refs when the reader may see them. */
async function inspect(page: Page) {
  await page.locator('#world g.node', { hasText: 'auth-svc' }).locator('.node-rect').click();
  return page.locator('#inspector');
}

test('a link shows threats and code only after the owner includes them, live', async ({ browser, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await owner(browser, token);
  await sensitiveBoard(page, stack, token);
  const link = await shareBoard(page, 'view');
  const threats = page.locator('#share-threats'), code = page.locator('#share-code');
  await expect(threats).not.toBeChecked();
  await expect(code).not.toBeChecked();

  // A new link carries the drawing and neither layer.
  const viewer = await guest();
  await viewer.goto(link);
  await expect(viewer.locator('#world')).toContainText('auth-svc');
  await expect(viewer.locator('#world g.edge')).toHaveCount(1);
  await expect(marker(viewer)).toHaveCount(0);
  await expect(await inspect(viewer)).not.toContainText('verify');

  // Each box reaches the open viewer without a reload.
  await threats.check();
  await expect(marker(viewer)).toHaveCount(1);
  await expect(await inspect(viewer)).not.toContainText('verify');
  await code.check();
  await expect(await inspect(viewer)).toContainText('verify');
  await page.locator('#share-pop').screenshot({ path: test.info().outputPath('share-includes.png') });

  // Unticking takes the layer back at once.
  await threats.uncheck();
  await expect(marker(viewer)).toHaveCount(0);
  await code.uncheck();
  await expect(await inspect(viewer)).not.toContainText('verify');

  // The owner's choices survive a reload of the menu.
  await page.reload();
  await page.locator('#act-share').click();
  await expect(threats).not.toBeChecked();
  await expect(code).not.toBeChecked();
});

test('an edit link always carries code, without storing it as chosen', async ({ browser, account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await owner(browser, token);
  await sensitiveBoard(page, stack, token);
  const link = await shareBoard(page, 'edit');
  const code = page.locator('#share-code');
  await expect(code).toBeChecked();
  await expect(code).toBeDisabled();
  await expect(page.locator('#share-code-note')).toBeVisible();

  const editor = await account();
  await editor.goto(link);
  await expect(await inspect(editor)).toContainText('verify');
  await expect(marker(editor)).toHaveCount(0); // threats are still the owner's choice

  // Back to view: the stored choice (off) applies again.
  const view = page.getByRole('button', { name: 'Can view', exact: true });
  await view.click();
  await expect(view).toHaveAttribute('aria-pressed', 'true');
  await expect(code).not.toBeChecked();
  await expect(code).toBeEnabled();
});
