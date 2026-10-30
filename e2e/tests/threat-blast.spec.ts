import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, openBoard, palette, boardLink, type Stack } from '../fixtures';

// A threat on the canvas (spec 2026-10-16, PR #105/#133): marker, blast radius, the docked panel and the rail.
// Boards, nodes, edges and threats are seeded through the module as the owner; the page is the owner's.

const NONE = { none: [] };
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const WIDE = { viewport: { width: 1440, height: 900 } };
type Ids = Record<string, number>;

/** src calls b and c, c calls d; lonely has no edges. */
const BLAST: Record<string, [number, number]> = { src: [100, 300], b: [400, 120], c: [400, 480], d: [700, 480], lonely: [700, 120] };
const BLAST_EDGES: [string, string][] = [['src', 'b'], ['src', 'c'], ['c', 'd']];

const unique = (name: string) => `${name} ${randomBytes(3).toString('hex')}`;

async function boardNamed(stack: Stack, name: string) {
  const [row] = await stack.sql(`SELECT id FROM board WHERE name = '${name}'`);
  return Number(row.id);
}

/** Service nodes and human-cited edges on board B, as token; ids by label and by 'from>to'. */
async function seed(stack: Stack, token: string, B: number, nodes: Record<string, [number, number]>, edges: [string, string][] = []) {
  for (const [label, [x, y]] of Object.entries(nodes)) {
    await stack.callReducer(token, 'create_node', [B, label, '', x, y, 160, 80, 'ink', false, { some: 'service' }, NONE, NONE, NONE, NONE, NONE, NONE]);
  }
  const node: Ids = {}, labelOf: Record<number, string> = {};
  for (const row of await stack.sql(`SELECT id, label FROM node WHERE board_id = ${B}`)) {
    node[String(row.label)] = Number(row.id);
    labelOf[Number(row.id)] = String(row.label);
  }
  for (const [from, to] of edges) await stack.callReducer(token, 'create_edge', [B, node[from], node[to], '', 'human:e2e', NONE, NONE, NONE]);
  const edge: Ids = {};
  for (const row of await stack.sql(`SELECT id, from_node, to_node FROM edge WHERE board_id = ${B}`)) {
    edge[`${labelOf[Number(row.from_node)]}>${labelOf[Number(row.to_node)]}`] = Number(row.id);
  }
  return { node, edge };
}

/** A new board of the owner's with these nodes and edges. */
async function board(stack: Stack, token: string, nodes: Record<string, [number, number]>, edges: [string, string][] = []) {
  const name = unique('e2e-threats');
  await stack.callReducer(token, 'create_board', [name]);
  const B = await boardNamed(stack, name);
  return { B, ...(await seed(stack, token, B, nodes, edges)) };
}

async function open(page: Page, stack: Stack, B: number, nodes: number) {
  await openBoard(page, await boardLink(stack, B));
  await expect(page.locator('#world g.node')).toHaveCount(nodes);
}

const addThreat = (stack: Stack, token: string, B: number, anchor: number, stage: string, severity: string, title: string) =>
  stack.callReducer(token, 'add_threat', [B, anchor, stage, severity, title, 'Seen in the e2e SIEM.', '', '', '', '[]', '', 'e2e']);
const threatIds = async (stack: Stack, B: number): Promise<Ids> =>
  Object.fromEntries((await stack.sql(`SELECT id, title FROM threat WHERE board_id = ${B}`)).map(row => [String(row.title), Number(row.id)]));

const node = (page: Page, id: number) => page.locator(`#world g.node[data-id="${id}"]`);
const marker = (page: Page, id: number) => page.locator(`#world g.node[data-id="${id}"] > .board-marker[role="button"]`);
const markers = (page: Page) => page.locator('#world .board-marker[role="button"]');
const edge = (page: Page, id: number) => page.locator(`#world g.edge:has(.edge-hit[data-edge-id="${id}"])`);
const dots = (page: Page) => page.locator('#world .route-dot.blast-dot');
const panel = (page: Page) => page.locator('#inspector .tc');
const row = (page: Page, id: number) => page.locator(`#inspector .tc [data-key="node:${id}"]`);
const rowLabels = async (page: Page) => (await page.locator('#inspector .tc .tc-row .tc-row-label').allTextContents()).sort();
/** Inside the node, clear of its centred label and the marker at its top right. */
const clickNode = (page: Page, id: number) => node(page, id).locator('.node-rect').click({ position: { x: 12, y: 12 } });

