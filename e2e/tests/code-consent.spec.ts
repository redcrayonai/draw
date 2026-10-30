import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, shareBoard, selectEdge, boardWith, boardLink, type Stack } from '../fixtures';

// RC-690 code consent: a board keeps code text only while its owner (or a linked agent's person)
// opts in; paths, lines, line hashes and the GitHub link stand without it. Reducers are called as
// each actor over HTTP, as the MCP server would; no MCP Worker here.

const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HEAD = 'a'.repeat(40);
const NONE = { none: [] };
const NO_CODE = 'No code stored for this reference.';
const CODE_RULE = 'code rule: this board does not store code';
const WIDE = { viewport: { width: 1440, height: 900 } };
const LINES = `${'a'.repeat(32)} ${'b'.repeat(32)}`; // one hash per line of src/a.ts:3-4
const LINE = 'c'.repeat(32);
const ODD = 'src/a b#c.ts'; // a path the GitHub link has to percent-encode
const ODD_BLOB = `https://github.com/acme/api/blob/${HEAD}/src/a%20b%23c.ts#L3-L5`;

async function boardNamed(stack: Stack, name: string) {
  const [{ id }] = await stack.sql(`SELECT id FROM board WHERE name = '${name}'`);
  return Number(id);
}

/** A session board token starts from this checkout root, opened on the page with auth-svc drawn on it. */
async function sessionBoard(page: Page, stack: Stack, token: string, root: string) {
  const name = `e2e-session-${randomBytes(3).toString('hex')}`;
  await stack.callReducer(token, 'start_session', [name, root, SHA]);
  const B = await boardNamed(stack, name);
  await openBoard(page, await boardLink(stack, B));
  await drawNode(page, 'auth-svc');
  return { B, nodeId: Number(await page.locator('#world g.node').first().getAttribute('data-id')) };
}

const addRef = (stack: Stack, token: string, B: number, nodeId: number, path: string, symbol: string, start: number, end: number, snippet = '') =>
  stack.callReducer(token, 'add_code_ref', [B, 'node', nodeId, path, symbol, start, end, SHA, snippet, 'e2e']);

const snippets = async (stack: Stack, B: number) =>
  (await stack.sql(`SELECT id, snippet FROM code_ref WHERE board_id = ${B}`)).sort((a, b) => Number(a.id) - Number(b.id)).map(r => r.snippet);

/** Selects the node and returns the inspector, which lists its code refs when the reader may see them. */
async function inspect(page: Page, label: string) {
  await page.locator('#world g.node', { hasText: label }).locator('.node-rect').click({ position: { x: 12, y: 12 } }); // clear of the centred label
  const inspector = page.locator('#inspector');
  await expect(inspector.locator('.insp-title')).toHaveText(label);
  return inspector;
}

const github = (page: Page) => page.locator('#inspector a[data-act="github"]');
const notPushed = (page: Page) => page.locator('#inspector .insp-ref-note', { hasText: 'not pushed yet' });
/** The list item of one ref: its row and, when open, its body. */
const refItem = (page: Page, symbol: string) => page.locator('#inspector li.insp-ref', { has: page.locator('.insp-ref-sym', { hasText: symbol }) });

async function deleteNode(page: Page, label: string) {
  const nodes = page.locator('#world g.node');
  const count = await nodes.count();
  await page.locator('#world g.node', { hasText: label }).locator('.node-rect').click({ position: { x: 12, y: 12 } });
  await page.keyboard.press('Delete');
  await expect(nodes).toHaveCount(count - 1);
}

/** Every code row of the board, ids as numbers. */
async function codeRows(stack: Stack, B: number) {
  return {
    refs: (await stack.sql(`SELECT id, snippet, target_id FROM code_ref WHERE board_id = ${B}`)).map(r => ({ id: Number(r.id), snippet: r.snippet, target: Number(r.target_id) })),
    refHashes: (await stack.sql(`SELECT ref_id, line_hashes FROM code_ref_hash WHERE board_id = ${B}`)).map(h => ({ refId: Number(h.ref_id), lineHashes: h.line_hashes })),
    edges: (await stack.sql(`SELECT id, evidence_snippet, from_node, to_node FROM edge WHERE board_id = ${B}`)).map(e => ({ id: Number(e.id), snippet: e.evidence_snippet, ends: [Number(e.from_node), Number(e.to_node)] })),
    edgeHashes: (await stack.sql(`SELECT edge_id, line_hash FROM edge_evidence_hash WHERE board_id = ${B}`)).map(h => ({ edgeId: Number(h.edge_id), lineHash: h.line_hash })),
  };
}

