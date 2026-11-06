import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatCore, MAX_SNAPSHOT_BYTES, SAVED_STATE_MS, WAKE_WAIT_MS, WHOLE_TEXT_WAIT_MS, pruneSavedState, runChat, scrubber, shellsRunning } from './chat';
import { chatDir, chatSocketPath, removeDeadSockets } from './chat-path';
import { chatRequest } from './chat-bootstrap';

function setup() {
  const sent: Record<string, any>[] = [];
  const wakes: string[] = [];
  const kills: string[] = [];
  const core = new ChatCore({ send: e => sent.push(e), wake: l => wakes.push(l), killCommand: c => kills.push(c) });
  return { core, sent, wakes, kills, states: () => sent.filter(e => e.type === 'state').map(e => e.state) };
}
const hook = (core: ChatCore, hook_event_name: string, rest: Record<string, unknown> = {}) => core.hook({ hook_event_name, cwd: '/repo', ...rest });
const send = (core: ChatCore, id: string, text = id, context?: string) => core.person({ type: 'send', id, text, context });

describe('the blocking queue', () => {
  it('an idle agent is woken with the message; the next waits until it finishes', () => {
    const { core, wakes } = setup();
    hook(core, 'Stop');
    send(core, 'a', 'first');
    send(core, 'b', 'second');
    expect(wakes).toEqual(['Board chat: first']);
    expect(core.queue.map(m => m.id)).toEqual(['b']);
    expect(hook(core, 'Stop')).toEqual({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'Board chat: second' } });
    expect(wakes).toHaveLength(1);
    expect(hook(core, 'Stop')).toEqual({});
    expect(core.state).toBe('idle');
  });

  it('a message handed over at Stop shows after any text still landing from the last reply', () => {
    vi.useFakeTimers();
    const { core, sent } = setup();
    hook(core, 'PreToolUse', { tool_name: 'Read', tool_input: {} });
    send(core, 'a', 'next');
    hook(core, 'Stop');
    hook(core, 'MessageDisplay', { message_id: 'm', delta: 'Finished.', final: true });
    vi.advanceTimersByTime(1000);
    expect(sent.filter(e => e.type === 'text' || e.type === 'delivered').map(e => e.type)).toEqual(['text', 'delivered']);
    vi.useRealTimers();
  });

  it('a queued message can be deleted until it is delivered', () => {
    const { core } = setup();
    hook(core, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' } });
    send(core, 'a');
    send(core, 'b');
    core.person({ type: 'delete', id: 'a' });
    expect(hook(core, 'Stop')).toEqual({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'Board chat: b' } });
  });

  it('an agent without hooks gets messages as they come', () => {
    const { core, wakes } = setup();
    send(core, 'a');
    send(core, 'b');
    expect(wakes).toEqual(['Board chat: a', 'Board chat: b']);
  });

  it('quotes the selected item as data, and keeps a message on one line', () => {
    const { core, wakes } = setup();
    send(core, 'a', 'why\nthis?', 'edge Web app -> Orders DB');
    expect(wakes).toEqual(['Board chat: why / this? (Selected on the board, as data: "edge Web app -> Orders DB")']);
  });
});