/** Click the middle of this edge's routed path (as evidence.spec.ts). */
async function selectEdge(page: Page, id: number) {
  const point = await page.locator(`#world .edge-hit[data-edge-id="${id}"]`).evaluate(el => {
    const path = el as SVGPathElement;
    const at = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: at.x * m.a + at.y * m.c + m.e, y: at.x * m.b + at.y * m.d + m.f };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#toolbar')).toHaveClass(/edges-only/);
}

/** Runs the palette's first match, after checking it is the command meant. */
async function runCommand(page: Page, title: string) {
  await palette(page, title.toLowerCase());
  await expect(page.locator('#palette-list .palette-title').first()).toHaveText(title);
  await page.keyboard.press('Enter');
  await expect(page.locator('#palette-input')).toBeHidden();
}

test("the marker's tone and accessible name follow the worst threat", async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, node: n } = await board(stack, token, { 'edge-vm-01': [100, 100], low: [400, 100], high: [100, 400], medium: [400, 400] });
  await addThreat(stack, token, B, n.low, 'compromised', 'low', 'Odd login');
  await addThreat(stack, token, B, n.high, 'vulnerable', 'high', 'CVE high');
  await addThreat(stack, token, B, n.medium, 'vulnerable', 'medium', 'CVE medium');
  await addThreat(stack, token, B, n['edge-vm-01'], 'compromised', 'critical', 'Bulk read of customers-db');
  await open(page, stack, B, 4);

  // TF-02: compromised is red and pulses at any severity; vulnerable is red at high, amber below.
  await expect(marker(page, n.low)).toHaveClass(/tone-red/);
  await expect(marker(page, n.low)).toHaveClass(/\bpulse\b/);
  await expect(marker(page, n.high)).toHaveClass(/tone-red/);
  await expect(marker(page, n.high)).not.toHaveClass(/\bpulse\b/);
  await expect(marker(page, n.medium)).toHaveClass(/tone-amber/);
  await expect(marker(page, n.medium)).not.toHaveClass(/\bpulse\b/);
  await stack.callReducer(token, 'set_threat_contained', [(await threatIds(stack, B))['Odd login'], true]);
  await expect(marker(page, n.low)).toHaveClass(/tone-muted/);
  await expect(marker(page, n.low)).not.toHaveClass(/\bpulse\b/);

  // TF-03: a focusable button named for its worst threat; a second threat adds ", and 1 more" and a count.
  const named = page.getByRole('button', { name: 'Threat on edge-vm-01: Bulk read of customers-db, critical, compromised', exact: true });
  await expect(named).toBeVisible();
  await expect(named).toHaveAttribute('tabindex', '0');
  await expect(marker(page, n['edge-vm-01']).locator('.board-marker-count')).toHaveCount(0);
  await addThreat(stack, token, B, n['edge-vm-01'], 'vulnerable', 'high', 'CVE-2021-23017');
  await expect(page.getByRole('button', { name: 'Threat on edge-vm-01: Bulk read of customers-db, critical, compromised, and 1 more', exact: true })).toBeVisible();
  await expect(marker(page, n['edge-vm-01']).locator('.board-marker-count')).toHaveText('2');
});

