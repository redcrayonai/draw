import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openBoardRename } from './board-rename';
import { CommandPalette } from './palette';
import html from '../index.html?raw';

beforeEach(() => {
  document.body.innerHTML = html;
  // jsdom does not implement native dialog methods; browser checks cover them.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => {
  document.querySelector<HTMLDialogElement>('#board-rename')?.close();
  vi.useRealTimers();
});

const input = () => document.querySelector<HTMLInputElement>('#board-rename-name')!;
const dialog = () => document.querySelector<HTMLDialogElement>('#board-rename')!;
const saveButton = () => dialog().querySelector<HTMLButtonElement>('[type="submit"]')!;
function type(value: string) {
  input().value = value;
  input().dispatchEvent(new Event('input', { bubbles: true }));
}
function submit() {
  dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('board rename modal', () => {
  it('selects the current name and saves a trimmed replacement', async () => {
    const rename = vi.fn().mockResolvedValue(undefined);
    openBoardRename('Payments', rename);
    expect(dialog().open).toBe(true);
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)?.textContent).toBe('Rename board');
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe('Payments');
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(8);
    expect(input().maxLength).toBe(100);

    type('  New payments  ');
    submit();
    expect(rename).toHaveBeenCalledExactlyOnceWith('New payments');
    await vi.waitFor(() => expect(document.querySelector('#board-rename')).toBeNull());
  });

  it.each(['', '   ', 'Payments', '  Payments  '])('does not save an empty or unchanged name: %j', value => {
    const rename = vi.fn();
    openBoardRename('Payments', rename);
    type(value);
    expect(saveButton().disabled).toBe(true);
    submit();
    expect(rename).not.toHaveBeenCalled();
    expect(dialog().open).toBe(true);
  });

  it('cancels without saving', () => {
    const rename = vi.fn();
    openBoardRename('Payments', rename);
    dialog().querySelector<HTMLButtonElement>('[type="button"]')!.click();
    expect(document.querySelector('#board-rename')).toBeNull();
    expect(rename).not.toHaveBeenCalled();
  });

  it('keeps canvas shortcuts from seeing keys in the modal', () => {
    openBoardRename('Payments', vi.fn());
    const shortcut = vi.fn();
    window.addEventListener('keydown', shortcut);
    try {
      for (const key of ['Delete', 'Escape', 'k', ' ']) {
        input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
      expect(shortcut).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', shortcut);
    }
  });

  it('blocks canvas shortcuts when Tab leaves focus on the body, then restores them on close', () => {
    const shortcut = vi.fn();
    window.addEventListener('keydown', shortcut);
    openBoardRename('Payments', vi.fn());
    try {
      for (const key of ['Delete', 'Backspace', 'h', 'l', 'f', ' ', 'T']) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
      expect(shortcut).not.toHaveBeenCalled();
      dialog().close();
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      expect(shortcut).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', shortcut);
    }
  });

  it('recovers from a reducer that never answers and ignores its late result after a retry', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let retry!: () => void;
    const rename = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockImplementationOnce(() => new Promise<void>(resolve => { retry = resolve; }));
    openBoardRename('Payments', rename);
    type('Updated');
    submit();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('The database did not answer in 15 seconds. Check your connection and try again.');
    expect(input().value).toBe('Updated');
    expect(input().disabled).toBe(false);
    expect(saveButton().disabled).toBe(false);
    expect(dialog().querySelector<HTMLButtonElement>('[type="button"]')!.disabled).toBe(false);
    const cancel = new Event('cancel', { cancelable: true });
    dialog().dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(false);

    submit();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(dialog().open).toBe(true);
    expect(saveButton().disabled).toBe(true);
    retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('#board-rename')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('blocks duplicate saves and cancellation while saving, then keeps errors for retry', async () => {
    let reject!: (error: Error) => void;
    const rename = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }))
      .mockResolvedValue(undefined);
    openBoardRename('Payments', rename);
    type('Updated');
    submit();
    submit();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(input().disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
    const cancel = new Event('cancel', { cancelable: true });
    dialog().dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);

    reject(new Error('Could not rename this board.'));
    await vi.waitFor(() => expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('Could not rename this board.'));
    expect(input().value).toBe('Updated');
    expect(input().disabled).toBe(false);
    expect(saveButton().disabled).toBe(false);
    submit();
    await vi.waitFor(() => expect(document.querySelector('#board-rename')).toBeNull());
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('opens from the command palette with focus in the name field', () => {
    const palette = new CommandPalette({
      commands: () => [{ id: 'rename-board', title: 'Rename board', run: () => openBoardRename('Payments', vi.fn()) }],
      context: () => '',
    });
    palette.open();
    document.getElementById('palette-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(palette.isOpen).toBe(false);
    expect(dialog().open).toBe(true);
    expect(document.activeElement).toBe(input());
  });
});
