import { expect, it, vi } from 'vitest';
import { mountLocalChat, sendLocalMarks, NO_NOTE } from './local-chat';
import { mountLocalRefs } from './local-refs';
import type { LocalBoard, LocalNode } from '../../shared/local';

const board: LocalBoard = { slug: 'board', name: 'Board', repo: '/repo', revision: 0, nextId: 2, nodes: [], edges: [], notes: [], feedback: [] };
const input = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => { field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); };
it('preserves a new feedback draft while the previous message is being delivered', async () => {
  const container = document.createElement('div');
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const call = vi.fn(() => pending);
  mountLocalChat(container, () => board, () => [], call, () => {});
  const form = container.querySelector<HTMLFormElement>('[data-send]')!;
  const text = form.querySelector('textarea')!;
  input(text, 'First message'); form.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ text: 'First message' }));
  input(text, 'Next message'); finish(); await pending;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(text.value).toBe('Next message');
});
it('preserves the next reference draft while the previous code read completes', async () => {
  const container = document.createElement('div');
  const node: LocalNode = { id: '1', label: 'API', description: '', x: 0, y: 0, w: 160, h: 80, kind: 'service', refs: [] };
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const mutate = vi.fn(async () => {});
  mountLocalRefs(container, () => board, () => node, mutate, () => pending, () => {});
  const form = container.querySelector('form')!, path = form.querySelector<HTMLInputElement>('[name="path"]')!;
  input(path, 'first.ts'); form.dispatchEvent(new Event('submit', { cancelable: true }));
  input(path, 'next.ts'); finish(); await pending;
  await vi.waitFor(() => expect(mutate).toHaveBeenCalled());
  expect(path.value).toBe('next.ts');
  expect(mutate).toHaveBeenCalledWith([expect.objectContaining({ patch: { refs: [{ path: 'first.ts', start: 1, end: 1 }] } })], 0);
});
it('ignores an old code response after the user opens another reference', async () => {
  const container = document.createElement('div');
  const node: LocalNode = { id: '1', label: 'API', description: '', x: 0, y: 0, w: 160, h: 80, kind: 'service', refs: [{ path: 'first.ts', start: 1, end: 1 }, { path: 'second.ts', start: 1, end: 1 }] };
  let finish!: (source: { text: string }) => void;
  const pending = new Promise<{ text: string }>(resolve => { finish = resolve; });
  const call = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce({ text: 'second file' });
  const render = mountLocalRefs(container, () => board, () => node, async () => {}, call, () => {});
  render();
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-refs] button')];
  buttons[0].click(); buttons[2].click();
  await vi.waitFor(() => expect(container.querySelector('[data-code]')!.textContent).toBe('second file'));
  finish({ text: 'first file' }); await pending;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(container.querySelector('[data-code]')!.textContent).toBe('second file');
});
it('saves every circle as a review note in one edit, and tells only a connected agent', async () => {
  const mutate = vi.fn(async () => {}), call = vi.fn(async () => {}), report = vi.fn();
  expect(await sendLocalMarks('board', ['1', '2'], ['Retry here', ''], false, mutate, call, report)).toBe(false);
  expect(mutate).toHaveBeenCalledWith([{ type: 'note.add', target: '1', text: 'Retry here' }, { type: 'note.add', target: '2', text: NO_NOTE }]);
  expect(call).not.toHaveBeenCalled();
  expect(await sendLocalMarks('board', ['1', '2'], ['Retry here', ''], true, mutate, call, report)).toBe(true);
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: 'send_feedback', board: 'board', selected: ['1', '2'], text: expect.stringContaining('2 nodes') }));
  expect(report).not.toHaveBeenCalled();
});
it('does not wait for the agent, and reports its refusal once the marks are saved', async () => {
  let refuse!: (error: Error) => void;
  const call = vi.fn(() => new Promise<void>((_, reject) => { refuse = reject; })), report = vi.fn();
  expect(await sendLocalMarks('board', ['1'], ['Note'], true, async () => {}, call, report)).toBe(true);
  refuse(new Error('UNAVAILABLE: feedback is saved.'));
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith('UNAVAILABLE: feedback is saved.'));
});
it('sends no message when the notes could not be saved', async () => {
  const call = vi.fn(async () => {});
  await expect(sendLocalMarks('board', ['1'], ['Note'], true, async () => { throw new Error('REJECTED: board changed'); }, call, () => {})).rejects.toThrow('board changed');
  expect(call).not.toHaveBeenCalled();
});