test('an open threat lights the blast radius by hop with travelling dots, and Esc clears it', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, node: n, edge: e } = await board(stack, token, BLAST, BLAST_EDGES);
  await addThreat(stack, token, B, n.src, 'compromised', 'critical', 'Forged tokens');
  await open(page, stack, B, 5);

  const world = page.locator('#world');
  await marker(page, n.src).click();
  await expect(panel(page)).toBeVisible();
  // TF-07: the blast owns the dimming; the selected anchor's neighbour dim stays off.
  await expect(world).toHaveClass(/blast-on/);
  await expect(world).not.toHaveClass(/focus-dim/);
  await expect(node(page, n.src)).toHaveClass(/blast-src/);
  await expect(node(page, n.b)).toHaveClass(/blast-hop1/);
  await expect(node(page, n.c)).toHaveClass(/blast-hop1/);
  await expect(node(page, n.d)).toHaveClass(/blast-hopn/);
  await expect(node(page, n.lonely)).toHaveClass(/blast-clear/);
  await expect.poll(() => node(page, n.lonely).evaluate(el => getComputedStyle(el).opacity)).toBe('0.22');
  await expect(node(page, n.b).locator('.hop-badge .hop-badge-text')).toHaveText('1');
  await expect(node(page, n.c).locator('.hop-badge .hop-badge-text')).toHaveText('1');
  await expect(node(page, n.d).locator('.hop-badge.hop-n .hop-badge-text')).toHaveText('2');
  await expect(edge(page, e['src>b'])).toHaveClass(/blast-hot/);
  await expect(edge(page, e['src>c'])).toHaveClass(/blast-hot/);
  await expect(edge(page, e['c>d'])).toHaveClass(/blast-warm/);
  // The flow and the pulse run with motion allowed (the reduced-motion case checks they stop).
  await expect.poll(() => edge(page, e['src>b']).locator('.edge-line').evaluate(el => getComputedStyle(el).animationName)).toBe('edge-flow-12');
  await expect(marker(page, n.src).locator('.board-marker-halo')).toHaveCSS('animation-name', 'board-marker-halo');

  // TF-08: a dot per blast edge, amber past hop 1.
  await expect(dots(page)).toHaveCount(3);
  await expect(page.locator('#world .route-dot.blast-dot.warm')).toHaveCount(1);

  // TF-13: a reach row lights its node and never moves the selection or closes the threat.
  await row(page, n.b).hover();
  await expect(node(page, n.b)).toHaveClass(/tc-lit/);
  await row(page, n.b).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.tc-title')).toHaveText('Forged tokens');
  await expect(page.locator('#inspector .insp-title')).toHaveText('src');
  await expect(node(page, n.b)).toHaveClass(/tc-lit/);
  await expect(world).toHaveClass(/blast-on/);

  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(world).not.toHaveClass(/blast-on/);
  await expect(page.locator('#world [class*="blast-"]')).toHaveCount(0);
  await expect(page.locator('#world .hop-badge')).toHaveCount(0);
  await expect.poll(() => dots(page).count()).toBe(0);
  await expect(world).toHaveClass(/focus-dim/); // the anchor stays selected: its neighbour dim is back
});

test('under reduced motion an open threat has no dots, static dashes and no pulse', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, { ...WIDE, reducedMotion: 'reduce' });
  const { B, node: n, edge: e } = await board(stack, token, BLAST, BLAST_EDGES);
  await addThreat(stack, token, B, n.src, 'compromised', 'critical', 'Forged tokens');
  await open(page, stack, B, 5);
  await marker(page, n.src).click();
  await expect(page.locator('#world')).toHaveClass(/blast-on/);
  await expect(edge(page, e['src>b'])).toHaveClass(/blast-hot/);
  await expect(dots(page)).toHaveCount(0);
  const line = await edge(page, e['src>b']).locator('.edge-line').evaluate(el => {
    const s = getComputedStyle(el);
    return { animation: s.animationName, dash: s.strokeDasharray };
  });
  expect(line.animation).toBe('none');
  expect(line.dash).not.toBe('none');
  const halo = marker(page, n.src).locator('.board-marker-halo');
  await expect(halo).toHaveCount(1);
  await expect(halo).toHaveCSS('animation-name', 'none');
});

