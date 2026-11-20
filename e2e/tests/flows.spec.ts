import { test, expect, openBoard, boardIdOf, nodes, type Stack } from '../fixtures';

// Flows: a walk-through with a colour paints its path on the board, the legend lists it,
// and a reader can show one flow alone and step through it.

const NONE = { none: [] };
const some = (v: unknown) => ({ some: v });
/** FLOW_SHOTS=1 also writes screenshots to .context/ for a person to look at. */
const shot = async (page: import('@playwright/test').Page, name: string, settleMs: number) => {
  if (!process.env.FLOW_SHOTS) return;
  await page.waitForTimeout(settleMs); // the camera and the fade, for the picture only
  await page.screenshot({ path: `../.context/${name}.png` });
};

const NODES: [key: string, label: string, sub: string, x: number, y: number, kind: string][] = [
  ['web', 'Web app', 'Next.js', 0, 180, 'service'], ['mobile', 'Mobile app', 'React Native', 0, 420, 'service'],
  ['gw', 'API gateway', 'routes, rate limits', 300, 304, 'service'],
  ['auth', 'Auth service', 'sessions, tokens', 600, 0, 'service'], ['catalog', 'Catalog', 'products, prices', 600, 152, 'service'],
  ['cart', 'Cart', 'line items', 600, 304, 'service'], ['checkout', 'Checkout', 'totals, tax', 600, 456, 'service'], ['orders', 'Orders', 'order state', 600, 608, 'service'],
  ['index', 'Search index', 'OpenSearch', 900, 152, 'datastore'], ['pay', 'Payments', 'intents, refunds', 900, 456, 'service'],
  ['bus', 'Event bus', 'order events', 900, 608, 'service'], ['notify', 'Notifications', 'email, push', 900, 760, 'service'],
  ['idp', 'Identity provider', 'OIDC', 1200, 0, 'external'], ['pg', 'Cart store', 'Postgres', 1200, 304, 'datastore'],
  ['card', 'Card processor', 'external', 1200, 456, 'external'], ['worker', 'Fulfilment worker', 'picks, packs', 1200, 608, 'service'], ['wh', 'Warehouse API', 'external', 1200, 760, 'external'],
];
const EDGES: [string, string, string][] = [
  ['web', 'gw', ''], ['mobile', 'gw', ''], ['gw', 'auth', 'sign in'], ['auth', 'idp', 'verify'], ['gw', 'catalog', 'search'], ['catalog', 'index', 'query'],
  ['gw', 'cart', 'add item'], ['cart', 'pg', 'save'], ['cart', 'checkout', 'begin'], ['checkout', 'pay', 'charge'], ['pay', 'card', 'authorise'], ['checkout', 'orders', 'place order'],
  ['orders', 'bus', 'order placed'], ['bus', 'worker', 'fulfil'], ['worker', 'wh', 'ship'], ['bus', 'notify', 'confirm'],
];
const FLOWS: [name: string, color: string, title: string, steps: string[][]][] = [
  ['Checkout', 'blue', 'How an order is paid', [['web'], ['gw'], ['cart', 'pg'], ['checkout'], ['pay'], ['card'], ['orders']]],
  ['Sign-in', 'pink', 'How a session starts', [['web'], ['gw'], ['auth'], ['idp']]],
  ['Search', 'teal', 'How a shopper finds a product', [['web'], ['gw'], ['catalog'], ['index']]],
  ['Order fulfilment', 'yellow', 'What happens after an order is placed', [['orders'], ['bus'], ['worker'], ['wh'], ['notify']]],
];

async function seed(stack: Stack, token: string, B: number) {
  for (const [, label, sub, x, y, kind] of NODES) {
    await stack.callReducer(token, 'create_node', [B, label, sub, x, y, 176, 72, 'ink', false, some(kind), NONE, NONE, NONE, label === 'Checkout' ? some('blue-bold') : NONE, NONE, NONE]);
  }
  const rows = await stack.sql(`SELECT id, label FROM node WHERE board_id = ${B}`);
  const id = (key: string) => Number(rows.find(r => r.label === NODES.find(n => n[0] === key)![1])!.id);
  for (const [from, to, label] of EDGES) await stack.callReducer(token, 'create_edge', [B, id(from), id(to), label, 'human:e2e', NONE, NONE, NONE]);
  // One plain walk-through as well: it must stay out of the legend.
  await stack.callReducer(token, 'save_telling', [B, 'Product', 'The shop in one minute', JSON.stringify([{ nodes: [String(id('web'))], title: 'Start', body: 'Shoppers start here.' }]), 'e2e']);
  for (const [name, color, title, steps] of FLOWS) {
    await stack.callReducer(token, 'save_telling', [B, name, title, JSON.stringify(steps.map((keys, i) => ({ nodes: keys.map(k => String(id(k))), title: `Step ${i + 1}`, body: `${name} passes through here.` }))), 'e2e']);
    await stack.callReducer(token, 'set_telling_color', [B, name, color]);
  }
  return id;
}

