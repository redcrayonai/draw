import { realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { localCall, localEndpoint } from './local-mcp';

export function localClaudeSettings(args: string[]) {
  if (!args.includes('--board') || args.length % 2 || args.some((arg, i) => i % 2 === 0 && !['--board', '--repo', '--store'].includes(arg)) || args.some((arg, i) => i % 2 === 1 && !arg)) throw new Error('REJECTED: use --board slug [--repo path] [--store path]');
  const absolute = args.map((arg, i) => i && ['--repo', '--store'].includes(args[i - 1]) ? resolve(arg) : arg);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, resolve(process.argv[1]), 'local-claude-hook', ...absolute].map(quote).join(' ');
  const hook = { type: 'command', command, timeout: 5 };
  const wake = { ...hook, command: `${command} --wait`, asyncRewake: true, timeout: 43200 };
  return { hooks: {
    SessionStart: [{ hooks: [hook] }], UserPromptSubmit: [{ hooks: [hook, wake] }],
    PreToolUse: [{ hooks: [hook, wake] }], Stop: [{ hooks: [hook, wake] }], SessionEnd: [{ hooks: [hook] }],
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
  localClaudeSettings(args.filter(arg => arg !== '--wait'));
  const waiting = args.includes('--wait');
  const flags = args.filter(a => a !== '--wait'), endpointArgs: string[] = [];
  let board = '';
  for (let i = 0; i < flags.length; i += 2) {
    if (flags[i] === '--board') board = flags[i + 1];
    else endpointArgs.push(flags[i], flags[i + 1]);
  }
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) return 0; }
  const hook = JSON.parse(raw);
  if (!board || typeof hook.session_id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(hook.session_id) || typeof hook.cwd !== 'string' || realpathSync(hook.cwd) !== realpathSync(process.cwd())) return 0;
  const endpoint = localEndpoint(endpointArgs), session = `claude-code:${hook.session_id}`;
  const call = (input: object) => localCall(endpoint, { ...input, board, session });
  if (hook.hook_event_name === 'SessionStart' && !waiting) {
    await call({ action: 'connect_local_agent', agent: 'claude-code', threadId: hook.session_id, cwd: hook.cwd });
    return 0;
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
  process.stdout.write(JSON.stringify(await call({ action: 'claude_local_hook', hook })));
  return 0;
}