test('the panel lists reach tiers, follows the direction and depth controls, and explains each row', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, node: n, edge: e } = await board(stack, token, { ...BLAST, caller: [-200, 300] }, [...BLAST_EDGES, ['caller', 'src']]);
  await stack.callReducer(token, 'set_node_doc', [n.b, 'Holds customer PII']);
  await addThreat(stack, token, B, n.src, 'compromised', 'critical', 'Forged tokens');
  await open(page, stack, B, 6);

  // TF-12: the peek counts the PII stores the blast reaches.
  await marker(page, n.src).hover();
  const peek = page.locator('.threat-peek');
  await expect(peek).toContainText('Reaches 4 nodes in 2 hops');
  await expect(peek.locator('.tc-pii')).toHaveText('1 PII');

  await marker(page, n.src).click();
  const tc = panel(page);
  await expect(tc).toBeVisible();
  // TF-10: tiers by hop with counts, then Clear with its caveat.
  await expect(tc.locator('.tc-tier.hop1 .tc-tier-label')).toHaveText('Exposed · 1 hop');
  await expect(tc.locator('.tc-tier.hop1 .tc-count')).toHaveText('3');
  await expect(tc.locator('.tc-tier.hopn .tc-tier-label')).toHaveText('At risk · 2 hops');
  await expect(tc.locator('.tc-tier.hopn .tc-count')).toHaveText('1');
  await expect(tc.locator('.tc-clear .tc-tier-label')).toHaveText('Clear');
  await expect(tc.locator('.tc-clear .tc-count')).toHaveText('1');
  await expect(tc.locator('.tc-caveat')).toHaveText('Read from the drawn edges, not verified.');
  // TF-12: why each node is reached, and its PII tag.
  await expect(row(page, n.b).locator('.tc-why')).toHaveText('calls');
  await expect(row(page, n.b).locator('.tc-pii')).toHaveText('PII');
  await expect(row(page, n.c).locator('.tc-why')).toHaveText('calls');
  await expect(row(page, n.c).locator('.tc-pii')).toHaveCount(0);
  await expect(row(page, n.caller).locator('.tc-why')).toHaveText('trusts it');
  await expect(row(page, n.d).locator('.tc-why')).toHaveText('via c');

  // TF-11: both and 2 by default; each control rebuilds the list and the canvas at once.
  const seg = (key: string) => tc.locator(`[data-key="seg:${key}"]`);
  await expect(seg('both')).toHaveAttribute('aria-pressed', 'true');
  await expect(seg('2')).toHaveAttribute('aria-pressed', 'true');
  await seg('reaches').click();
  await expect(seg('reaches')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => rowLabels(page)).toEqual(['b', 'c', 'd']);
  await expect(node(page, n.caller)).toHaveClass(/blast-clear/);
  await expect(edge(page, e['caller>src'])).toHaveClass(/blast-clear/);
  await seg('trusts').click();
  await expect.poll(() => rowLabels(page)).toEqual(['caller']);
  await expect(node(page, n.b)).toHaveClass(/blast-clear/);
  await expect(node(page, n.caller)).toHaveClass(/blast-hop1/);
  await seg('both').click();
  await seg('1').click();
  await expect(seg('1')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => rowLabels(page)).toEqual(['b', 'c', 'caller']);
  await expect(tc.locator('.tc-tier.hopn')).toHaveCount(0);
  await expect(node(page, n.d)).toHaveClass(/blast-clear/);
  await seg('all').click();
  await expect(node(page, n.d)).toHaveClass(/blast-hopn/);
  await expect(tc.locator('.tc-tier.hopn .tc-tier-label')).toHaveText('At risk · 2 hops');

  // TF-10: a vulnerable threat is only exposed if exploited. TF-11: J keeps a non-default direction and depth.
  await seg('reaches').click();
  await expect.poll(() => rowLabels(page)).toEqual(['b', 'c', 'd']);
  await addThreat(stack, token, B, n.c, 'vulnerable', 'high', 'CVE on c');
  await expect(marker(page, n.c)).toHaveCount(1);
  await page.keyboard.press('j');
  await expect(tc.locator('.tc-title')).toHaveText('CVE on c');
  await expect(tc.locator('.tc-tier.hop1 .tc-tier-label')).toHaveText('Exposed if exploited · 1 hop');
  await expect(seg('reaches')).toHaveAttribute('aria-pressed', 'true');
  await expect(seg('all')).toHaveAttribute('aria-pressed', 'true');
  // c only reaches d; at 'both' src, b and caller would be listed too.
  await expect.poll(() => rowLabels(page)).toEqual(['d']);
});

