// Agents a plugin provides (plugin-api.ts, CanvasAgent) in the board's one chat panel. Each
// becomes a session beside the person's own agent's: the shell (agent-chat.ts) sees one
// connection and one protocol, whoever answers.
import type { ChatSession, ChatState } from '../../shared/chat';
import type { ChatConnection, ChatConnectionOptions, ChatFrame } from './chat-connection';
import type { AgentConversation, AgentReply } from './plugin-api';

/** A plugin's agent for the board on screen (plugin-mounts.ts). */
export type BoardAgent = { id: string; name: string; open(reply: AgentReply): AgentConversation };

/** `ChatSession.agent` of a plugin's agent: not the person's own, so it receives no red-crayon marks. */
export const PLUGIN_AGENT = 'plugin';

type Queued = { id: string; text: string; context?: string };

/** One plugin agent as a chat session. It keeps the transcript and the queue the helper keeps for the person's own agent. */
function pluginSession(agent: BoardAgent, emit: (frame: ChatFrame) => void) {
  let events: ChatFrame[] = [];
  let queue: Queued[] = [];
  let state: ChatState = 'idle';
  let paused = false;
  let part = 0;
  let texted = false;
  let step: string | null = null;

  const log = (frame: ChatFrame) => { events.push(frame); emit(frame); };
  const setState = (next: ChatState) => { state = next; emit({ type: 'state', state }); };
  const sendQueue = () => emit({ type: 'queue', queue: [...queue], paused });
  // Text after a step is a new message, so the transcript keeps the order things happened in.
  const closePart = () => {
    if (step) log({ type: 'tool', id: step, phase: 'done' });
    if (texted) log({ type: 'text', message: `m${part}`, delta: '', final: true });
    step = null;
    texted = false;
    part++;
  };
  const finish = (problem?: string, next: ChatState = 'idle') => {
    closePart();
    if (problem) log({ type: 'notice', text: problem, tone: 'attention' });
    setState(next);
    pump();
  };
  const broke = (error: unknown) => {
    console.warn('plugin.canvas_failed', agent.id, error);
    return `${agent.name} stopped working. Reload the page to try again.`;
  };
  const conversation = agent.open({
    text(delta) {
      if (state !== 'working' || !delta) return;
      texted = true;
      log({ type: 'text', message: `m${part}`, delta, final: false });
    },
    step(summary) {
      if (state !== 'working') return;
      closePart();
      step = `s${part}`;
      log({ type: 'tool', id: step, phase: 'start', summary });
    },
    done(problem) {
      if (state === 'working') finish(problem);
    },
  });
  function pump(): void {
    const next = state === 'working' || paused ? undefined : queue.shift();
    if (!next) return;
    sendQueue();
    log({ type: 'delivered', ...next });
    setState('working');
    try { conversation.send(next.text, next.context); } catch (error) { finish(broke(error)); }
  }
  const stop = () => {
    if (state !== 'working') return;
    try { conversation.stop(); } catch (error) { console.warn('plugin.canvas_failed', agent.id, error); }
    // As with the person's own agent: what was queued waits for them.
    paused = queue.length > 0;
    finish(undefined, 'stopped');
    sendQueue();
  };
  const session: ChatSession = {
    id: `plugin:${agent.id}`,
    agent: PLUGIN_AGENT,
    name: agent.name,
    capabilities: { stop: 'interrupt', approvals: false, reset: Boolean(conversation.reset) },
  };
  const snapshot = (): ChatFrame => ({ type: 'snapshot', session, events: [...events], queue: [...queue], state, paused });

  return {
    session,
    snapshot,
    stop,
    untouched: () => events.length === 0 && queue.length === 0,
    /** A frame the person's panel sent to this session. */
    handle(frame: ChatFrame): void {
      if (frame.type === 'send' && typeof frame.text === 'string') {
        queue.push({ id: String(frame.id), text: frame.text, ...(typeof frame.context === 'string' ? { context: frame.context } : {}) });
        sendQueue();
        pump();
      } else if (frame.type === 'delete') {
        queue = queue.filter(q => q.id !== frame.id);
        sendQueue();
      } else if (frame.type === 'resume') {
        paused = false;
        sendQueue();
        pump();
      } else if (frame.type === 'stop') stop();
      else if (frame.type === 'reset') {
        let problem: string | undefined;
        try {
          if (state === 'working') conversation.stop();
          conversation.reset?.();
        } catch (error) { problem = broke(error); }
        events = problem ? [{ type: 'notice', text: problem, tone: 'attention' }] : [];
        queue = [];
        state = 'idle';
        paused = false;
        step = null;
        texted = false;
        part++;
        emit(snapshot());
      }
    },
  };
}

