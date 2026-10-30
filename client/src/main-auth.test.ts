import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  init: vi.fn(), dashboardHref: vi.fn(() => 'https://dash.example/'), builder: vi.fn(),
  config: {
    uri: 'ws://localhost:3000', db: 'vitest', defaultDb: 'vitest',
    accounts: 'https://id.example|canvas', requireAuth: false, dashboardUrl: 'https://dash.example/',
  },
}));
vi.mock('./config', () => ({ config: state.config }));
vi.mock('./auth', () => ({ initAuth: state.init, SignedOutError: class extends Error {} }));
vi.mock('./module_bindings/index', () => ({ DbConnection: { builder: state.builder } }));
vi.mock('./chrome', async importOriginal => ({
  ...await importOriginal<typeof import('./chrome')>(),
  setupTheme: vi.fn(), setupRailToggle: vi.fn(), setupShortcutsToggle: vi.fn(),
  dashboardHref: state.dashboardHref,
  showError: (message: string) => { document.getElementById('error-text')!.textContent = message; },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.config.db = state.config.defaultDb = 'vitest';
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div id="error-strip" hidden><span id="error-text"></span></div>';
  vi.spyOn(window, 'addEventListener');
});
afterEach(() => {
  // Each test imports main.ts afresh on the same window; drop its startup listeners.
  for (const [type, listener] of vi.mocked(window.addEventListener).mock.calls) {
    if (type === 'hashchange') window.removeEventListener(type, listener);
  }
  history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A guest's builder that keeps the connection callbacks main.ts registers.
function guestBuilder() {
  const on: { connectError?: (ctx: unknown, err: Error) => void; disconnect?: (ctx: unknown, err?: Error) => void } = {};
  state.init.mockResolvedValueOnce({ hasSession: () => false, onSignedOut: vi.fn() });
  const builder = {
    withUri() { return this; }, withDatabaseName() { return this; }, withToken() { return this; },
    onConnect() { return this; },
    onConnectError(fn: typeof on.connectError) { on.connectError = fn; return this; },
    onDisconnect(fn: typeof on.disconnect) { on.disconnect = fn; return this; },
    build: vi.fn(),
  };
  state.builder.mockReturnValueOnce(builder);
  return { builder, on };
}

describe('canvas startup after authentication', () => {
  it.each(['/?db=other&boardId=7', '/?db=other#b=private-board'])('refuses a board link from another database: %s', async href => {
    history.replaceState(null, '', href);
    await import('./main');
    expect(document.getElementById('error-text')?.textContent).toBe(
      'This link is for a database this site does not serve, so it was not opened.',
    );
    expect(state.init).not.toHaveBeenCalled();
    expect(state.builder).not.toHaveBeenCalled();
  });

  // setDb leaves this build's own database out, whatever its name, so a bare board link names it.
  it.each([
    ['/', '', ''],
    ['/?boardId=7', '?boardId=7', ''],
    ['/?db=vitest#b=private-board', '', '#b=private-board'],
    ['/?db=vitest&boardId=7', '?boardId=7', ''],
    ['/?db=vitest#s=share-token', '', '#s=share-token'],
  ])('leaves a non-production home database unnamed in durable links from %s', async (href, search, hash) => {
    history.replaceState(null, '', href);
    state.init.mockReturnValueOnce(new Promise(() => {}));
    await import('./main');
    expect(document.getElementById('error-text')?.textContent).toBe('');
    expect(location.search).toBe(search);
    expect(location.hash).toBe(hash);
  });

  it.each([
    ['/?db=rc-dev', '?db=rc-dev', ''],
    ['/?db=rc-dev#b=private-board', '?db=rc-dev', '#b=private-board'],
    ['/?db=rc-dev&boardId=7', '?db=rc-dev&boardId=7', ''],
  ])('keeps an allowed other database in durable links from %s', async (href, search, hash) => {
    state.config.db = 'rc-dev'; // pickDb took the allowed ?db=
    history.replaceState(null, '', href);
    state.init.mockReturnValueOnce(new Promise(() => {}));
    await import('./main');
    expect(location.search).toBe(search);
    expect(location.hash).toBe(hash);
  });

  it('leaves the production default unnamed without changing the board destination', async () => {
    state.config.db = state.config.defaultDb = 'redcrayon';
    history.replaceState(null, '', '/?db=redcrayon#b=private-board');
    state.init.mockReturnValueOnce(new Promise(() => {}));
    await import('./main');
    expect(location.search).toBe('');
    expect(location.hash).toBe('#b=private-board');
  });

  it.each(['sso-callback', 'create/sso-callback', 'create/continue'])(
    'leaves navigation to the provider while the signed-in page is still on #/%s', async route => {
      const callback = `#/${route}?sign_in_force_redirect_url=${encodeURIComponent(`${location.origin}/#b=shared-board`)}`;
      history.replaceState(null, '', callback);
      const auth = {
        hasSession: vi.fn(() => true), onSignedOut: vi.fn(),
        authenticatedHref: vi.fn((href: string) => href),
        freshToken: vi.fn().mockResolvedValue('fresh'),
      };
      let finishSignIn!: (value: typeof auth) => void;
      state.init.mockReturnValueOnce(new Promise(resolve => { finishSignIn = resolve; }));

      await import('./main');
      finishSignIn(auth);
      await vi.waitFor(() => expect(auth.onSignedOut).toHaveBeenCalled());
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(state.dashboardHref).not.toHaveBeenCalled();
      expect(auth.freshToken).not.toHaveBeenCalled();
      expect(state.builder).not.toHaveBeenCalled();
      expect(location.hash).toBe(callback);
    },
  );

  it('opens the board when the provider returns by changing only the hash', async () => {
    history.replaceState(null, '', `#/sso-callback?sign_in_force_redirect_url=${encodeURIComponent(`${location.origin}/#b=shared-board`)}`);
    const auth = {
      hasSession: vi.fn(() => true), onSignedOut: vi.fn(),
      authenticatedHref: vi.fn((href: string) => href),
      freshToken: vi.fn().mockResolvedValue('fresh'),
    };
    state.init.mockResolvedValueOnce(auth);
    const builder = {
      withUri() { return this; }, withDatabaseName() { return this; }, withToken() { return this; },
      onConnect() { return this; }, onConnectError() { return this; }, onDisconnect() { return this; },
      build: vi.fn(),
    };
    state.builder.mockReturnValueOnce(builder);

    await import('./main');
    await vi.waitFor(() => expect(auth.onSignedOut).toHaveBeenCalled());
    location.hash = '#/create/continue';
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.builder).not.toHaveBeenCalled();

    // The provider's redirect sets location.href; same path and search means no page load.
    location.hash = '#b=shared-board';
    await vi.waitFor(() => expect(builder.build).toHaveBeenCalled());
    expect(state.builder).toHaveBeenCalledTimes(1);
    expect(auth.freshToken).toHaveBeenCalled();
    expect(state.init).toHaveBeenCalledTimes(1);
  });

  it('still sends signed-in root visitors to the dashboard', async () => {
    history.replaceState(null, '', '/');
    const auth = {
      hasSession: () => true, onSignedOut: vi.fn(), authenticatedHref: (href: string) => href,
    };
    state.init.mockResolvedValueOnce(auth);
    await import('./main');
    await vi.waitFor(() => expect(state.dashboardHref).toHaveBeenCalled());
    expect(state.builder).not.toHaveBeenCalled();
  });

  it('allows guest startup after the callback card is dismissed', async () => {
    history.replaceState(null, '', '#/create/sso-callback');
    const auth = { hasSession: () => false, onSignedOut: vi.fn() };
    state.init.mockResolvedValueOnce(auth);
    const builder = {
      withUri() { return this; }, withDatabaseName() { return this; },
      onConnect() { return this; }, onConnectError() { return this; }, onDisconnect() { return this; },
      build: vi.fn(),
    };
    state.builder.mockReturnValueOnce(builder);
    await import('./main');
    await vi.waitFor(() => expect(builder.build).toHaveBeenCalled());
    expect(state.dashboardHref).not.toHaveBeenCalled();
  });

  describe('a refused guest token', () => {
    const key = 'stdb_token:ws://localhost:3000/vitest';
    const verifyFailed = new Error('Failed to verify token: ');
    // Lets the probe's response land without reaching the reconnect reload's timer.
    const settle = () => vi.advanceTimersByTimeAsync(0);

    async function startGuest(status: number) {
      vi.useFakeTimers();
      localStorage.setItem(key, 'guest-tok');
      const fetch = vi.fn(async () => new Response(null, { status }));
      vi.stubGlobal('fetch', fetch);
      const { builder, on } = guestBuilder();
      await import('./main');
      await vi.waitFor(() => expect(builder.build).toHaveBeenCalled());
      return { fetch, on };
    }

    it('keeps the saved token when the token endpoint answers 503 twice', async () => {
      const { fetch, on } = await startGuest(503);
      on.connectError!({}, verifyFailed);
      await settle();
      on.connectError!({}, verifyFailed);
      await settle();
      expect(localStorage.getItem(key)).toBe('guest-tok');
      expect(fetch).toHaveBeenCalledWith(new URL('http://localhost:3000/v1/identity/websocket-token'), {
        method: 'POST', headers: { Authorization: 'Bearer guest-tok' },
      });
    });

    it('clears the saved token when the token endpoint answers 401', async () => {
      const { on } = await startGuest(401);
      on.connectError!({}, verifyFailed);
      await settle();
      expect(localStorage.getItem(key)).toBeNull();
    });
  });

  it('holds the reconnect reload while someone is typing', async () => {
    vi.useFakeTimers();
    const { builder, on } = guestBuilder();
    await import('./main');
    await vi.waitFor(() => expect(builder.build).toHaveBeenCalled());
    // jsdom's Location cannot be spied on; main.ts reads the global at reload time.
    const reload = vi.fn();
    vi.stubGlobal('location', { ...location, reload });
    // Spied, not focused: earlier imports' popover listeners throw on a focusin in this bare DOM.
    const focused = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.createElement('textarea'));
    on.disconnect!({});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).not.toHaveBeenCalled();
    focused.mockReturnValue(document.body);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // A timeline slider, a switch or the read-only share link holds no draft.
  it.each(['<input type="range">', '<input type="checkbox">', '<select></select>', '<input readonly>'])(
    'still reloads on time with focus on %s', async html => {
      vi.useFakeTimers();
      const { builder, on } = guestBuilder();
      await import('./main');
      await vi.waitFor(() => expect(builder.build).toHaveBeenCalled());
      const reload = vi.fn();
      vi.stubGlobal('location', { ...location, reload });
      const field = document.createElement('div');
      field.innerHTML = html;
      vi.spyOn(document, 'activeElement', 'get').mockReturnValue(field.firstElementChild);
      on.disconnect!({});
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).toHaveBeenCalledTimes(1);
    },
  );
});
