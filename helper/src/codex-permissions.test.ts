import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureCodexPermissions, disableLegacyCodexIntegrations } from './codex-permissions';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
const policy = { boards: 'ask', conversation: 'ask', snippets: 'deny', uploads: 'deny' } as const;
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function server(settings: Record<string, unknown> = {}, mode = 'local', overrides: Record<string, unknown> = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
  const frames: any[] = [];
  const plugin = 'draw@draw-binary';
  const name = mode === 'local' ? 'draw-local' : 'draw';
  const config = { plugins: { [plugin]: { enabled: true, mcp_servers: { [name]: settings } } }, approval_policy: 'never', sandbox_mode: 'read-only' };
  const results: Record<string, any> = {
    initialize: {},
    'config/read': { config, layers: [
      { name: { type: 'user', file: '/mock/config.toml' }, version: 'user-version', config },
      { name: { type: 'project', dotCodexFolder: '/mock/project/.codex' }, version: 'project-version', config: {} },
    ] },
    'plugin/list': { marketplaces: [], marketplaceLoadErrors: [] },
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
        { keyPath: 'plugins.draw@draw-binary.mcp_servers.draw-local.default_tools_approval_mode', value: 'prompt', mergeStrategy: 'replace' },
        { keyPath: 'plugins.draw@draw-binary.mcp_servers.draw-local.disabled_tools', value: ['custom', 'read_code'], mergeStrategy: 'replace' },
        { keyPath: 'plugins.draw@draw-binary.mcp_servers.draw-local.tools', value: { read_board: { approval_mode: 'prompt', output_token_limit: 1000 } }, mergeStrategy: 'replace' },
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

function readConfig(config: Record<string, unknown>, effective = config) {
  return { config: effective, layers: [{ name: { type: 'user', file: '/mock/config.toml' }, version: 'user-version', config }] };
}

describe('unified Codex plugin migration', () => {
  it('imports manual legacy local denials while preserving installer ownership', async () => {
    const legacy = { enabled: false, mcp_servers: { 'draw-local': { disabled_tools: ['read_code', 'attach_conversation', 'custom'] } } };
    const config = { plugins: { 'draw-local@draw-local-dev': legacy } };
    const before = JSON.stringify(config);
    const s = server({}, 'local', { 'config/read': readConfig(config) });
    expect(await configureCodexPermissions('local', policy, ['read_code'])).toEqual(['read_code']);
    expect(s.write().edits[1]).toEqual({ keyPath: 'plugins.draw@draw-binary.mcp_servers.draw-local.disabled_tools', value: ['attach_conversation', 'custom', 'read_code'], mergeStrategy: 'replace' });
    expect(JSON.stringify(config)).toBe(before);
  });

  it('can release migrated managed denials without claiming or restoring manual denials', async () => {
    const config = { plugins: { 'draw-local@draw-local-dev': { mcp_servers: { 'draw-local': { disabled_tools: ['read_code', 'attach_conversation'] } } } } };
    const s = server({}, 'local', { 'config/read': readConfig(config) });
    expect(await configureCodexPermissions('local', { ...policy, snippets: 'ask' }, ['read_code'])).toEqual([]);
    expect(s.write().edits[1].value).toEqual(['attach_conversation']);

    const migrated = { plugins: { ...config.plugins, 'draw@draw-binary': { mcp_servers: { 'draw-local': { disabled_tools: ['attach_conversation'] } } } } };
    const again = server({}, 'local', { 'config/read': readConfig(migrated) });
    expect(await configureCodexPermissions('local', { ...policy, snippets: 'ask' })).toEqual([]);
    expect(again.write().edits[1].value).toEqual(['attach_conversation']);
  });

  it('disables only older Draw entries and leaves credentials, policies, and other plugins untouched', async () => {
    const config = {
      plugins: {
        'draw@draw-binary': { enabled: true, mcp_servers: { draw: { disabled_tools: ['delete_node'] } } },
        'draw-local@draw-local-dev': { enabled: true, mcp_servers: { 'draw-local': { disabled_tools: ['read_code'] } } },
        'draw@older-market': { enabled: true, token: 'retain-me' },
        'draw@already-off': { enabled: false },
        'draw-editor@other': { enabled: true },
      },
      mcp_servers: {
        draw: { url: 'https://example.test/mcp', bearer_token_env_var: 'DRAW_TOKEN' },
        redcrayon: { command: 'redcrayon', args: ['mcp'], env: { TOKEN: 'retain-me' } },
        'draw-local': { command: 'draw', args: ['local-mcp', '--per-repo'] },
        other: { command: 'other' },
      },
      approval_policy: 'never', sandbox_mode: 'read-only',
    };
    const before = JSON.stringify(config);
    const s = server({}, 'local', { 'config/read': readConfig(config) });
    await disableLegacyCodexIntegrations();
    expect(s.write()).toEqual({ filePath: '/mock/config.toml', expectedVersion: 'user-version', edits: [
      { keyPath: 'plugins.draw-local@draw-local-dev.enabled', value: false, mergeStrategy: 'replace' },
      { keyPath: 'plugins.draw@older-market.enabled', value: false, mergeStrategy: 'replace' },
      ...['draw', 'redcrayon', 'draw-local'].map(name => ({ keyPath: `mcp_servers.${name}.enabled`, value: false, mergeStrategy: 'replace' })),
    ] });
    expect(JSON.stringify(config)).toBe(before);
  });

  it('finds installed Draw plugins in the supported inventory even without config entries', async () => {
    const s = server({}, 'local', { 'plugin/list': { marketplaces: [{ plugins: [
      { id: 'draw@remote-market', name: 'draw', installed: true, enabled: true },
      { id: 'draw@draw-binary', name: 'draw', installed: true, enabled: true },
      { id: 'draw@not-installed', name: 'draw', installed: false, enabled: true },
      { id: 'draw@disabled', name: 'draw', installed: true, enabled: false },
      { id: 'other@remote-market', name: 'other', installed: true, enabled: true },
    ] }] } });
    await disableLegacyCodexIntegrations();
    expect(s.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'config/read', 'plugin/list', 'config/batchWrite']);
    expect(s.write().edits).toEqual([{ keyPath: 'plugins.draw@remote-market.enabled', value: false, mergeStrategy: 'replace' }]);
  });

  it('does not write when no legacy integrations are enabled', async () => {
    const s = server();
    await disableLegacyCodexIntegrations();
    expect(s.write()).toBeUndefined();
  });

  it('disables saved legacy entries even when the current project already disables them', async () => {
    const config = { plugins: { 'draw@older-market': { enabled: true } }, mcp_servers: { draw: { command: 'draw' } } };
    const effective = { plugins: { 'draw@older-market': { enabled: false } }, mcp_servers: { draw: { enabled: false } } };
    const s = server({}, 'local', { 'config/read': readConfig(config, effective) });
    await disableLegacyCodexIntegrations();
    expect(s.write().edits).toEqual([
      { keyPath: 'plugins.draw@older-market.enabled', value: false, mergeStrategy: 'replace' },
      { keyPath: 'mcp_servers.draw.enabled', value: false, mergeStrategy: 'replace' },
    ]);
  });

  it.each([
    { 'plugin/list': { marketplaces: [], marketplaceLoadErrors: [{ message: 'private detail' }] } },
    { 'plugin/list': { marketplaces: [{ plugins: [{ id: 'draw@unsafe.path', name: 'draw', installed: true, enabled: true }] }] } },
    { 'plugin/list': { error: { message: 'private detail' } } },
  ])('does not disable anything when the inventory is unsafe or incomplete', async overrides => {
    const s = server({}, 'local', overrides);
    await expect(disableLegacyCodexIntegrations()).rejects.toThrow('UNAVAILABLE');
    expect(s.write()).toBeUndefined();
    expect(s.child.kill).toHaveBeenCalledOnce();
  });

  it.each([
    { error: { code: -32600, data: { config_write_error_code: 'configVersionConflict' } } },
    { status: 'okOverridden' },
  ])('reports conflicting or overridden migration writes', async result => {
    server({}, 'local', {
      'config/read': readConfig({ mcp_servers: { draw: { command: 'draw' } } }),
      'config/batchWrite': result,
    });
    await expect(disableLegacyCodexIntegrations()).rejects.toThrow('UNCONFIRMED');
  });
});
