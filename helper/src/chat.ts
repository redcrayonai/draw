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
import { createServer, type Server, type Socket } from 'node:net';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { findSecret, isSecretFile } from '../../shared/capture';
import { HelperError } from './capture';
import { chatDir, chatSocketPath, removeDeadSockets } from './chat-path';
import { connectCodex } from './chat-codex';
import { CHAT_VIEWER_TTL_MS, type ChatSession, type ChatEvent, type ApprovalDecision } from '../../shared/chat';

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
  /** Scoped hooks can only deliver after their async wake listener is waiting. */
  canWake?(): boolean;
  /** Best effort: signal the shell running this command, if one can be found. */
  killCommand(command: string): void;
  changed?(): void;
}

export interface ChatExecution {
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  approve(id: string, decision: ApprovalDecision): Promise<void>;
}

export class ChatCore {
  session?: ChatSession;
  private execution?: ChatExecution;
  private submitting = false;
  private submissionEvents: ChatEvent[] = [];
  private approvals = new Set<string>();
  private answering = new Set<string>();
  private localApprovals = new Map<string, (decision: ApprovalDecision | undefined) => void>();
  private viewers = 0;
  private viewerExpiry: ReturnType<typeof setTimeout> | undefined;

  private setViewers(count: number): void {
    clearTimeout(this.viewerExpiry);
    this.viewers = count;
    if (count > 0) this.viewerExpiry = setTimeout(() => this.setViewers(0), CHAT_VIEWER_TTL_MS);
    else for (const finish of this.localApprovals.values()) finish(undefined);
  }

  attach(session: ChatSession, execution: ChatExecution): void {
    this.session = session;
    this.execution = execution;
    this.hooksSeen = true;
  }

  /** Adapters supply lifecycle events, never raw terminal output. */
  agent(event: ChatEvent): void {
    if (this.submitting && event.type !== 'state') { this.submissionEvents.push(event); return; }
    if (event.type === 'state') {
      if (event.state === 'idle' || event.state === 'stopped') {
        for (const [message, scrub] of this.scrubbers) this.record({ type: 'text', message, delta: scrub('', true), final: true });
        this.scrubbers.clear();
      }
      if (event.state === 'stopped') this.paused = true;
      this.setState(event.state);
      if (event.state === 'idle') this.deliver();
      return;
    }
    if (event.type === 'text') {
      let scrub = this.scrubbers.get(event.message);
      if (!scrub) this.scrubbers.set(event.message, scrub = scrubber());
      const delta = scrub(event.delta.slice(0, MAX_TEXT_CHARS), event.final);
      if (event.final) this.scrubbers.delete(event.message);
      if (delta || event.final) this.record({ ...event, delta });
      return;
    }
    if (event.type === 'approval') {
      if (event.status === 'pending' && findSecret(event.summary)) {
        this.record({ type: 'notice', tone: 'attention', text: 'This approval contains sensitive details. Review it in your agent.' });
        return;
      }
      if (event.status === 'pending') this.approvals.add(event.id);
      else { this.approvals.delete(event.id); this.answering.delete(event.id); }
    }
    if (event.type === 'user') this.record({ ...event, text: scrubber()(event.text.slice(0, MAX_TEXT_CHARS)) });
    else if (event.type === 'tool') this.record({ ...event, ...(event.summary ? { summary: scrubber()(event.summary) } : {}) });
    else this.record({ ...event, ...(event.type === 'notice' ? { text: scrubber()(event.text) } : {}), ...(event.type === 'approval' ? { summary: scrubber()(event.summary) } : {}) });
  }

