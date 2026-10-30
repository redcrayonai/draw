import { test, expect, openBoard, shareBoard, exportSvg } from '../fixtures';
import type { Page } from '@playwright/test';

// Library icons (docs/superpowers/specs/2026-10-18-component-library-design.md):
// found by search, placed with the existing interactions, saved, drawn for a
// collaborator and written into Export SVG.

async function placeIcon(page: Page, query: string, x: number, y: number) {
  const nodes = page.locator('#world g.node');
  const count = await nodes.count();
  await page.keyboard.press('l');
  const search = page.getByRole('searchbox', { name: 'Search the library' });
  await search.fill(query);
  await search.press('Enter');
  await page.locator('#board').click({ position: { x, y } });
  await expect(nodes).toHaveCount(count + 1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#save-status')).toHaveText('Saved');
}

test('library icons are placed from search, saved, shown to a collaborator and exported', async ({ guest, stack }) => {
  const owner = await guest();
  await openBoard(owner, stack.url);
  await placeIcon(owner, 'orchestrator', 400, 200);
  await placeIcon(owner, 'xai', 640, 200); // a search term: the first match is Grok
  await placeIcon(owner, 'k8s', 880, 200);
  const icons = owner.getByRole('img', { name: /^(Orchestrator|Grok|Kubernetes)$/ });
  await expect(icons).toHaveCount(3);
  await expect(owner.locator('#world')).toContainText('Orchestrator');
  await expect(owner.locator('#world')).toContainText('Kubernetes');

  // the node is an ordinary node: it duplicates with its icon, and undo takes the copy away
  await owner.locator('#world g.node').first().click();
  await owner.keyboard.press('ControlOrMeta+d');
  await expect(owner.getByRole('img', { name: 'Orchestrator' })).toHaveCount(2);
  await owner.keyboard.press('ControlOrMeta+z');
  await expect(owner.getByRole('img', { name: 'Orchestrator' })).toHaveCount(1);

  await owner.reload();
  await expect(owner.getByRole('img', { name: /^(Orchestrator|Grok|Kubernetes)$/ })).toHaveCount(3);

  const link = await shareBoard(owner, 'view');
  const viewer = await guest();
  await viewer.goto(link);
  await expect(viewer.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(viewer.getByRole('img', { name: 'Grok' })).toHaveCount(1);
  await expect(viewer.getByRole('img', { name: 'Kubernetes' })).toHaveCount(1);

  const stream = await (await exportSvg(owner)).createReadStream();
  let svg = '';
  for await (const chunk of stream!) svg += chunk;
  for (const name of ['Orchestrator', 'Grok', 'Kubernetes']) expect(svg).toMatch(new RegExp(`<title[^>]*>${name}</title>`));
  expect((svg.match(/class="node-icon-slot"/g) ?? []).length).toBe(3);
});
