import type { Page } from '@playwright/test';
import { test, expect, openBoard } from '../fixtures';

// VITE_CANVAS_EXTRA swaps in e2e/canvas-extra.ts, which records each boardReady call and then throws.
test.use({ clientEnv: { VITE_CANVAS_EXTRA: '../e2e/canvas-extra.ts', VITE_MCP_URL: 'https://mcp.e2e.invalid/mcp' } });

const calls = (page: Page) => page.evaluate(() => ((window as any).__canvasExtra as { bareVisit: boolean; openConnectGuide?: unknown }[])
  .map(c => ({ bareVisit: c.bareVisit, guide: typeof c.openConnectGuide })));

test('the build\'s extra hears once per page after the first paint, knows a bare visit, and can open the guide', async ({ guest, stack }) => {
  const g = await guest();
  // The extra throws on every call: the canvas must log it, not let it escape.
  const uncaught: string[] = [];
  const logged: string[] = [];
  g.on('pageerror', err => uncaught.push(err.message));
  g.on('console', msg => { if (msg.type() === 'error') logged.push(msg.text()); });
  await openBoard(g, stack.url);
  await expect.poll(() => calls(g)).toEqual([{ bareVisit: true, guide: 'function' }]);
  const boardLink = g.url(); // the bare visit now carries its #b= link

  // A board link is not a bare visit; switching boards in place does not call it again.
  await openBoard(g, boardLink);
  await expect.poll(() => calls(g)).toEqual([{ bareVisit: false, guide: 'function' }]);
  await g.goto(`${stack.url}?new=1`);
  await expect(g.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await g.evaluate(href => { location.hash = new URL(href).hash; }, boardLink);
  await expect(g.locator('#board-title')).not.toBeEmpty();
  expect(await calls(g)).toHaveLength(1);

  // openConnectGuide shows the guide to a guest; the header button would ask for an account first.
  await g.evaluate(() => ((window as any).__canvasExtra[0].openConnectGuide as () => void)());
  await expect(g.locator('#connect')).toBeVisible();
  await expect(g.locator('#connect-pane-claude')).toContainText('claude mcp add --transport http --scope user draw https://mcp.e2e.invalid/mcp');
  expect(uncaught).toEqual([]);
  expect(logged.some(text => text.includes('canvas extra failed'))).toBe(true);
});