  askApproval(id: string, summary: string): Promise<ApprovalDecision | undefined> {
    if (!this.viewers) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(undefined), 120_000);
      const finish = (decision: ApprovalDecision | undefined) => {
        clearTimeout(timer);
        this.localApprovals.delete(id);
        this.agent({ type: 'approval', id, summary, status: 'resolved' });
        resolve(decision);
      };
      this.localApprovals.set(id, finish);
      this.agent({ type: 'approval', id, summary, status: 'pending' });
    });
  }

  dispose(): void {
    this.setViewers(0);
    clearTimeout(this.wholeText);
    clearTimeout(this.wakeTimer);
  }

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

  restore(saved: { events?: Event[]; queue?: QueuedMessage[]; paused?: boolean; state?: ChatState }): void {
    this.events = (saved.events ?? []).map(e => e.type === 'approval' ? { ...e, status: 'resolved' } : e);
    this.nextId = Math.max(0, ...this.events.map(e => Number(String(e.id ?? e.message ?? '').match(/^[wts](\d+)$/)?.[1] ?? 0))) + 1;
    this.queue = saved.queue ?? [];
    this.paused = saved.paused ?? false;
    if (saved.state && ['idle', 'working', 'stopping', 'stopped'].includes(saved.state)) this.state = saved.state;
    this.afterStop = this.state === 'stopped' || this.state === 'stopping';
  }

  /** Newest talk first to survive: a long session must still fit in one frame. */
  snapshot() {
    const frame = (events: Event[]) => ({ type: 'snapshot', events, queue: this.queue, state: this.state, paused: this.paused, ...(this.session ? { session: this.session } : {}) });
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
    this.deps.changed?.();
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
    if (this.submitting || this.paused || (this.hooksSeen && this.state !== 'idle' && this.state !== 'stopped')) return;
    if (!this.execution && this.deps.canWake && !this.deps.canWake()) return;
    if (this.execution) {
      const next = this.queue[0];
      if (!next) return;
      this.submitting = true;
      this.setState('working');
      void this.execution.send(this.format(next)).then(() => {
        // Remove only the accepted message; new arrivals remain queued.
        this.queue = this.queue.filter(m => m.id !== next.id);
        this.record({ type: 'delivered', ...next });
        this.queueChanged();
      }).catch(() => {
        // A lost acknowledgement may have followed acceptance. Never replay automatically.
        this.paused = true;
        this.record({ type: 'notice', tone: 'attention', text: 'Could not confirm delivery. Check the conversation before resuming the queue.' });
        this.queueChanged();
      }).finally(() => {
        this.submitting = false;
        const events = this.submissionEvents.splice(0);
        for (const event of events) this.agent(event);
        if (this.state === 'idle' || this.state === 'stopped') this.agent({ type: 'state', state: this.state });
      });
      return;
    }
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

  wakeReady(): void { this.deliver(); }

  /** A frame from the browser. */
  person(msg: { type?: unknown; id?: unknown; text?: unknown; context?: unknown; decision?: unknown; session?: unknown; count?: unknown }): void {
    if (msg.session && this.session && msg.session !== this.session.id) return;
    if (msg.type === 'viewers' && typeof msg.count === 'number' && Number.isSafeInteger(msg.count) && msg.count >= 0) return this.setViewers(msg.count);
    if (msg.type === 'joined') return this.deps.send(this.snapshot());
    if (msg.type === 'send' || msg.type === 'receipt') {
      if (typeof msg.text !== 'string' || !msg.text.trim() || typeof msg.id !== 'string') return;
      if (msg.id.length > 200 || msg.text.length > 32000 || this.queue.length >= 100 || this.queue.some(m => m.id === msg.id) || this.events.some(e => e.type === 'delivered' && e.id === msg.id)) return;
      if (msg.type === 'receipt') {
        return this.record({ type: 'delivered', id: msg.id, text: scrubber()(msg.text), ...(typeof msg.context === 'string' ? { context: scrubber()(msg.context) } : {}) });
      }
      const held = this.paused && this.queue.length > 0;
      this.queue.push({ id: msg.id, text: msg.text, ...(typeof msg.context === 'string' && msg.context ? { context: msg.context } : {}) });
      this.paused = held;
      this.queueChanged();
      return this.deliver();
    }
    if (msg.type === 'approval') {
      if ((!this.execution && !this.localApprovals.size) || !this.session?.capabilities.approvals || typeof msg.id !== 'string' || !this.approvals.has(msg.id) || this.answering.has(msg.id) || (msg.decision !== 'accept' && msg.decision !== 'decline')) return;
      const id = msg.id;
      this.answering.add(id);
      const local = this.localApprovals.get(id);
      if (local) { local(msg.decision); return; }
      void this.execution!.approve(id, msg.decision).catch(() => {
        this.answering.delete(id);
        const approval = [...this.events].reverse().find(e => e.type === 'approval' && e.id === id);
        if (approval && this.approvals.has(id)) this.record({ ...approval, status: 'pending' });
        this.record({ type: 'notice', tone: 'attention', text: 'The approval could not be sent. Try again or answer in your agent.' });
      });
      return;
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
      if (this.session?.capabilities.stop === 'none') return;
      this.paused = true;
      for (const finish of this.localApprovals.values()) finish('decline');
      this.queueChanged();
      if (this.state === 'idle' || this.state === 'stopped') return this.stopped();
      this.setState('stopping');
      if (this.execution) {
        void this.execution.stop().catch(() => {
          this.setState('working');
          this.record({ type: 'notice', tone: 'attention', text: 'Could not confirm Stop. Your agent may still be working.' });
        });
      } else if (this.inFlight) this.deps.killCommand(this.inFlight.command);
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
        if (prompt && !/^\s*</.test(prompt) && !prompt.includes('Board chat:')) this.afterStop = false;
        this.textThisTurn = false;
        if (this.state !== 'stopping') this.setState('working');
        // Turns the harness starts itself carry its own wrapper, and a delivered message is already on the board.
        if (prompt && !/^\s*</.test(prompt) && !prompt.includes('Board chat:')) this.record({ type: 'user', id: `t${this.nextId++}`, text: scrubber()(prompt.slice(0, MAX_TEXT_CHARS)), origin: 'terminal' });
        return {};
      }
      case 'PermissionRequest':
        if (this.state === 'stopping' || this.afterStop) return halt({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: STOPPED_REASON } } });
        return {};
      case 'PreToolUse': {
        if (this.state === 'stopping' || this.afterStop) return halt({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: STOPPED_REASON } });
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
          this.deliver();
          return {};
        }
        if (this.deps.canWake) {
          this.setState(this.afterStop ? 'stopped' : 'idle');
          this.deliver();
          return {};
        }
        if (this.state === 'stopped' && this.paused) return {};
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
export function killCommand(command: string, run: typeof execFile = execFile, kill: (pid: number) => void = pid => process.kill(pid, 'SIGTERM'), owner?: string): void {
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
    const ownerPid = owner ? Number(owner.split(':')[0]) : undefined;
    const ownerCommand = owner?.slice(owner.indexOf(':') + 1);
    // Detached helpers may only inspect the recorded harness, never ancestors or siblings.
    const root = ownerPid ? rows.find(r => r.pid === ownerPid && r.command === ownerCommand) : undefined;
    if (ownerPid && !root) return;
    const scoped = root ? rows.map(r => r.pid === root.pid ? { ...r, ppid: 0 } : r) : rows;
    const shells = shellsRunning(command, scoped, root?.pid ?? process.pid);
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
      if (now - statSync(file).mtimeMs > (name.endsWith('.connection.json') ? 12 * 60 * 60_000 : SAVED_STATE_MS)) unlinkSync(file);
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
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--token', '--session', '--agent', '--socket', '--owner'].includes(argv[i]) || !argv[i + 1] || flags.has(argv[i])) throw new HelperError(CHAT_USAGE);
    flags.set(argv[i], argv[i + 1]);
  }
  const token = flags.get('--token');
  if (!token) throw new HelperError(CHAT_USAGE);
  const agent = flags.get('--agent') ?? 'claude-code';
  if (agent !== 'claude-code' && agent !== 'codex') throw new HelperError(CHAT_USAGE);
  const thread = flags.get('--session') ?? (agent === 'codex' ? process.env.CODEX_THREAD_ID : undefined);
  if (thread && !/^[a-zA-Z0-9_:.-]{1,180}$/.test(thread)) throw new HelperError(CHAT_USAGE);
  if (agent === 'codex' && !thread) throw new HelperError('redcrayon: chat needs the current conversation id.');
  const sessionId = thread ? (thread.startsWith(`${agent}:`) ? thread : `${agent}:${thread}`) : undefined;
  const board = boardOfToken(token);
  const WS = (globalThis as { WebSocket?: new (url: string) => Socketish }).WebSocket;
  if (!WS) throw new HelperError('redcrayon: chat needs Node 22 or newer.');
  const url = `${origin.replace(/^http/, 'ws')}/chat/${board}`;
  const path = chatSocketPath(cwd, sessionId);
  mkdirSync(chatDir(), { recursive: true, mode: 0o700 });
  pruneSavedState(chatDir(), Date.now());
  await removeDeadSockets(chatDir(), Date.now());
  const statePath = `${path}.json`;

  let ws: Socketish | null = null;
  let relayReady = false;
  let waiter: Socket | undefined;
  let adapter: Awaited<ReturnType<typeof connectCodex>> | undefined;
  const controller = new AbortController();
  let done: (code: number) => void = () => {};
  const finished = new Promise<number>(resolve => (done = resolve));
  let closing = false;
  const quit = () => { closing = true; done(0); controller.abort(); };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    try {
      writeFileSync(statePath, JSON.stringify({ board, origin, session: sessionId, state: core.state, events: core.events, queue: core.queue, paused: core.paused }), { mode: 0o600 });
    } catch {
      // history is a convenience
    }
  };
  const core: ChatCore = new ChatCore({
    send: e => {
      if (ws?.readyState === 1) ws.send(JSON.stringify(e));
    },
    wake: line => {
      if (!sessionId || agent !== 'claude-code') return wake(line);
      if (waiter && !waiter.destroyed) { waiter.end(JSON.stringify({ wake: line }) + '\n'); waiter = undefined; }
    },
    canWake: sessionId && agent === 'claude-code' ? () => Boolean(waiter && !waiter.destroyed) : undefined,
    killCommand: command => { if (!sessionId || flags.has('--owner')) killCommand(command, execFile, pid => process.kill(pid, 'SIGTERM'), flags.get('--owner')); },
    changed: () => {
      saveTimer ??= setTimeout(() => {
        saveTimer = undefined;
        save();
      }, 250);
    },
  });
  if (sessionId && agent === 'claude-code') {
    core.session = { id: sessionId, agent, name: 'Claude Code', capabilities: { stop: 'step', approvals: true } };
    core.hook({ hook_event_name: 'Connected' });
  }
  // A re-armed helper picks up where the last one stopped.
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    if (saved.board === board && saved.origin === origin && saved.session === sessionId) {
      core.restore({ ...saved, ...(agent === 'codex' ? { events: [] } : {}) });
      if (sessionId && core.queue.length) core.paused = true;
    }
  } catch {
    // first run
  }

  const server: Server = createServer(conn => {
    let raw = '';
    conn.setEncoding('utf8');
    conn.on('data', async chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) { conn.destroy(); return; }
      const end = raw.indexOf('\n');
      if (end < 0) return;
      conn.removeAllListeners('data');
      let answer: Record<string, unknown> = {};
      try {
        const input = JSON.parse(raw.slice(0, end));
        if (input.hook_event_name === 'BoardChatWait') {
          waiter?.end('{}\n');
          waiter = conn;
          core.wakeReady();
          return;
        }
        if (input.hook_event_name === 'BoardChatPing') {
          const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
          answer = { running: true, connected: relayReady, board, origin, expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : 0 };
        }
        else if (input.hook_event_name === 'SessionEnd') { conn.end('{}\n'); quit(); return; }
        else if (input.hook_event_name === 'PermissionRequest' && core.session) {
          answer = core.hook(input);
          if (answer.hookSpecificOutput) { conn.end(`${JSON.stringify(answer)}\n`); return; }
          if (findSecret(JSON.stringify(input.tool_input ?? {}))) {
            core.agent({ type: 'notice', tone: 'attention', text: 'This approval contains sensitive details. Review it in your agent.' });
            conn.end('{}\n'); return;
          }
          const id = `permission:${input.tool_use_id ?? randomUUID()}`;
          const details = input.tool_name === 'Bash' ? input.tool_input?.command : input.tool_input?.file_path;
          const decision = await core.askApproval(id, `Allow ${String(input.tool_name ?? 'this action')} in ${cwd}?${typeof details === 'string' ? `\n${details}` : '\nReview the action in your terminal.'}`);
          if (decision) answer = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decision === 'accept' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Declined from the board by the person running you.' } } };
        } else answer = core.hook(input);
      } catch { /* A failed hook leaves the terminal available. */ }
      conn.end(`${JSON.stringify(answer)}\n`);
    });
    conn.on('error', () => {});
    conn.on('close', () => { if (waiter === conn) waiter = undefined; });
  });
  if (!sessionId) {
    try { unlinkSync(path); } catch { /* Legacy Monitor replacement. */ }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });

  const socketFile = statSync(path).ino;
  let backoff = 1000;
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
  if (agent === 'codex') {
    try {
      core.paused = true;
      adapter = await connectCodex({ threadId: thread!.replace(/^codex:/, ''), cwd, socketPath: flags.get('--socket'), signal: controller.signal, emit: event => core.agent(event), onDisconnect: () => done(1) });
      core.attach(adapter.session, adapter);
      if (!core.queue.length) core.paused = false;
    } catch (error) {
      if (!closing) {
        server.close();
        core.dispose();
        clearTimeout(saveTimer);
        process.removeListener('SIGINT', quit);
        process.removeListener('SIGTERM', quit);
        throw error;
      }
    }
  }
  const connect = () => {
    if (closing) return;
    const socket = new WS(url);
    ws = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ auth: token, role: 'agent', ...(core.session ? { session: core.session } : {}) })));
    socket.addEventListener('message', ev => {
      let msg: { ok?: boolean; type?: unknown; id?: unknown; text?: unknown; context?: unknown; count?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.ok) {
        relayReady = true;
        backoff = 1000;
        log(`redcrayon chat: connected to board ${board}.`);
        return;
      }
      core.person(msg);
    });
    socket.addEventListener('close', ev => {
      if (ws === socket) { ws = null; relayReady = false; core.person({ type: 'viewers', count: 0 }); }
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

  const code = await finished;
  closing = true;
  (ws as Socketish | null)?.close();
  clearTimeout(saveTimer);
  core.dispose();
  adapter?.close();
  waiter?.end('{}\n');
  process.removeListener('SIGINT', quit);
  process.removeListener('SIGTERM', quit);
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
