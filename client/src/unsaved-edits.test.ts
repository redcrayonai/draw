import { expect, it, vi } from 'vitest';
import { protectUnsavedEdits } from './unsaved-edits';

it.each(['<input type="search">', '<input id="palette-input">'])('ignores search text before and after disconnect: %s', html => {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  const input = host.firstElementChild as HTMLInputElement;
  input.focus();
  input.value = 'Search term';
  const guard = protectUnsavedEdits(() => []);
  expect(guard.blocked()).toBe(false);
  guard.disconnect();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(guard.blocked()).toBe(false);
  host.remove();
  expect(guard.blocked()).toBe(false);
});

it('releases an explicitly cancelled draft but keeps other unacknowledged edits', () => {
  const writes = vi.fn(() => [{ reducer: 'updateNode', args: [] }]);
  const guard = protectUnsavedEdits(writes);
  const input = document.createElement('textarea');
  document.body.append(input);
  input.focus();
  input.value = 'Discard this';
  guard.disconnect();
  input.dispatchEvent(new Event('draft-cancel', { bubbles: true }));
  input.remove();
  expect(guard.blocked()).toBe(true);
  writes.mockReturnValue([]);
  expect(guard.blocked()).toBe(false);
});

it('protects disconnected text after blur removes the editor, and downloads the latest draft', () => {
  vi.useFakeTimers();
  const writes = vi.fn(() => [{ reducer: 'updateNode', args: [{ nodeId: 1n, label: 'Pending label' }] }]);
  const guard = protectUnsavedEdits(writes);
  const input = document.createElement('textarea');
  input.id = 'inline-edit';
  input.value = 'First draft';
  document.body.append(input);
  input.focus();
  guard.disconnect();
  input.value = 'Latest draft';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.remove();
  expect(guard.blocked()).toBe(true);
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  const blob = vi.spyOn(globalThis, 'Blob');
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:backup'), revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  guard.download();
  expect(JSON.parse(blob.mock.calls[0][0]![0] as string)).toEqual({
    drafts: [{ field: 'inline-edit', text: 'Latest draft' }],
    unacknowledgedWrites: [{ reducer: 'updateNode', args: [{ nodeId: '1', label: 'Pending label' }] }],
  });
  expect(click).toHaveBeenCalled();
  vi.runAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('allows reconnect after all writes are acknowledged when no text draft is open', () => {
  const writes = vi.fn(() => [{ reducer: 'moveNode', args: [] }]);
  const guard = protectUnsavedEdits(writes);
  guard.disconnect();
  expect(guard.blocked()).toBe(true);
  writes.mockReturnValue([]);
  expect(guard.blocked()).toBe(false);
});
