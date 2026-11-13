import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { choosePermissionSet, choosePermissions, DEFAULT_PERMISSIONS, enforceToolPermissions, PermissionError, permissionPath, readPermissions, runtimePermissions, savePermissions } from './permissions';

vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: vi.fn() }));
vi.mock('node:readline/promises', () => ({ createInterface: vi.fn() }));
let directory: string;
const ttyDescriptors = [process.stdin, process.stderr].map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
const question = vi.fn(), close = vi.fn();
function tty(enabled: boolean) {
  for (const stream of [process.stdin, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: enabled, configurable: true });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'draw-permissions-test-'));
  vi.mocked(homedir).mockReturnValue(directory);
  vi.stubEnv('DRAW_PERMISSION_FILE', ''); vi.stubEnv('CODEX_THREAD_ID', '');
  tty(false);
  question.mockReset(); close.mockReset();
  vi.mocked(createInterface).mockReset().mockReturnValue({ question, close } as unknown as ReturnType<typeof createInterface>);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  [process.stdin, process.stderr].forEach((stream, index) => {
    const descriptor = ttyDescriptors[index];
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

it('persists separate private local and hosted records without temporary files', () => {
  expect(readPermissions('local')).toBeUndefined();
  const local = { permissions: { ...DEFAULT_PERMISSIONS }, managedDisabledTools: ['read_code'] };
  const hosted = { permissions: { ...DEFAULT_PERMISSIONS, boards: 'deny' as const } };
  savePermissions('local', local); savePermissions('hosted', hosted);
  expect(readPermissions('local')).toEqual(local); expect(readPermissions('hosted')).toEqual(hosted);
  expect(statSync(permissionPath('local')).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(permissionPath('local'))).mode & 0o777).toBe(0o700);
  expect(readdirSync(dirname(permissionPath('local'))).sort()).toEqual(['codex-hosted.json', 'codex-local.json']);
});

it.each([
  '{', 'null', JSON.stringify({ permissions: {} }),
  JSON.stringify({ permissions: { ...DEFAULT_PERMISSIONS, snippets: 'allow' } }),
  JSON.stringify({ permissions: DEFAULT_PERMISSIONS, managedDisabledTools: 'read_code' }),
  JSON.stringify({ permissions: DEFAULT_PERMISSIONS, managedDisabledTools: [7] }),
])('rejects invalid saved settings without falling back to defaults (%s)', async raw => {
  mkdirSync(dirname(permissionPath('local')), { recursive: true }); writeFileSync(permissionPath('local'), raw);
  expect(() => readPermissions('local')).toThrow(PermissionError);
  await expect(choosePermissions('local', { defaults: true })).rejects.toThrow(PermissionError);
});

it('requires explicit defaults for first noninteractive setup and leaves saving to the installer', async () => {
  await expect(choosePermissions('local')).rejects.toThrow('--permissions-defaults');
  expect(await choosePermissions('local', { defaults: true })).toEqual({ permissions: DEFAULT_PERMISSIONS });
  expect(readPermissions('local')).toBeUndefined();
  expect(createInterface).not.toHaveBeenCalled();
});

it('reuses saved choices on reinstall and with defaults, without prompting', async () => {
  const saved = { permissions: { ...DEFAULT_PERMISSIONS, boards: 'deny' as const, uploads: 'ask' as const }, managedDisabledTools: ['open_board'] };
  savePermissions('hosted', saved);
  expect(await choosePermissions('hosted')).toEqual(saved);
  expect(await choosePermissions('hosted', { reconfigure: true, defaults: true })).toEqual(saved);
  expect(createInterface).not.toHaveBeenCalled();
});

it('reconfiguration requires a terminal even with existing settings', async () => {
  savePermissions('local', { permissions: DEFAULT_PERMISSIONS });
  await expect(choosePermissions('local', { reconfigure: true })).rejects.toThrow('--permissions-defaults');
});

it.each(['local', 'hosted'] as const)('prompts for %s choices, retries invalid answers, and preserves ownership', async mode => {
  tty(true);
  savePermissions(mode, { permissions: DEFAULT_PERMISSIONS, managedDisabledTools: ['read_code'] });
  question.mockResolvedValueOnce('no').mockResolvedValueOnce('deny').mockResolvedValueOnce(' ASK ').mockResolvedValueOnce('').mockResolvedValueOnce('ask').mockResolvedValueOnce('ask');
  expect(await choosePermissions(mode, { reconfigure: true })).toEqual({
    permissions: { boards: 'ask', conversation: 'allow', snippets: 'ask', uploads: mode === 'hosted' ? 'ask' : 'deny' },
    managedDisabledTools: ['read_code'],
  });
  expect(question).toHaveBeenCalledTimes(mode === 'hosted' ? 6 : 5);
  expect(close).toHaveBeenCalledOnce();
  expect(readPermissions(mode)?.permissions).toEqual(DEFAULT_PERMISSIONS);
});

it('closes the prompt and preserves saved choices if input fails', async () => {
  tty(true); savePermissions('local', { permissions: DEFAULT_PERMISSIONS });
  question.mockRejectedValueOnce(new Error('input closed'));
  await expect(choosePermissions('local', { reconfigure: true })).rejects.toThrow('input closed');
  expect(close).toHaveBeenCalledOnce();
  expect(readPermissions('local')?.permissions).toEqual(DEFAULT_PERMISSIONS);
});

it('does not apply Codex settings to unmanaged agents', () => {
  savePermissions('local', { permissions: { ...DEFAULT_PERMISSIONS, boards: 'deny' } });
  expect(runtimePermissions('local')).toBeUndefined();
  expect(() => enforceToolPermissions('read_code', 'local')).not.toThrow();
});

it('loads the matching saved mode for a Codex terminal fallback', () => {
  savePermissions('local', { permissions: { ...DEFAULT_PERMISSIONS, boards: 'deny' } });
  vi.stubEnv('CODEX_THREAD_ID', 'current-thread');
  expect(runtimePermissions('local')?.boards).toBe('deny');
  expect(runtimePermissions('hosted')).toBeUndefined();
});

it('fails closed when an explicit launcher policy is missing or corrupt', () => {
  const path = join(directory, 'explicit.json'); vi.stubEnv('DRAW_PERMISSION_FILE', path);
  expect(() => runtimePermissions('local')).toThrow('settings are missing');
  writeFileSync(path, '{');
  expect(() => runtimePermissions('local')).toThrow('settings are invalid');
});

it('rereads the launcher policy so a running integration sees permission changes', () => {
  const path = join(directory, 'explicit.json'); vi.stubEnv('DRAW_PERMISSION_FILE', path);
  savePermissions('local', { permissions: DEFAULT_PERMISSIONS }, path);
  expect(() => enforceToolPermissions('read_code', 'local')).toThrow('source code access');
  savePermissions('local', { permissions: { ...DEFAULT_PERMISSIONS, snippets: 'ask' } }, path);
  expect(() => enforceToolPermissions('read_code', 'local')).not.toThrow();
});

it.each([
  ['local', 'attach_conversation', 'conversation', 'conversation attachment'],
  ['hosted', 'start_chat', 'conversation', 'conversation attachment'],
  ['local', 'read_code', 'snippets', 'source code access'],
  ['hosted', 'add_code_ref', 'snippets', 'source code access'],
  ['local', 'future_tool', 'boards', 'board access'],
  ['hosted', 'delete_node', 'boards', 'board access'],
] as const)('enforces %s %s denial', (mode, tool, field, message) => {
  vi.stubEnv('DRAW_PERMISSION_FILE', permissionPath(mode));
  savePermissions(mode, { permissions: { boards: 'ask', conversation: 'ask', snippets: 'ask', uploads: 'ask', [field]: 'deny' } });
  expect(() => enforceToolPermissions(tool, mode)).toThrow(message);
});

it('accepts both backends with one confirmation and never permits source Allow', async () => {
  tty(true); question.mockResolvedValueOnce('');
  const entries = await choosePermissionSet(['local', 'hosted']);
  expect(entries.map(entry => entry.record.permissions)).toEqual([DEFAULT_PERMISSIONS, DEFAULT_PERMISSIONS]);
  expect(question).toHaveBeenCalledOnce();
  expect(readPermissions('local')).toBeUndefined();
});
it('customizes shared defaults once, with Ask/Deny only for source', async () => {
  tty(true);
  question.mockResolvedValueOnce('n').mockResolvedValueOnce('ask').mockResolvedValueOnce('allow')
    .mockResolvedValueOnce('allow').mockResolvedValueOnce('ask').mockResolvedValueOnce('deny');
  const entries = await choosePermissionSet(['local', 'hosted']);
  for (const entry of entries) expect(entry.record.permissions).toEqual({ boards: 'ask', conversation: 'allow', snippets: 'ask', uploads: 'deny' });
  expect(question).toHaveBeenCalledTimes(6);
});
it('combines old split choices using the more restrictive setting', async () => {
  tty(true); question.mockResolvedValueOnce('yes');
  const local = { permissions: { ...DEFAULT_PERMISSIONS, boards: 'deny' as const, snippets: 'ask' as const } };
  savePermissions('local', local);
  const entries = await choosePermissionSet(['local', 'hosted'], { reconfigure: true });
  for (const entry of entries) expect(entry.record.permissions).toEqual({ ...DEFAULT_PERMISSIONS, boards: 'deny' });
  const text = vi.mocked(process.stderr.write).mock.calls.map(call => call[0]).join('');
  expect(text.match(/Board access and edits/g)).toHaveLength(1);
  expect(text).not.toMatch(/\(local\)|\(hosted\)|local \+ hosted/);
  expect(question).toHaveBeenCalledOnce();
});
it('uses terminal color and respects NO_COLOR without losing labels', async () => {
  tty(true); vi.stubEnv('NO_COLOR', undefined); question.mockResolvedValue('yes');
  await choosePermissionSet(['local', 'hosted']);
  let text = vi.mocked(process.stderr.write).mock.calls.map(call => call[0]).join('');
  expect(text).toContain('\x1b[1mDraw permissions');
  expect(text).toContain('\x1b[32mAllow'); expect(text).toContain('\x1b[31mDeny');
  vi.mocked(process.stderr.write).mockClear(); vi.stubEnv('NO_COLOR', '1');
  await choosePermissionSet(['local', 'hosted']);
  text = vi.mocked(process.stderr.write).mock.calls.map(call => call[0]).join('');
  expect(text).not.toContain('\x1b['); expect(text).toContain('Allow'); expect(text).toContain('Deny');
});

it('reviews conflicting saved settings once, then applies customization to both backends', async () => {
  tty(true);
  savePermissions('local', { permissions: { ...DEFAULT_PERMISSIONS, boards: 'ask', snippets: 'ask' }, managedDisabledTools: ['local-only'] });
  savePermissions('hosted', { permissions: { ...DEFAULT_PERMISSIONS, uploads: 'ask' }, managedDisabledTools: ['hosted-only'] });
  question.mockResolvedValueOnce('n').mockResolvedValueOnce('allow').mockResolvedValueOnce('ask').mockResolvedValueOnce('ask').mockResolvedValueOnce('');
  const entries = await choosePermissionSet(['local', 'hosted']);
  for (const entry of entries) expect(entry.record.permissions).toMatchObject({ boards: 'allow', conversation: 'ask', snippets: 'ask' });
  expect(entries[1].record.permissions.uploads).toBe('ask');
  expect(entries.map(entry => entry.record.managedDisabledTools)).toEqual([['local-only'], ['hosted-only']]);
  expect(question).toHaveBeenCalledTimes(5);
});
it('does not reprompt for matching shared choices or let unused local upload settings override hosted', async () => {
  savePermissions('local', { permissions: DEFAULT_PERMISSIONS });
  savePermissions('hosted', { permissions: { ...DEFAULT_PERMISSIONS, uploads: 'ask' } });
  const entries = await choosePermissionSet(['local', 'hosted']);
  expect(entries[1].record.permissions.uploads).toBe('ask');
  expect(question).not.toHaveBeenCalled();
});
