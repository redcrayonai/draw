import { afterEach, expect, it, vi } from 'vitest';
import localPi from './local-pi-extension';
import { localCall } from './local-mcp';
vi.mock('./local-mcp', () => ({ localEndpoint: () => ({ origin: 'http://127.0.0.1:1234', token: 'test' }), localCall: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('keeps deliveries inside the current pi session and aborts its poll before switching sessions', async () => {
  vi.stubEnv('DRAW_LOCAL_BOARD', 'board');
  const handlers = new Map<string, Function>(), sendUserMessage = vi.fn(), registerMcpServer = vi.fn(), notify = vi.fn();
  const polls: { resolve(value: object): void; signal: AbortSignal }[] = [];
  vi.mocked(localCall).mockImplementation(async (_endpoint, value, signal) => {
    if ((value as any).action !== 'poll_local_agent') return {};
    return new Promise((resolve, reject) => { polls.push({ resolve, signal: signal! }); signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  });
  localPi({ on: (name, fn) => { handlers.set(name, fn); }, sendUserMessage, registerMcpServer });
  const context = (session: string) => ({ cwd: process.cwd(), isIdle: () => true, abort: vi.fn(), sessionManager: { getSessionId: () => session }, ui: { notify } });
  await handlers.get('session_start')!({}, context('first'));
  polls[0].resolve({ type: 'message', id: 'delivery', text: 'feedback' });
  await vi.waitFor(() => expect(localCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ack_local_agent', session: 'pi:first', id: 'delivery' }), undefined));
  expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith('feedback');
  await handlers.get('session_start')!({}, context('second'));
  expect(polls[1].signal.aborted).toBe(true);
  polls[1].resolve({ type: 'message', id: 'stale', text: 'must not deliver' });
  await handlers.get('agent_start')!();
  expect(sendUserMessage).toHaveBeenCalledTimes(1);
  expect(localCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'local_agent_event', session: 'pi:second', event: { type: 'state', state: 'working' } }), undefined);
  await handlers.get('session_shutdown')!();
  expect(polls.at(-1)!.signal.aborted).toBe(true);
  expect(notify).not.toHaveBeenCalled();
  expect(registerMcpServer).toHaveBeenCalledWith('draw-local', expect.objectContaining({ exposure: 'direct' }));
});
it('registers local tools without a selected board and attaches when the session opens one', async () => {
  vi.stubEnv('DRAW_LOCAL_BOARD', '');
  const handlers = new Map<string, Function>(), registerMcpServer = vi.fn();
  vi.mocked(localCall).mockImplementation(async (_endpoint, value, signal) => {
    if ((value as any).action !== 'poll_local_agent') return {};
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  localPi({ on: (name, fn) => { handlers.set(name, fn); }, registerMcpServer, sendUserMessage: vi.fn() });
  const context = { cwd: process.cwd(), isIdle: () => false, abort: vi.fn(), sessionManager: { getSessionId: () => 'auto' }, ui: { notify: vi.fn() } };
  await handlers.get('session_start')!({}, context);
  expect(localCall).not.toHaveBeenCalled();
  await handlers.get('tool_result')!({ toolName: 'mcp__draw_local__open_board', content: [{ type: 'text', text: JSON.stringify({ slug: 'new-board' }) }] }, context);
  expect(localCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'connect_local_agent', board: 'new-board', session: 'pi:auto' }), undefined);
  expect(registerMcpServer).toHaveBeenCalledOnce();
  await handlers.get('session_shutdown')!();
});
it('does not revive local chat when a pending attachment finishes after switching modes', async () => {
  vi.stubEnv('DRAW_LOCAL_BOARD', '');
  const handlers = new Map<string, Function>(), beforeAttach = vi.fn();
  let connected!: () => void;
  vi.mocked(localCall).mockImplementation(async (_endpoint, value) => {
    if ((value as any).action === 'connect_local_agent') return new Promise<void>(resolve => { connected = resolve; });
    return {};
  });
  const controller = localPi({ on: (name, fn) => { handlers.set(name, fn); }, registerMcpServer: vi.fn(), sendUserMessage: vi.fn() }, ['/test/draw'], beforeAttach);
  const context = { cwd: process.cwd(), isIdle: () => true, abort: vi.fn(), sessionManager: { getSessionId: () => 'auto' }, ui: { notify: vi.fn() } };
  const opening = handlers.get('tool_result')!({ toolName: 'mcp__draw-local__open_board', structuredContent: { slug: 'local-board' } }, context);
  await vi.waitFor(() => expect(beforeAttach).toHaveBeenCalledOnce());
  await controller.close();
  connected();
  await opening;
  expect(localCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'disconnect_local_agent', board: 'local-board' }), undefined);
  expect(vi.mocked(localCall).mock.calls.some(([, input]) => (input as any).action === 'poll_local_agent')).toBe(false);
});