describe('Stop', () => {
  it('denies a late permission request after Stop, including after the stop hook settles', () => {
    const { core, sent } = setup();
    hook(core, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'touch result' } });
    core.person({ type: 'stop' });
    const answer = hook(core, 'PermissionRequest') as any;
    expect(answer.hookSpecificOutput.decision.behavior).toBe('deny');
    hook(core, 'Stop');
    expect((hook(core, 'PermissionRequest') as any).hookSpecificOutput.decision.behavior).toBe('deny');
    expect(sent.some(e => e.type === 'approval' && e.status === 'pending')).toBe(false);
    send(core, 'new', 'New request');
    expect(hook(core, 'PermissionRequest')).toEqual({});
  });
  it('halts at the next hook, signals the running command and pauses the queue', () => {
    const { core, kills, states, sent } = setup();
    hook(core, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test', description: 'Run tests' } });
    send(core, 'a');
    core.person({ type: 'stop' });
    expect(kills).toEqual(['pnpm test']);
    expect(core.state).toBe('stopping');
    const answer = hook(core, 'PostToolUse', { tool_name: 'Bash' });
    expect(answer.continue).toBe(false);
    expect(states()).toEqual(['stopping', 'stopped']);
    expect(sent).toContainEqual({ type: 'notice', text: 'Stopped.' });
    expect(core.queue.map(m => m.id)).toEqual(['a']);
    expect(core.paused).toBe(true);
    expect(hook(core, 'Stop')).toEqual({});
  });

  it('denies a tool the agent was about to run', () => {
    const { core } = setup();
    hook(core, 'PreToolUse', { tool_name: 'Read', tool_input: {} });
    core.person({ type: 'stop' });
    const answer = hook(core, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/repo/a.ts' } }) as any;
    expect(answer.continue).toBe(false);
    expect(answer.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('does not touch a background command', () => {
    const { core, kills } = setup();
    hook(core, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm dev', run_in_background: true } });
    core.person({ type: 'stop' });
    expect(kills).toEqual([]);
  });

  it('resume or a new message releases the paused queue', () => {
    const { core, wakes } = setup();
    hook(core, 'PreToolUse', { tool_name: 'Read', tool_input: {} });
    send(core, 'a');
    core.person({ type: 'stop' });
    hook(core, 'Stop');
    expect(wakes).toEqual([]);
    core.person({ type: 'resume' });
    expect(wakes).toEqual(['Board chat: [New message after Stop: act on it.] a']);
  });

  it('a failed tool counts as a hook for halting: a signalled command fails', () => {
    const { core } = setup();
    hook(core, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } });
    core.person({ type: 'stop' });
    expect(hook(core, 'PostToolUseFailure', { tool_name: 'Bash' }).continue).toBe(false);
  });
});

describe('shellsRunning', () => {
  const snapshot = '/bin/zsh -c source /home/x/.claude/shell-snapshots/s.sh && eval';
  const rows = [
    { pid: 1, ppid: 0, command: 'launchd' },
    { pid: 10, ppid: 1, command: 'claude' },
    { pid: 20, ppid: 10, command: `${snapshot} 'npx chat --token t'` },
    { pid: 21, ppid: 20, command: 'node redcrayon.mjs chat --token t' },
    { pid: 30, ppid: 10, command: `${snapshot} './slow-build.sh'` },
    { pid: 31, ppid: 30, command: 'sh ./slow-build.sh' },
    { pid: 40, ppid: 10, command: `${snapshot} 'pnpm dev'` },
    { pid: 50, ppid: 1, command: 'claude' },
    { pid: 51, ppid: 50, command: `${snapshot} './slow-build.sh'` },
  ];

  it('finds the shell in this session running the command, and nothing else', () => {
    expect(shellsRunning('./slow-build.sh', rows, 21).map(r => r.pid)).toEqual([30]);
  });

  it('never its own shell, and nothing when no shell matches', () => {
    expect(shellsRunning('chat --token t', rows, 21)).toEqual([]);
    expect(shellsRunning('cargo build --release', rows, 21)).toEqual([]);
  });

  it('does not climb past this session to someone else with the same words on their command line', () => {
    const sibling = { pid: 60, ppid: 1, command: 'claude --prompt "run ./other-build.sh"' };
    const otherShell = { pid: 61, ppid: 1, command: `${snapshot} './other-build.sh'` };
    expect(shellsRunning('./other-build.sh', [...rows, sibling, otherShell], 21)).toEqual([]);
  });

  it('nothing but a tool shell: a process that only mentions the command is not signalled', () => {
    const editor = { pid: 70, ppid: 10, command: 'vim ./slow-build.sh' };
    expect(shellsRunning('./slow-build.sh', [...rows, editor], 21).map(r => r.pid)).toEqual([30]);
  });
});

describe('a woken agent that never answers', () => {
  it('tells the person after a while, unless a hook fires', () => {
    vi.useFakeTimers();
    const notices = (sent: Record<string, any>[]) => sent.filter(e => e.type === 'notice' && e.tone === 'attention');
    const silent = setup();
    send(silent.core, 'a');
    vi.advanceTimersByTime(WAKE_WAIT_MS);
    expect(notices(silent.sent)).toHaveLength(1);

    const answering = setup();
    hook(answering.core, 'Stop');
    send(answering.core, 'a');
    hook(answering.core, 'UserPromptSubmit', { prompt: 'Board chat: a' });
    vi.advanceTimersByTime(WAKE_WAIT_MS);
    expect(notices(answering.sent)).toHaveLength(0);
    vi.useRealTimers();
  });
});

describe('a long conversation', () => {
  it('still fits one frame, keeping the newest talk', () => {
    const { core } = setup();
    for (let i = 0; i < 400; i++) hook(core, 'MessageDisplay', { message_id: `m${i}`, delta: `${i}:${'x'.repeat(4000)}`, final: true });
    const snapshot = core.snapshot();
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect((snapshot.events.at(-1) as any).delta.startsWith('399:')).toBe(true);
    expect(snapshot.events.length).toBeLessThan(400);
  });
});

describe('pruneSavedState', () => {
  it('removes talk from ended sessions and leaves a recent one and the sockets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-prune-'));
    const now = Date.now();
    for (const name of ['old.json', 'new.json', 'old.sock']) writeFileSync(join(dir, name), '{}');
    const past = new Date(now - SAVED_STATE_MS - 1000);
    utimesSync(join(dir, 'old.json'), past, past);
    utimesSync(join(dir, 'old.sock'), past, past);
    pruneSavedState(dir, now);
    expect(readdirSync(dir).sort()).toEqual(['new.json', 'old.sock']);
  });
});

