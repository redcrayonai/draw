import { fileURLToPath } from 'node:url';
import { localCall, localEndpoint } from './local-mcp';

type Context = { cwd: string; isIdle(): boolean; abort(): void; sessionManager: { getSessionId(): string }; ui: { notify(message: string, tone: string): void } };
type Pi = { on(event: string, handler: (event: any, context: Context) => unknown): void; sendUserMessage(text: string): void; registerMcpServer(name: string, config: { command: string; args: string[]; exposure: 'direct' }): void };
/** Runs inside pi's existing session; it never starts or resumes another agent process. */
export default function localPi(pi: Pi) {
  const board = process.env.DRAW_LOCAL_BOARD;
  if (!board) return;
  const storeArgs = process.env.DRAW_LOCAL_STORE ? ['--store', process.env.DRAW_LOCAL_STORE] : [];
  pi.registerMcpServer('draw-local', { command: process.execPath, args: [fileURLToPath(new URL('./redcrayon.mjs', import.meta.url)), 'local-mcp', '--repo', process.cwd(), ...storeArgs], exposure: 'direct' });
  let active: { event(value: object): Promise<void>; close(): Promise<void> } | undefined;
  let sequence = 0;
  pi.on('session_start', async (_event, context) => {
    await active?.close(); active = undefined;
    const endpoint = localEndpoint(['--repo', context.cwd, ...storeArgs]);
    const session = `pi:${context.sessionManager.getSessionId()}`, cancel = new AbortController();
    const call = (input: object, signal?: AbortSignal) => localCall(endpoint, { ...input, board, session }, signal);
    await call({ action: 'connect_local_agent', agent: 'pi', threadId: context.sessionManager.getSessionId(), cwd: context.cwd });
    const close = async () => {
      if (cancel.signal.aborted) return;
      cancel.abort();
      try { await call({ action: 'disconnect_local_agent' }); } catch { /* The server also expires missing clients. */ }
    };
    const fail = async (error: Error) => { context.ui.notify(`Board chat: ${error.message}`, 'error'); await close(); };
    let events = Promise.resolve();
    const event = (value: object) => {
      events = events.then(async () => { if (!cancel.signal.aborted) await call({ action: 'local_agent_event', event: value }); }).catch(fail);
      return events;
    };
    active = { event, close };
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
  });
  pi.on('agent_start', () => active?.event({ type: 'state', state: 'working' }));
  pi.on('message_end', message => {
    if (message.message?.role !== 'assistant') return;
    const text = (message.message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    if (text) return active?.event({ type: 'text', message: `pi-${++sequence}`, delta: text + '\n\n', final: false });
  });
  pi.on('agent_settled', event => active?.event({ type: 'state', state: event.aborted ? 'stopped' : 'idle' }));
  pi.on('session_shutdown', () => active?.close());
}
