import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureCodexPermissions } from './codex-permissions';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
const policy = { boards: 'ask', conversation: 'ask', snippets: 'deny', uploads: 'deny' } as const;
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function server(settings: Record<string, unknown> = {}, mode = 'local', overrides: Record<string, unknown> = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
  const frames: any[] = [];
  const plugin = mode === 'local' ? 'draw-local@draw-local-dev' : 'draw@draw-binary';
  const name = mode === 'local' ? 'draw-local' : 'draw';
  const config = { plugins: { [plugin]: { enabled: true, mcp_servers: { [name]: settings } } }, approval_policy: 'never', sandbox_mode: 'read-only' };
  const results: Record<string, any> = {
    initialize: {},
    'config/read': { config, layers: [
      { name: { type: 'user', file: '/mock/config.toml' }, version: 'user-version', config },
      { name: { type: 'project', dotCodexFolder: '/mock/project/.codex' }, version: 'project-version', config: {} },
    ] },
    'config/batchWrite': { status: 'ok', version: 'next-version', filePath: '/mock/config.toml' },
    ...overrides,
  };
  child.stdin.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const frame = JSON.parse(line); frames.push(frame);
      if (frame.id === undefined || results[frame.method] === undefined) continue;
      const result = results[frame.method];
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: frame.id, ...(result.error ? result : { result }) }) + '\n'));
    }
  });
  spawn.mockReturnValue(child);
  return { child, frames, write: () => frames.find(frame => frame.method === 'config/batchWrite')?.params };
}

describe('Draw plugin permissions in Codex', () => {
  it('writes only plugin policy using the user layer version, without starting a conversation', async () => {
    const s = server({ disabled_tools: ['custom'], tools: { read_board: { approval_mode: 'approve', output_token_limit: 1000 } } });
    expect(await configureCodexPermissions('local', policy)).toEqual(['read_code']);
    expect(spawn).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
    expect(s.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'config/read', 'config/batchWrite']);
    expect(s.write()).toEqual({
      filePath: '/mock/config.toml', expectedVersion: 'user-version',
      edits: [
        { keyPath: 'plugins.draw-local@draw-local-dev.mcp_servers.draw-local.default_tools_approval_mode', value: 'prompt', mergeStrategy: 'replace' },
        { keyPath: 'plugins.draw-local@draw-local-dev.mcp_servers.draw-local.disabled_tools', value: ['custom', 'read_code'], mergeStrategy: 'replace' },
        { keyPath: 'plugins.draw-local@draw-local-dev.mcp_servers.draw-local.tools', value: { read_board: { approval_mode: 'prompt', output_token_limit: 1000 } }, mergeStrategy: 'replace' },
      ],
    });
    expect(s.child.kill).toHaveBeenCalledOnce();
  });

  it('removes only denials it previously managed when changing to Ask', async () => {
    const s = server({ disabled_tools: ['custom', 'read_code', 'attach_conversation'] });
    expect(await configureCodexPermissions('local', { ...policy, snippets: 'ask' }, ['read_code'])).toEqual([]);
    expect(s.write().edits[1].value).toEqual(['custom', 'attach_conversation']);
  });

  it('preserves independently disabled tools and never claims ownership of them', async () => {
    const s = server({ disabled_tools: ['read_code', 'attach_conversation'] });
    expect(await configureCodexPermissions('local', policy)).toEqual([]);
    expect(s.write().edits[1].value).toEqual(['read_code', 'attach_conversation']);
  });

  it('keeps managed denials on reinstall and disables local conversation when requested', async () => {
    const s = server({ disabled_tools: ['read_code'] });
    expect(await configureCodexPermissions('local', { ...policy, conversation: 'deny' }, ['read_code'])).toEqual(['attach_conversation', 'read_code']);
    expect(s.write().edits[1].value).toEqual(['attach_conversation', 'read_code']);
  });

  it('maps hosted conversation and snippet denials to the hosted tools', async () => {
    const s = server({}, 'hosted');
    expect(await configureCodexPermissions('hosted', { ...policy, conversation: 'deny' })).toEqual(['start_chat', 'add_code_ref']);
    expect(s.write().edits[0].keyPath).toBe('plugins.draw@draw-binary.mcp_servers.draw.default_tools_approval_mode');
  });

  it('disables every hosted board tool when board access is denied', async () => {
    const s = server({}, 'hosted');
    await configureCodexPermissions('hosted', { ...policy, boards: 'deny' });
    const source = readFileSync(new URL('../../mcp/src/tools.ts', import.meta.url), 'utf8');
    const names = [...source.matchAll(/^  ([a-z_]+): \{/gm)].map(match => match[1]);
    expect(new Set(s.write().edits[1].value)).toEqual(new Set(names));
  });

  it('disables every local tool, including code and conversation, when boards are denied', async () => {
    const s = server();
    await configureCodexPermissions('local', { ...policy, boards: 'deny' });
    expect(s.write().edits[1].value).toEqual(['list_boards', 'open_board', 'read_board', 'apply_board', 'attach_conversation', 'read_code']);
  });

  it.each([
    { 'config/read': { config: {}, layers: [] } },
    { 'config/batchWrite': { error: { code: -32600, data: { config_write_error_code: 'configVersionConflict' }, message: 'private config details' } } },
    { 'config/batchWrite': { status: 'okOverridden' } },
  ])('fails closed when the configuration cannot be safely changed', async overrides => {
    const s = server({}, 'local', overrides);
    await expect(configureCodexPermissions('local', policy)).rejects.toThrow(/UNAVAILABLE|UNCONFIRMED/);
    expect(s.child.kill).toHaveBeenCalledOnce();
  });

  it('bounds the transaction and closes only its own child on timeout', async () => {
    vi.useFakeTimers();
    const s = server({}, 'local', { initialize: undefined });
    const pending = expect(configureCodexPermissions('local', policy)).rejects.toThrow('UNCONFIRMED');
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(s.child.kill).toHaveBeenCalledOnce();
    expect(s.write()).toBeUndefined();
  });

  it('rejects process and malformed protocol errors without leaking config', async () => {
    const s = server({}, 'local', { initialize: undefined });
    const pending = expect(configureCodexPermissions('local', policy)).rejects.toThrow('UNAVAILABLE');
    s.child.stdout.write('not json\n');
    await pending;
    expect(s.child.kill).toHaveBeenCalledOnce();
  });

  it.each(['error', 'exit'])('cleans up when the child emits %s', async event => {
    const s = server({}, 'local', { initialize: undefined });
    const pending = expect(configureCodexPermissions('local', policy)).rejects.toThrow('UNAVAILABLE');
    s.child.emit(event, event === 'error' ? new Error('private subprocess details') : 1);
    await pending;
    expect(s.child.kill).toHaveBeenCalledOnce();
    expect(s.write()).toBeUndefined();
  });

  it.each([{ disabled_tools: 'read_code' }, { tools: { read_code: 'approve' } }])('does not replace malformed existing policy', async settings => {
    const s = server(settings);
    await expect(configureCodexPermissions('local', policy)).rejects.toThrow('UNAVAILABLE');
    expect(s.write()).toBeUndefined();
  });

  it('does not write when config/read fails and does not expose its error details', async () => {
    const s = server({}, 'local', { 'config/read': { error: { message: 'private config content' } } });
    const error = await configureCodexPermissions('local', policy).catch(error => error);
    expect(error.message).not.toContain('private config content');
    expect(s.write()).toBeUndefined();
  });
});