/**
 * One connection over the person's own agent (`relay`, null when they have none linked) and
 * the board's plugin agents. Their own agent comes first; a plugin agent fills in when theirs
 * is not connected, so the panel never opens on a dead end. After the person has seen or
 * picked a conversation, only they change it.
 */
export function joinAgents(relay: ((options: ChatConnectionOptions) => ChatConnection) | null, agents: BoardAgent[], opts: ChatConnectionOptions): ChatConnection {
  type Session = ReturnType<typeof pluginSession>;
  let live = false;
  /** The plugin session on screen; null while the relay's is. */
  let on: Session | null = null;
  let settled = false;
  let relaySessions: ChatSession[] = [];
  let relaySelected: string | null = null;

  const locals: Session[] = agents.flatMap(agent => {
    try {
      const local: Session = pluginSession(agent, frame => { if (live && on === local) opts.receive({ session: local.session.id, ...frame }); });
      return [local];
    } catch (error) {
      console.warn('plugin.canvas_failed', agent.id, error);
      return [];
    }
  });
  const advertise = () => opts.receive({ type: 'sessions', sessions: [...relaySessions, ...locals.map(l => l.session)], selected: on?.session.id ?? relaySelected });
  const show = (local: Session) => {
    on = local;
    advertise();
    opts.receive(local.snapshot());
  };
  // Not while their own sessions wait to be chosen between: that choice is theirs.
  const fallBack = () => !on && !settled && locals.length > 0 && relaySessions.length === 0;

  const own = relay?.({
    url: opts.url,
    token: opts.token,
    status(status, reason) {
      if (status === 'reconnecting') {
        relaySessions = [];
        relaySelected = null;
        if (on) advertise();
      }
      if (on) return;
      if (fallBack() && (status === 'waiting' || status === 'reconnecting')) show(locals[0]);
      else opts.status(status, reason);
    },
    receive(frame) {
      if (frame.type === 'sessions') {
        relaySessions = Array.isArray(frame.sessions) ? frame.sessions : [];
        relaySelected = typeof frame.selected === 'string' ? frame.selected : null;
        // Their own agent arrived before they used the plugin's: theirs comes first.
        if (on && !settled && relaySessions.length && on.untouched()) on = null;
        return advertise();
      }
      if (frame.agent === 'gone' && fallBack()) return show(locals[0]);
      if (on) return;
      if (frame.type === 'snapshot') settled = true;
      opts.receive(frame);
    },
  });

  return {
    start() {
      if (live) return;
      live = true;
      if (own) own.start();
      else if (locals.length) show(locals[0]);
      else opts.status('offline');
    },
    close() {
      live = false;
      own?.close();
      for (const local of locals) local.stop();
    },
    send(frame) {
      const local = locals.find(l => l.session.id === frame.session);
      if (frame.type === 'select') {
        if (!local && !own?.send(frame)) return false;
        settled = true;
        if (!local) on = null;
        // After this returns, the shell clears its transcript for the choice: the snapshot must follow that.
        else queueMicrotask(() => { if (live) show(local); });
        return true;
      }
      if (!local) return own?.send(frame) ?? false;
      // Later, as an answer over a socket would be: the shell updates its own state after send returns.
      queueMicrotask(() => { if (live) local.handle(frame); });
      return true;
    },
  };
}
