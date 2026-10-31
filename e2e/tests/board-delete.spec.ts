import { test, expect, drawNode, openBoard, shareBoard, palette, confirmBoardDelete } from '../fixtures';

const PROMPT = 'Delete "Untitled board" and everything on it, including its code refs? This cannot be undone. Type the board name to confirm.';

test('an owner deletes a board from ⌘K; a link visitor is never offered it', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Doomed service');
  const link = await shareBoard(owner, 'edit');
  await owner.locator('#act-share').click(); // closes the share menu
  const boardHref = owner.url();
  const id = await owner.locator('#world g.node').first().getAttribute('data-id');
  const [{ board_id: boardId }] = await stack.sql(`SELECT board_id FROM node WHERE id = ${id}`);

  // An editor through the link may draw here, but only an owner deletes.
  const visitor = await account();
  await openBoard(visitor, link);
  await palette(visitor, 'board');
  await expect(visitor.locator('#palette-list')).not.toContainText('Delete this board');
  await visitor.keyboard.press('Escape');

  const other = await owner.context().newPage();
  await openBoard(other, boardHref);
  await owner.bringToFront(); // the new page took window focus, so ⌘K would land on an inactive document

  // Esc on the confirm keeps the board.
  await palette(owner, 'delete this board');
  await owner.keyboard.press('Enter');
  const confirm = owner.locator('#board-delete');
  await expect(confirm.locator('#board-delete-prompt')).toHaveText(PROMPT);
  await expect(confirm.getByRole('button', { name: 'cancel', exact: true })).toBeFocused();
  await owner.screenshot({ path: test.info().outputPath('delete-confirm.png') });
  await owner.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect(await stack.sql(`SELECT id FROM board WHERE id = ${boardId}`)).toHaveLength(1);

  await palette(owner, 'delete this board');
  await owner.keyboard.press('Enter');
  await confirmBoardDelete(owner);
  // No dashboard in this build, so the owner lands on a fresh board.
  await expect(owner).not.toHaveURL(boardHref);
  await expect(owner.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(owner.locator('#board-title')).toContainText('Untitled board');
  await expect(owner.locator('#world g.node')).toHaveCount(0);
  expect(await stack.sql(`SELECT id FROM board WHERE id = ${boardId}`)).toEqual([]);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${boardId}`)).toEqual([]);
  await expect(other.getByText('This board is unavailable')).toBeVisible();
  await expect(visitor.getByText('This board is unavailable')).toBeVisible();
});