test('the marker works from the keyboard, and the threat closes on a second click or another selection', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, node: n, edge: e } = await board(stack, token, BLAST, BLAST_EDGES);
  await addThreat(stack, token, B, n.src, 'compromised', 'critical', 'Forged tokens');
  await open(page, stack, B, 5);
  const world = page.locator('#world');

  // TF-05: focus peeks, Enter opens with focus in the panel, Esc gives focus back to the marker.
  const m = marker(page, n.src);
  await m.focus();
  await expect(page.locator('.threat-peek')).toBeVisible();
  await expect(page.locator('.threat-peek')).toContainText('Forged tokens');
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(m).toBeFocused();

  // TF-15: a second click collapses it.
  await m.click();
  await expect(panel(page)).toBeVisible();
  await expect(world).toHaveClass(/blast-on/);
  await m.click();
  await expect(panel(page)).toHaveCount(0);
  await expect(world).not.toHaveClass(/blast-on/);

  // Selecting another node closes it too.
  await m.click();
  await expect(panel(page)).toBeVisible();
  await clickNode(page, n.b);
  await expect(page.locator('#inspector .insp-title')).toHaveText('b');
  await expect(panel(page)).toHaveCount(0);
  await expect(world).not.toHaveClass(/blast-on/);

  // So does selecting an edge.
  await m.click();
  await expect(panel(page)).toBeVisible();
  await selectEdge(page, e['src>b']);
  await expect(panel(page)).toHaveCount(0);
  await expect(world).not.toHaveClass(/blast-on/);
});

test('deleting the anchor removes its threats, and a threat removed or hidden while open closes cleanly', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, node: n } = await board(stack, token, BLAST, BLAST_EDGES);
  await addThreat(stack, token, B, n.src, 'compromised', 'critical', 'Primary');
  await addThreat(stack, token, B, n.src, 'vulnerable', 'medium', 'Secondary');
  await open(page, stack, B, 5);
  const world = page.locator('#world');

  // TF-26: the agent removes the open threat: the panel, the blast and the dots go, with no error.
  await marker(page, n.src).click();
  await expect(panel(page).locator('.tc-title')).toHaveText('Primary');
  await expect(dots(page)).toHaveCount(3);
  await stack.callReducer(token, 'remove_threat', [(await threatIds(stack, B)).Primary]);
  await expect(panel(page)).toHaveCount(0);
  await expect(world).not.toHaveClass(/blast-on/);
  await expect.poll(() => dots(page).count()).toBe(0);
  await expect(page.locator('#error-strip')).toBeHidden();
  // The other threat on that anchor still opens.
  await expect(marker(page, n.src)).toHaveAccessibleName('Threat on src: Secondary, medium, vulnerable');
  await marker(page, n.src).click();
  await expect(panel(page).locator('.tc-title')).toHaveText('Secondary');

  // Hiding the anchor while open closes it.
  await stack.callReducer(token, 'set_node_hidden', [n.src, true, NONE]);
  await expect(node(page, n.src)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect(world).not.toHaveClass(/blast-on/);
  await expect(page.locator('#error-strip')).toBeHidden();

  // TF-25: deleting the anchor deletes its threats; undo brings the node back without them.
  await stack.callReducer(token, 'set_node_hidden', [n.src, false, NONE]);
  await expect(marker(page, n.src)).toHaveCount(1);
  await marker(page, n.src).click();
  await expect(panel(page)).toBeVisible();
  await clickNode(page, n.src);
  await expect(panel(page)).toBeVisible(); // selecting the anchor keeps it open
  await page.keyboard.press('Delete');
  await expect(page.locator('#world g.node')).toHaveCount(4);
  await expect(markers(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => stack.sql(`SELECT id FROM threat WHERE board_id = ${B}`)).toEqual([]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#world g.node')).toHaveCount(5);
  await expect(page.locator('#world')).toContainText('src');
  await expect(markers(page)).toHaveCount(0);
  expect(await stack.sql(`SELECT id FROM threat WHERE board_id = ${B}`)).toEqual([]);
});

test('⌘K offers threat commands only while threats exist', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, node: n } = await board(stack, token, { 'auth-svc': [100, 100], 'users-db': [400, 100] }, [['auth-svc', 'users-db']]);
  await open(page, stack, B, 2);

  await palette(page, 'threat');
  await expect(page.locator('#palette-list .palette-title, #palette-list .palette-empty').first()).toBeVisible(); // the list has drawn
  await expect(page.locator('#palette-list')).not.toContainText('Open next threat');
  await page.keyboard.press('Escape');
  await addThreat(stack, token, B, n['auth-svc'], 'compromised', 'critical', 'Forged tokens');
  await expect(markers(page)).toHaveCount(1);
  await palette(page, 'threat');
  await expect(page.locator('#palette-list')).toContainText('Open next threat');
  await expect(page.locator('#palette-list')).not.toContainText('Close threat'); // nothing open yet
  await page.keyboard.press('Escape');

  await runCommand(page, 'Open next threat');
  await expect(panel(page)).toBeVisible();
  await palette(page, 'threat');
  await expect(page.locator('#palette-list')).toContainText('Play threat spread');
  await expect(page.locator('#palette-list')).toContainText('Close threat');
  await page.keyboard.press('Escape');
  const containedBy = async () => String((await stack.sql(`SELECT contained_by FROM threat WHERE board_id = ${B}`))[0].contained_by);
  await runCommand(page, 'Mark threat contained');
  await expect(marker(page, n['auth-svc'])).toHaveClass(/tone-muted/);
  await expect.poll(containedBy).not.toBe('');
  await runCommand(page, 'Reopen threat');
  await expect(marker(page, n['auth-svc'])).toHaveClass(/tone-red/);
  await expect.poll(containedBy).toBe('');
  await runCommand(page, 'Close threat');
  await expect(panel(page)).toHaveCount(0);
});

