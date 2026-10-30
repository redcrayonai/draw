import { test, expect, drawNode, openBoard, shareBoard } from '../fixtures';

// The rail's access line (RC-570), as the owner and every link holder read it.
const LINE = {
  view: 'link sharing on · anyone with the link can view',
  edit: 'link sharing on · signed-in people with the link can edit',
};

for (const ownerKind of ['guest', 'account'] as const) {
  for (const mode of ['view', 'edit'] as const) {
    for (const recipientKind of ['guest', 'account'] as const) {
      test(`${ownerKind} owner, ${mode} link, ${recipientKind} recipient`, async ({ guest, account, stack }) => {
        const owner = await (ownerKind === 'guest' ? guest() : account());
        await openBoard(owner, `${stack.url}?new=1`);
        await drawNode(owner, 'Owner service');
        await expect(owner.locator('#access-line')).toHaveText('private');
        const link = await shareBoard(owner, mode);
        await expect(owner.locator('#access-line')).toHaveText(LINE[mode]);
        const recipient = await (recipientKind === 'guest' ? guest() : account());
        await openBoard(recipient, link);
        await expect(recipient.locator('#world')).toContainText('Owner service');
        await expect(recipient.locator('#act-share')).toBeHidden();
        await expect(recipient.locator('#access-line')).toHaveText(LINE[mode]);
        // guests get no way to the dashboard, which needs an account
        await expect(recipient.locator('#crumb-boards')).toBeVisible({ visible: recipientKind === 'account' });

        if (mode === 'edit' && recipientKind === 'account') {
          await drawNode(recipient, 'Recipient');
          await expect(owner.locator('#world')).toContainText('Recipient');
        } else {
          await recipient.keyboard.press('1');
          await recipient.locator('#board').click({ position: { x: 650, y: 350 } });
          await recipient.keyboard.press('Escape');
          await expect(recipient.locator('#world g.node')).toHaveCount(1);
          if (mode === 'edit') await expect(recipient.getByRole('button', { name: 'sign in to edit', exact: true })).toBeVisible();
        }
        await recipient.reload();
        await expect(recipient.locator('#world')).toContainText('Owner service');
        await expect(recipient.locator('#world g.node')).toHaveCount(mode === 'edit' && recipientKind === 'account' ? 2 : 1);
        await expect(recipient).toHaveURL(link);
      });
    }
  }
}

test('downgrade and revoke update an already open recipient', async ({ account, stack }) => {
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Shared service');
  const link = await shareBoard(owner, 'edit');
  const recipient = await account();
  await openBoard(recipient, link);
  await drawNode(recipient, 'Collaborator');
  await expect(owner.locator('#world')).toContainText('Collaborator');

  await owner.getByRole('button', { name: 'Can view', exact: true }).click();
  await expect(recipient.locator('#board-title')).toContainText('view only');
  await expect(recipient.locator('#access-line')).toHaveText(LINE.view);
  await expect(owner.locator('#access-line')).toHaveText(LINE.view);
  await recipient.keyboard.press('1');
  await recipient.locator('#board').click({ position: { x: 650, y: 350 } });
  await recipient.keyboard.press('Escape');
  await expect(recipient.locator('#world g.node')).toHaveCount(2);
  await owner.getByRole('switch', { name: 'Share with link' }).uncheck();
  await expect(recipient.getByText('This link is no longer shared.', { exact: false })).toBeVisible();
  await expect(owner.locator('#world')).toContainText('Shared service');
  await expect(owner.locator('#access-line')).toHaveText('private');
  await recipient.reload();
  await expect(recipient.getByText('This link is no longer shared.', { exact: false })).toBeVisible();
});
