import { realpathSync, openSync, fstatSync, readSync, closeSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { localCommand } from './local-runtime';
import { localCall, localEndpoint } from './local-mcp';
import { localDirectory } from './local-path';
import { hookResult } from './hook-result';

const LOCAL_BOARD_TOOL = '^mcp__(?:plugin_draw[-_]local_)?draw[-_]local__(open_board|read_board)$';
const BOARD = /^[a-zA-Z0-9_-]{1,100}$/;

function options(args: string[]) {
  const auto = args.includes('--auto'), flags = args.filter(arg => arg !== '--auto');
  if (args.filter(arg => arg === '--auto').length > 1 || auto === flags.includes('--board') || flags.length % 2 || flags.some((arg, i) => i % 2 === 0 && !['--board', '--repo', '--store'].includes(arg)) || flags.some((arg, i) => i % 2 === 1 && (!arg || arg.startsWith('--'))) || new Set(flags.filter((_, i) => i % 2 === 0)).size !== flags.length / 2) throw new Error('REJECTED: use --auto or --board slug [--repo path] [--store path]');
  const values = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) values.set(flags[i], flags[i + 1]);
  if (values.has('--board') && !BOARD.test(values.get('--board')!)) throw new Error('REJECTED: invalid board slug');
  return { auto, values };
}

export function localClaudeSettings(args: string[], launcher = localCommand()) {
  const { auto } = options(args);
  const absolute = args.map((arg, i) => i && ['--repo', '--store'].includes(args[i - 1]) ? resolve(arg) : arg);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [...launcher, 'local-claude-hook', ...absolute].map(quote).join(' ');
  const hook = { type: 'command', command, timeout: 5 };
  const wake = { ...hook, command: `${command} --wait`, asyncRewake: true, timeout: 43200 };
  return { hooks: {
    SessionStart: [{ hooks: [hook] }], UserPromptSubmit: [{ hooks: [hook, wake] }],
    PreToolUse: [{ hooks: [hook, wake] }], Stop: [{ hooks: [hook, wake] }], SessionEnd: [{ hooks: [hook] }],
    ...(auto ? { PostToolUse: [{ matcher: LOCAL_BOARD_TOOL, hooks: [hook, wake] }] } : {}),
  } };
}

// asyncRewake skips UserPromptSubmit. Confirm receipt from this session's user entries.
export function receivedClaudeDeliveries(path: string, session: string): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - 1024 * 1024), buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.flatMap(line => {
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId !== session || entry.type !== 'user' || typeof entry.message?.content !== 'string') return [];
        return [...entry.message.content.matchAll(/Board chat \[([a-f0-9-]{36})\]:/g)].map(match => match[1]);
      } catch { return []; }
    });
  } finally { closeSync(fd); }
}

export async function runLocalClaudeHook(args: string[]) {
  const { auto, values } = options(args.filter(arg => arg !== '--wait'));
  const waiting = args.includes('--wait');
  const endpointArgs = [...values].filter(([key]) => key !== '--board').flat();
  let board = values.get('--board') ?? '';
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) return 0; }
  let hook: Record<string, any>, repo: string;
  try {
    hook = JSON.parse(raw);
    if (!hook || Array.isArray(hook) || typeof hook.session_id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(hook.session_id) || typeof hook.cwd !== 'string') return 0;
    repo = realpathSync(hook.cwd);
    if (repo !== realpathSync(process.cwd()) || (values.has('--repo') && repo !== realpathSync(values.get('--repo')!))) return 0;
  } catch { return 0; }
  let binding: string | undefined, previous = '';
  const opening = auto && hook.hook_event_name === 'PostToolUse' && new RegExp(LOCAL_BOARD_TOOL).test(hook.tool_name);
  if (auto) {
    const directory = join(resolve(values.get('--store') ?? localDirectory(repo)), 'claude-sessions');
    binding = join(directory, `${hook.session_id}.json`);
    const saved = () => {
      try {
        if (statSync(binding!).size > 1024) return '';
        const value = JSON.parse(readFileSync(binding!, 'utf8'));
        return value.repo === repo && typeof value.board === 'string' && BOARD.test(value.board) ? value.board : '';
      } catch { return ''; }
    };
    board = previous = saved();
    if (opening && !waiting) {
      const result = hookResult(hook.tool_response);
      if (hook.tool_response?.isError || !result || result.isError || typeof result.slug !== 'string' || !BOARD.test(result.slug) || result.repo !== repo) return 0;
      try { if (hook.tool_input?.repo !== undefined && realpathSync(hook.tool_input.repo) !== repo) return 0; } catch { return 0; }
      board = result.slug;
    }
    // The asynchronous wake hook can start before the attaching hook saves its binding.
    if (opening && waiting && !board) for (let n = 0; n < 30 && !board; n++) { await new Promise(resolve => setTimeout(resolve, 100)); board = saved(); }
    if (!board) return 0;
  }
  const endpoint = localEndpoint(endpointArgs), session = `claude-code:${hook.session_id}`;
  const call = (input: object) => localCall(endpoint, { ...input, board, session });
  if (!waiting && (hook.hook_event_name === 'SessionStart' || opening)) {
    if (previous && previous !== board) await localCall(endpoint, { action: 'disconnect_local_agent', board: previous, session }).catch(() => {});
    const status = await call({ action: 'chat_status' });
    if (!status.connected || status.session?.id !== session) await call({ action: 'connect_local_agent', agent: 'claude-code', threadId: hook.session_id, cwd: repo });
    if (binding) {
      mkdirSync(join(binding, '..'), { recursive: true, mode: 0o700 });
      const temporary = `${binding}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ repo, board }), { mode: 0o600 });
      renameSync(temporary, binding);
    }
    if (hook.hook_event_name === 'SessionStart') return 0;
  }
  if (waiting) {
    for (;;) {
      const delivery = await call({ action: 'poll_local_agent' });
      if (delivery?.type === 'replaced') return 0;
      if (delivery?.type === 'message') { process.stderr.write(`Board chat [${delivery.id}]:\n${delivery.text}`); return 2; }
      // A step-stop is enforced by PreToolUse; keep the wake hook alive for the next message.
    }
  }
  if (typeof hook.transcript_path === 'string') {
    try { hook.received = receivedClaudeDeliveries(hook.transcript_path, hook.session_id); }
    catch { /* Missing receipt evidence keeps delivery unconfirmed. */ }
  }
  try { process.stdout.write(JSON.stringify(await call({ action: 'claude_local_hook', hook }))); }
  finally { if (binding && hook.hook_event_name === 'SessionEnd') rmSync(binding, { force: true }); }
  return 0;
}