describe('runChat', () => {
  const home = process.env.HOME;
  afterEach(() => {
    process.env.HOME = home;
    vi.unstubAllGlobals();
  });

  it('returns permissions to the terminal immediately without viewers, including when the last viewer leaves', async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'rc-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'rc-repo-'));
    class Socket {
      static all: Socket[] = [];
      readyState = 1;
      sent: Record<string, any>[] = [];
      handlers: Record<string, (ev: any) => void> = {};
      constructor() { Socket.all.push(this); }
      addEventListener(type: string, fn: (ev: any) => void) { this.handlers[type] = fn; }
      send(raw: string) { this.sent.push(JSON.parse(raw)); }
      close() {}
      frame(value: object) { this.handlers.message({ data: JSON.stringify(value) }); }
    }
    vi.stubGlobal('WebSocket', Socket);
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const token = `x.${Buffer.from(JSON.stringify({ board: '7', exp })).toString('base64url')}.y`;
    const running = runChat(['--token', token, '--session', 'permissions'], 'http://relay.invalid', cwd, () => {}, () => {});
    const path = chatSocketPath(cwd, 'claude-code:permissions');
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    const socket = Socket.all[0];
    const request = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo hello' } };
    try {
      socket.frame({ ok: true });
      expect(await chatRequest(path, { hook_event_name: 'BoardChatPing' })).toMatchObject({ expiresAt: exp * 1000 });
      expect(await chatRequest(path, { hook_event_name: 'BoardChatPing' })).not.toHaveProperty('token');
      expect(await chatRequest(path, request, 500)).toEqual({});
      expect(socket.sent.some(e => e.type === 'approval')).toBe(false);
      socket.frame({ type: 'viewers', count: 1 });
      const pending = chatRequest(path, request, 1000);
      await vi.waitFor(() => expect(socket.sent.some(e => e.type === 'approval' && e.status === 'pending')).toBe(true));
      socket.frame({ type: 'viewers', count: 0 });
      expect(await pending).toEqual({});
      socket.sent.length = 0;
      socket.frame({ type: 'viewers', count: 1 });
      const allowed = chatRequest(path, request, 1000);
      await vi.waitFor(() => expect(socket.sent.some(e => e.type === 'approval' && e.status === 'pending')).toBe(true));
      const approval = socket.sent.find(e => e.type === 'approval' && e.status === 'pending')!;
      socket.frame({ type: 'approval', id: approval.id, decision: 'accept' });
      expect(await allowed).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
    } finally {
      await chatRequest(path, { hook_event_name: 'SessionEnd' });
      await running;
    }
  });

  it('a helper that was replaced leaves the new one its socket; the last one out removes it', async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'rc-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'rc-repo-'));
    mkdirSync(join(cwd, '.git'));
    class Socket {
      static all: Socket[] = [];
      readyState = 1;
      handlers: Record<string, (ev: any) => void> = {};
      constructor() { Socket.all.push(this); }
      addEventListener(type: string, fn: (ev: any) => void) { this.handlers[type] = fn; }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', Socket);
    const token = `x.${Buffer.from(JSON.stringify({ board: '7' })).toString('base64url')}.y`;
    const start = () => runChat(['--token', token], 'http://relay.invalid', cwd, () => {}, () => {});
    const path = chatSocketPath(cwd);
    expect(path.startsWith(chatDir())).toBe(true);
    const first = start();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    expect(statSync(chatDir()).mode & 0o077).toBe(0);
    const firstFile = statSync(path).ino;
    const second = start();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(2));
    expect(statSync(path).ino).not.toBe(firstFile);

    Socket.all[0].handlers.close({ code: 4009 });
    expect(await first).toBe(0);
    expect(existsSync(path)).toBe(true);
    const answer = await new Promise<string>((resolve, reject) => {
      const c = connect(path);
      let out = '';
      c.on('connect', () => c.write(`${JSON.stringify({ hook_event_name: 'Stop', cwd })}\n`));
      c.on('data', d => (out += d));
      c.on('close', () => resolve(out));
      c.on('error', reject);
    });
    expect(JSON.parse(answer)).toEqual({});

    Socket.all[1].handlers.close({ code: 4009 });
    expect(await second).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});

