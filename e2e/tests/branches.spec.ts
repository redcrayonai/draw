import { test, expect, openBoard, drawNode, shareBoard, nodes, chip, status, openReview, act } from '../fixtures';

// J23, hand-drawn base: branch from the header chip, review in the dialog, merge back.

test('a branch forks from the chip, is reviewed in the dialog, and merges back into the board', async ({ guest, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await drawNode(owner, 'orders');
  const base = owner.url();
  await expect(chip(owner).locator('.branch-name')).toHaveText(await owner.locator('#board-title').textContent() as string);
  await expect(status(owner)).toBeEmpty();

  // fork: the dialog names the base and its counts; the canvas switches to the copy
  await chip(owner).click();
  await owner.locator('#branch-pop .branch-new').click();
  const create = owner.locator('#branch-create');
  await expect(create.locator('.branch-from')).toContainText('2 nodes');
  await create.locator('#branch-create-name').fill('add-queue');
  await create.locator('button[type="submit"]').click();
  await expect.poll(() => owner.url()).not.toBe(base);
  await expect(owner.locator('#board-title')).toHaveText('Branch · add-queue');
  await expect(status(owner)).toHaveText('Draft');
  await expect(nodes(owner)).toHaveCount(2);

  // the tree: base tagged, this branch current
  await chip(owner).click();
  const rows = owner.locator('#branch-pop .branch-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.branch-tag')).toHaveText('base');
  await expect(rows.nth(1)).toHaveClass(/current/);
  await owner.keyboard.press('Escape');
  await expect(owner.locator('#branch-pop')).toBeHidden();

  // edit the branch; the review dialog lists the change and walks the statuses
  await drawNode(owner, 'queue');
  await openReview(owner);
  const review = owner.locator('#branch-review');
  await expect(review.locator('.branch-change')).toHaveCount(1);
  await expect(review.locator('.branch-change-title')).toContainText('queue');
  await expect(review.locator('.branch-step.now')).toHaveText('Draft');
  await review.locator('button[data-action="submit"]').click();
  await expect(review).toHaveCount(0);
  await expect(status(owner)).toHaveText('In review');
  await act(owner, 'accept', 'Accepted');
  await openReview(owner);
  await expect(review.locator('.branch-note')).toContainText('Merging adds 1 node');
  await review.locator('button[data-action="merge"]').click();
  await expect(review).toHaveCount(0);
  await expect(status(owner)).toHaveText('Merged');

  // the base received the node; a reload keeps it; the merged branch is muted in the tree
  await chip(owner).click();
  await owner.locator('#branch-pop .branch-row').first().click();
  await expect(owner.locator('#board-title')).not.toContainText('Branch ·');
  await expect(nodes(owner)).toHaveCount(3);
  await expect(owner.locator('#world')).toContainText('queue');
  await owner.reload();
  await expect(owner.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(nodes(owner)).toHaveCount(3);
  await chip(owner).click();
  await expect(owner.locator('#branch-pop .branch-row.muted .branch-row-status')).toHaveText('Merged');
});

test('a rejected branch returns to the author, who submits again', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await chip(owner).click();
  await owner.locator('#branch-pop .branch-new').click();
  await owner.locator('#branch-create button[type="submit"]').click();
  await expect(status(owner)).toHaveText('Draft');
  await act(owner, 'submit', 'In review');
  await act(owner, 'reject', 'Rejected');
  await openReview(owner);
  await expect(owner.locator('#branch-review .branch-step.now')).toHaveText('Rejected');
  await expect(owner.locator('#branch-review button[data-action="submit"]')).toBeVisible();
  await owner.locator('#branch-review button[data-action="submit"]').click();
  await expect(status(owner)).toHaveText('In review');
});

test('a link viewer sees the branch chip and tree but cannot branch or review', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  const link = await shareBoard(owner, 'view');
  const viewer = await account();
  await viewer.goto(link);
  await expect(viewer.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(chip(viewer)).toBeVisible();
  await chip(viewer).click();
  await expect(viewer.locator('#branch-pop')).toBeVisible();
  await expect(viewer.locator('#branch-pop .branch-row')).toHaveCount(1);
  await expect(viewer.locator('#branch-pop .branch-new')).toBeHidden();
  await viewer.keyboard.press('Escape');
  await viewer.keyboard.press('Meta+Shift+B');
  await expect(viewer.locator('#branch-create')).toHaveCount(0);
});

test('the palette and ⌘⇧B reach branching', async ({ guest, stack }) => {
  test.setTimeout(60_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await owner.keyboard.press('Meta+k');
  await owner.locator('#palette-input').fill('new branch');
  await expect(owner.locator('#palette-list')).toContainText('New branch');
  await owner.keyboard.press('Escape');
  await owner.keyboard.press('Meta+Shift+B');
  await expect(owner.locator('#branch-create')).toBeVisible();
  await owner.keyboard.press('Escape');
  await expect(owner.locator('#branch-create')).toHaveCount(0);
});
