import { test, expect, openBoard } from '../fixtures';

// Worker options must be top-level: this file gets its own stack, built with these extras.
test.use({ clientEnv: { VITE_MCP_URL: 'https://mcp.e2e.invalid/mcp' }, moduleEnv: { BROWSER_CLIENT_IDS: 'e2e-client' } });

test('clientEnv and moduleEnv reach the canvas build and the module publish', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await expect(page.locator('#act-connect')).toBeVisible();
  await stack.callReducer(stack.accountToken({ azp: undefined, aud: 'e2e-client' }), 'join_board', ['e2e', 'human']);
});
