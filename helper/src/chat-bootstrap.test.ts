import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chatConnection } from './chat-bootstrap';
import { chatDir, chatSocketPath } from './chat-path';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFileSync: vi.fn(() => '') }));

describe('automatic chat connection', () => {
  const hook = { session_id: 'abc-123', hook_event_name: 'PostToolUse', tool_name: 'mcp__plugin_draw_draw__start_session', tool_response: { content: [{ type: 'text', text: JSON.stringify({ chat: { token: 'signed.token.value', board: '12', origin: 'https://agent.example' } }) }] } };
  it('uses the exact harness conversation and the server origin from a successful board open', () => {
    expect(chatConnection(hook, false)).toMatchObject({ session: 'claude-code:abc-123', agent: 'claude-code', board: '12', origin: 'https://agent.example' });
    expect(chatConnection(hook, true)?.session).toBe('codex:abc-123');
  });
  it('never starts for unrelated or malformed tool responses', () => {
    expect(chatConnection({ ...hook, tool_name: 'Read' }, false)).toBeUndefined();
    expect(chatConnection({ ...hook, session_id: '../../other' }, false)).toBeUndefined();
    expect(chatConnection({ ...hook, tool_response: { chat: { token: 'x', board: '12', origin: 'http://remote.example' } } }, false)).toBeUndefined();
  });

  it.each([
    { nearExpiry: false, standalone: false },
    { nearExpiry: true, standalone: false },
    { nearExpiry: false, standalone: true },
    { nearExpiry: true, standalone: true },
  ])('reuses or restarts the helper (near expiry: $nearExpiry, standalone: $standalone)', async ({ nearExpiry, standalone }) => {
    const home = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'rc-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'rc-repo-'));
    const connection = { session: 'claude-code:reuse', agent: 'claude-code' as const, token: 'new-token', board: '7', origin: 'http://localhost:8789', at: Date.now() };
    const path = chatSocketPath(cwd, connection.session);
    mkdirSync(chatDir(), { recursive: true });
    let status = { running: true, connected: true, board: '7', origin: connection.origin, expiresAt: Date.now() + (nearExpiry ? 30 : 720) * 60_000 };
    const requests: string[] = [];
    const server = createServer(socket => {
      socket.once('data', data => {
        const { hook_event_name: event } = JSON.parse(String(data));
        requests.push(event);
        if (event === 'SessionEnd') status = { ...status, running: false, connected: false };
        socket.end(JSON.stringify(status) + '\n');
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => {
      status = { ...status, running: true, connected: true, expiresAt: Date.now() + 12 * 60 * 60_000 };
      return { on() {}, unref() {} } as any;
    });
    try {
      vi.stubGlobal('Bun', { isStandaloneExecutable: standalone });
      vi.resetModules();
      const { startChatConnection } = await import('./chat-bootstrap');
      expect(await startChatConnection(cwd, connection)).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(nearExpiry ? 1 : 0);
      if (nearExpiry) {
        const [executable, args, options] = vi.mocked(spawn).mock.calls[0];
        expect(executable).toBe(process.execPath);
        expect(args).toEqual([
          ...(standalone ? [] : [fileURLToPath(new URL('./redcrayon.mjs', import.meta.url))]),
          'chat', '--token', connection.token, '--session', connection.session, '--agent', connection.agent,
        ]);
        expect(options?.cwd).toBe(cwd);
        expect(options?.env?.REDCRAYON_ORIGIN).toBe(connection.origin);
      }
      expect(requests.includes('SessionEnd')).toBe(nearExpiry);
      expect(JSON.parse(readFileSync(`${path}.connection.json`, 'utf8'))).toEqual(connection);
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>(resolve => server.close(() => resolve()));
      process.env.HOME = home;
    }
  });
});
