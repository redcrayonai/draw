import { test, expect, drawNode, openBoard } from '../fixtures';
import type { Page } from '@playwright/test';

// The node labels in the tab's row cache: the module sends only the open board's (RC-605).
const cached = (page: Page) => page.evaluate(() => [...(window as any).conn.db.visibleNode.iter()].map((n: { label: string }) => n.label).sort());

test('switching boards draws the new board without a reload, and never the old one', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'Alpha');
  const first = page.url();
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'Beta');
  expect(await cached(page)).toEqual(['Beta']);

  // Every frame from here on: which board's nodes are on screen. Resolves once
  // a frame of Beta is recorded, so the switch cannot land before the first sample.
  await page.evaluate(() => {
    const w = window as any;
    w.__sameDocument = true;
    w.__frames = [];
    const sample = () => {
      const text = document.getElementById('world')?.textContent ?? '';
      w.__frames.push(`${text.includes('Alpha') ? 'A' : ''}${text.includes('Beta') ? 'B' : ''}`);
      requestAnimationFrame(sample);
    };
    return new Promise(done => requestAnimationFrame(() => { sample(); done(null); }));
  });
  // Back to the first board in the same document, as the browser's back button does.
  await page.evaluate(href => { history.pushState(null, '', href); dispatchEvent(new PopStateEvent('popstate')); }, first);
  await expect(page.locator('#world')).toContainText('Alpha');
  await expect(page.locator('#world')).not.toContainText('Beta');
  await expect(page.locator('#world g.node')).toHaveCount(1);

  expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true);
  const frames: string[] = await page.evaluate(() => (window as any).__frames);
  // Beta until the switch, then Alpha: no empty frame, no frame with both.
  expect(frames.filter((frame, i) => frame !== frames[i - 1])).toEqual(['B', 'A']);
  expect(await cached(page)).toEqual(['Alpha']);
});
