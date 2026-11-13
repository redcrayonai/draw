import { expect, it, vi } from 'vitest';
import { protectUnsavedEdits } from './unsaved-edits';

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