/** The ref and hash rows this page holds: a delete snapshots exactly these for undo. */
const held = (page: Page) => page.evaluate(() => {
  const db = (window as any).conn.db;
  return {
    refs: [...db.visibleCodeRef.iter()].map((r: any) => Number(r.id)),
    refHashes: [...db.visibleCodeRefHash.iter()].map((h: any) => Number(h.refId)),
    edgeHashes: [...db.visibleEdgeEvidenceHash.iter()].map((h: any) => Number(h.edgeId)),
  };
});

/** api holds a ref on src/a.ts:3-4 and cites db at src/a.ts:3, both with hash rows; text only when given. */
async function citedPair(page: Page, stack: Stack, token: string, B: number, api: number, db: number, text?: { ref: string; line: string }) {
  await stack.callReducer(token, 'add_repo_files', [B, ['src/a.ts']]);
  await addRef(stack, token, B, api, 'src/a.ts', 'handler', 3, 4, text?.ref ?? '');
  const [{ id: refId }] = await stack.sql(`SELECT id FROM code_ref WHERE board_id = ${B}`);
  await stack.callReducer(token, 'set_code_ref_hashes', [refId, LINES]);
  await stack.callReducer(token, 'create_edge', [B, api, db, 'reads', 'source:src/a.ts:3', NONE, text ? { some: text.line } : NONE, { some: 'ok' }]);
  const [{ id: edgeId }] = await stack.sql(`SELECT id FROM edge WHERE board_id = ${B}`);
  await stack.callReducer(token, 'set_edge_evidence_code', [edgeId, LINE, NONE]);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  await expect.poll(() => held(page)).toEqual({ refs: [Number(refId)], refHashes: [Number(refId)], edgeHashes: [Number(edgeId)] });
}

type Seq = 'node' | 'edge' | 'ref';
/** One throwaway node, edge or code ref on B, made and deleted through the module; returns its id. */
async function burn(stack: Stack, token: string, B: number, [api, db]: number[], seq: Seq) {
  if (seq === 'node') await stack.callReducer(token, 'create_node', [B, 'probe', '', 2400, 2400, 160, 80, 'ink', false, ...Array(7).fill(NONE)]);
  if (seq === 'edge') await stack.callReducer(token, 'create_edge', [B, api, db, 'probe', 'import', NONE, NONE, NONE]);
  if (seq === 'ref') await stack.callReducer(token, 'add_code_ref', [B, 'node', db, 'src/a.ts', 'probe', 1, 1, SHA, '', 'e2e']);
  const rows = await stack.sql(`SELECT id FROM ${seq === 'ref' ? 'code_ref' : seq} WHERE board_id = ${B}`);
  const id = Math.max(...rows.map(r => Number(r.id)));
  await stack.callReducer(token, { node: 'delete_node', edge: 'delete_edge', ref: 'remove_code_ref' }[seq], [id]);
  return id;
}

/**
 * Undo finds each row it recreates by id in one set shared by nodes, edges and refs (client/src/ops.ts
 * claimedIds), so whether it can depends on the ids the module hands out next. Throwaway rows move each
 * sequence on: apart, the recreated node, edge and ref get three different ids; collide, the ref gets the edge's.
 */
async function steerIds(stack: Stack, token: string, B: number, ends: number[], collide: boolean) {
  const next = async (seq: Seq) => (await burn(stack, token, B, ends, seq)) + 1;
  let node = await next('node'), edge = await next('edge'), ref = await next('ref');
  if (collide) {
    while (ref < edge) ref = await next('ref');
    while (edge < ref) edge = await next('edge');
    while (node === edge) node = await next('node');
  } else {
    while (edge === node) edge = await next('edge');
    while (ref === node || ref === edge) ref = await next('ref');
  }
}

