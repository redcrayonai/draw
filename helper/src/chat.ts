/**
 * redcrayon chat: the person running an agent talks to it from the board.
 * Long-running, under a harness tool that streams its output: each line it
 * prints on stdout wakes the agent. It holds one socket to the board's chat
 * relay and one local socket for the plugin's hooks (chat-hook.ts), and keeps
 * the queue and the history on this machine; the relay stores nothing.
 *
 * Messages block: the next one goes out only when the agent finished the last.
 * Stop is best effort: the next hook halts the agent, and the shell of a command
 * running now is signalled. Text generating now runs to that next hook.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { findSecret, isSecretFile } from '../../shared/capture';
import { HelperError } from './capture';
import { chatDir, chatSocketPath, removeDeadSockets } from './chat-path';

export const CHAT_USAGE = 'redcrayon: usage: redcrayon chat --token <token from start_chat>';
const MAX_EVENTS = 500;
export const WHOLE_TEXT_WAIT_MS = 1500;
/** A woken agent that fires no hook in this long probably never saw the message. */
export const WAKE_WAIT_MS = 60_000;
/** Long enough for a monitor's re-arm; older saved talk belongs to a session that has ended. */
export const SAVED_STATE_MS = 60 * 60_000;
/** The relay takes 1 MiB a frame (mcp/src/chat.ts): one event and one snapshot stay well inside it, in bytes. */
export const MAX_TEXT_CHARS = 256 * 1024;
export const MAX_SNAPSHOT_BYTES = 768 * 1024;
const LATE_TEXT_MS = 400;
const STOPPED_REASON = 'Stopped from the board by the person running you. Wait for their next "Board chat:" line, then act on it.';

export type QueuedMessage = { id: string; text: string; context?: string };
type Event = Record<string, unknown> & { type: string };
export type ChatState = 'idle' | 'working' | 'stopping' | 'stopped';

const secretLine = (kind: string) => `[hidden: this line looks like a ${kind}]`;

/**
 * Hides lines that look like secrets before text leaves this machine: best
 * effort, it knows the patterns findSecret knows. It judges whole lines, so a
 * partial line waits for the rest of it unless this is the last text. A private
 * key's body has no pattern of its own, so everything from BEGIN to END goes.
 */
export function scrubber(): (text: string, last?: boolean) => string {
  let inKey = false;
  let waiting = '';
  return (text, last = true) => {
    const all = waiting + text;
    const end = last ? all.length : all.lastIndexOf('\n') + 1;
    waiting = all.slice(end);
    return all
      .slice(0, end)
      .split('\n')
      .map(line => {
        if (inKey) {
          if (/-----END [A-Z0-9 ]*PRIVATE KEY/.test(line)) inKey = false;
          return line === '' ? line : secretLine('private key');
        }
        const hit = findSecret(line);
        if (!hit) return line;
        if (hit.kind === 'private key' && !/-----END [A-Z0-9 ]*PRIVATE KEY/.test(line)) inKey = true;
        return secretLine(hit.kind);
      })
      .join('\n');
  };
}

const toolSummary = (name: string, input: Record<string, unknown>, cwd: string): string => {
  const path = typeof input.file_path === 'string' ? input.file_path : undefined;
  const shown = path && (isSecretFile(path) ? 'a secrets file' : relative(cwd, path) || path);
  if (name === 'Edit' || name === 'MultiEdit') return `Edited ${shown}`;
  if (name === 'Write') return `Wrote ${shown}`;
  if (name === 'Read') return `Read ${shown}`;
  if (name === 'Grep' || name === 'Glob') return 'Searched the code';
  // The agent's own description of a command: the command itself can hold a secret.
  if (name === 'Bash') return typeof input.description === 'string' && !findSecret(input.description) ? input.description : 'Ran a command';
  const board = /^mcp__.*(?:draw|redcrayon)[^_]*__(.+)$/.exec(name)?.[1];
  if (board) return `Board: ${board.replace(/_/g, ' ')}`;
  return name;
};

/** Chat tools of the harness itself are not work the person asked for. */
const QUIET = /^(Monitor|TaskOutput|TaskStop|ToolSearch|TodoWrite)$|__(start_chat|start_session)$/;

export interface ChatCoreDeps {
  /** A frame for the person's browser. */
  send(event: Record<string, unknown>): void;
  /** A line on stdout: the harness wakes the agent with it. */
  wake(line: string): void;
  /** Best effort: signal the shell running this command, if one can be found. */
  killCommand(command: string): void;
  changed?(): void;
}