test('an SVG export taken with a threat open carries no threat', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, node: n } = await board(stack, token, BLAST, BLAST_EDGES);
  await addThreat(stack, token, B, n.src, 'compromised', 'critical', 'CVE-2026-31337');
  await open(page, stack, B, 5);
  await marker(page, n.src).click();
  await row(page, n.b).hover(); // a lit row too
  await expect(node(page, n.b)).toHaveClass(/tc-lit/);
  await expect(dots(page)).toHaveCount(3);

  const download = page.waitForEvent('download');
  // A real click would move the pointer off the row and unlight it before the export reads the board.
  await page.locator('#act-export').dispatchEvent('click'); // hidden for owners (Share holds Export) but still wired
  let svg = '';
  for await (const chunk of (await (await download).createReadStream())!) svg += chunk;
  for (const label of Object.keys(BLAST)) expect(svg).toContain(`>${label}<`);
  for (const leak of ['CVE-2026-31337', 'board-marker', 'hop-badge', 'blast-', 'route-comet', 'focus-dim', 'tc-lit']) expect(svg).not.toContain(leak);
  expect(svg).not.toMatch(/opacity:\s*0\.22\b/); // lonely is not dimmed in the file
  // The live board keeps its blast and the lit row.
  await expect(page.locator('#world')).toHaveClass(/blast-on/);
  await expect(node(page, n.src)).toHaveClass(/blast-src/);
  await expect(node(page, n.b)).toHaveClass(/tc-lit/);
  await expect(node(page, n.lonely)).toHaveCSS('opacity', '0.22');
});

test("the panel shows the threat's source, author, package and flags", async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, node: n } = await board(stack, token, { 'auth-svc': [100, 100] });
  const args = (url: string) => [B, n['auth-svc'], 'compromised', 'critical', 'CVE-2026-31337', 'Forged tokens.', '9.8', 'jsonwebtoken < 9.0.3', '9.0.3', '["KEV"]',
    JSON.stringify({ system: 'Splunk', ref: 'notable #48213', url }), 'claude-code'];
  await stack.callReducer(token, 'add_threat', args('https://siem.example/48213'));
  await open(page, stack, B, 1);
  await marker(page, n['auth-svc']).click();
  const tc = panel(page);
  const src = tc.locator('.tc-src');
  await expect(src).toHaveText('Splunk notable #48213');
  expect(await src.evaluate(el => el.localName)).toBe('a');
  await expect(src).toHaveAttribute('href', 'https://siem.example/48213');
  await expect(src).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(src).toHaveAttribute('target', '_blank');
  await expect(tc.locator('.tc-meta')).toContainText('just now');
  await expect(tc.locator('.tc-meta')).toContainText('noted by claude-code');
  await expect(tc.locator('.tc-meta')).toContainText('critical');
  await expect(tc.locator('.tc-pkg')).toHaveText('jsonwebtoken < 9.0.3 · CVSS 9.8 · fix 9.0.3');
  await expect(tc.locator('.tc-tags')).toHaveText('KEV');
  // Only an https source becomes a link: the module refuses any other url.
  await expect(stack.callReducer(token, 'add_threat', args('http://x'))).rejects.toThrow('threat source url must start with https://');
  expect(await stack.sql(`SELECT id FROM threat WHERE board_id = ${B}`)).toHaveLength(1);
});