/** Reload (an empty claimedIds), steer the next ids, delete api (cascading its ref, edge and hash rows), run between, then undo. */
async function deleteAndUndo(page: Page, stack: Stack, token: string, B: number, { collide = false, between = async () => {} } = {}) {
  await page.reload();
  await expect(page.locator('#world')).toContainText('api');
  const idOf = async (label: string) => Number(await page.locator('#world g.node', { hasText: label }).getAttribute('data-id'));
  const before = await codeRows(stack, B);
  await steerIds(stack, token, B, [await idOf('api'), await idOf('db')], collide);
  await expect(page.locator('#world g.node')).toHaveCount(2);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  await expect.poll(() => held(page)).toEqual({ refs: before.refs.map(r => r.id), refHashes: before.refHashes.map(h => h.refId), edgeHashes: before.edgeHashes.map(h => h.edgeId) });
  await deleteNode(page, 'api');
  await expect(page.locator('#world g.edge')).toHaveCount(0);
  await expect.poll(() => codeRows(stack, B)).toEqual({ refs: [], refHashes: [], edges: [], edgeHashes: [] });
  await between();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#world g.node')).toHaveCount(2);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  return before;
}

/** After the undo: the ref and the edge on new ids with this text, each with its hash row again. */
async function expectRestored(stack: Stack, B: number, before: Awaited<ReturnType<typeof codeRows>>, text = { ref: '', line: '' }) {
  // The ref's hash row is the restore's last write.
  await expect.poll(async () => { const r = await codeRows(stack, B); return [r.refHashes.length, r.edgeHashes.length]; }).toEqual([1, 1]);
  const { refs: [ref], refHashes, edges: [edge], edgeHashes } = await codeRows(stack, B);
  const node = async (label: string) => Number((await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = '${label}'`))[0].id);
  const [api, db] = [await node('api'), await node('db')];
  // On the recreated api node: not left on the deleted one.
  expect([ref.target, ...edge.ends]).toEqual([api, api, db]);
  expect(ref.id).not.toBe(before.refs[0].id);
  expect(edge.id).not.toBe(before.edges[0].id);
  expect([ref.snippet, edge.snippet]).toEqual([text.ref, text.line]);
  expect(refHashes).toEqual([{ refId: ref.id, lineHashes: LINES }]);
  expect(edgeHashes).toEqual([{ edgeId: edge.id, lineHash: LINE }]);
}

test('without consent a ref keeps no text; opting in shows code; opting out drops it live everywhere', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, ids: [id] } = await boardWith(page, stack, ['auth-svc']);
  await stack.callReducer(token, 'add_repo_files', [B, ['src/auth.ts', 'src/b.ts']]);
  const inspector = await inspect(page, 'auth-svc');

  // Default off: the text is refused and nothing is stored; the same ref without it lands live.
  await expect(addRef(stack, token, B, id, 'src/auth.ts', 'verify', 1, 1, 'export function verify() {}')).rejects.toThrow(CODE_RULE);
  expect(await stack.sql(`SELECT id FROM code_ref WHERE board_id = ${B}`)).toEqual([]);
  await addRef(stack, token, B, id, 'src/auth.ts', 'verify', 1, 1);
  await expect(inspector.locator('.insp-ref-sym')).toHaveText('verify');
  await expect(inspector.locator('.insp-ref-loc')).toHaveText('src/auth.ts:1');
  await expect(inspector.locator('[data-act="copy"]')).toHaveText('copy ref');
  await expect(inspector.locator('.insp-ref-note', { hasText: NO_CODE })).toBeVisible();
  await expect(inspector.locator('.insp-code')).toHaveCount(0);
  await expect(inspector.locator('a[data-act="privacy"]')).toHaveCount(0); // the e2e build sets no privacy URL
  await inspector.screenshot({ path: test.info().outputPath('no-code.png') });

  // Opting in stores nothing at once: the old ref keeps its note, a new ref brings its code.
  await stack.callReducer(token, 'set_code_consent', [true]);
  await addRef(stack, token, B, id, 'src/b.ts', 'check', 10, 10, 'export function check() {}');
  // Another board of theirs keeps code too, until the opt-out below.
  const other = `e2e-other-${randomBytes(3).toString('hex')}`;
  await stack.callReducer(token, 'start_session', [other, '/repo', SHA]);
  const B2 = await boardNamed(stack, other);
  await stack.callReducer(token, 'create_node', [B2, 'jobs', '', 400, 300, 160, 80, 'ink', false, ...Array(7).fill(NONE)]);
  const [{ id: jobs }] = await stack.sql(`SELECT id FROM node WHERE board_id = ${B2}`);
  await stack.callReducer(token, 'add_repo_files', [B2, ['src/jobs.ts']]);
  await addRef(stack, token, B2, Number(jobs), 'src/jobs.ts', 'run', 1, 1, 'export function run() {}');
  expect(await snippets(stack, B2)).toEqual(['export function run() {}']);
  await expect(inspector.locator('.insp-ref-sym')).toHaveText(['verify', 'check']);
  await expect(refItem(page, 'verify').locator('.insp-ref-note', { hasText: NO_CODE })).toBeVisible();
  expect(await snippets(stack, B)).toEqual(['', 'export function check() {}']);
  await inspector.locator('.insp-ref-row', { hasText: 'check' }).click();
  const code = inspector.locator('.insp-code');
  await expect(code.locator('.code-text')).toContainText('export function check');
  await expect(code.locator('.code-gutter').first()).toHaveText('10');
  await expect(code.locator('.code-sym')).toHaveText('check');

  // An edit-link editor in another browser reads the same code.
  const link = await shareBoard(page, 'edit');
  await page.locator('#act-share').click(); // closes the share menu
  const editor = await account();
  await editor.goto(link);
  const theirs = await inspect(editor, 'auth-svc');
  await theirs.locator('.insp-ref-row', { hasText: 'check' }).click();
  await expect(theirs.locator('.insp-code .code-text')).toContainText('export function check');
  await expect(code.locator('.code-text')).toContainText('export function check');

  // Opting out blanks the text at once: both open inspectors drop the code without a reload.
  await stack.callReducer(token, 'set_code_consent', [false]);
  for (const reader of [page, editor]) {
    await expect(refItem(reader, 'check').locator('.insp-ref-note', { hasText: NO_CODE })).toBeVisible();
    await expect(reader.locator('#inspector .insp-code')).toHaveCount(0);
  }
  expect(await snippets(stack, B)).toEqual(['', '']);
  expect(await snippets(stack, B2)).toEqual(['']);

  await page.reload();
  await inspect(page, 'auth-svc');
  await inspector.locator('.insp-ref-row', { hasText: 'check' }).click();
  await expect(refItem(page, 'check').locator('.insp-ref-note', { hasText: NO_CODE })).toBeVisible();
  await expect(code).toHaveCount(0);
});

test('the GitHub link points at the pushed commit, and a dirty or unpushed file says not pushed yet', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, ids: [id] } = await boardWith(page, stack, ['auth-svc']); // no session row: no checkpoint gating
  await stack.callReducer(token, 'add_repo_files', [B, [ODD]]);
  await addRef(stack, token, B, id, ODD, 'verify', 3, 5);
  const inspector = await inspect(page, 'auth-svc');
  await expect(inspector.locator('.insp-ref-loc')).toHaveText('src/a b#c.ts:3–5');
  // No remote row: neither a link nor 'not pushed yet', in the ref's open body.
  await expect(inspector.locator('.insp-ref-note', { hasText: NO_CODE })).toBeVisible();
  await expect(github(page)).toHaveCount(0);
  await expect(notPushed(page)).toHaveCount(0);

  const remote = (url: string, head = HEAD, dirty: string[] = []) => stack.callReducer(token, 'set_session_remote', [B, url, head, dirty]);
  await remote('git@github.com:acme/api.git');
  await expect(github(page)).toHaveText('open on GitHub');
  await expect(github(page)).toHaveAttribute('href', ODD_BLOB);
  await expect(github(page)).toHaveAttribute('target', '_blank');
  await expect(github(page)).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(notPushed(page)).toHaveCount(0);

  // Another host gets neither (GitLab is later).
  await remote('git@gitlab.com:acme/api.git');
  await expect(github(page)).toHaveCount(0);
  await expect(notPushed(page)).toHaveCount(0);

  // Each github.com form gives the same link; a dirty path or an unpushed head takes it away, live.
  await remote('https://github.com/acme/api');
  await expect(github(page)).toHaveAttribute('href', ODD_BLOB);
  await remote('https://github.com/acme/api', HEAD, [ODD]);
  await expect(notPushed(page)).toBeVisible();
  await expect(github(page)).toHaveCount(0);
  await remote('ssh://git@github.com/acme/api.git');
  await expect(github(page)).toHaveAttribute('href', ODD_BLOB);
  await expect(notPushed(page)).toHaveCount(0);
  // With consent the link stands beside the stored code.
  await stack.callReducer(token, 'set_code_consent', [true]);
  await addRef(stack, token, B, id, ODD, 'check', 3, 5, 'export function check() {}');
  await inspector.locator('.insp-ref-row', { hasText: 'check' }).click();
  await expect(inspector.locator('.insp-code .code-text').first()).toContainText('export function check');
  await expect(github(page)).toHaveAttribute('href', ODD_BLOB);
  await remote('ssh://git@github.com/acme/api.git', '');
  await expect(notPushed(page)).toBeVisible();
  await expect(github(page)).toHaveCount(0);
});

test('on a session board, open in editor stays, and a ref newer than the checkpoint waits for it', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, { ...WIDE, permissions: ['clipboard-read', 'clipboard-write'] });
  const { B, nodeId } = await sessionBoard(page, stack, token, '/repo');
  await stack.callReducer(token, 'add_repo_files', [B, ['src/auth.ts', 'src/other.ts']]);
  await addRef(stack, token, B, nodeId, 'src/auth.ts', 'verify', 3, 5);
  const remote = (dirty: string[], head = HEAD) => stack.callReducer(token, 'set_session_remote', [B, 'https://github.com/acme/api', head, dirty]);
  await remote([]);
  const inspector = await inspect(page, 'auth-svc');
  const open = inspector.locator('a[data-act="open"]');
  const asof = inspector.locator('.insp-ref-asof');
  const blob = `https://github.com/acme/api/blob/${HEAD}/src/auth.ts#L3-L5`;

  // The ref belongs to the next checkpoint: the pushed commit may not hold its lines yet.
  await expect(asof).toContainText('not yet checkpointed');
  await expect(notPushed(page)).toBeVisible();
  await expect(github(page)).toHaveCount(0);
  await expect(open).toHaveAttribute('href', 'vscode://file/repo/src/auth.ts:3');
  await stack.callReducer(token, 'mark_checkpoint', [B, HEAD, '{}']);
  await expect(github(page)).toHaveAttribute('href', blob);
  await expect(asof).toContainText('checkpoint 1');
  await expect(notPushed(page)).toHaveCount(0);

  // A dirty copy of this path says not pushed yet and keeps open in editor; another dirty path does not.
  await remote(['src/auth.ts']);
  await expect(notPushed(page)).toBeVisible();
  await expect(github(page)).toHaveCount(0);
  await expect(open).toHaveAttribute('href', 'vscode://file/repo/src/auth.ts:3');
  await remote(['src/other.ts']);
  await expect(github(page)).toHaveAttribute('href', blob);
  await expect(notPushed(page)).toHaveCount(0);
  // So does an unpushed head.
  await remote([], '');
  await expect(notPushed(page)).toBeVisible();
  await expect(github(page)).toHaveCount(0);
  await expect(open).toHaveAttribute('href', 'vscode://file/repo/src/auth.ts:3');
  await remote([]);
  await expect(github(page)).toHaveAttribute('href', blob);

  // copy ref, and ⌥-click on open in editor copies its link; both labels flip back.
  const copy = inspector.locator('[data-act="copy"]');
  await copy.click();
  await expect(copy).toHaveText('copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('src/auth.ts:3-5');
  await expect(copy).toHaveText('copy ref');
  await open.click({ modifiers: ['Alt'] });
  await expect(open).toHaveText('link copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('vscode://file/repo/src/auth.ts:3');
  await expect(open).toHaveText('open in editor');

  // ⌘K switches the editor; the choice survives a reload.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#palette-input')).toBeFocused();
  await page.locator('#palette-input').fill('Editor for code links');
  await expect(page.locator('#palette-list')).toContainText('Editor for code links: Cursor');
  await page.keyboard.press('Enter');
  await expect(open).toHaveAttribute('href', 'cursor://file/repo/src/auth.ts:3');
  await page.reload();
  await inspect(page, 'auth-svc');
  await expect(open).toHaveAttribute('href', 'cursor://file/repo/src/auth.ts:3');
  await expect(github(page)).toHaveAttribute('href', blob);

  // A checkpoint that saw the file deleted: no link, no editor, and the row says so.
  await stack.callReducer(token, 'mark_checkpoint', [B, HEAD, JSON.stringify({ changed: 1, uncovered: [], excluded: [], deleted: ['src/auth.ts'] })]);
  await expect(inspector.locator('.insp-chip.deleted')).toHaveText('deleted');
  await expect(inspector.locator('.insp-ref-note', { hasText: 'open in editor unavailable · file deleted' })).toBeVisible();
  await expect(open).toHaveCount(0);
  await expect(github(page)).toHaveCount(0);
  await expect(notPushed(page)).toHaveCount(0);
});

test('undo on a board without consent brings the ref and cited edge back with their hash rows on new ids', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, ids } = await boardWith(page, stack, ['api', 'db']);
  await citedPair(page, stack, token, B, ids[0], ids[1]);
  const before = await deleteAndUndo(page, stack, token, B);
  await expectRestored(stack, B, before);
  const inspector = await inspect(page, 'api');
  await expect(inspector.locator('.insp-ref-sym')).toHaveText('handler');
  await expect(inspector.locator('.insp-ref-note', { hasText: NO_CODE })).toBeVisible();
  await expect(page.locator('#error-strip')).toBeHidden();
});

test('undo brings the ref back even when the module gives it the id of the edge restored just before', async ({ account, stack }) => {
  // divergent (CC-12): ops.ts claimedIds is one set for node, edge and ref captures, so this ref is never captured; undo stalls without its hash row or an error
  test.fail();
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, ids } = await boardWith(page, stack, ['api', 'db']);
  await citedPair(page, stack, token, B, ids[0], ids[1]);
  const before = await deleteAndUndo(page, stack, token, B, { collide: true });
  await expect.poll(async () => (await codeRows(stack, B)).refs.length).toBe(1);
  const { refs: [ref], edges: [edge] } = await codeRows(stack, B);
  test.skip(ref.id !== edge.id, 'id sequences did not line up');
  await expectRestored(stack, B, before);
});