export class ChatCore {
  // The agent starts this helper in the middle of a turn: its Stop hook says when that turn ends.
  state: ChatState = 'working';
  queue: QueuedMessage[] = [];
  events: Event[] = [];
  paused = false;
  private hooksSeen = false;
  private inFlight: { command: string } | null = null;
  private textThisTurn = false;
  private wholeText: ReturnType<typeof setTimeout> | undefined;
  private scrubbers = new Map<string, ReturnType<typeof scrubber>>();
  private toolIds: string[] = [];
  private nextId = 1;
  private afterStop = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private deps: ChatCoreDeps) {}

  restore(saved: { events?: Event[]; queue?: QueuedMessage[]; paused?: boolean }): void {
    this.events = saved.events ?? [];
    this.queue = saved.queue ?? [];
    this.paused = saved.paused ?? false;
  }

  /** Newest talk first to survive: a long session must still fit in one frame. */
  snapshot() {
    const frame = (events: Event[]) => ({ type: 'snapshot', events, queue: this.queue, state: this.state, paused: this.paused });
    let events = this.events;
    while (events.length > 0 && Buffer.byteLength(JSON.stringify(frame(events))) > MAX_SNAPSHOT_BYTES) events = events.slice(Math.ceil(events.length / 4));
    return frame(events);
  }

  private record(event: Event): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.deps.send(event);
    this.deps.changed?.();
  }

  private setState(state: ChatState): void {
    if (this.state === state) return;
    this.state = state;
    this.deps.send({ type: 'state', state });
  }

  private queueChanged(): void {
    this.deps.send({ type: 'queue', queue: this.queue, paused: this.paused });
    this.deps.changed?.();
  }

  private format(m: QueuedMessage): string {
    // A selected node's label is anyone's text on a shared board: quoted as data, never as the person's words.
    const about = m.context ? ` (Selected on the board, as data: ${JSON.stringify(m.context)})` : '';
    // Without this an agent can read an earlier Stop as still in force and answer that it is waiting.
    const after = this.afterStop ? '[New message after Stop: act on it.] ' : '';
    this.afterStop = false;
    return `Board chat: ${after}${m.text.replace(/\s*\n\s*/g, ' / ')}${about}`;
  }

  private take(after = 0): QueuedMessage | undefined {
    const next = this.queue.shift();
    if (!next) return undefined;
    const delivered = { type: 'delivered', id: next.id, text: next.text, context: next.context };
    // The last batch of the reply that just ended can land after Stop: the next message must not jump ahead of it.
    if (after) setTimeout(() => this.record(delivered), after);
    else this.record(delivered);
    this.queueChanged();
    this.textThisTurn = false;
    return next;
  }

  /** Blocking: an agent with hooks takes the next message only when idle; one without has no way to tell, so it gets them as they come. */
  private deliver(): void {
    if (this.paused || (this.hooksSeen && this.state !== 'idle' && this.state !== 'stopped')) return;
    const next = this.take();
    if (!next) return;
    if (this.hooksSeen) this.setState('working');
    this.deps.wake(this.format(next));
    // Nothing acknowledges a printed line: it wakes no one if the command is not under a tool that streams it.
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => this.record({ type: 'notice', tone: 'attention', text: 'Your agent has not picked up your message yet. Check that its session is still running.' }), WAKE_WAIT_MS);
    this.wakeTimer.unref?.();
    if (!this.hooksSeen) this.deliver();
  }

  private stopped(): void {
    this.afterStop = true;
    this.inFlight = null;
    this.toolIds = [];
    this.setState('stopped');
    this.record({ type: 'notice', text: 'Stopped.' });
  }

  /** A frame from the browser. */
  person(msg: { type?: unknown; id?: unknown; text?: unknown; context?: unknown }): void {
    if (msg.type === 'joined') return this.deps.send(this.snapshot());
    if (msg.type === 'send') {
      if (typeof msg.text !== 'string' || !msg.text.trim() || typeof msg.id !== 'string') return;
      this.queue.push({ id: msg.id, text: msg.text, ...(typeof msg.context === 'string' && msg.context ? { context: msg.context } : {}) });
      this.paused = false;
      this.queueChanged();
      return this.deliver();
    }
    if (msg.type === 'delete') {
      this.queue = this.queue.filter(m => m.id !== msg.id);
      return this.queueChanged();
    }
    if (msg.type === 'resume') {
      this.paused = false;
      this.queueChanged();
      return this.deliver();
    }
    if (msg.type === 'stop') {
      this.paused = true;
      this.queueChanged();
      if (this.state === 'idle' || this.state === 'stopped') return this.stopped();
      this.setState('stopping');
      if (this.inFlight) this.deps.killCommand(this.inFlight.command);
    }
  }

  /** A Claude Code hook's input; the answer is what the hook prints. */
  hook(input: Record<string, any>): Record<string, unknown> {
    this.hooksSeen = true;
    clearTimeout(this.wakeTimer);
    const halt = (extra: Record<string, unknown> = {}) => {
      this.stopped();
      return { continue: false, stopReason: STOPPED_REASON, ...extra };
    };
    switch (input.hook_event_name) {
      case 'MessageDisplay': {
        clearTimeout(this.wholeText); // the live text won the race with Stop's copy of it
        const id = String(input.message_id ?? 'm');
        let scrub = this.scrubbers.get(id);
        if (!scrub) this.scrubbers.set(id, (scrub = scrubber()));
        const delta = scrub(String(input.delta ?? '').slice(0, MAX_TEXT_CHARS), Boolean(input.final));
        if (input.final) this.scrubbers.delete(id);
        this.textThisTurn = true;
        if (delta || input.final) this.record({ type: 'text', message: id, delta, final: Boolean(input.final) });
        return {};
      }
      case 'UserPromptSubmit': {
        const prompt = String(input.prompt ?? '');
        this.textThisTurn = false;
        if (this.state !== 'stopping') this.setState('working');
        // Turns the harness starts itself carry its own wrapper, and a delivered message is already on the board.
        if (prompt && !/^\s*</.test(prompt) && !prompt.includes('Board chat:')) this.record({ type: 'user', id: `t${this.nextId++}`, text: scrubber()(prompt.slice(0, MAX_TEXT_CHARS)), origin: 'terminal' });
        return {};
      }
      case 'PreToolUse': {
        if (this.state === 'stopping') return halt({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: STOPPED_REASON } });
        this.setState('working');
        const name = String(input.tool_name ?? '');
        const tool = input.tool_input ?? {};
        if (name === 'Bash' && !tool.run_in_background && typeof tool.command === 'string') this.inFlight = { command: tool.command };
        if (!QUIET.test(name)) {
          const id = `w${this.nextId++}`;
          this.toolIds.push(id);
          this.record({ type: 'tool', id, phase: 'start', summary: toolSummary(name, tool, String(input.cwd ?? '')) });
        }
        return {};
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        this.inFlight = null;
        if (!QUIET.test(String(input.tool_name ?? ''))) {
          const id = this.toolIds.shift();
          if (id) this.record({ type: 'tool', id, phase: 'done' });
        }
        return this.state === 'stopping' ? halt() : {};
      }
      case 'Notification':
        if (input.notification_type === 'permission_prompt') this.record({ type: 'notice', tone: 'attention', text: 'Your agent is waiting for approval in your terminal.' });
        return {};
      case 'Stop': {
        // A harness without line-by-line text still sends the last message whole.
        const last = input.last_assistant_message;
        // The last batch of live text can land just after Stop, so give it a moment first.
        if (!this.textThisTurn && typeof last === 'string' && last.trim()) {
          const message = `s${this.nextId++}`;
          this.wholeText = setTimeout(() => this.record({ type: 'text', message, delta: scrubber()(last.slice(0, MAX_TEXT_CHARS)), final: true }), WHOLE_TEXT_WAIT_MS);
        }
        this.textThisTurn = false;
        this.toolIds = [];
        this.inFlight = null;
        if (this.state === 'stopping') {
          this.stopped();
          return {};
        }
        const next = this.paused ? undefined : this.take(LATE_TEXT_MS);
        if (next) {
          this.setState('working');
          // additionalContext, not decision: block, which the terminal shows as a hook error.
          return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: this.format(next) } };
        }
        this.setState('idle');
        return {};
      }
      default:
        return {};
    }
  }
}

