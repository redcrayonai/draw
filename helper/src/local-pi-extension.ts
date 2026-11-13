import { piHelperCommand } from './pi-runtime';
import { localCall, localEndpoint } from './local-mcp';
import { hookResult } from './hook-result';

type Context = { cwd: string; isIdle(): boolean; abort(): void; sessionManager: { getSessionId(): string }; ui: { notify(message: string, tone: string): void } };
type Pi = { on(event: string, handler: (event: any, context: Context) => unknown): void; sendUserMessage(text: string): void; registerMcpServer(name: string, config: { command: string; args: string[]; exposure: 'direct' }): void };
/** Runs inside pi's existing session; it never starts or resumes another agent process. */
export default function localPi(pi: Pi, helper = piHelperCommand(), beforeAttach?: () => void) {
  const configuredBoard = process.env.DRAW_LOCAL_BOARD;
  const storeArgs = process.env.DRAW_LOCAL_STORE ? ['--store', process.env.DRAW_LOCAL_STORE] : [];
  const [command, ...args] = helper;
  pi.registerMcpServer('draw-local', { command, args: [...args, 'local-mcp', '--repo', process.cwd(), ...storeArgs], exposure: 'direct' });
  let active: { board: string; event(value: object): Promise<void>; close(): Promise<void> } | undefined;
  let sequence = 0, generation = 0;
  const detach = async () => {
    generation++;
    const previous = active; active = undefined;
    await previous?.close();
  };
  const attach = async (board: string, context: Context) => {
    const closing = detach(), current = generation;
    await closing;
    if (current !== generation) return;
    beforeAttach?.();
    const endpoint = localEndpoint(['--repo', context.cwd, ...storeArgs]);
    const session = `pi:${context.sessionManager.getSessionId()}`, cancel = new AbortController();
    const call = (input: object, signal?: AbortSignal) => localCall(endpoint, { ...input, board, session }, signal);
    await call({ action: 'connect_local_agent', agent: 'pi', threadId: context.sessionManager.getSessionId(), cwd: context.cwd });
    if (current !== generation) { await call({ action: 'disconnect_local_agent' }); return; }
    const close = async () => {
      if (cancel.signal.aborted) return;
      cancel.abort();
      if (active?.close === close) active = undefined;
      try { await call({ action: 'disconnect_local_agent' }); } catch { /* The server also expires missing clients. */ }
    };
    const fail = async (error: Error) => { context.ui.notify(`Board chat: ${error.message}`, 'error'); await close(); };
    let events = Promise.resolve();
    const event = (value: object) => {
      events = events.then(async () => { if (!cancel.signal.aborted) await call({ action: 'local_agent_event', event: value }); }).catch(fail);
      return events;
    };
    active = { board, event, close };
    await event({ type: 'state', state: context.isIdle() ? 'idle' : 'working' });
    void (async () => {
      while (!cancel.signal.aborted) {
        const delivery = await call({ action: 'poll_local_agent' }, cancel.signal);
        if (cancel.signal.aborted) break;
        if (delivery?.type === 'replaced') { await close(); break; }
        if (delivery?.type === 'stop') {
          if (context.isIdle()) await event({ type: 'state', state: 'stopped' });
          else context.abort();
        }
        if (delivery?.type === 'message') {
          if (!context.isIdle()) throw new Error('UNCONFIRMED: pi became busy before delivery; check the terminal');
          pi.sendUserMessage(delivery.text);
          await call({ action: 'ack_local_agent', id: delivery.id });
        }
      }
    })().catch(error => { if (!cancel.signal.aborted) return fail(error); });
  };
  pi.on('session_start', async (_event, context) => {
    await detach();
    if (configuredBoard) await attach(configuredBoard, context);
  });
  pi.on('tool_result', async (event, context) => {
    if (configuredBoard || event.isError || !/^mcp__draw[-_]local__(open_board|read_board)$/.test(event.toolName)) return;
    const board = hookResult(event.structuredContent ?? { content: event.content });
    if (typeof board?.slug === 'string' && board.slug !== active?.board && /^[A-Za-z0-9_-]{1,200}$/.test(board.slug)) await attach(board.slug, context);
  });
  pi.on('agent_start', () => active?.event({ type: 'state', state: 'working' }));
  pi.on('message_end', async message => {
    if (message.message?.role !== 'assistant') return;
    const text = (message.message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    const connection = active, id = `pi-${++sequence}`, reply = text ? text + '\n\n' : '';
    // Bound each JSON request even when control characters expand to six bytes.
    for (let offset = 0; offset < reply.length && active === connection; offset += 64000) {
      await connection?.event({ type: 'text', message: id, delta: reply.slice(offset, offset + 64000), final: false });
    }
  });
  pi.on('agent_settled', event => active?.event({ type: 'state', state: event.aborted ? 'stopped' : 'idle' }));
  pi.on('session_shutdown', detach);
  return { close: detach };
}
