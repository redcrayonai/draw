import { test, expect } from '../fixtures';

test('local board signs in and shares through the dashboard route', async ({ stack, account }) => {
  test.setTimeout(90000);
  const dashboard = await stack.startDashboard();
  const local = await account();
  const board = { name: 'Local sharing journey', slug: 'test-board', revision: 0, nodes: [], edges: [], notes: [], feedback: [] };
  // Only the local disk API is stubbed. Both pages and the hosted database are real.
  await local.route('**/api/call', route => {
    const { action } = route.request().postDataJSON();
    const results: Record<string, unknown> = {
      sharing_preference: { skip: false, instance: 'custom' }, list_boards: [board], read_board: board, remember_shared_copy: {},
    };
    if (!(action in results)) throw new Error('Unexpected local call: ' + action);
    return route.fulfill({ json: results[action] });
  });
  await local.route('**/api/events?*', route => route.fulfill({ status: 204 }));
  await local.goto(new URL('local.html', stack.url).href);
  await local.getByRole('button', { name: 'Sign in', exact: true }).click();
  await local.getByLabel('Where do you sign in to Draw?').fill(dashboard);
  const opening = local.waitForEvent('popup');
  await local.getByRole('button', { name: 'Sign in or create an account' }).click();
  const accountTab = await opening;
  await expect(accountTab.getByRole('heading', { name: 'Signed in to Draw' })).toBeVisible();
  await expect(local.getByRole('button', { name: 'Account', exact: true })).toBeVisible();

  const share = local.getByRole('button', { name: 'Share', exact: true });
  const sharing = local.waitForEvent('popup');
  await share.click();
  const tab = await sharing;
  await expect.poll(() => accountTab.isClosed()).toBe(true);
  await expect(tab.getByRole('heading', { name: 'Share a copy of ' + board.name })).toBeVisible();
  await share.click();
  const remembered = local.waitForRequest(request => request.url().endsWith('/api/call') && request.postDataJSON().action === 'remember_shared_copy');
  await tab.getByRole('button', { name: 'Share a copy', exact: true }).click();
  await expect(tab.getByRole('heading', { name: 'Your shared copy is ready' })).toBeVisible();
  expect((await remembered).postDataJSON().board).toBe(board.slug);
  expect(local.context().pages()).toHaveLength(2);
});