test('undo restores code text with consent, and restores without text after consent is turned off', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, ids } = await boardWith(page, stack, ['api', 'db']);
  await stack.callReducer(token, 'set_code_consent', [true]);
  const text = { ref: 'export function handler() {}', line: 'const a = 1' };
  await citedPair(page, stack, token, B, ids[0], ids[1], text);

  // With consent the text comes back with the ref.
  let before = await deleteAndUndo(page, stack, token, B);
  await expectRestored(stack, B, before, text);
  const inspector = await inspect(page, 'api');
  await expect(inspector.locator('.insp-code .code-text')).toContainText('export function handler');

  // Consent goes between the delete and the undo: the module refuses the text, the canvas restores without it.
  before = await deleteAndUndo(page, stack, token, B, { between: () => stack.callReducer(token, 'set_code_consent', [false]) });
  await expectRestored(stack, B, before);
  await inspect(page, 'api');
  await expect(inspector.locator('.insp-ref-note', { hasText: NO_CODE })).toBeVisible();
  await expect(page.locator('#error-text')).not.toContainText('code rule');
  await expect(page.locator('#error-strip')).toBeHidden();
});

test('a view link without Code carries no code refs; ticking Code shows the ref and its GitHub link live', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, ids: [id] } = await boardWith(page, stack, ['auth-svc']);
  await stack.callReducer(token, 'add_repo_files', [B, [ODD]]);
  await addRef(stack, token, B, id, ODD, 'verify', 3, 5);
  await stack.callReducer(token, 'set_session_remote', [B, 'git@github.com:acme/api.git', HEAD, []]);
  const link = await shareBoard(page, 'view');
  const code = page.locator('#share-code');
  await expect(code).not.toBeChecked();

  const viewer = await guest();
  await viewer.goto(link);
  const inspector = await inspect(viewer, 'auth-svc');
  // What the server sends: no ref and no remote row, not just a hidden section. The canvas subscribes to
  // these apart from the nodes, so read them once a subscription of our own has been applied.
  const rowsSent = () => viewer.evaluate(() => new Promise<number[]>((resolve, reject) => {
    const conn = (window as any).conn;
    conn.subscriptionBuilder()
      .onApplied(() => resolve([[...conn.db.visibleCodeRef.iter()].length, [...conn.db.visibleSessionRemote.iter()].length]))
      .onError((ctx: any) => reject(new Error(String(ctx.event))))
      .subscribe(['SELECT * FROM visible_code_ref', 'SELECT * FROM visible_session_remote']);
  }));
  expect(await rowsSent()).toEqual([0, 0]);
  await expect(inspector.locator('.insp-ref-row')).toHaveCount(0);
  await expect(github(viewer)).toHaveCount(0);

  await code.check();
  await expect(inspector.locator('.insp-ref-loc')).toHaveText('src/a b#c.ts:3–5');
  await expect(github(viewer)).toHaveAttribute('href', ODD_BLOB);
  expect(await rowsSent()).toEqual([1, 1]);
  await code.uncheck();
  await expect(inspector.locator('.insp-ref-row')).toHaveCount(0);
  await expect(github(viewer)).toHaveCount(0);
  await expect.poll(rowsSent).toEqual([0, 0]);
});

