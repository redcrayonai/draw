import { readFile } from 'node:fs/promises';
import { test, expect, openBoard, drawNode } from '../fixtures';

test('a disconnected draft survives submission and offers a backup before reload', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'Saved label');
  await page.locator('#world g.node').dblclick();
  await page.locator('#inline-edit').fill('Keep this draft');
  await page.evaluate(() => (window as any).conn.disconnect());
  await expect(page.locator('#reconnect')).toContainText('Reconnect paused');
  await page.locator('#inline-edit').fill('Keep the latest draft');
  await page.locator('#inline-edit').press('Enter');
  // Beyond the automatic retry delay, including after the editor has gone.
  await page.waitForTimeout(2200);
  await expect(page.locator('#reconnect')).toContainText('Reconnect paused');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download unsaved edits' }).click();
  const backup = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(backup.drafts).toContainEqual({ field: 'inline-edit', text: 'Keep the latest draft' });
  expect(backup.unacknowledgedWrites.some((w: any) => w.args.some((a: any) => a.label === 'Keep the latest draft'))).toBe(true);
  const dialog = page.waitForEvent('dialog');
  const click = page.getByRole('button', { name: 'Reload anyway' }).click();
  const warning = await dialog;
  expect(warning.type()).toBe('beforeunload');
  await warning.dismiss();
  await click;
  await expect(page.locator('#reconnect')).toBeVisible();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Reload anyway' }).click();
  await expect(page.locator('#reconnect')).toHaveCount(0);
  await expect(page.locator('#world')).toContainText('Saved label');
});

test('pending acknowledgements hold reconnect even after the editor closes', async ({ guest, stack }) => {
  const page = await guest();
  let hold = false;
  let closeSocket!: () => void;
  await page.routeWebSocket(/\/v1\/database\//, ws => {
    const server = ws.connectToServer();
    server.onMessage(message => { if (!hold) ws.send(message); });
    closeSocket = () => ws.close();
  });
  await openBoard(page, stack.url);
  await drawNode(page, 'Original');
  await page.locator('#world g.node').dblclick();
  hold = true;
  await page.locator('#inline-edit').fill('Unacknowledged label');
  await page.locator('#inline-edit').press('Enter');
  await expect(page.locator('#inline-edit')).toHaveCount(0);
  await expect(page.locator('#save-status')).toHaveText('Saving…');
  closeSocket();
  await expect(page.locator('#reconnect')).toContainText('Reconnect paused');
  await page.waitForTimeout(2200);
  await expect(page.locator('#reconnect')).toContainText('Reconnect paused');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download unsaved edits' }).click();
  const backup = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(backup.unacknowledgedWrites.some((w: any) => w.args.some((a: any) => a.label === 'Unacknowledged label'))).toBe(true);
});
