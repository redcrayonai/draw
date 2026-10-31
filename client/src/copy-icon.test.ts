import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyIconButton } from './chrome';

const clipboard = (writeText: (text: string) => Promise<void>) =>
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

describe('copyIconButton', () => {
  afterEach(() => vi.useRealTimers());

  it('is named for assistive tech, copies, shows a check, then the copy icon again', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn((_t: string) => Promise.resolve());
    clipboard(writeText);
    const onFail = vi.fn();
    const b = copyIconButton('Copy a prompt', () => 'start a tap', onFail);
    expect([b.getAttribute('aria-label'), b.title, b.textContent]).toEqual(['Copy a prompt', 'Copy a prompt', '']);
    const idle = b.innerHTML;
    b.click();
    await vi.waitFor(() => expect(b.classList.contains('copied')).toBe(true));
    expect(writeText).toHaveBeenCalledWith('start a tap');
    expect(b.innerHTML).not.toBe(idle);
    vi.advanceTimersByTime(1200);
    expect(b.innerHTML).toBe(idle);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('hands the text to onFail when the clipboard refuses it', async () => {
    clipboard(() => Promise.reject(new Error('denied')));
    const onFail = vi.fn();
    copyIconButton('Copy', () => 'the prompt', onFail).click();
    await vi.waitFor(() => expect(onFail).toHaveBeenCalledWith('the prompt'));
  });
});