/** A session board of the owner's (start_session as a person), seeded, then opened. */
async function sessionBoard(page: Page, stack: Stack, token: string, nodes: Record<string, [number, number]>, edges: [string, string][]) {
  const name = unique('e2e-session');
  await stack.callReducer(token, 'start_session', [name, '/tmp/e2e-repo', SHA]);
  const B = await boardNamed(stack, name);
  const seeded = await seed(stack, token, B, nodes, edges);
  await open(page, stack, B, Object.keys(nodes).length);
  await expect(page.locator('#session-row')).toBeVisible();
  return { B, ...seeded };
}

test('the session rail summarises threats and opens the next one', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, node: n } = await sessionBoard(page, stack, token, { 'auth-svc': [100, 100], 'users-db': [400, 100] }, [['auth-svc', 'users-db']]);
  const line = page.locator('#session-row .session-threats');
  await expect(line).toHaveCount(0);

  await addThreat(stack, token, B, n['auth-svc'], 'compromised', 'critical', 'Forged tokens');
  await expect(line).toHaveText('1 threat · auth-svc compromised');
  await expect(line).not.toHaveClass(/is-contained/);
  await line.click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.tc-title')).toHaveText('Forged tokens');

  await addThreat(stack, token, B, n['users-db'], 'vulnerable', 'high', 'CVE on users-db');
  const ids = await threatIds(stack, B);
  await stack.callReducer(token, 'set_threat_contained', [ids['Forged tokens'], true]);
  await expect(line).toHaveText('2 threats · 1 contained');
  await expect(line).not.toHaveClass(/is-contained/);
  await line.click(); // skips the contained one
  await expect(panel(page).locator('.tc-title')).toHaveText('CVE on users-db');
  await stack.callReducer(token, 'set_threat_contained', [ids['CVE on users-db'], true]);
  await expect(line).toHaveText('2 threats · 2 contained');
  await expect(line).toHaveClass(/is-contained/);
});

test('hidden edges and nodes stay out of the blast, and the rail names threats on hidden nodes', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, node: n, edge: e } = await sessionBoard(page, stack, token, { src: [100, 300], b: [400, 120], c: [400, 480] }, [['src', 'b'], ['src', 'c']]);
  await addThreat(stack, token, B, n.src, 'compromised', 'critical', 'Forged tokens');
  await marker(page, n.src).hover();
  const peek = page.locator('.threat-peek');
  await expect(peek).toContainText('Reaches 2 nodes in 1 hop');
  // The open peek follows each hide without moving the pointer.
  await stack.callReducer(token, 'set_edge_hidden', [e['src>c'], true, NONE]);
  await expect(peek).toContainText('Reaches 1 node in 1 hop');
  await stack.callReducer(token, 'set_node_hidden', [n.b, true, NONE]);
  await expect(peek).toContainText('Reaches nothing on the drawn edges');

  // Opened, c (behind the hidden edge) is clear and the hidden b is in no tier.
  await marker(page, n.src).click();
  await expect(panel(page)).toBeVisible();
  await expect(node(page, n.c)).toHaveClass(/blast-clear/);
  await expect(panel(page).locator('.tc-clear .tc-count')).toHaveText('1');
  await expect(panel(page).locator('.tc-row')).toHaveCount(0);

  const line = page.locator('#session-row .session-threats');
  await expect(line).toHaveText('1 threat · src compromised');
  await stack.callReducer(token, 'set_node_hidden', [n.src, true, NONE]);
  await expect(node(page, n.src)).toHaveCount(0);
  await expect(node(page, n.c)).toBeVisible();
  await expect(markers(page)).toHaveCount(0);
  await expect(line).toHaveText('1 threat · src compromised · 1 on a hidden node');
  await line.click();
  await expect(page.locator('#error-text')).toHaveText('Threats are on hidden nodes. Show them to open.');
  await expect(panel(page)).toHaveCount(0);
});