test('link visitors never see the checkout path', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, nodeId } = await sessionBoard(page, stack, token, '/home/alice/secret-repo');
  await stack.callReducer(token, 'add_repo_files', [B, ['src/auth.ts']]);
  await addRef(stack, token, B, nodeId, 'src/auth.ts', 'verify', 1, 1);
  const mine = await inspect(page, 'auth-svc');
  await expect(mine.locator('a[data-act="open"]')).toHaveAttribute('href', 'vscode://file/home/alice/secret-repo/src/auth.ts:1');

  const link = await shareBoard(page, 'edit');
  const visitor = await account();
  await visitor.goto(link);
  const theirs = await inspect(visitor, 'auth-svc');
  await expect(theirs.locator('.insp-ref-sym')).toHaveText('verify');
  await expect(theirs.locator('a[data-act="open"]')).toHaveCount(0);
  await expect(theirs.locator('.insp-ref-note', { hasText: 'open in editor unavailable · path or repo root not linkable' })).toBeVisible();
  // The server blanks the root for non-members; nothing on the page names it.
  const roots = (reader: Page) => reader.evaluate(() => [...(window as any).conn.db.visibleSession.iter()].map((s: any) => s.repoRoot));
  await expect.poll(() => roots(visitor)).toEqual(['']);
  expect(await visitor.content()).not.toContain('secret-repo');

  // A view link with Code ticked: a guest reads the ref, still without the root.
  const view = page.getByRole('button', { name: 'Can view', exact: true });
  await view.click();
  await expect(view).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#share-code').check();
  const viewLink = await page.locator('#share-url').inputValue();
  const guestPage = await guest();
  await guestPage.goto(viewLink);
  const guests = await inspect(guestPage, 'auth-svc');
  await expect(guests.locator('.insp-ref-sym')).toHaveText('verify');
  await expect(guests.locator('.insp-ref-note', { hasText: 'open in editor unavailable · path or repo root not linkable' })).toBeVisible();
  await expect(guests.locator('a[data-act="open"]')).toHaveCount(0);
  await expect.poll(() => roots(guestPage)).toEqual(['']);
  expect(await guestPage.content()).not.toContain('secret-repo');
});

