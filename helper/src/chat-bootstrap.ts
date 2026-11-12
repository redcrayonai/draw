import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatDir, chatSocketPath } from './chat-path';
import { hookResult } from './hook-result';
import { localCommand } from './local-runtime';
import { enforceToolPermissions, PermissionError, runtimePermissions } from './permissions';

export interface ChatConnection { session: string; agent: 'claude-code' | 'codex'; token: string; board: string; origin: string; at: number }

const reusable = (status: Record<string, any>, connection: ChatConnection) =>
  status.connected && status.board === connection.board && status.origin === connection.origin &&
  typeof status.expiresAt === 'number' && status.expiresAt > Date.now() + 60 * 60_000;

export function chatConnection(input: Record<string, any>, codex: boolean): ChatConnection | undefined {
  if (input.hook_event_name !== 'PostToolUse' || !/^mcp__(plugin_draw_)?(?:draw|redcrayon)(-dev)?__(start_session|start_chat)$/.test(String(input.tool_name))) return;
  const result = hookResult(input.tool_response);
  const chat = result?.chat ?? (String(input.tool_name).endsWith('__start_chat') ? result : undefined);
  const thread = input.session_id ?? (codex ? process.env.CODEX_THREAD_ID : undefined);
  if (!chat || typeof thread !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(thread) || typeof chat.token !== 'string' || chat.token.length > 16000 || !/^\d{1,20}$/.test(String(chat.board))) return;
  let url: URL;
  try { url = new URL(chat.origin); } catch { return; }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return;
  const agent = codex ? 'codex' : 'claude-code';
  return { session: `${agent}:${thread}`, agent, token: chat.token, board: String(chat.board), origin: url.origin, at: Date.now() };
}

export function approvedChatConnection(input: Record<string, any>, connection: Pick<ChatConnection, 'session' | 'token' | 'origin'>): boolean {
  if (!String(input.tool_name).endsWith('__start_chat')) return false;
  const approved = chatConnection(input, true);
  return !!approved && approved.session === connection.session && approved.token === connection.token && approved.origin === connection.origin;
}

export function chatRequest(path: string, input: object, timeout = 2000): Promise<Record<string, any>> {
  return new Promise(resolve => {
    const socket = connect(path);
    let answer = '';
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      try { resolve(JSON.parse(answer)); } catch { resolve({ offline: true }); }
    };
    const timer = setTimeout(done, timeout);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(input) + '\n'));
    socket.on('data', chunk => { answer += chunk; if (answer.includes('\n') || answer.length > 1024 * 1024) done(); });
    socket.on('error', done);
    socket.on('end', done);
  });
}

/** Starts the packaged helper, never an agent or a new conversation. */
export async function startChatConnection(cwd: string, connection: ChatConnection, approval?: Record<string, any>): Promise<boolean> {
  const managed = connection.agent === 'codex' && !!runtimePermissions('hosted');
  if (managed) {
    enforceToolPermissions('start_chat', 'hosted');
    if (!approval || !approvedChatConnection(approval, connection)) throw new PermissionError('REJECTED: call start_chat and approve it in Codex before connecting this conversation.');
  }
  mkdirSync(chatDir(), { recursive: true, mode: 0o700 });
  const path = chatSocketPath(cwd, connection.session);
  const lock = `${path}.starting`;
  try {
    try { if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true }); } catch { /* No stale starter. */ }
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    for (let n = 0; n < 25; n++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const status = await chatRequest(path, { hook_event_name: 'BoardChatPing' });
      if (reusable(status, connection)) return true;
    }
    return false;
  }
  try {
    const current = await chatRequest(path, { hook_event_name: 'BoardChatPing' });
    if (reusable(current, connection)) {
      // Keep fresh credentials for recovery without interrupting the live helper or its queue.
      writeFileSync(`${path}.connection.json`, JSON.stringify(connection), { mode: 0o600 });
      return true;
    }
    if (current.running) {
      await chatRequest(path, { hook_event_name: 'SessionEnd' });
      for (let n = 0; n < 20; n++) {
        if (!(await chatRequest(path, { hook_event_name: 'BoardChatPing' })).running) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    writeFileSync(`${path}.connection.json`, JSON.stringify(connection), { mode: 0o600 });
    const [executable, ...args] = localCommand(join(dirname(fileURLToPath(import.meta.url)), 'redcrayon.mjs'));
    let owner: string | undefined;
    if (connection.agent === 'claude-code') {
      try {
        const rows = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean);
        let pid = process.ppid;
        for (let i = 0; i < 5; i++) {
          const row = rows.find(r => Number(r![1]) === pid);
          if (!row) break;
          if (/(?:^|\/)(?:claude|[0-9]+\.[0-9]+\.[0-9]+)$/.test(row![3])) {
            const command = execFileSync('ps', ['-p', String(pid), '-ww', '-o', 'command='], { encoding: 'utf8' }).trim();
            owner = `${pid}:${command}`;
            break;
          }
          pid = Number(row![2]);
        }
      } catch { /* Stop still works at the next hook if the harness cannot be identified. */ }
    }
    const child = spawn(executable, [...args, 'chat', '--token', connection.token, '--session', connection.session, '--agent', connection.agent, ...(owner ? ['--owner', owner] : [])], {
      cwd, detached: true, stdio: managed ? ['pipe', 'ignore', 'ignore'] : 'ignore', env: { ...process.env, REDCRAYON_ORIGIN: connection.origin },
    });
    child.on('error', () => {});
    if (managed) { child.stdin?.on('error', () => {}); child.stdin?.end(JSON.stringify(approval)); }
    child.unref();
    for (let n = 0; n < 20; n++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if ((await chatRequest(path, { hook_event_name: 'BoardChatPing' })).connected) return true;
    }
    return false;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

export function savedConnection(cwd: string, session: string): ChatConnection | undefined {
  try {
    const saved = JSON.parse(readFileSync(`${chatSocketPath(cwd, session)}.connection.json`, 'utf8')) as ChatConnection;
    if (saved.session === session && Date.now() - saved.at < 11 * 60 * 60_000) return saved;
  } catch { /* A session with no board needs no helper. */ }
}
