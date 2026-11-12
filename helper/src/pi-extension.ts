import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { ChatCore } from './chat';
import { chatConnection } from './chat-bootstrap';
import { origin } from './capture';
import { piHelperCommand } from './pi-runtime';
import localPi from './local-pi-extension';

type Context = {
  cwd: string; isIdle(): boolean; abort(): void;
  sessionManager: { getSessionId(): string; getEntries(): any[] };
  ui: { notify(message: string, tone: string): void };
};
type Pi = {
  on(event: string, handler: (event: any, context: Context) => unknown): void;
  sendUserMessage(text: string): void;
  appendEntry(type: string, data: unknown): void;
  registerMcpServer(name: string, config: any): void;
};

export function piCaptureHook(input: object, cwd: string, notify: (message: string) => void, helper = piHelperCommand()): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = helper;
    const child = spawn(command, [...args, 'hook'], { cwd, stdio: 'pipe' });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || 'Draw repository capture failed.'));
      if (stderr.trim()) notify(stderr.trim());
      try { resolve(stdout.trim() ? JSON.parse(stdout) : {}); } catch { reject(new Error('Draw returned an invalid capture response.')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Loaded in the user's pi session: board messages never start another conversation. */
export default function drawPi(pi: Pi, options?: { mode: 'local' | 'hosted' | 'unified'; executable: string }) {
  const helper = options ? [options.executable] : piHelperCommand();
  const mode = options?.mode ?? process.env.DRAW_MODE;
  if (mode === 'local' || (!mode && process.env.DRAW_LOCAL_BOARD)) return localPi(pi, helper);
  let active: { core: ChatCore; close(): void } | undefined;
  let generation = 0;
  const close = () => { generation++; active?.close(); active = undefined; };
  const local = mode === 'unified' ? localPi(pi, helper, () => {
    close();
    pi.appendEntry('draw-chat', null);
  }) : undefined;
  pi.registerMcpServer('draw', { url: process.env.REDCRAYON_MCP_URL || `${origin()}/mcp`, exposure: 'direct' });
  let sequence = 0;
  const attach = (chat: { token: string; board: string; origin: string }, ctx: Context) => {
    active?.close();
    let socket: WebSocket | undefined, closed = false, retry: ReturnType<typeof setTimeout> | undefined, backoff = 1000;
    const core = new ChatCore({
      send: event => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); },
      wake: () => {}, killCommand: () => {},
    });
    core.attach({ id: `pi:${ctx.sessionManager.getSessionId()}`, agent: 'pi', name: 'pi', capabilities: { stop: 'interrupt', approvals: false } }, {
      async send(text) {
        if (!ctx.isIdle()) throw new Error('pi is busy; delivery was not confirmed.');
        pi.sendUserMessage(text);
      },
      async stop() { if (ctx.isIdle()) core.agent({ type: 'state', state: 'stopped' }); else ctx.abort(); },
      async approve() { throw new Error('Review permissions in pi.'); },
    });
    core.agent({ type: 'state', state: ctx.isIdle() ? 'idle' : 'working' });
    const close = () => { closed = true; clearTimeout(retry); core.dispose(); socket?.close(); };
    active = { core, close };
    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(`${chat.origin.replace(/^http/, 'ws')}/chat/${chat.board}`, { maxPayload: 1024 * 1024 });
      socket = ws;
      ws.on('open', () => ws.send(JSON.stringify({ auth: chat.token, role: 'agent', session: core.session })));
      ws.on('message', raw => {
        if (closed || socket !== ws) return;
        let frame; try { frame = JSON.parse(String(raw)); } catch { return; }
        if (!frame || typeof frame !== 'object') return;
        if (frame.ok) { backoff = 1000; ws.send(JSON.stringify(core.snapshot())); return; }
        core.person(frame);
      });
      ws.on('error', () => {});
      ws.on('close', (code, reason) => {
        if (closed || socket !== ws) return;
        socket = undefined;
        core.person({ type: 'viewers', count: 0 });
        if ([4001, 4008, 4009].includes(code)) {
          close();
          ctx.ui.notify(`Board chat disconnected: ${reason.toString() || 'open the board again to reconnect.'}`, 'warning');
          return;
        }
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      });
    };
    connect();
  };
  const connection = (event: any, ctx: Context) => chatConnection({
    hook_event_name: 'PostToolUse', tool_name: event.toolName, tool_response: event.structuredContent ?? { content: event.content }, session_id: ctx.sessionManager.getSessionId(),
  }, false);
  pi.on('session_start', async (_event, ctx) => {
    close();
    const saved = ctx.sessionManager.getEntries().filter(e => e.type === 'custom' && e.customType === 'draw-chat').at(-1)?.data;
    if (!saved || Date.now() - saved.at > 11 * 60 * 60_000) return;
    const chat = connection({ toolName: 'mcp__draw__start_chat', structuredContent: saved }, ctx);
    if (chat) {
      const current = generation;
      await local?.close();
      if (current === generation) attach(chat, ctx);
    }
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!/^mcp__draw__/.test(event.toolName)) return;
    try {
      const answer = await piCaptureHook({ hook_event_name: 'PreToolUse', tool_name: event.toolName, tool_input: event.input, cwd: ctx.cwd }, ctx.cwd, message => ctx.ui.notify(message, 'info'), helper);
      if (answer.hookSpecificOutput?.updatedInput) Object.assign(event.input, answer.hookSpecificOutput.updatedInput);
    } catch (error) { return { block: true, reason: String(error) }; }
  });
  pi.on('tool_result', async (event, ctx) => {
    if (event.isError || !/^mcp__draw__/.test(event.toolName)) return;
    const chat = connection(event, ctx);
    const current = chat ? ++generation : generation;
    try {
      await piCaptureHook({ hook_event_name: 'PostToolUse', tool_name: event.toolName, tool_input: event.input, tool_response: event.structuredContent ?? { content: event.content }, cwd: ctx.cwd }, ctx.cwd, message => ctx.ui.notify(message, 'info'), helper);
    } catch (error) { ctx.ui.notify(String(error), 'warning'); }
    if (chat && current === generation) {
      await local?.close();
      if (current !== generation) return;
      pi.appendEntry('draw-chat', chat); attach(chat, ctx);
    }
  });
  pi.on('input', event => {
    if (event.source !== 'extension' && typeof event.text === 'string') active?.core.agent({ type: 'user', id: `pi-user-${++sequence}`, text: event.text, origin: 'terminal' });
  });
  pi.on('agent_start', () => active?.core.agent({ type: 'state', state: 'working' }));
  pi.on('message_end', event => {
    if (event.message?.role !== 'assistant') return;
    const text = (event.message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    if (text) active?.core.agent({ type: 'text', message: `pi-${++sequence}`, delta: text, final: true });
  });
  pi.on('tool_execution_start', event => active?.core.agent({ type: 'tool', id: event.toolCallId, phase: 'start', summary: `Tool: ${event.toolName}` }));
  pi.on('tool_execution_end', event => active?.core.agent({ type: 'tool', id: event.toolCallId, phase: 'done' }));
  pi.on('agent_settled', event => active?.core.agent({ type: 'state', state: event.aborted ? 'stopped' : 'idle' }));
  pi.on('session_shutdown', close);
}
