import { test, expect, openBoard, drawNode, drawEdge } from '../fixtures';

// A threat peeks on hover, docks its detail in the inspector on click, steps with J/K and closes with Esc.
test('threat marker: peek on hover, panel in the inspector, J/K and Esc', async ({ browser, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(value => { Object.assign(window, { __e2eAccountToken: value }); }, token);
  const page = await context.newPage();
  await openBoard(page, stack.url);
  await drawNode(page, 'edge-vm-01');
  await drawNode(page, 'customers-db');
  await drawNode(page, 'orders-db');
  await drawEdge(page, 0, 1);
  await drawEdge(page, 0, 2);
  const ids = await page.locator('#world g.node').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')!));
  const [{ board_id: boardId }] = await stack.sql(`SELECT board_id FROM node WHERE id = ${ids[0]}`);
  const add = (title: string, stage: string, severity: string) => stack.callReducer(token, 'add_threat', [
    Number(boardId), Number(ids[0]), stage, severity, title, 'Proxy service account read every customer row.', '', '', '', '["PII"]', '{"system":"SIEM","ref":"notable #1"}', 'e2e',
  ]);
  await add('Bulk read of customers-db', 'compromised', 'critical');

  const marker = page.locator('#world .board-marker[role="button"]');
  await expect(marker).toHaveCount(1);
  await marker.hover();
  const peek = page.locator('.threat-peek');
  await expect(peek).toBeVisible();
  await expect(peek).toContainText('Bulk read of customers-db');
  await expect(peek).toContainText('Reaches 2 nodes in 1 hop');
  // The peek sits beside the node, clear of it.
  const [nodeBox, peekBox] = [await page.locator('#world g.node .node-rect').first().boundingBox(), await peek.boundingBox()];
  const overlaps = nodeBox!.x < peekBox!.x + peekBox!.width && peekBox!.x < nodeBox!.x + nodeBox!.width
    && nodeBox!.y < peekBox!.y + peekBox!.height && peekBox!.y < nodeBox!.y + nodeBox!.height;
  expect(overlaps).toBe(false);
  await page.screenshot({ path: test.info().outputPath('peek.png') });
  // A live write refreshes the open peek; Esc hides it without touching the canvas.
  await add('CVE-2021-23017', 'vulnerable', 'high');
  await expect(peek).toContainText('1 of 2');
  await page.keyboard.press('Escape');
  await expect(peek).toBeHidden();

  await marker.click();
  await expect(peek).toBeHidden();
  const panel = page.locator('#inspector .tc');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.tc-title')).toHaveText('Bulk read of customers-db');
  await expect(panel.locator('.tc-row')).toHaveCount(2);
  await expect(page.locator('.board-card')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('open.png') });

  await expect(panel.locator('.th-row')).toHaveCount(2);
  await expect(panel.locator('.tc-sev')).toHaveText('critical');
  // Another writer's threat rebuilds the panel and the inspector; keyboard focus stays put.
  const both = panel.locator('[data-key="seg:both"]');
  await both.focus();
  await add('Debug endpoint exposed', 'vulnerable', 'medium');
  await expect(panel.locator('.th-row')).toHaveCount(3);
  await expect(both).toBeFocused();
  await page.keyboard.press('j');
  await expect(panel.locator('.tc-title')).toHaveText('CVE-2021-23017');
  await page.keyboard.press('k');
  await expect(panel.locator('.tc-title')).toHaveText('Bulk read of customers-db');

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('#inspector .th-row')).toHaveCount(3); // the anchor stays selected, threats as rows
  await context.close();
});
