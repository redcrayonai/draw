import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { localClaudeSettings, runLocalClaudeHook } from './local-claude-hook';
import { localCall, localEndpoint } from './local-mcp';
import { chatRequest } from './chat-bootstrap';
import { chatSocketPath } from './chat-path';
vi.mock('./chat-bootstrap', async original => ({ ...await original<object>(), chatRequest: vi.fn(async () => ({})) }));
vi.mock('./chat-path', () => ({ chatSocketPath: vi.fn() }));

vi.mock('./local-mcp', () => ({ localCall: vi.fn(), localEndpoint: vi.fn() }));
let directory: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'draw-claude-auto-')));
  vi.mocked(chatSocketPath).mockReturnValue(join(directory, 'hosted.sock'));
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.mocked(localEndpoint).mockReturnValue({ origin: 'http://127.0.0.1:1234', token: 'a'.repeat(64) });
  vi.mocked(localCall).mockImplementation(async (_endpoint, input: any) => input.action === 'poll_local_agent' ? { type: 'replaced' } : {});
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); rmSync(directory, { recursive: true, force: true }); });
async function hook(input: unknown, flags: string[] = []) {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([typeof input === 'string' ? input : JSON.stringify(input && !Array.isArray(input) && typeof input === 'object' ? { cwd: directory, session_id: 'thread', ...input } : input)]) as any);
  return runLocalClaudeHook(['--auto', '--store', directory, ...flags]);
}
const opened = (repo: string, slug = 'first-board') => ({ hook_event_name: 'PostToolUse', tool_name: 'mcp__draw-local__open_board', tool_input: { repo }, tool_response: { content: [{ type: 'text', text: JSON.stringify({ slug, repo }) }] } });
const calls = () => vi.mocked(localCall).mock.calls.map(([, input]) => input as any);

it('generates automatic hooks which attach and wake after opening or reading a local board', () => {
  const settings = localClaudeSettings(['--auto'], ["/tmp/user's draw"]);
  expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("'--auto'");
  expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("'/tmp/user'\\''s draw'");
  expect(settings.hooks.PostToolUse![0].hooks[1]).toMatchObject({ asyncRewake: true });
  for (const name of ['mcp__plugin_draw-local_draw-local__read_board', 'mcp__plugin_draw_draw-local__open_board', 'mcp__plugin_draw_draw_local__read_board', 'mcp__plugin_draw_draw__start_session']) {
    expect(new RegExp(settings.hooks.PostToolUse![0].matcher).test(name)).toBe(true);
  }
  expect(() => localClaudeSettings(['--auto', '--board', 'first-board'])).toThrow('REJECTED');
});
it('persists only the selected board for this repository and conversation, then polls it', async () => {
  await hook({ hook_event_name: 'SessionStart' });
  expect(localEndpoint).not.toHaveBeenCalled();
  await hook(opened(directory));
  expect(calls()).toContainEqual(expect.objectContaining({ action: 'connect_local_agent', board: 'first-board', threadId: 'thread', cwd: directory }));
  expect(statSync(join(directory, 'claude-sessions', 'thread.json')).mode & 0o777).toBe(0o600);
  vi.mocked(localCall).mockClear();
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'done' });
  expect(calls()).toContainEqual(expect.objectContaining({ action: 'claude_local_hook', board: 'first-board', session: 'claude-code:thread' }));
  await hook({ hook_event_name: 'Stop' }, ['--wait']);
  expect(calls()).toContainEqual(expect.objectContaining({ action: 'poll_local_agent', board: 'first-board' }));
  vi.mocked(localCall).mockClear();
  await hook({ hook_event_name: 'Stop', session_id: 'other' });
  expect(localCall).not.toHaveBeenCalled();
});
it('refuses malformed hooks, failed results, unrelated tools, and boards from other repositories', async () => {
  for (const input of [null, [], '{invalid', 'x'.repeat(1024 * 1024 + 1),
    { ...opened(directory), session_id: '../escape' }, { ...opened(directory), cwd: tmpdir() },
    { ...opened(tmpdir()) }, { ...opened(directory), tool_name: 'mcp__remote__open_board' },
    { ...opened(directory), tool_response: { isError: true, slug: 'first-board', repo: directory } },
    { ...opened(directory), tool_response: { slug: '../escape', repo: directory } },
  ]) await hook(input);
  expect(localCall).not.toHaveBeenCalled();
});
it('disconnects the previous binding when the user opens another board and removes it at session end', async () => {
  await hook(opened(directory));
  await hook(opened(directory, 'second-board'));
  expect(calls()).toContainEqual(expect.objectContaining({ action: 'disconnect_local_agent', board: 'first-board', session: 'claude-code:thread' }));
  await hook({ hook_event_name: 'SessionEnd' });
  vi.mocked(localCall).mockClear();
  await hook({ hook_event_name: 'Stop' });
  expect(localCall).not.toHaveBeenCalled();
});
it('keeps an already connected conversation alive when its board is read again or its context is compacted', async () => {
  await hook(opened(directory));
  vi.mocked(localCall).mockClear();
  vi.mocked(localCall).mockImplementation(async (_endpoint, input: any) => input.action === 'chat_status' ? { connected: true, session: { id: 'claude-code:thread' } } : {});
  await hook({ ...opened(directory), tool_name: 'mcp__plugin_draw-local_draw-local__read_board' });
  await hook({ hook_event_name: 'SessionStart', source: 'compact' });
  expect(calls().some(call => call.action === 'connect_local_agent' || call.action === 'disconnect_local_agent')).toBe(false);
});

it('switches from hosted to local chat without leaving hosted recovery credentials', async () => {
  const saved = join(directory, 'hosted.sock.connection.json');
  writeFileSync(saved, '{}');
  await hook({ ...opened(directory), tool_name: 'mcp__plugin_draw_draw-local__open_board' });
  expect(existsSync(saved)).toBe(false);
  expect(chatRequest).toHaveBeenCalledWith(join(directory, 'hosted.sock'), { hook_event_name: 'SessionEnd' });
  expect(calls()).toContainEqual(expect.objectContaining({ action: 'connect_local_agent', board: 'first-board' }));
});
it('disconnects local chat and removes its binding when a hosted board connects', async () => {
  await hook(opened(directory));
  vi.mocked(localCall).mockClear();
  await hook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__plugin_draw_draw__start_session', tool_response: { chat: { token: 'token', board: '123', origin: 'https://example.com' } } });
  expect(calls()).toEqual([expect.objectContaining({ action: 'disconnect_local_agent', board: 'first-board', session: 'claude-code:thread' })]);
  expect(existsSync(join(directory, 'claude-sessions', 'thread.json'))).toBe(false);
  vi.mocked(localCall).mockClear();
  await hook({ hook_event_name: 'Stop' });
  await hook({ hook_event_name: 'SessionStart' });
  expect(localCall).not.toHaveBeenCalled();
});
