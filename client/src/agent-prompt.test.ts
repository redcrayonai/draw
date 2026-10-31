import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentPromptButton } from './chrome';

const clipboard = (writeText: (text: string) => Promise<void>) =>
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

describe('agentPromptButton', () => {
  afterEach(() => vi.useRealTimers());

  it('names the hand-off, copies, says to paste it to the agent, then reads as before', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn((_t: string) => Promise.resolve());
    clipboard(writeText);
    const onFail = vi.fn();
    const b = agentPromptButton(() => 'start a tap', onFail);
    expect(b.textContent).toBe('Copy prompt for agent');
    expect(b.querySelector('svg')).not.toBeNull();
    b.click();
    await vi.waitFor(() => expect(b.classList.contains('copied')).toBe(true));
    expect(writeText).toHaveBeenCalledWith('start a tap');
    expect(b.textContent).toBe('Copied · paste to agent');
    vi.advanceTimersByTime(2400);
    expect(b.textContent).toBe('Copy prompt for agent');
    expect(b.classList.contains('copied')).toBe(false);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('hands the text to onFail when the clipboard refuses it', async () => {
    clipboard(() => Promise.reject(new Error('denied')));
    const onFail = vi.fn();
    const b = agentPromptButton(() => 'the prompt', onFail);
    b.click();
    await vi.waitFor(() => expect(onFail).toHaveBeenCalledWith('the prompt'));
    expect(b.textContent).toBe('Copy prompt for agent');
  });
});
