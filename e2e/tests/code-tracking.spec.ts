import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, openBoard, shareBoard, linkedAgent, guestToken, boardLink, type Stack } from '../fixtures';

// What a session board shows about code over time (session companion spec, change-notes spec).
// The agent side is the module reducers called with the person's own token, as the MCP server would.
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HEAD = 'c'.repeat(40);
const NONE = { none: [] };
const WIDE = { viewport: { width: 1440, height: 900 } };
const CLIPBOARD = { ...WIDE, permissions: ['clipboard-read', 'clipboard-write'] };
const READ_ONLY = 'not authorized: board is read only';
const REVIEW_RULE = 'only a signed-in person with edit access can review a change note';

const unique = (name: string) => `${name}-${randomBytes(3).toString('hex')}`;
const boardNamed = async (stack: Stack, name: string) => Number((await stack.sql(`SELECT id FROM board WHERE name = '${name}'`))[0].id);

/** A session board this person started, as start_session does for their agent. */
async function sessionBoard(stack: Stack, token: string) {
  const name = unique('e2e-session');
  await stack.callReducer(token, 'start_session', [name, '/tmp/e2e-repo', SHA]);
  return boardNamed(stack, name);
}

/** create_node as token; 240 px wide so a ref badge has room for its status suffix. */
async function node(stack: Stack, token: string, B: number, label: string) {
  const count = (await stack.sql(`SELECT id FROM node WHERE board_id = ${B}`)).length;
  await stack.callReducer(token, 'create_node', [B, label, '', 200 + count * 320, 240, 240, 100, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  return Number((await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = '${label}'`))[0].id);
}

async function addRef(stack: Stack, token: string, B: number, kind: 'node' | 'edge', target: number, path: string, symbol: string, start: number, end: number, snippet = '') {
  await stack.callReducer(token, 'add_code_ref', [B, kind, target, path, symbol, start, end, SHA, snippet, 'e2e']);
  return Number((await stack.sql(`SELECT id FROM code_ref WHERE target_id = ${target} AND symbol = '${symbol}'`))[0].id);
}

const select = (page: Page, id: number) => page.locator(`#world g[data-id="${id}"] .node-rect`).click({ position: { x: 12, y: 12 } });
const codeEyebrow = (page: Page) => page.locator('#inspector .eyebrow').filter({ hasText: /^code · / });

// Spec D5's example: Postgres holds the migration that drops customers.name; Invoice worker still reads it.
const MIGRATION = 'migrations/0042_split.sql';
const READER = 'workers/invoice/src/bill-to.ts';
const TITLE = '0042 split customer name';

async function migrationNote(stack: Stack, token: string, B: number, consent = true) {
  const pg = await node(stack, token, B, 'Postgres');
  const inv = await node(stack, token, B, 'Invoice worker');
  await stack.callReducer(token, 'create_edge', [B, inv, pg, 'reads', 'human:e2e', NONE, NONE, NONE]);
  await stack.callReducer(token, 'add_repo_files', [B, [MIGRATION, READER]]);
  const main = await addRef(stack, token, B, 'node', pg, MIGRATION, 'customers', 1, 3, consent
    ? 'ALTER TABLE customers ADD first_name text;\nUPDATE customers SET first_name = name;\nALTER TABLE customers DROP COLUMN name;' : '');
  const reader = await addRef(stack, token, B, 'node', inv, READER, 'billTo', 40, 41, consent ? 'export function billTo(c) {\n  return c.name;' : '');
  await stack.callReducer(token, 'add_change_note', [B, pg, 'migration', 'destructive', TITLE, 'Drops customers.name', main,
    JSON.stringify([{ label: 'add', startLine: 1, endLine: 1 }, { label: 'drop', startLine: 3, endLine: 3, irreversible: true }]),
    JSON.stringify({ table: 'customers', columns: [{ name: 'first_name', type: 'text', change: 'added' }, { name: 'name', type: 'text', change: 'dropped' }] }),
    JSON.stringify([{ table: 'customers', column: 'name' }]),
    JSON.stringify([{ refId: String(reader), subject: 0 }]), 'e2e']);
  const note = Number((await stack.sql(`SELECT id FROM change_note WHERE board_id = ${B}`))[0].id);
  /** set_change_note_readers with the one reader at this status, as a checkpoint's reader check writes it. */
  const readers = (status: string, sha: string) =>
    stack.callReducer(token, 'set_change_note_readers', [note, JSON.stringify([{ refId: String(reader), subject: 0, status, checkpoint: 1 }]), sha]);
  return { pg, inv, main, reader, note, readers };
}

test('the inspector CODE section lists refs, expands one, and updates its checkpoint line live', async ({ account, stack }) => {
  const token = stack.accountToken();
  const B = await sessionBoard(stack, token);
  await stack.callReducer(token, 'set_code_consent', [true]); // the board keeps the snippets (RC-690)
  const api = await node(stack, token, B, 'api');
  const db = await node(stack, token, B, 'db');
  await stack.callReducer(token, 'add_repo_files', [B, ['src/api.ts']]);
  await addRef(stack, token, B, 'node', api, 'src/api.ts', 'a', 1, 1, 'export function a() {}');
  await addRef(stack, token, B, 'node', api, 'src/api.ts', 'b', 5, 5, 'export function b() {}');
  const page = await account(token, CLIPBOARD);
  await openBoard(page, await boardLink(stack, B));

  await select(page, api);
  const inspector = page.locator('#inspector');
  const rows = inspector.locator('.insp-ref-row');
  await expect(codeEyebrow(page)).toHaveText('code · 2 refs');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'false');
  await expect(inspector.locator('.insp-ref-asof')).toHaveText('current as of 4b825dc · not yet checkpointed');
  await expect(inspector.locator('.insp-code')).toContainText('function a');
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'false');
  await expect(inspector.locator('.insp-code')).toContainText('function b');

  // The ref was stamped for the upcoming checkpoint; the open panel follows the checkpoint landing.
  await stack.callReducer(token, 'mark_checkpoint', [B, HEAD, '{}']);
  await expect(inspector.locator('.insp-ref-asof')).toHaveText('current as of 4b825dc · checkpoint 1');

  // Keyboard (spec 8): the arrows move within the list, Enter expands, c copies the focused ref.
  await rows.nth(0).click();
  await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await rows.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('c');
  await expect(inspector.locator('[data-act="copy"]')).toHaveText('copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('src/api.ts:5-5');
  await expect(page.locator('#tool-crayon')).not.toHaveClass(/armed/); // the panel kept the key

  await select(page, db);
  await expect(inspector.locator('.insp-title')).toHaveText('db');
  await expect(codeEyebrow(page)).toHaveCount(0);
});

test('a stale or ambiguous ref is flagged on its row, node and rail, live', async ({ account, stack }) => {
  const token = stack.accountToken();
  const B = await sessionBoard(stack, token);
  const api = await node(stack, token, B, 'api');
  const db = await node(stack, token, B, 'db');
  await stack.callReducer(token, 'add_repo_files', [B, ['src/api.ts']]);
  const r = await addRef(stack, token, B, 'node', api, 'src/api.ts', 'handler', 3, 4);
  const page = await account(token, WIDE);
  await openBoard(page, await boardLink(stack, B));
  const rail = page.locator('#session-row');
  const inspector = page.locator('#inspector');
  await expect(page.locator('#world .node-refs-text')).toContainText('1 ref');
  await expect(rail).toContainText('no checkpoint yet');
  await expect(rail.locator('.session-stale')).toHaveCount(0);

  for (const [status, cause] of [['stale', 'symbol not found at the last checkpoint'], ['ambiguous', 'more than one match at the last checkpoint']]) {
    await select(page, db);
    await expect(inspector.locator('.insp-title')).toHaveText('db');
    // A checkpoint's resolver writes the status; nothing reloads.
    await stack.callReducer(token, 'update_code_ref', [r, 3, 4, SHA, '', status]);
    await expect(rail.locator('.session-stale')).toHaveText(`1 ${status} ref`);
    await expect(page.locator('#world .node-refs-status')).toContainText(`1 ${status}`);
    await rail.locator('.session-stale').click();
    await expect(inspector.locator('.insp-title')).toHaveText('api');
    await expect(inspector.locator(`.insp-chip.${status}`)).toHaveText(status);
    await expect(inspector.locator('.insp-ref-note-line')).toHaveText([cause, 'lines are as last seen']);
  }
});

test('the ⌥C code overlay shows ref badges on session boards and is remembered per board', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const row = (page: Page) => page.locator('#code-overlay-row');

  // A board without a session has no switch, and ⌥C does nothing; the inspector still lists the ref.
  const plainName = unique('Plain');
  await stack.callReducer(token, 'create_board', [plainName]);
  const P = await boardNamed(stack, plainName);
  const plainApi = await node(stack, token, P, 'api');
  await stack.callReducer(token, 'add_repo_files', [P, ['src/api.ts']]);
  await addRef(stack, token, P, 'node', plainApi, 'src/api.ts', 'handler', 3, 4);
  const page = await account(token, WIDE);
  await openBoard(page, await boardLink(stack, P));
  await select(page, plainApi);
  await expect(codeEyebrow(page)).toHaveText('code · 1 ref');
  await expect(row(page)).toBeHidden();
  await page.keyboard.press('Alt+KeyC');
  await page.keyboard.press('Alt+KeyE'); // handled after ⌥C: once it shows, ⌥C was handled too
  await expect(page.locator('#overlay-row')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page)).toBeHidden();
  await expect(row(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#world .node-refs')).toHaveCount(0);

  // A session board with refs starts with the overlay on: node badge and edge suffix.
  const B = await sessionBoard(stack, token);
  const api = await node(stack, token, B, 'api');
  const db = await node(stack, token, B, 'db');
  await stack.callReducer(token, 'add_repo_files', [B, ['src/api.ts', 'src/db.ts']]);
  await stack.callReducer(token, 'create_edge', [B, api, db, 'calls', 'source:src/api.ts:3', NONE, NONE, { some: 'ok' }]);
  const edge = Number((await stack.sql(`SELECT id FROM edge WHERE board_id = ${B}`))[0].id);
  await addRef(stack, token, B, 'node', api, 'src/api.ts', 'handler', 3, 4);
  await addRef(stack, token, B, 'edge', edge, 'src/db.ts', 'query', 7, 7);
  await openBoard(page, await boardLink(stack, B));
  await expect(row(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#world .node-refs-text')).toContainText('1 ref');
  await expect(page.locator('#world .edge-refs-text')).toContainText('1 ref');
  // An edge with a ref lists it in the inspector too (CC-34); the suffix selects its edge.
  await page.locator('#world .edge-refs-text').click();
  await expect(codeEyebrow(page)).toHaveText('code · 1 ref');
  await expect(page.locator('#inspector .insp-ref-sym')).toHaveText('query');

  await page.keyboard.press('Alt+KeyC');
  await expect(row(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#world .node-refs')).toHaveCount(0);
  await expect(page.locator('#world .edge-refs')).toHaveCount(0);
  await select(page, api);
  await expect(codeEyebrow(page)).toHaveText('code · 1 ref');

  // The explicit off survives a reload of this board.
  await page.reload();
  await expect(page.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await select(page, api);
  await expect(codeEyebrow(page)).toHaveText('code · 1 ref');
  await expect(row(page)).toBeVisible();
  await expect(row(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#world .node-refs')).toHaveCount(0);

  // A session board with no refs starts off; turned on, the rail says why nothing shows.
  const E = await sessionBoard(stack, token);
  await openBoard(page, await boardLink(stack, E));
  const rail = page.locator('#session-row');
  await expect(rail).toContainText('no checkpoint yet');
  await expect(row(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(rail).not.toContainText('no code refs yet');
  await row(page).click();
  await expect(row(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(rail.locator('.session-hint')).toHaveText('no code refs yet — the agent adds them at checkpoints');

  // Per board: turning this one on left the first session board off.
  await openBoard(page, await boardLink(stack, B));
  await select(page, api);
  await expect(codeEyebrow(page)).toHaveText('code · 1 ref');
  await expect(row(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#world .node-refs')).toHaveCount(0);
});

test('a checkpoint fills the session rail with reconciliation, debt, exclusions and unconfirmed migrations, live', async ({ account, stack }) => {
  const token = stack.accountToken();
  const B = await sessionBoard(stack, token);
  const page = await account(token, WIDE);
  await openBoard(page, await boardLink(stack, B));
  const rail = page.locator('#session-row');
  await expect(rail.locator('.session-line')).toHaveText('no checkpoint yet');
  await expect(rail.locator('.session-empty')).toHaveText('coverage appears at the first checkpoint');
  await expect(rail.locator('.session-recon')).toHaveCount(0);

  const coverage = { changed: 3, uncovered: ['src/x.ts'], excluded: [{ reason: 'generated bindings', paths: ['src/gen.ts'] }], deleted: ['docs/old.md'] };
  await stack.callReducer(token, 'mark_checkpoint', [B, HEAD, JSON.stringify(coverage)]);
  await expect(rail.locator('.session-line')).toHaveText('checkpoint 1 · just now');
  await expect(rail.locator('.session-recon')).toHaveText('3 changed · 1 on board · 1 excluded · 1 not on board');
  await expect(rail.locator('.chip')).toHaveText([/1 changed file not on board/, /1 · generated bindings/, /1 deleted/]);
  const debt = rail.locator('.chip.debt');
  const paths = rail.locator('.chip-paths[data-key="uncovered"]');
  await expect(debt).toHaveAttribute('aria-expanded', 'false');
  await expect(paths).toBeHidden();
  await debt.click();
  await expect(debt).toHaveAttribute('aria-expanded', 'true');
  await expect(paths).toBeVisible();
  await expect(paths).toContainText('src/x.ts');

  await stack.callReducer(token, 'mark_checkpoint', [B, HEAD, JSON.stringify({ changed: 0, uncovered: [], excluded: [], deleted: [] })]);
  await expect(rail.locator('.session-line')).toHaveText('checkpoint 2 · just now');
  await expect(rail.locator('.session-empty')).toHaveText('nothing changed since the session started');
  await expect(rail.locator('.session-recon')).toHaveCount(0);

  // A changed migration file no note cites (CC-51): the agent reports it, the rail counts it.
  await stack.callReducer(token, 'mark_checkpoint', [B, HEAD, JSON.stringify({ changed: 1, uncovered: [], excluded: [], deleted: [], unconfirmed: ['migrations/0043_x.sql'] })]);
  await expect(rail.locator('.session-notes')).toHaveText('1 unconfirmed migration');
});

test("a change note's inspector block shows deltas, readers, steps and breaking lines", async ({ account, stack }) => {
  const token = stack.accountToken();
  const B = await sessionBoard(stack, token);
  await stack.callReducer(token, 'set_code_consent', [true]);
  const { pg, reader: readerRef } = await migrationNote(stack, token, B);
  const page = await account(token, CLIPBOARD);
  await openBoard(page, await boardLink(stack, B));
  await select(page, pg);

  const note = page.locator('#inspector .cn-note');
  await expect(note.locator('.cn-kind')).toHaveText('migration');
  await expect(note.locator('.cn-title')).toHaveText(TITLE);
  await expect(note.locator('.cn-sev')).toHaveText('destructive');
  await expect(note.locator('.cn-delta.add')).toHaveText('+first_name');
  await expect(note.locator('.cn-delta.drop')).toHaveText('−name');
  await expect(note.locator('.cn-summary')).toHaveText('Drops customers.name');
  await expect(note.locator('.cn-readers .eyebrow')).toHaveText('READERS OF customers.name');
  const reader = note.locator('.cn-reader.stale');
  await expect(reader).toContainText(`${READER}:41`);
  await expect(reader).toContainText('still reads');
  await expect(note.locator('.cn-code .cn-step')).toHaveCount(2);
  await expect(note.locator('.cn-code .cn-danger')).toContainText('DROP COLUMN');
  await expect(note.locator('.cn-break .cn-breaks')).toHaveText('breaks at 2');
  await expect(note.locator('.cn-break .cn-snippet')).toContainText('return c.name;');
  await expect(note.locator('.cn-error')).toHaveText('on deploy: column "name" does not exist');

  // D8: no channel to a live agent yet, so the fix request goes through the clipboard.
  const ask = reader.locator('button'); // not by name: the name flips to 'copied'
  await expect(ask).toHaveText('ask agent to fix');
  await ask.click();
  await expect(ask).toHaveText('copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${TITLE} changes customers.name, but ${READER}:41 still reads it. Update that code to the new columns, then call mark_checkpoint.`
  );

  // A reader whose ref is removed stays listed as removed, with no breaking line.
  await stack.callReducer(token, 'remove_code_ref', [readerRef]);
  await expect(note.locator('.cn-reader.removed .cn-reader-status')).toHaveText('ref removed');
  await expect(note.locator('.cn-reader.stale')).toHaveCount(0);
  await expect(note.locator('.cn-break')).toHaveCount(0);
});

test('reader statuses from a checkpoint update the note, rail chip and edge live, and deleting the anchor drops the note', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const B = await sessionBoard(stack, token);
  await stack.callReducer(token, 'set_code_consent', [true]);
  const { pg, inv, readers } = await migrationNote(stack, token, B);
  const page = await account(token, WIDE);
  await openBoard(page, await boardLink(stack, B));
  const chip = page.locator('#session-row .session-notes');
  const edge = page.locator('#world g.edge .edge-line');
  const note = page.locator('#inspector .cn-note');
  await expect(chip).toHaveText('1 migration · 1 reader not updated');
  await expect(edge).toHaveClass(/reader-stale/);
  await select(page, pg);
  await expect(note.locator('.cn-reader.stale')).toContainText('still reads');
  // A second browser on the board sees the delete land without a reload (CC-57).
  const other = await account(token, WIDE);
  await openBoard(other, await boardLink(stack, B));
  const otherChip = other.locator('#session-row .session-notes');
  await select(other, pg);
  await expect(other.locator('#inspector .cn-note .cn-title')).toHaveText(TITLE);
  await expect(otherChip).toHaveText('1 migration · 1 reader not updated');

  await readers('updated', SHA);
  await expect(chip).toHaveText('1 migration');
  await expect(otherChip).toHaveText('1 migration');
  await expect(note.locator('.cn-reader.updated')).toContainText('updated');
  await expect(note.locator('.cn-reader.stale')).toHaveCount(0);
  await expect(edge).toHaveClass(/reader-updated/);
  await expect(edge).not.toHaveClass(/reader-stale/);

  await select(page, inv);
  await expect(page.locator('#inspector .insp-title')).toHaveText('Invoice worker');
  await chip.click();
  await expect(page.locator('#inspector .insp-title')).toHaveText('Postgres');

  // Deleting the anchor deletes its notes (change-notes spec, Data).
  await select(page, pg);
  await page.keyboard.press('Delete');
  await expect(page.locator('#world g.node')).toHaveCount(1);
  await expect(page.locator('#world')).toContainText('Invoice worker');
  await expect(chip).toHaveCount(0);
  await expect(other.locator('#world g.node')).toHaveCount(1);
  await expect(other.locator('#world')).toContainText('Invoice worker');
  await expect(otherChip).toHaveCount(0);
  await expect(other.locator('#inspector .cn-note')).toHaveCount(0);
  await expect.poll(() => stack.sql(`SELECT id FROM change_note WHERE board_id = ${B}`)).toEqual([]);
});

test('only a signed-in editor may mark a note reviewed, and a material change clears the review', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const B = await sessionBoard(stack, token);
  await stack.callReducer(token, 'set_code_consent', [true]);
  const { pg, main, note: noteId, readers } = await migrationNote(stack, token, B);
  const owner = await account(token, WIDE);
  await openBoard(owner, await boardLink(stack, B));
  await select(owner, pg);
  const review = (page: Page) => page.locator('#inspector .cn-review');
  const reviewed = (page: Page) => page.locator('#inspector .cn-reviewed');
  const sev = (page: Page) => page.locator('#inspector .cn-sev');
  await expect(review(owner)).toHaveText('mark reviewed');
  await expect(reviewed(owner)).toHaveCount(0);

  // A view-link visitor, signed in, sees the note but never the button; the module refuses them too.
  const link = await shareBoard(owner, 'view');
  await owner.locator('#act-share').click();
  await expect(owner.locator('#share-pop')).toBeHidden();
  const vToken = stack.accountToken();
  const v = await account(vToken, WIDE);
  await openBoard(v, link);
  await select(v, pg);
  await expect(sev(v)).toHaveText('destructive');
  await expect(review(v)).toHaveCount(0);
  await expect(stack.callReducer(vToken, 'mark_change_note_reviewed', [noteId, true])).rejects.toThrow(READ_ONLY);

  // The owner's review reaches the visitor's open inspector.
  const by = /^reviewed by .+ \([0-9a-f]{12}\) · just now$/;
  await review(owner).click();
  await expect(reviewed(owner)).toHaveText(by);
  await expect(review(owner)).toHaveText('clear review');
  await expect(reviewed(v)).toHaveText(by);
  await expect(review(v)).toHaveCount(0);

  // An edit link: a signed-out guest sees the review and no button; the module takes no write from them.
  await owner.locator('#act-share').click();
  const canEdit = owner.getByRole('button', { name: 'Can edit', exact: true });
  await canEdit.click();
  await expect(canEdit).toHaveAttribute('aria-pressed', 'true');
  await owner.locator('#act-share').click();
  await expect(owner.locator('#share-pop')).toBeHidden();
  // The signed-in visitor now has edit access and gets the button, live: the guest below differs only in being signed out.
  await expect(review(v)).toHaveText('clear review');
  const g = await guest(WIDE);
  await openBoard(g, link);
  await expect(g.locator('#access-line')).toHaveText('link sharing on · signed-in people with the link can edit');
  await select(g, pg);
  await expect(reviewed(g)).toHaveText(by);
  await expect(review(g)).toHaveCount(0);
  await expect(stack.callReducer(await guestToken(g), 'mark_change_note_reviewed', [noteId, true])).rejects.toThrow(READ_ONLY);
  // Never an agent either (D12).
  const agent = await linkedAgent(stack, token, B);
  await expect(stack.callReducer(agent.token, 'mark_change_note_reviewed', [noteId, true])).rejects.toThrow(REVIEW_RULE);

  // D9: a title-only edit keeps the review; a severity change ends it, live for everyone.
  await stack.callReducer(token, 'update_change_note', [noteId, NONE, NONE, { some: `${TITLE} (v2)` }, NONE, NONE, NONE, NONE, NONE, NONE]);
  await expect(owner.locator('#inspector .cn-title')).toHaveText(`${TITLE} (v2)`);
  await expect(reviewed(owner)).toHaveText(by);
  await expect(v.locator('#inspector .cn-title')).toHaveText(`${TITLE} (v2)`);
  await expect(reviewed(v)).toHaveText(by);
  await stack.callReducer(token, 'update_change_note', [noteId, NONE, { some: 'notable' }, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  await expect(sev(owner)).toHaveText('notable');
  await expect(review(owner)).toHaveText('mark reviewed');
  await expect(reviewed(owner)).toHaveCount(0);
  await expect(sev(v)).toHaveText('notable');
  await expect(reviewed(v)).toHaveCount(0);

  // A checkpoint that sees the same migration file sha keeps it; another sha ends it.
  await review(owner).click();
  await expect(reviewed(owner)).toHaveText(by);
  await expect(reviewed(v)).toHaveText(by);
  await readers('updated', SHA);
  await expect(owner.locator('#inspector .cn-reader.updated')).toBeVisible();
  await expect(reviewed(owner)).toHaveText(by);
  await readers('stale', 'b'.repeat(40));
  await expect(owner.locator('#inspector .cn-reader.stale')).toBeVisible();
  await expect(review(owner)).toHaveText('mark reviewed');
  await expect(reviewed(owner)).toHaveCount(0);
  await expect(v.locator('#inspector .cn-reader.stale')).toBeVisible();
  await expect(reviewed(v)).toHaveCount(0);

  // D9: while the migration ref is not ok there is nothing to approve; a standing review stays clearable.
  await review(owner).click();
  await expect(review(owner)).toHaveText('clear review');
  await expect(reviewed(v)).toHaveText(by);
  await stack.callReducer(token, 'update_code_ref', [main, 1, 3, SHA, '', 'stale']);
  await expect(owner.locator('#inspector .cn-ref-stale')).toHaveText(
    'stale: these lines are as last seen, not the file now; the agent must cite the migration again before it can be reviewed'
  );
  await expect(review(owner)).toHaveText('clear review');
  await review(owner).click();
  await expect(reviewed(owner)).toHaveCount(0);
  await expect(owner.locator('#inspector .cn-ref-stale')).toBeVisible();
  await expect(review(owner)).toHaveCount(0);
  await expect(v.locator('#inspector .cn-ref-stale')).toBeVisible();
  await expect(reviewed(v)).toHaveCount(0);
});

test('a change note on a board without consent shows paths and statuses with no code panel', async ({ account, stack }) => {
  // divergent (CC-52): main still renders the migration and breaking-line code boxes (.cn-snippet) from empty text
  test.fail();
  const token = stack.accountToken();
  const B = await sessionBoard(stack, token);
  // No consent: the refs keep no text, and the reader is accepted without the term check (code-consent spec D3).
  const { pg } = await migrationNote(stack, token, B, false);
  const page = await account(token, WIDE);
  await openBoard(page, await boardLink(stack, B));
  await select(page, pg);
  const note = page.locator('#inspector .cn-note');
  await expect(note.locator('.cn-reader.stale')).toContainText(`${READER}:40`);
  await expect(note.locator('.cn-reader.stale')).toContainText('still reads');
  await expect(note.locator('.cn-snippet')).toHaveCount(0);
});