test('without consent a source citation keeps its location but no line', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, ids: [n1, n2] } = await boardWith(page, stack, ['api', 'db']);
  await stack.callReducer(token, 'add_repo_files', [B, ['src/a.ts']]);
  const cite = (line: unknown) => stack.callReducer(token, 'create_edge', [B, n1, n2, 'reads', 'source:src/a.ts:3', NONE, line, { some: 'ok' }]);
  await expect(cite({ some: 'const a = 1' })).rejects.toThrow('code rule:');
  expect(await stack.sql(`SELECT id FROM edge WHERE board_id = ${B}`)).toEqual([]);
  await cite(NONE);
  const [{ id: edgeId }] = await stack.sql(`SELECT id FROM edge WHERE board_id = ${B}`);
  await expect(stack.callReducer(token, 'set_edge_evidence_code', [edgeId, LINE, { some: 'const a = 1' }])).rejects.toThrow('code rule:');
  await stack.callReducer(token, 'set_edge_evidence_code', [edgeId, LINE, NONE]);
  expect(await stack.sql(`SELECT evidence_snippet, evidence_status FROM edge WHERE board_id = ${B}`)).toEqual([{ evidence_snippet: '', evidence_status: 'ok' }]);

  await expect(page.locator('#world g.edge')).toHaveCount(1);
  await page.keyboard.press('Escape'); // the last drawn node's toolbar can cover the edge
  await selectEdge(page);
  const inspector = page.locator('#inspector');
  await expect(inspector.locator('.insp-chiprow .insp-chip')).toHaveText('source');
  await expect(inspector.locator('.insp-cite')).toHaveText('src/a.ts:3');
  await page.locator('#overlay-row').click();
  await expect(page.locator('#legend-summary')).toContainText('1 proven');
});

