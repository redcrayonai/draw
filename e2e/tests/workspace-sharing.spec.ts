import { randomBytes } from 'node:crypto';
import { test, expect, drawNode, openBoard, shareBoard } from '../fixtures';

const token = () => randomBytes(16).toString('hex');
const NONE = { none: [] };

test('workspace viewers edit only through an independent edit link, which remains separately revocable', async ({ browser, stack }) => {
  test.setTimeout(120_000);
  const dashboard = await stack.startDashboard();
  const ownerToken = stack.accountToken(), memberToken = stack.accountToken();
  const name = `Workspace link precedence ${token()}`;
  await stack.callReducer(ownerToken, 'create_workspace', [name]);
  const workspace = (await stack.sql(`SELECT * FROM workspace WHERE name = '${name}'`))[0];
  const invitation = token();
  await stack.callReducer(ownerToken, 'create_workspace_invite', [workspace.id, 0, 'member', invitation]);
  await stack.callReducer(memberToken, 'accept_workspace_invite', [invitation]);
  await stack.callReducer(ownerToken, 'create_workspace_board', [workspace.id, name, token()]);
  const board = (await stack.sql(`SELECT * FROM board WHERE name = '${name}'`))[0];
  await stack.callReducer(ownerToken, 'set_workspace_board_access', [board.id, 'viewer']);
  const boardUrl = `${stack.url}#b=${board.slug}`;
  const ownerContext = await browser.newContext(), memberContext = await browser.newContext();
  const errors: string[] = [];
  try {
    await ownerContext.addInitScript(value => { Object.assign(window, { __e2eAccountToken: value }); }, ownerToken);
    await memberContext.addInitScript(value => { Object.assign(window, { __e2eAccountToken: value }); }, memberToken);
    const owner = await ownerContext.newPage(), member = await memberContext.newPage();
    for (const page of [owner, member]) page.on('pageerror', error => errors.push(error.message));
    const edit = (label: string) => stack.callReducer(memberToken, 'create_node', [board.id, label, '', 0, 0, 160, 80, 'ink', false, ...Array(7).fill(NONE)]);
    await openBoard(owner, boardUrl);
    await openBoard(member, boardUrl);
    await expect(member.locator('#board-title')).toContainText('view only');
    await expect(edit('viewer write')).rejects.toThrow(/read only/);

    const sharedUrl = await shareBoard(owner, 'edit');
    await openBoard(member, sharedUrl);
    await expect(member.locator('#board-title')).toHaveText(name);
    await expect(member.locator('#act-share')).toBeHidden();
    await drawNode(member, 'Link edit');
    await expect(owner.locator('#world')).toContainText('Link edit');
    await expect(stack.callReducer(memberToken, 'set_link_share', [board.id, 'edit', token()])).rejects.toThrow(/only an owner/);

    // Removing the workspace grant does not revoke a separately issued edit link.
    await owner.goto(`${dashboard}/dashboard`);
    const card = owner.getByTestId('board-card').filter({ hasText: name });
    await owner.getByRole('button', { name: `Details for ${name}`, exact: true }).click();
    await card.locator('summary').filter({ hasText: `Access · ${name}` }).click();
    await card.getByRole('combobox', { name: 'Workspace members', exact: true }).selectOption('none');
    await expect.poll(async () => (await stack.sql(`SELECT * FROM board_workspace WHERE board_id = ${board.id}`))[0].default_role).toBe('none');
    await expect(member.locator('#board-title')).toHaveText(name);
    await drawNode(member, 'Still edits');

    await openBoard(owner, boardUrl);
    await owner.locator('#act-share').click();
    await owner.getByRole('switch', { name: 'Share with link' }).uncheck();
    await expect(member.getByText('This link is no longer shared.', { exact: false })).toBeVisible();
    await expect(edit('revoked write')).rejects.toThrow(/unavailable/);
    await expect(owner.locator('#world g.node')).toHaveCount(2);
    await member.reload();
    await expect(member.getByText('This link is no longer shared.', { exact: false })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await ownerContext.close();
    await memberContext.close();
  }
});

test('a view link on a workspace board opens for a signed-out visitor and a workspace viewer, and revoking it ends only the signed-out visitor access', async ({ guest, account, stack }) => {
  test.setTimeout(120_000);
  const ownerToken = stack.accountToken(), memberToken = stack.accountToken();
  const name = `Workspace view link ${token()}`;
  await stack.callReducer(ownerToken, 'create_workspace', [name]);
  const workspace = (await stack.sql(`SELECT * FROM workspace WHERE name = '${name}'`))[0];
  const invitation = token();
  await stack.callReducer(ownerToken, 'create_workspace_invite', [workspace.id, 0, 'member', invitation]);
  await stack.callReducer(memberToken, 'accept_workspace_invite', [invitation]);
  await stack.callReducer(ownerToken, 'create_workspace_board', [workspace.id, name, token()]);
  const board = (await stack.sql(`SELECT * FROM board WHERE name = '${name}'`))[0];
  await stack.callReducer(ownerToken, 'set_workspace_board_access', [board.id, 'viewer']);

  const owner = await account(ownerToken);
  await openBoard(owner, `${stack.url}#b=${board.slug}`);
  await drawNode(owner, 'Ledger');
  const link = await shareBoard(owner, 'view');

  // A link visitor gets the board by the share token in the link; a workspace board once hid that token (the canvas then said "no longer shared").
  const [stranger, member] = [await guest(), await account(memberToken)];
  for (const visitor of [stranger, member]) {
    await openBoard(visitor, link);
    await expect(visitor.locator('#board-title')).toContainText(name);
    await expect(visitor.locator('#world')).toContainText('Ledger');
    await expect(visitor.locator('#act-share')).toBeHidden();
    await expect(visitor).toHaveURL(link);
  }

  await owner.getByRole('switch', { name: 'Share with link' }).uncheck();
  await expect(stranger.getByText('This link is no longer shared.', { exact: false })).toBeVisible();
  // The member's workspace viewer access is independent of the link.
  await expect(member.locator('#world')).toContainText('Ledger');
});