test('a flow paints its path, the legend shows one flow alone, and Step through plays it', async ({ account, stack }) => {
  test.setTimeout(120_000);
  const token = stack.accountToken();
  const page = await account(token, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: process.env.FLOW_SHOTS ? 2 : 1 });
  await openBoard(page, `${stack.url}?new=1`);
  const B = await boardIdOf(stack, page);
  const id = await seed(stack, token, B);
  const node = (key: string) => page.locator(`#world g.node[data-id="${id(key)}"]`);
  await expect(nodes(page)).toHaveCount(NODES.length);
  await expect(page.locator('#world g.edge')).toHaveCount(EDGES.length);
  await page.keyboard.press('Shift+Digit1');

  // Every flow at once: a node or edge only one flow uses wears its hue; shared nodes get a dot per flow.
  const legend = page.locator('#flow-legend');
  await expect(legend.locator('.flow-legend-row')).toHaveText(['Checkout7 steps', 'Sign-in4 steps', 'Search4 steps', 'Order fulfilment5 steps']);
  await expect(node('cart')).toHaveClass(/color-blue/);
  await expect(node('auth')).toHaveClass(/color-pink/);
  await expect(node('index')).toHaveClass(/color-teal/);
  await expect(node('worker')).toHaveClass(/color-yellow/);
  await expect(node('checkout')).toHaveClass(/color-blue tone-bold/); // its own colour
  await expect(node('gw')).not.toHaveClass(/color-/);
  await expect(node('gw').locator('.node-flow-dot')).toHaveCount(3);
  await expect(node('orders').locator('.node-flow-dot')).toHaveCount(2);
  await expect(node('mobile').locator('.node-flow-dot')).toHaveCount(0);
  await expect(page.locator('#world .edge-line.color-blue')).toHaveCount(6);
  await expect(page.locator('#world .edge-line.color-yellow')).toHaveCount(4);
  await shot(page, 'flows-real-1-all', 500);

  // One flow alone: its whole path in its hue, shared trunk included, numbered; the rest dims.
  await legend.locator('.flow-legend-row', { hasText: 'Checkout' }).click();
  await expect(page.locator('#world')).toHaveClass(/flow-only/);
  await expect(legend.locator('.flow-legend-row', { hasText: 'Checkout' })).toHaveAttribute('aria-pressed', 'true');
  await expect(node('gw')).toHaveClass(/color-blue/);
  await expect(node('web')).toHaveClass(/color-blue/);
  await expect(node('auth')).toHaveClass(/flow-out/);
  await expect(node('mobile')).toHaveClass(/flow-out/);
  await expect(page.locator('#world g.node:not(.flow-out)')).toHaveCount(8);
  await expect(page.locator('#world g.node .node-step')).toHaveCount(8);
  await expect(node('orders').locator('.node-step-number')).toHaveText('7');
  await expect(page.locator('#world .edge-line.color-blue')).toHaveCount(7);
  await expect(node('gw').locator('.node-flow-dot')).toHaveCount(0);
  await expect.poll(async () => Number(await node('auth').evaluate(el => getComputedStyle(el).opacity))).toBeLessThan(0.3);
  await shot(page, 'flows-real-2-one', 900);

  // Step through plays that flow in its hue; leaving it comes back to the flow shown alone.
  await legend.getByRole('button', { name: 'Step through' }).click();
  const bar = page.locator('#telling-bar');
  await expect(bar).toBeVisible();
  await expect(legend).toBeHidden();
  await expect(bar.locator('.telling-count')).toHaveText('1 of 7');
  await bar.getByRole('button', { name: 'Next' }).click();
  await bar.getByRole('button', { name: 'Next' }).click();
  await expect(bar.locator('.telling-count')).toHaveText('3 of 7');
  await expect(node('cart')).toHaveClass(/telling-lit/);
  await expect(node('gw')).toHaveClass(/color-blue/);
  await shot(page, 'flows-real-3-step', 1200);
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  await expect(legend).toBeVisible();
  await expect(page.locator('#world')).toHaveClass(/flow-only/);

  await legend.getByRole('button', { name: 'Show all' }).click();
  await expect(page.locator('#world')).not.toHaveClass(/flow-only/);
  await expect(node('gw')).not.toHaveClass(/color-/);
  await expect(node('auth')).not.toHaveClass(/flow-out/);

  // A colour is one flow's on a board, and removing the colour takes the flow out of the legend.
  await expect(stack.callReducer(token, 'set_telling_color', [B, 'Search', 'blue'])).rejects.toThrow(/blue already marks Checkout/);
  await stack.callReducer(token, 'set_telling_color', [B, 'Search', '']);
  await expect(legend.locator('.flow-legend-row')).toHaveCount(3);
  await expect(node('index')).not.toHaveClass(/color-/);
});