test("agent boards follow their person's consent", async ({ account, stack }) => {
  test.setTimeout(90_000);
  // An unlinked agent's own board, with consent of its own, stores code.
  const agent = await stack.mintIdentity();
  await stack.callReducer(agent.token, 'join_board', ['e2e-agent', 'agent']);
  const name = `e2e-agent-board-${randomBytes(3).toString('hex')}`;
  await stack.callReducer(agent.token, 'start_session', [name, '/repo', SHA]);
  const B = await boardNamed(stack, name);
  await stack.callReducer(agent.token, 'create_node', [B, 'auth-svc', '', 400, 300, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  const [{ id }] = await stack.sql(`SELECT id FROM node WHERE board_id = ${B}`);
  const nodeId = Number(id);
  await stack.callReducer(agent.token, 'set_code_consent', [true]);
  await stack.callReducer(agent.token, 'add_repo_files', [B, ['src/auth.ts', 'src/b.ts']]);
  await addRef(stack, agent.token, B, nodeId, 'src/auth.ts', 'verify', 1, 1, 'export function verify() {}');
  expect(await snippets(stack, B)).toEqual(['export function verify() {}']);

  // Linking hands the board to a person who never opted in: its text goes.
  const token = stack.accountToken();
  const code = randomBytes(32).toString('base64url');
  await stack.callReducer(agent.token, 'offer_agent_link', [code]);
  await stack.callReducer(token, 'redeem_agent_link', [code]);
  expect(await snippets(stack, B)).toEqual(['']);
  // The agent's own consent no longer counts: its text is refused while the person is off.
  await expect(addRef(stack, agent.token, B, nodeId, 'src/b.ts', 'check', 10, 10, 'export function check() {}')).rejects.toThrow(CODE_RULE);
  expect(await snippets(stack, B)).toEqual(['']);
  const page = await account(token, WIDE);
  await openBoard(page, await boardLink(stack, B));
  const inspector = await inspect(page, 'auth-svc');
  await expect(inspector.locator('.insp-ref-sym')).toHaveText('verify');
  await expect(inspector.locator('.insp-ref-note', { hasText: NO_CODE })).toBeVisible();
  await expect(inspector.locator('.insp-code')).toHaveCount(0);

  // The person's choice now decides: on, the agent's next ref keeps its code; off, it goes live.
  await stack.callReducer(token, 'set_code_consent', [true]);
  await addRef(stack, agent.token, B, nodeId, 'src/b.ts', 'check', 10, 10, 'export function check() {}');
  await inspector.locator('.insp-ref-row', { hasText: 'check' }).click();
  await expect(inspector.locator('.insp-code .code-text')).toContainText('export function check');
  await stack.callReducer(token, 'set_code_consent', [false]);
  await expect(refItem(page, 'check').locator('.insp-ref-note', { hasText: NO_CODE })).toBeVisible();
  await expect(inspector.locator('.insp-code')).toHaveCount(0);
  expect(await snippets(stack, B)).toEqual(['', '']);
});
