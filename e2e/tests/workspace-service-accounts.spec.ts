import { test, expect } from '../fixtures';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

test('workspace admins create scoped service accounts and keys, rotate, revoke, and discard shown secrets', async ({ page, browser, stack }) => {
  test.setTimeout(120_000);
  const dashboard = await stack.startDashboard();
  const alice = stack.accountToken(), bob = stack.accountToken(), member = stack.accountToken();
  await stack.callReducer(alice, 'create_workspace', ['Automation workspace']);
  const workspace = (await stack.sql("SELECT * FROM workspace WHERE name = 'Automation workspace'"))[0];
  for (const [token, role] of [[bob, 'admin'], [member, 'member']]) {
    const previous = new Set((await stack.sql('SELECT * FROM workspace WHERE personal = true')).map(row => String(row.id)));
    await stack.callReducer(token, 'ensure_personal_workspace', []);
    const personal = (await stack.sql('SELECT * FROM workspace WHERE personal = true')).find(row => !previous.has(String(row.id)))!;
    await stack.callReducer(alice, 'set_workspace_member', [workspace.id, personal.owner, role]);
  }
  await stack.callReducer(alice, 'create_workspace_board', [workspace.id, 'Architecture', 'service-architecture']);
  await stack.callReducer(alice, 'create_workspace_board', [workspace.id, 'Roadmap', 'service-roadmap']);
  const architecture = (await stack.sql("SELECT * FROM board WHERE name = 'Architecture'"))[0];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(token => Object.assign(window, { __e2eAccountToken: token }), alice);
  await page.goto(`${dashboard}/workspaces/keys?workspace=${workspace.id}`);
  const createAccount = page.getByRole('form', { name: 'Create service account' });
  await createAccount.getByLabel('Service account name').fill('Build automation');
  await createAccount.getByLabel('Service account permission').selectOption('editor');
  await createAccount.getByLabel('Service account boards').selectOption('selected');
  await createAccount.getByLabel('Architecture', { exact: true }).check();
  await createAccount.getByRole('button', { name: 'create service account', exact: true }).click();
  const details = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Build automation$/ }) });
  await details.locator('summary').click();
  const keyForm = details.getByRole('form', { name: 'Create API key for Build automation' });
  await keyForm.getByLabel('Key name').fill('CI production');
  await keyForm.getByLabel('Key permission').selectOption('viewer');
  await keyForm.getByRole('button', { name: 'create API key', exact: true }).click();
  const shown = page.getByLabel('New API key', { exact: true });
  await expect(shown).toBeVisible();
  const bearer = await shown.inputValue();
  expect(bearer).toMatch(/^rcak_[a-f0-9]{32}_[a-f0-9]{64}$/);
  const keyId = bearer.split('_')[1];
  const persisted = (await stack.sql(`SELECT * FROM workspace_api_key WHERE id = '${keyId}'`))[0];
  expect(persisted).toMatchObject({ key_hash: createHash('sha256').update(bearer).digest('hex'), role: 'viewer', all_boards: true, board_ids: [], revoked: false });
  const serviceAccount = (await stack.sql("SELECT * FROM workspace_service_account WHERE name = 'Build automation'"))[0];
  expect(serviceAccount.board_ids).toEqual([architecture.id]);
  expect(JSON.stringify(persisted)).not.toContain(bearer);
  expect(await page.evaluate(token => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(token)), bearer)).toBe(false);

  // Same page, same org, second administrator: the prior plaintext must disappear.
  await page.evaluate(token => {
    Object.assign(window, { __e2eAccountToken: token });
    window.dispatchEvent(new Event('e2e-account-change'));
  }, bob);
  await expect(shown).toHaveCount(0);
  await details.locator('summary').click();
  await expect(shown).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'revoke CI production', exact: true })).toBeVisible();

  // Rotation overlaps old/new keys; revocation is an explicit separate action.
  await details.getByRole('button', { name: 'rotate CI production', exact: true }).click();
  await expect(keyForm.getByLabel('Key name')).toHaveValue('CI production replacement');
  await keyForm.getByLabel('Key permission').selectOption('editor');
  await keyForm.getByRole('button', { name: 'create API key', exact: true }).click();
  await expect(shown).toBeVisible();
  const replacement = await shown.inputValue();
  expect(replacement).not.toBe(bearer);
  expect((await stack.sql(`SELECT * FROM workspace_api_key WHERE id = '${keyId}'`))[0].revoked).toBe(false);
  await page.getByRole('button', { name: 'I saved this key', exact: true }).click();
  await expect(shown).toHaveCount(0);
  await details.getByRole('button', { name: 'revoke CI production', exact: true }).click();
  await expect(details.getByRole('button', { name: 'revoke CI production', exact: true })).toHaveCount(0);
  expect((await stack.sql(`SELECT * FROM workspace_api_key WHERE id = '${keyId}'`))[0].revoked).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Service accounts', exact: true })).toBeVisible();
  await details.locator('summary').click();
  await expect(shown).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'revoke CI production replacement', exact: true })).toBeVisible();
  await page.locator('section.workspace-panel').filter({ has: page.getByRole('heading', { name: 'Service accounts', exact: true }) }).screenshot({ path: fileURLToPath(new URL('../../.context/service-accounts.png', import.meta.url)), style: 'header.bar { visibility: hidden; }' });

  // Long names still leave usable key controls on a small screen.
  await keyForm.getByLabel('Key name').fill('K'.repeat(100));
  await keyForm.getByRole('button', { name: 'create API key', exact: true }).click();
  await expect(shown).toBeVisible();
  await page.getByRole('button', { name: 'I saved this key', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.setViewportSize({ width: 1280, height: 720 });

  const editAccount = details.getByRole('form', { name: 'Edit service account Build automation' });
  await editAccount.getByLabel('Disable service account').check();
  await editAccount.getByRole('button', { name: 'save', exact: true }).click();
  await expect(details.getByText('Disabled · all keys are blocked.', { exact: true })).toBeVisible();
  await expect(keyForm.getByLabel('Key name')).toBeDisabled();

  const memberContext = await browser.newContext();
  try {
    await memberContext.addInitScript(token => Object.assign(window, { __e2eAccountToken: token }), member);
    const memberPage = await memberContext.newPage();
    await memberPage.goto(`${dashboard}/workspaces/members?workspace=${workspace.id}`);
    await expect(memberPage.getByRole('region', { name: 'Members', exact: true })).toBeVisible();
    await expect(memberPage.getByRole('link', { name: 'Service accounts & keys' })).toHaveCount(0);
    await memberPage.goto(`${dashboard}/workspaces/keys?workspace=${workspace.id}`);
    await expect(memberPage.getByText('Owners and admins of a shared workspace manage its service accounts.')).toBeVisible();
    await expect(memberPage.getByRole('heading', { name: 'Service accounts', exact: true })).toHaveCount(0);
    await expect(memberPage.getByText('Build automation', { exact: true })).toHaveCount(0);
  } finally { await memberContext.close(); }
  expect(errors).toEqual([]);
});
