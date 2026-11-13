import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHookAgent } from './local-hook-agent';
import { localClaudeSettings, receivedClaudeDeliveries } from './local-claude-hook';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers(); });
function setup(agent: 'claude-code' | 'pi' = 'pi') {
  vi.useFakeTimers();
  const emit = vi.fn(), disconnected = vi.fn();
  const hook = new LocalHookAgent(agent, 'thread', emit, disconnected);
  cleanup.push(() => hook.close());
  return { hook, emit, disconnected };
}
it('generates session-scoped Claude hooks with shell-quoted paths and no permission overrides', () => {
  const settings = localClaudeSettings(['--board', 'slug', '--repo', "/tmp/user's repo", '--store', '/tmp/store']);
  expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("'/tmp/user'\\''s repo'");
  expect(settings.hooks.Stop[0].hooks[1]).toMatchObject({ asyncRewake: true });
  expect(Object.keys(settings)).toEqual(['hooks']);
  expect(() => localClaudeSettings(['--board'])).toThrow('REJECTED');
  expect(() => localClaudeSettings(['--board', 'slug', '--bad', 'value'])).toThrow('REJECTED');
});
it('delivers once, requires the dispatched message acknowledgement, and replaces old waiters', async () => {
  const { hook } = setup();
  const old = hook.poll(), poll = hook.poll();
  expect(await old).toEqual({ type: 'replaced' });
  const sent = hook.send('one');
  const delivery = await poll;
  expect(delivery).toMatchObject({ type: 'message', text: 'one' });
  expect(() => hook.acknowledge('wrong')).toThrow('UNCONFIRMED');
  await expect(hook.send('two')).rejects.toThrow('busy');
  const next = hook.poll();
  hook.acknowledge((delivery as { id: string }).id); await sent;
  await vi.advanceTimersByTimeAsync(20000);
  expect(await next).toBeNull();
  expect(() => hook.acknowledge((delivery as { id: string }).id)).toThrow('UNCONFIRMED');
});
it('keeps lost delivery uncertain and expires disconnected clients', async () => {
  const { hook, disconnected } = setup();
  const failed = expect(hook.send('one')).rejects.toThrow('UNCONFIRMED');
  await hook.poll();
  await vi.advanceTimersByTimeAsync(25000); await failed;
  const empty = hook.poll(); await vi.advanceTimersByTimeAsync(20000); expect(await empty).toBeNull();
  await vi.advanceTimersByTimeAsync(25000); expect(disconnected).toHaveBeenCalledOnce();
  await expect(hook.send('two')).rejects.toThrow('disconnected');
});
it('confirms Claude wake receipt from its transcript and stops only at a tool boundary', async () => {
  const { hook, emit } = setup('claude-code');
  const sent = hook.send('one'), delivery = await hook.poll() as { id: string };
  hook.claudeHook({ hook_event_name: 'PreToolUse', received: [delivery.id] }); await sent;
  await hook.stop(); expect(await hook.poll()).toEqual({ type: 'stop' });
  expect(hook.claudeHook({ hook_event_name: 'PreToolUse' })).toMatchObject({ continue: false });
  await expect(hook.approve()).rejects.toThrow('terminal');
  hook.claudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'new terminal instruction' });
  expect(hook.claudeHook({ hook_event_name: 'PreToolUse' })).toEqual({});
  expect(emit).toHaveBeenCalledWith({ type: 'state', state: 'working' });
});
it('rejects unsupported events and disconnects pending delivery', async () => {
  const { hook, disconnected } = setup();
  expect(() => hook.event({ type: 'approval' } as any)).toThrow('REJECTED');
  expect(() => hook.event({ type: 'text', message: 'a', delta: 'x'.repeat(256001), final: true })).toThrow('REJECTED');
  const failed = expect(hook.send('one')).rejects.toThrow('UNCONFIRMED');
  hook.disconnect(); await failed; expect(disconnected).toHaveBeenCalledOnce();
});
it('reads only receipt IDs from matching Claude user entries in a bounded transcript tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'draw-receipts-')), path = join(dir, 'session.jsonl');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const id = '00000000-0000-0000-0000-000000000001';
  const entry = (type: string, sessionId: string) => JSON.stringify({ type, sessionId, message: { content: `<system-reminder>Board chat [${id}]: hello` } });
  writeFileSync(path, 'x'.repeat(1100000) + '\n' + entry('assistant', 'thread') + '\n' + entry('user', 'other') + '\n');
  expect(receivedClaudeDeliveries(path, 'thread')).toEqual([]);
  writeFileSync(path, entry('user', 'thread') + '\n{incomplete');
  expect(receivedClaudeDeliveries(path, 'thread')).toEqual([id]);
});
it('does not deliver a message stopped before a hook picked it up', async () => {
  const { hook, emit } = setup();
  const failed = expect(hook.send('cancel this')).rejects.toThrow('UNCONFIRMED');
  await hook.stop(); await failed;
  expect(emit).toHaveBeenCalledWith({ type: 'state', state: 'stopped' });
  expect(await hook.poll()).toEqual({ type: 'stop' });
  const next = hook.poll(); await vi.advanceTimersByTimeAsync(20000); expect(await next).toBeNull();
});
