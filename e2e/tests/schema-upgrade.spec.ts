import { test as base, expect, openBoard, drawNode, drawEdge } from '../fixtures';
import { withStack } from '../stack';
import type { Page } from '@playwright/test';

// Upgrading this module must not change another journey's server or build.
const test = base.extend({
  stack: [async ({}, use) => { await withStack(use); }, { scope: 'worker', timeout: 120_000 }],
});

async function captureErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  // The canvas prevents default on unhandledrejection, suppressing pageerror.
  await page.addInitScript(() => {
    window.addEventListener('unhandledrejection', event => console.error(String(event.reason?.message ?? event.reason)));
  });
  return errors;
}

test('module upgrade retains edge rows before deploying appended-column canvas bindings', async ({ guest, stack }) => {
  test.setTimeout(120_000);
  const page = await guest();
  const legacyErrors = await captureErrors(page);
  await openBoard(page, stack.url);
  await drawNode(page, 'Gateway');
  await drawNode(page, 'Database');
  // Multiple rows expose decoder misalignment as well as missing columns.
  await drawEdge(page, 0, 1);
  await drawEdge(page, 1, 0);
  const nodeIds = await page.locator('#world g.node').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')));
  const boardUrl = page.url();
  const upgrade = await stack.prepareSchemaUpgrade();
  const before = await upgrade.readEdges();
  expect(before).toHaveLength(2);
  expect(before.every(row => !('upgrade_probe' in row))).toBe(true);

  // Wrong deployment order: this must fail with retained, nonempty edges.
  await upgrade.deployClient();
  const premature = await page.context().newPage();
  const errors = await captureErrors(premature);
  await premature.goto(boardUrl);
  await expect.poll(() => errors.join('\n')).toMatch(/decode|DataView|bounds|buffer|deserialize|offset/i);
  await expect(premature.locator('#world g.edge')).toHaveCount(0);
  await test.info().attach('client-before-module-decoder-error', { body: errors.join('\n'), contentType: 'text/plain' });
  await premature.close();

  await upgrade.restorePreviousClient();
  // The gate rejects the unsafe shape before touching the retained module.
  await expect(upgrade.publishModule()).rejects.toThrow(/visible_edge: existing public view wire contract changed/);
  expect(await upgrade.readEdges()).toEqual(before);
  await expect(page.locator('#world g.edge')).toHaveCount(2);
  expect(legacyErrors).toEqual([]);
  await upgrade.preservePublicEdge();
  await upgrade.publishModule();
  const after = await upgrade.readEdges();
  expect(after).toEqual(before.map(row => ({ ...row, upgrade_probe: 'retained-edge' })));
  // The old asset remains served between module publish and canvas deploy.
  // A fresh connection must also work during this window.
  const previous = await page.context().newPage();
  const previousErrors = await captureErrors(previous);
  await openBoard(previous, boardUrl);
  await expect(previous.locator('#world g.node')).toHaveCount(2);
  await expect(previous.locator('#world g.edge')).toHaveCount(2);
  await expect(previous.locator('#world')).toContainText('Gateway');
  await expect(previous.locator('#world')).toContainText('Database');
  expect(previousErrors).toEqual([]);
  // Build and expose the new canvas only after the upgraded module is ready.
  await upgrade.deployClient();
  const current = await page.context().newPage();
  const currentErrors = await captureErrors(current);
  await openBoard(current, boardUrl);
  await expect(current.locator('#world g.node')).toHaveCount(2);
  await expect(current.locator('#world g.edge')).toHaveCount(2);
  expect(await current.locator('#world g.node').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')))).toEqual(nodeIds);
  await expect(current.locator('#world')).toContainText('Gateway');
  await expect(current.locator('#world')).toContainText('Database');
  await drawEdge(current, 0, 1);
  const saved = await upgrade.readEdges();
  expect(saved).toHaveLength(3);
  expect(saved).toEqual(expect.arrayContaining(after));
  expect(saved.every(row => row.upgrade_probe === 'retained-edge')).toBe(true);
  await drawNode(current, 'AfterUpgrade');
  await current.reload();
  await expect(current.locator('#world g.node')).toHaveCount(3);
  await expect(current.locator('#world g.edge')).toHaveCount(3);
  await expect(current.locator('#world')).toContainText('AfterUpgrade');
  expect(await upgrade.readEdges()).toEqual(saved);
  expect(currentErrors).toEqual([]);
  // The original page lost its socket at the break-clients publish and reloaded
  // itself, onto whichever canvas was served then. It must show the post-upgrade writes.
  await expect(page.locator('#world g.edge')).toHaveCount(3);
  await expect(page.locator('#world g.node')).toHaveCount(3);
  await expect(page.locator('#world')).toContainText('AfterUpgrade');
  expect(legacyErrors).toEqual([]);
});