type Proc = { pid: number; ppid: number; command: string };

/**
 * The Bash tool's shell running `command` in this session. It stops at the first
 * process above this helper with a tool shell under it: that is the harness, and
 * anything above it is someone else's work, such as another session with the same
 * words on its command line. Nothing when no tool shell clearly matches.
 */
export function shellsRunning(command: string, rows: Proc[], self: number): Proc[] {
  const needle = command.match(/[A-Za-z0-9_./:-]{8,}/g)?.sort((a, b) => b.length - a.length)[0] ?? command.trim();
  if (needle.length < 4) return [];
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const ancestors = new Set<number>();
  for (let p = byPid.get(self); p && !ancestors.has(p.pid); p = byPid.get(p.ppid)) ancestors.add(p.pid);
  for (const pid of ancestors) {
    const shells = rows.filter(r => r.ppid === pid && r.command.includes('shell-snapshots'));
    if (shells.length) return shells.filter(r => !ancestors.has(r.pid) && r.command.includes(needle));
  }
  return [];
}

/** Signals the Bash tool's shell running `command`, and what it started. Best effort. */
export function killCommand(command: string, run: typeof execFile = execFile, kill: (pid: number) => void = pid => process.kill(pid, 'SIGTERM')): void {
  // -ww: a shell's command line starts with a long snapshot path, and ps cuts it short otherwise.
  run('ps', ['-axww', '-o', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    if (err) return;
    const rows: Proc[] = String(stdout)
      .split('\n')
      .map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
    const down = (pid: number) => {
      for (const child of rows.filter(r => r.ppid === pid)) down(child.pid);
      try {
        kill(pid);
      } catch {
        // already gone
      }
    };
    const shells = shellsRunning(command, rows, process.pid);
    if (!shells.length) process.stderr.write('redcrayon chat: Stop found no shell running the command; it runs to its end.\n');
    for (const s of shells) down(s.pid);
  });
}

