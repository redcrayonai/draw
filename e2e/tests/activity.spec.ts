import { test, expect } from '../fixtures';

const NONE = { none: [] };

// The dashboard's Activity panel reads the my_activity view live: no reload, no copy step.
test('the dashboard activity feed shows board events as they happen', async ({ page, stack }) => {
  test.setTimeout(120_000);
  const dashboard = await stack.startDashboard();
  const owner = stack.accountToken();
  await stack.callReducer(owner, 'create_workspace', ['Activity workspace']);
  const workspace = (await stack.sql("SELECT * FROM workspace WHERE name = 'Activity workspace'"))[0];
  await stack.callReducer(owner, 'create_workspace_board', [workspace.id, 'Feed board', 'activity-feed-board']);
  const board = (await stack.sql("SELECT * FROM board WHERE name = 'Feed board'"))[0];

  await page.addInitScript(token => Object.assign(window, { __e2eAccountToken: token }), owner);
  await page.goto(`${dashboard}/dashboard`);
  const feed = page.getByRole('complementary', { name: 'Activity' });
  await expect(feed).toContainText('you created Feed board');

  await stack.callReducer(owner, 'create_node', [board.id, 'Payments API', '', 0, 0, 160, 80, 'ink', false, ...Array(7).fill(NONE)]);
  await expect(feed).toContainText('you added “Payments API” to Feed board');
  await stack.callReducer(owner, 'create_node', [board.id, 'Ledger', '', 200, 0, 160, 80, 'ink', false, ...Array(7).fill(NONE)]);
  await expect(feed).toContainText('you added 2 nodes to Feed board'); // a burst merges into one row
  await expect(feed).not.toContainText('not set up');
});
