import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startLocal } from '../../helper/src/local-server';

test('out-of-order reads and pending undo/redo cannot change another board', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'draw-races-'));
  const app = await startLocal({ repo: directory, directory: join(directory, 'store'), assets: resolve(import.meta.dirname, '../../helper/dist/local-assets') });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const call = async (input: unknown) => {
    const response = await fetch(`${app.origin}/api/call`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}` }, body: JSON.stringify(input) });
    expect(response.ok).toBe(true); return response.json();
  };
  try {
    const first = await call({ action: 'open_board', name: 'First' });
    const second = await call({ action: 'open_board', name: 'Second' });
    for (const board of [first, second]) {
      await call({ action: 'apply_board', board: board.slug, revision: 0, operations: [
        { type: 'node.put', patch: { label: 'Same', x: 200, y: 200 } },
        { type: 'node.put', patch: { label: 'Reserve ID' } },
        { type: 'element.delete', id: '2' },
      ] });
    }
    await page.goto(`${app.origin}/#b=${first.slug}&key=${app.token}`);
    await expect(page.locator('.node[data-id]')).toHaveCount(1);
    const picker = page.locator('#boards');
    let release!: () => void;
    let intercepted = false;
    let restored = false;
    let target = 'read_board';
    let requests = 0;
    await page.route('**/api/call', async route => {
      const input = route.request().postDataJSON();
      if (input.action === 'apply_board') requests++;
      const match = target === 'read_board'
        ? input.action === target && input.board === second.slug
        : input.action === 'apply_board' && input.board === first.slug && input.operations[0]?.type === 'graph.restore';
      if (match && !intercepted) {
        intercepted = true;
        const response = await route.fetch();
        const gate = new Promise<void>(resolve => { release = resolve; });
        restored = true;
        await gate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await picker.selectOption(second.slug);
    await expect.poll(() => restored).toBe(true);
    await picker.selectOption(first.slug);
    await expect(page).toHaveURL(new RegExp(`#b=${first.slug}$`));
    release();
    // A subsequent UI action must use the board still selected after the old response arrives.
    await expect(picker).toHaveValue(first.slug);
    await page.locator('.node[data-id="1"]').click();
    await page.locator('#edit input[name="label"]').fill('Edited');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Saved');
    expect((await call({ action: 'read_board', board: first.slug })).nodes[0].label).toBe('Edited');
    expect((await call({ action: 'read_board', board: second.slug })).nodes[0].label).toBe('Same');

    for (const action of ['Undo', 'Redo']) {
      target = 'graph.restore'; intercepted = false; restored = false;
      await page.getByRole('button', { name: action, exact: true }).click();
      await expect.poll(() => restored).toBe(true);
      const changed = await call({ action: 'read_board', board: first.slug });
      const other = await call({ action: 'read_board', board: second.slug });
      await call({ action: 'apply_board', board: second.slug, revision: other.revision, operations: [{ type: 'graph.restore', nodes: changed.nodes, edges: changed.edges }] });
      await picker.selectOption(second.slug);
      await expect(page).toHaveURL(new RegExp(`#b=${second.slug}$`));
      const response = page.waitForResponse(response => response.request().postDataJSON()?.operations?.[0]?.type === 'graph.restore');
      release(); await response;
      // Wait for the continuation through a browser task, then try the opposite history operation.
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      const before = requests;
      await page.getByRole('button', { name: action === 'Undo' ? 'Redo' : 'Undo', exact: true }).click();
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      expect(requests).toBe(before);
      expect((await call({ action: 'read_board', board: second.slug })).nodes).toEqual(changed.nodes);
      if (action === 'Undo') {
        // Build a fresh redo entry on the first board for the second race.
        await picker.selectOption(first.slug);
        await expect(page).toHaveURL(new RegExp(`#b=${first.slug}$`));
        await page.locator('.node[data-id="1"]').click();
        await page.locator('#edit input[name="label"]').fill('Edited again');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.locator('#status')).toHaveText('Saved');
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(page.locator('#status')).toHaveText('Saved');
      }
    }
    expect(errors).toEqual([]);
  } finally { await page.close(); await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