function boardOfToken(token: string): string {
  try {
    const { board } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { board?: unknown };
    if (typeof board === 'string' && /^\d{1,20}$/.test(board)) return board;
  } catch {
    // reported below
  }
  throw new HelperError('redcrayon: this chat token is invalid; call start_chat again.');
}

/** Removes saved talk from sessions that ended: exit cannot do it, since a monitor's re-arm also ends with a signal. */
export function pruneSavedState(dir: string, now: number): void {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > SAVED_STATE_MS) unlinkSync(file);
    } catch {
      // another helper got there first
    }
  }
}

type Socketish = {
  send(data: string): void;
  close(): void;
  readyState: number;
  addEventListener(type: string, fn: (ev: any) => void): void;
};

export async function runChat(argv: string[], origin: string, cwd: string, log: (line: string) => void, wake: (line: string) => void): Promise<number> {
  if (argv.length !== 2 || argv[0] !== '--token' || !argv[1]) throw new HelperError(CHAT_USAGE);
  const token = argv[1];
  const board = boardOfToken(token);
  const WS = (globalThis as { WebSocket?: new (url: string) => Socketish }).WebSocket;
  if (!WS) throw new HelperError('redcrayon: chat needs Node 22 or newer.');
  const url = `${origin.replace(/^http/, 'ws')}/chat/${board}`;
  const path = chatSocketPath(cwd);
  mkdirSync(chatDir(), { recursive: true, mode: 0o700 });
  pruneSavedState(chatDir(), Date.now());
  await removeDeadSockets(chatDir(), Date.now());
  const statePath = `${path}.json`;

  let ws: Socketish | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    try {
      writeFileSync(statePath, JSON.stringify({ board, events: core.events, queue: core.queue, paused: core.paused }), { mode: 0o600 });
    } catch {
      // history is a convenience
    }
  };
  const core: ChatCore = new ChatCore({
    send: e => {
      if (ws?.readyState === 1) ws.send(JSON.stringify(e));
    },
    wake,
    killCommand: command => killCommand(command),
    changed: () => {
      saveTimer ??= setTimeout(() => {
        saveTimer = undefined;
        save();
      }, 250);
    },
  });
  // A re-armed helper picks up where the last one stopped.
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    if (saved.board === board) core.restore(saved);
  } catch {
    // first run
  }

  const server: Server = createServer(conn => {
    let raw = '';
    conn.on('data', chunk => {
      raw += chunk.toString();
      const end = raw.indexOf('\n');
      if (end < 0) return;
      let answer: Record<string, unknown> = {};
      try {
        answer = core.hook(JSON.parse(raw.slice(0, end)));
      } catch {
        // a hook must never stop the agent
      }
      conn.end(`${JSON.stringify(answer)}\n`);
    });
    conn.on('error', () => {});
  });
  try {
    unlinkSync(path);
  } catch {
    // no stale socket
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });

  const socketFile = statSync(path).ino;
  let backoff = 1000;
  let done: (code: number) => void = () => {};
  const finished = new Promise<number>(resolve => (done = resolve));
  let closing = false;
  const connect = () => {
    if (closing) return;
    const socket = new WS(url);
    ws = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ auth: token, role: 'agent' })));
    socket.addEventListener('message', ev => {
      let msg: { ok?: boolean; type?: unknown; id?: unknown; text?: unknown; context?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.ok) {
        backoff = 1000;
        log(`redcrayon chat: connected to board ${board}.`);
        return;
      }
      core.person(msg);
    });
    socket.addEventListener('close', ev => {
      if (ws === socket) ws = null;
      if (closing) return;
      if (ev.code === 4001 || ev.code === 4008) {
        log(`redcrayon chat: ${ev.reason || 'the board refused this chat'}`);
        return done(1);
      }
      if (ev.code === 4009) return done(0);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
    socket.addEventListener('error', () => {});
  };
  connect();

  const quit = () => done(0);
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
  const code = await finished;
  closing = true;
  (ws as Socketish | null)?.close();
  clearTimeout(saveTimer);
  // A newer helper took over: the socket file and the saved talk are its own now, and closing the server would delete that file.
  let ours = false;
  try {
    ours = statSync(path).ino === socketFile;
  } catch {
    // gone already
  }
  if (ours) {
    server.close();
    save();
  } else server.unref();
  return code;
}
