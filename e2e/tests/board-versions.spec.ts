import { test, expect } from '../fixtures';

// Versions plugin (PLUGINS.md) through the dashboard: the real module, dashboard server and an
// S3-compatible store. The save and restore case needs a store: set the VERSIONS_S3_* variables (SELF_HOSTING.md).
const STORE = ['VERSIONS_S3_ENDPOINT', 'VERSIONS_S3_BUCKET', 'VERSIONS_S3_REGION', 'VERSIONS_S3_ACCESS_KEY_ID', 'VERSIONS_S3_SECRET_ACCESS_KEY'];

const NONE = { none: [] };
const some = (v: unknown) => ({ some: v });

test('without storage the Versions switch stays off and says what it needs', async ({ account, stack }, info) => {
  const dashboard = await stack.startDashboard('fixture', { VERSIONS_S3_ENDPOINT: '' });
  const alice = stack.accountToken();
  await stack.callReducer(alice, 'create_workspace', ['Design team']);
  const W = (await stack.sql("SELECT id FROM workspace WHERE name = 'Design team'"))[0].id;
  const page = await account(alice);
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.goto(`${dashboard}/workspaces/plugins?workspace=${W}`);
  const control = page.getByRole('group', { name: 'Versions' });
  await expect(control.getByRole('button', { name: 'on' })).toBeDisabled();
  await expect(control.getByRole('button', { name: 'off' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/Needs storage first/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('0-needs-storage.png') });
});

test('a workspace admin turns Versions on, saves a board and restores it as a new private board', async ({ account, stack }, info) => {
  test.skip(STORE.some(name => !process.env[name]), 'set VERSIONS_S3_* to a local S3-compatible store');
  test.setTimeout(180_000);
  const service = await stack.serviceIdentity('versions-e2e');
  const dashboard = await stack.startDashboard('fixture', {
    SPACETIMEDB_URL: stack.databaseUrl, SPACETIMEDB_DB: stack.databaseName, SPACETIMEDB_SERVICE_TOKEN: service.token,
    ...Object.fromEntries(STORE.map(name => [name, process.env[name]!])),
  });
  const alice = stack.accountToken();
  await stack.callReducer(alice, 'create_workspace', ['Payments team']);
  const W = (await stack.sql("SELECT id FROM workspace WHERE name = 'Payments team'"))[0].id;
  await stack.callReducer(alice, 'create_workspace_board', [W, 'Checkout architecture', 'versions-e2e-checkout-architecture']);
  const B = (await stack.sql("SELECT id FROM board WHERE name = 'Checkout architecture'"))[0].id;
  const node = async (label: string, x: number, y: number, kind = 'service') => {
    await stack.callReducer(alice, 'create_node', [B, label, '', x, y, 176, 80, 'ink', false, some(kind), NONE, NONE, NONE, NONE, NONE, NONE]);
    return (await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = '${label}'`))[0].id;
  };
  const gateway = await node('API gateway', 0, 0), checkout = await node('Checkout', 256, 0), db = await node('Orders DB', 512, 0, 'datastore');
  const legacy = await node('Legacy cart', 256, 160);
  await stack.callReducer(alice, 'create_edge', [B, gateway, checkout, 'POST /checkout', 'human:e2e', NONE, NONE, NONE]);
  await stack.callReducer(alice, 'create_edge', [B, checkout, db, 'writes orders', 'human:e2e', NONE, NONE, NONE]);
  await stack.callReducer(alice, 'create_chart', [B, 'Checkout p99', 'ms', 0, 160, 224, 144, 'timeseries', 'time,p99\n10:00,180\n10:05,240\n10:10,210\n', NONE, NONE]);
  await stack.callReducer(alice, 'set_node_hidden', [legacy, true, some('retired')]);

  const page = await account(alice);
  await page.setViewportSize({ width: 1360, height: 860 });
  // After the controls' 160 ms transition, so a shot never shows a half-pressed state.
  const shot = async (name: string) => { await page.waitForTimeout(250); await page.screenshot({ path: info.outputPath(`${name}.png`) }); };

  // Off until an owner or admin turns it on; the board card has no Versions panel yet.
  await page.goto(`${dashboard}/workspaces/plugins?workspace=${W}`);
  const control = page.getByRole('group', { name: 'Versions' });
  await expect(control.getByRole('button', { name: 'off' })).toHaveAttribute('aria-pressed', 'true');
  await shot('1-plugins-off');
  await control.getByRole('button', { name: 'on' }).click();
  await expect(control.getByRole('button', { name: 'on' })).toHaveAttribute('aria-pressed', 'true');
  await shot('2-plugins-on');

  // Save from the board's card.
  await page.goto(`${dashboard}/dashboard?workspace=${W}`);
  await page.getByRole('button', { name: 'Details for Checkout architecture', exact: true }).click();
  const panel = page.locator('details.board-versions');
  await panel.locator('summary').click();
  await panel.getByRole('button', { name: 'save version' }).click();
  await expect(panel.locator('summary')).toHaveText('Versions · 1');
  await expect(panel.getByText(/Test account/)).toBeVisible();
  await shot('3-saved');

  // Edit the original afterwards: the restore must bring back the saved state, not this one.
  await stack.callReducer(alice, 'create_node', [B, 'Added after the version', '', 512, 160, 176, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  await panel.getByRole('button', { name: /Restore the version/ }).click();
  const open = panel.getByRole('link', { name: 'Open it' });
  await expect(open).toBeVisible();
  await shot('4-restored');
  const [restored] = await stack.sql("SELECT * FROM board WHERE name = 'Checkout architecture (restored)'");
  const labels = async (board: unknown) => (await stack.sql(`SELECT label, hidden FROM node WHERE board_id = ${board}`)).map(n => `${n.label}${n.hidden ? ' (hidden)' : ''}`).sort();
  expect(await labels(restored.id)).toEqual(['API gateway', 'Checkout', 'Checkout p99', 'Legacy cart (hidden)', 'Orders DB']);
  expect(await labels(B)).toContain('Added after the version');
  expect((await stack.sql(`SELECT default_role FROM board_workspace WHERE board_id = ${restored.id}`))[0].default_role).toBe('none');

  // The restored board opens in the canvas like any other.
  await page.goto((await open.getAttribute('href'))!);
  await expect(page.locator('#world g.node').filter({ hasText: 'Orders DB' })).toBeVisible();
  await expect(page.locator('#world g.node').filter({ hasText: 'Added after the version' })).toHaveCount(0);
  await shot('5-restored-canvas');

  // Off again: the panel goes, the saved data stays.
  await page.goto(`${dashboard}/workspaces/plugins?workspace=${W}`);
  await control.getByRole('button', { name: 'off' }).click();
  await expect(control.getByRole('button', { name: 'off' })).toHaveAttribute('aria-pressed', 'true');
  await page.goto(`${dashboard}/dashboard?workspace=${W}`);
  await page.getByRole('button', { name: 'Details for Checkout architecture', exact: true }).click();
  await expect(page.locator('details.board-versions')).toHaveCount(0);
  await shot('6-plugin-off-again');
  expect(await stack.sql(`SELECT id FROM board_version WHERE board_id = ${B}`)).toHaveLength(1);
});
