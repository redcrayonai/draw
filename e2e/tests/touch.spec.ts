import { test, expect, drawNode, openBoard, fingers, view } from '../fixtures';

type Point = { x: number; y: number };

test('on a phone, a finger pans the board and two fingers pinch-zoom it', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'Payments');
  await page.setViewportSize({ width: 390, height: 844 });
  // Empty canvas on the left, between the rail sheet above and the inspector sheet below.
  const at = (dx: number, dy: number) => ({ x: 40 + dx, y: 360 + dy });

  // The new node is selected; a marquee from empty canvas would clear that, a pan keeps it.
  const handles = page.locator('#world .resize-handle');
  await expect(handles).not.toHaveCount(0);
  const before = await view(page);
  await fingers(page, [0, 20, 40, 60].map(d => [at(d, d)]));
  const panned = await view(page);
  expect([panned.tx - before.tx, panned.ty - before.ty]).toEqual([60, 60]);
  await expect(handles).not.toHaveCount(0);
  await expect(page.locator('#world g.node')).toHaveCount(1);

  await fingers(page, [0, 20, 40, 60].map(d => [at(30 - d / 2, 100), at(70 + d / 2, 100)]));
  // The spread grew from 40 to 100 px.
  expect((await view(page)).scale).toBeCloseTo(panned.scale * 2.5);
  await expect(page.locator('#world g.node')).toHaveCount(1);
});