describe('what reaches the browser', () => {
  it('records review receipts once without queuing or waking the agent', () => {
    const { core, sent, wakes } = setup();
    const receipt = { type: 'receipt', id: 'marks-1', text: 'I sent 2 red-crayon marks.', context: 'Red-crayon marks' };
    core.person(receipt);
    core.person(receipt);
    expect(sent.filter(e => e.type === 'delivered')).toEqual([{ ...receipt, type: 'delivered' }]);
    expect(core.queue).toEqual([]);
    expect(wakes).toEqual([]);
    core.dispose();
  });

  it('expires viewer heartbeats and releases pending local approvals', async () => {
    vi.useFakeTimers();
    const { core } = setup();
    try {
      core.person({ type: 'viewers', count: 1 });
      const answer = core.askApproval('permission', 'Allow?');
      await vi.advanceTimersByTimeAsync(90_001);
      expect(await answer).toBeUndefined();
      expect(await core.askApproval('next', 'Allow?')).toBeUndefined();
    } finally { core.dispose(); vi.useRealTimers(); }
  });
  it('streams text as it displays, and sends a whole message only when none streamed', () => {
    vi.useFakeTimers();
    const { core, sent } = setup();
    hook(core, 'MessageDisplay', { message_id: 'm', delta: 'one\n', final: false });
    hook(core, 'Stop', { last_assistant_message: 'one' });
    vi.advanceTimersByTime(WHOLE_TEXT_WAIT_MS);
    expect(sent.filter(e => e.type === 'text')).toEqual([{ type: 'text', message: 'm', delta: 'one\n', final: false }]);
    hook(core, 'Stop', { last_assistant_message: 'whole' });
    vi.advanceTimersByTime(WHOLE_TEXT_WAIT_MS);
    expect(sent.filter(e => e.type === 'text').at(-1)).toMatchObject({ delta: 'whole', final: true });
    vi.useRealTimers();
  });

  it('live text landing just after Stop is not sent twice', () => {
    vi.useFakeTimers();
    const { core, sent } = setup();
    hook(core, 'Stop', { last_assistant_message: 'ready' });
    hook(core, 'MessageDisplay', { message_id: 'm', delta: 'ready', final: true });
    vi.advanceTimersByTime(WHOLE_TEXT_WAIT_MS);
    expect(sent.filter(e => e.type === 'text').map(e => e.delta)).toEqual(['ready']);
    vi.useRealTimers();
  });

  it('never sends a command, and hides a secrets file by name', () => {
    const { core, sent } = setup();
    hook(core, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'curl -H "x: sk-secret"', description: 'Call the API' } });
    hook(core, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    hook(core, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/repo/.env.local' } });
    hook(core, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/repo/src/a.ts' } });
    hook(core, 'PreToolUse', { tool_name: 'mcp__draw__delete_edge', tool_input: {} });
    expect(sent.filter(e => e.type === 'tool').map(e => e.summary)).toEqual(['Call the API', 'Ran a command', 'Read a secrets file', 'Edited src/a.ts', 'Board: delete edge']);
    expect(JSON.stringify(sent)).not.toContain('sk-secret');
  });

  it('mirrors prompts typed in the terminal, not the harness\'s own turns or delivered messages', () => {
    const { core, sent } = setup();
    hook(core, 'UserPromptSubmit', { prompt: 'fix the bug' });
    hook(core, 'UserPromptSubmit', { prompt: '<task-notification>done</task-notification>' });
    hook(core, 'UserPromptSubmit', { prompt: 'Board chat: hello' });
    expect(sent.filter(e => e.type === 'user').map(e => e.text)).toEqual(['fix the bug']);
  });

  it('a snapshot answers a browser that joins', () => {
    const { core, sent } = setup();
    hook(core, 'UserPromptSubmit', { prompt: 'hello' });
    core.person({ type: 'joined' });
    expect(sent.at(-1)).toMatchObject({ type: 'snapshot', state: 'working', queue: [] });
    expect(sent.at(-1)!.events).toHaveLength(1);
  });
});

describe('scrubber', () => {
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  it('hides a line that looks like a secret and keeps the rest', () => {
    expect(scrubber()(`ok\nmy key is ${key}\nfine`)).toBe('ok\n[hidden: this line looks like a AWS access key]\nfine');
  });

  it('hides a private key\'s whole body, across batches', () => {
    const scrub = scrubber();
    expect(scrub('-----BEGIN PRIVATE KEY-----\nMIIabc\n')).toBe('[hidden: this line looks like a private key]\n[hidden: this line looks like a private key]\n');
    expect(scrub('moreabc\n-----END PRIVATE KEY-----\nafter')).toBe('[hidden: this line looks like a private key]\n[hidden: this line looks like a private key]\nafter');
  });
});

describe('a secret split across batches', () => {
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';

  it('is hidden: a partial line waits for the rest of its line', () => {
    const scrub = scrubber();
    expect(scrub(`first\nmy key is ${key.slice(0, 8)}`, false)).toBe('first\n');
    expect(scrub(`${key.slice(8)} done\nnext\n`, false)).toBe('[hidden: this line looks like a AWS access key]\nnext\n');
  });

  it('the last batch lets out what was waiting', () => {
    const scrub = scrubber();
    expect(scrub('no newline yet', false)).toBe('');
    expect(scrub('', true)).toBe('no newline yet');
  });

  it('through the hook, nothing partial reaches the browser', () => {
    const { core, sent } = setup();
    hook(core, 'MessageDisplay', { message_id: 'm', delta: `my key is ${key.slice(0, 8)}`, final: false });
    hook(core, 'MessageDisplay', { message_id: 'm', delta: key.slice(8), final: true });
    expect(JSON.stringify(sent)).not.toContain(key.slice(0, 8));
    expect(sent.filter(e => e.type === 'text').map(e => e.delta).join('')).toContain('[hidden:');
  });
});

describe('removeDeadSockets', () => {
  const longAgo = new Date(Date.now() - 60_000);

  async function deadSocket(path: string) {
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`]);
    await new Promise(resolve => child.stdout.once('data', resolve));
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    expect(existsSync(path)).toBe(true);
  }

  it('removes the socket of a helper that was killed, and leaves a live one and other files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-dead-'));
    await deadSocket(join(dir, 'dead.sock'));
    utimesSync(join(dir, 'dead.sock'), longAgo, longAgo);
    const live = createServer();
    await new Promise<void>(resolve => live.listen(join(dir, 'live.sock'), resolve));
    utimesSync(join(dir, 'live.sock'), longAgo, longAgo);
    writeFileSync(join(dir, 'talk.json'), '{}');
    await removeDeadSockets(dir, Date.now());
    expect(readdirSync(dir).sort()).toEqual(['live.sock', 'talk.json']);
    await new Promise(resolve => live.close(resolve));
  });

  it('leaves a just-created socket: a helper may be between creating it and listening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-new-'));
    await deadSocket(join(dir, 'new.sock'));
    await removeDeadSockets(dir, Date.now());
    expect(existsSync(join(dir, 'new.sock'))).toBe(true);
  });

  it('a missing folder is nothing to do', async () => {
    await expect(removeDeadSockets(join(tmpdir(), 'rc-no-such-folder'), Date.now())).resolves.toBeUndefined();
  });
});

describe('chatSocketPath', () => {
  it('is the same from anywhere in a checkout', () => {
    expect(chatSocketPath(process.cwd())).toBe(chatSocketPath(`${process.cwd()}/src`));
  });
});

describe('execution adapters', () => {
  const session = { id: 'codex:thread', agent: 'codex', name: 'Codex', capabilities: { stop: 'interrupt' as const, approvals: true } };
  it.each(['idle', 'stopped'] as const)('keeps a partial reply when %s arrives before send acknowledgement', async state => {
    const { core, sent } = setup();
    let accept!: () => void;
    core.attach(session, { send: () => new Promise<void>(resolve => { accept = resolve; }), stop: vi.fn(), approve: vi.fn() });
    core.agent({ type: 'state', state: 'idle' });
    send(core, 'a');
    core.agent({ type: 'text', message: 'answer', delta: 'last partial line', final: false });
    core.agent({ type: 'state', state });
    accept();
    await vi.waitFor(() => expect(sent).toContainEqual({ type: 'text', message: 'answer', delta: 'last partial line', final: true }));
    expect(sent.findIndex(e => e.type === 'delivered')).toBeLessThan(sent.findIndex(e => e.type === 'text'));
  });
  it('waits for acceptance, serializes work and never replays duplicate browser sends', async () => {
    const { core, sent } = setup();
    let accept!: () => void;
    const submit = vi.fn(() => new Promise<void>(resolve => { accept = resolve; }));
    core.attach(session, { send: submit, stop: vi.fn(), approve: vi.fn() });
    core.agent({ type: 'state', state: 'idle' });
    send(core, 'a'); send(core, 'a'); send(core, 'b');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(sent.filter(e => e.type === 'delivered')).toHaveLength(0);
    accept(); await Promise.resolve(); await Promise.resolve();
    expect(sent.filter(e => e.type === 'delivered')).toHaveLength(1);
    expect(core.queue.map(m => m.id)).toEqual(['b']);
    expect(core.snapshot().session).toEqual(session);
  });
  it('retains failed sends for explicit retry rather than losing or endlessly replaying them', async () => {
    const { core, sent } = setup();
    core.attach(session, { send: vi.fn().mockRejectedValue(new Error('offline')), stop: vi.fn(), approve: vi.fn() });
    core.agent({ type: 'state', state: 'idle' });
    send(core, 'a'); await Promise.resolve(); await Promise.resolve();
    expect(core.queue.map(m => m.id)).toEqual(['a']);
    expect(core.paused).toBe(true);
    expect(sent.some(e => e.type === 'delivered')).toBe(false);
  });
  it('filters fragmented text and waits for interruption confirmation', async () => {
    const { core, sent } = setup();
    const stop = vi.fn().mockResolvedValue(undefined);
    core.attach(session, { send: vi.fn(), stop, approve: vi.fn() });
    core.agent({ type: 'text', message: 'm', delta: '-----BEGIN PRIVATE', final: false });
    core.agent({ type: 'text', message: 'm', delta: ' KEY-----\nsecret-body\n-----END PRIVATE KEY-----', final: true });
    expect(JSON.stringify(sent)).not.toContain('secret-body');
    core.person({ type: 'stop' }); await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(core.state).toBe('stopping');
    core.agent({ type: 'state', state: 'stopped' });
    expect(core.state).toBe('stopped');
  });
  it('only answers a pending approval once', async () => {
    const { core } = setup();
    const approve = vi.fn().mockResolvedValue(undefined);
    core.attach(session, { send: vi.fn(), stop: vi.fn(), approve });
    core.agent({ type: 'approval', id: 'p1', summary: 'Edit a file', status: 'pending' });
    core.person({ type: 'approval', id: 'other', decision: 'accept' });
    core.person({ type: 'approval', id: 'p1', decision: 'accept' });
    core.person({ type: 'approval', id: 'p1', decision: 'accept' });
    await Promise.resolve();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith('p1', 'accept');
  });
});

describe('conversation recovery boundaries', () => {
  it('keeps a restored Stop in effect until another user request', () => {
    const { core } = setup();
    core.restore({ state: 'stopped', paused: true });
    expect(hook(core, 'PreToolUse', { tool_name: 'Bash' }).continue).toBe(false);
    send(core, 'new', 'New request');
    expect(hook(core, 'PreToolUse', { tool_name: 'Read' }).continue).toBeUndefined();
  });
  it('holds a new request after Stop until the wake listener is ready, denying old tool retries', () => {
    let ready = false;
    const wakes: string[] = [];
    const core = new ChatCore({ send: () => {}, wake: line => wakes.push(line), canWake: () => ready, killCommand: () => {} });
    hook(core, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'old command' } });
    core.person({ type: 'stop' });
    hook(core, 'PostToolUseFailure', { tool_name: 'Bash' });
    send(core, 'new', 'New request');
    expect(core.queue.map(m => m.id)).toEqual(['new']);
    expect(wakes).toEqual([]);
    expect(hook(core, 'PreToolUse', { tool_name: 'Bash' }).continue).toBe(false);
    hook(core, 'Stop');
    expect(wakes).toEqual([]);
    ready = true;
    core.wakeReady();
    expect(wakes).toEqual(['Board chat: [New message after Stop: act on it.] New request']);
    expect(core.queue).toEqual([]);
    expect(hook(core, 'PreToolUse', { tool_name: 'Read' }).continue).toBeUndefined();
  });
  it('isolates concurrent sessions in the same checkout', () => {
    expect(chatSocketPath(process.cwd(), 'claude-code:a')).not.toBe(chatSocketPath(process.cwd(), 'claude-code:b'));
    expect(chatSocketPath(process.cwd(), 'claude-code:a')).toBe(chatSocketPath(`${process.cwd()}/src`, 'claude-code:a'));
  });
  it('retains a paused ambiguous send when another message arrives', async () => {
    const { core } = setup();
    const submit = vi.fn().mockRejectedValue(new Error('ack lost'));
    core.attach({ id: 'codex:one', agent: 'codex', name: 'Codex', capabilities: { stop: 'interrupt', approvals: true } }, { send: submit, stop: vi.fn(), approve: vi.fn() });
    core.agent({ type: 'state', state: 'idle' });
    send(core, 'a'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    send(core, 'b'); await Promise.resolve();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(core.paused).toBe(true);
    expect(core.queue.map(m => m.id)).toEqual(['a', 'b']);
  });
  it('restores history without live approvals or duplicate generated message ids', () => {
    const { core } = setup();
    core.restore({ events: [{ type: 'user', id: 't9', text: 'before' }, { type: 'approval', id: 'p', status: 'pending', summary: 'old' }] });
    core.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'after' });
    expect(core.events.filter(e => e.type === 'user').map(e => e.id)).toEqual(['t9', 't10']);
    expect(core.events.find(e => e.type === 'approval')?.status).toBe('resolved');
  });
  it('does not offer a blind approval when its command contains secrets', () => {
    const { core, sent } = setup();
    core.agent({ type: 'approval', id: 'p', summary: 'run with AKIA' + 'ABCDEFGHIJKLMNOP', status: 'pending' });
    expect(sent.some(e => e.type === 'approval')).toBe(false);
    expect(sent.some(e => e.type === 'notice')).toBe(true);
  });
});
