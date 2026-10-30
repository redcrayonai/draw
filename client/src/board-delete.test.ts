import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openBoardDelete } from './board-delete';

beforeEach(() => {
  // jsdom does not implement native dialog methods; the e2e covers them.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => document.querySelector<HTMLDialogElement>('#board-delete')?.close());

const dialog = () => document.querySelector<HTMLDialogElement>('#board-delete');
const button = (name: string) => [...dialog()!.querySelectorAll('button')].find(b => b.textContent === name)!;
const type = (text: string) => {
  const input = dialog()!.querySelector('input')!;
  input.value = text;
  input.dispatchEvent(new Event('input'));
};

describe('board delete confirm', () => {
  it('asks in exactly these words, with focus on cancel', () => {
    openBoardDelete('Pay<b>ments</b>', vi.fn(), vi.fn(), vi.fn());
    expect(dialog()!.open).toBe(true);
    expect(document.getElementById(dialog()!.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Delete "Pay<b>ments</b>" and everything on it, including its code refs? This cannot be undone. Type the board name to confirm.'
    );
    expect([...dialog()!.querySelectorAll('button')].map(b => b.textContent)).toEqual(['cancel', 'delete']);
    expect(document.activeElement).toBe(button('cancel'));
  });

  it('keeps delete disabled until the board name is typed', () => {
    const remove = vi.fn();
    openBoardDelete('Payments', remove, vi.fn(), vi.fn());
    expect(button('delete').disabled).toBe(true);
    type('Payment');
    expect(button('delete').disabled).toBe(true);
    button('delete').click();
    expect(remove).not.toHaveBeenCalled();
    type(' Payments ');
    expect(button('delete').disabled).toBe(false);
  });

  it('cancels with the button or Esc, and keeps canvas shortcuts out', () => {
    const remove = vi.fn();
    const shortcut = vi.fn();
    window.addEventListener('keydown', shortcut);
    try {
      openBoardDelete('Payments', remove, vi.fn(), vi.fn());
      button('cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      expect(shortcut).not.toHaveBeenCalled();
      button('cancel').click();
      expect(dialog()).toBeNull();
      openBoardDelete('Payments', remove, vi.fn(), vi.fn());
      button('cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(dialog()).toBeNull();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', shortcut);
    }
  });

  it('releases hidden palette focus before the delayed native close event', () => {
    const palette = document.createElement('div');
    palette.id = 'palette'; palette.hidden = true;
    const input = document.createElement('input');
    palette.append(input); document.body.append(palette);
    let closing: HTMLDialogElement | undefined;
    HTMLDialogElement.prototype.close = function () { this.open = false; input.focus(); closing = this; };
    try {
      openBoardDelete('Payments', vi.fn(), vi.fn(), vi.fn());
      button('cancel').click();
      expect(document.activeElement).not.toBe(input);
    } finally { closing?.dispatchEvent(new Event('close')); palette.remove(); }
  });

  it('releases focus inside the dialog before the delayed native close event', () => {
    // Linux Chrome leaves focus on the closed dialog's button until its close event.
    let closing: HTMLDialogElement | undefined;
    HTMLDialogElement.prototype.close = function () { this.open = false; closing = this; };
    try {
      openBoardDelete('Payments', vi.fn(), vi.fn(), vi.fn());
      button('cancel').click();
      expect(document.activeElement).toBe(document.body);
    } finally { closing?.dispatchEvent(new Event('close')); }
  });

  it('keeps focus when the palette reopens before the native close event arrives', () => {
    let closing: HTMLDialogElement | undefined;
    HTMLDialogElement.prototype.close = function () { this.open = false; closing = this; };
    openBoardDelete('Payments', vi.fn(), vi.fn(), vi.fn());
    button('cancel').click();
    const palette = document.createElement('div');
    palette.id = 'palette';
    const input = document.createElement('input');
    palette.append(input);
    document.body.append(palette);
    try {
      input.focus();
      closing!.dispatchEvent(new Event('close'));
      expect(document.activeElement).toBe(input);
    } finally { palette.remove(); }
  });

  it('deletes, then leaves the board', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const done = vi.fn();
    const report = vi.fn();
    openBoardDelete('Payments', remove, done, report);
    type('Payments');
    button('delete').click();
    expect(remove).toHaveBeenCalledOnce();
    expect(button('deleting…').disabled).toBe(true);
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(dialog()).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });

  it('reports a refusal and stays on the board', async () => {
    const refusal = new Error('architecture boards must be managed through their history');
    const done = vi.fn();
    const report = vi.fn();
    openBoardDelete('Payments', vi.fn().mockRejectedValue(refusal), done, report);
    type('Payments');
    button('delete').click();
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(refusal));
    expect(done).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
