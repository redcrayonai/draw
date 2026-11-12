// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderTellingBar, type TellingBarModel } from './telling-bar';

const model = (over: Partial<TellingBarModel> = {}): TellingBarModel => ({
  audiences: ['Everyone'], active: 0, at: 3, count: 5,
  title: 'Request arrives', body: 'The gateway checks the token.', source: 'CLAUDE.md',
  playing: false, reduced: false,
  onPlay: vi.fn(), onPause: vi.fn(), onReplay: vi.fn(), onNext: vi.fn(), onBack: vi.fn(), onAudience: vi.fn(), onExit: vi.fn(),
  ...over,
});
const btn = (el: HTMLElement, label: string) => [...el.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined;

let el: HTMLElement;
beforeEach(() => { document.body.innerHTML = '<div id="telling-bar" hidden></div>'; el = document.getElementById('telling-bar')!; });

describe('renderTellingBar', () => {
  it('shows count, title, body and source', () => {
    renderTellingBar(el, model());
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain('3 of 5');
    expect(el.querySelector('[aria-live="polite"]')!.textContent).toContain('Request arrives');
    expect(el.textContent).toContain('The gateway checks the token.');
    expect(el.querySelector('.telling-source')!.textContent).toBe('source CLAUDE.md');
  });

  it('omits the source line when empty', () => {
    renderTellingBar(el, model({ source: '' }));
    expect(el.querySelector('.telling-source')).toBeNull();
  });

  it('calls each handler once', () => {
    const m = model({ audiences: ['A', 'B'] });
    renderTellingBar(el, m);
    for (const l of ['Back', 'Play', 'Next', 'Exit']) btn(el, l)!.click();
    btn(el, 'B')!.click();
    renderTellingBar(el, model({ at: 5, count: 5 }));
    expect(m.onBack).toHaveBeenCalledTimes(1);
    expect(m.onPlay).toHaveBeenCalledTimes(1);
    expect(m.onNext).toHaveBeenCalledTimes(1);
    expect(m.onExit).toHaveBeenCalledTimes(1);
    expect(m.onAudience).toHaveBeenCalledWith(1);
  });

  it('calls the latest model handlers, Pause and Replay', () => {
    renderTellingBar(el, model());
    const m2 = model({ playing: true });
    renderTellingBar(el, m2);
    btn(el, 'Pause')!.click();
    expect(m2.onPause).toHaveBeenCalledTimes(1);
    const m3 = model({ at: 5 });
    renderTellingBar(el, m3);
    btn(el, 'Replay')!.click();
    expect(m3.onReplay).toHaveBeenCalledTimes(1);
  });

  it('shows the switch only with several audiences', () => {
    renderTellingBar(el, model());
    expect(el.querySelector('[aria-label="Told for"]')).toBeNull();
    renderTellingBar(el, model({ audiences: ['A', 'B'], active: 1 }));
    const group = el.querySelector('[aria-label="Told for"]')!;
    const bs = group.querySelectorAll('button');
    expect(bs).toHaveLength(2);
    expect(bs[0].getAttribute('aria-pressed')).toBe('false');
    expect(bs[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('ending: Replay instead of Play, empty count, Next disabled', () => {
    renderTellingBar(el, model({ at: 5 }));
    expect(btn(el, 'Replay')).toBeTruthy();
    expect(btn(el, 'Play')).toBeUndefined();
    expect(btn(el, 'Next')!.disabled).toBe(true);
    expect(el.querySelector('.telling-count')!.textContent).toBe('');
  });

  it('disables Back at step 1 and Play when motion is reduced', () => {
    renderTellingBar(el, model({ at: 1, reduced: true }));
    expect(btn(el, 'Back')!.disabled).toBe(true);
    const play = btn(el, 'Play')!;
    expect(play.disabled).toBe(true);
    expect(play.title).toBe('Motion is reduced on this device. Use Next.');
  });

  it('keeps focus when Play becomes Pause', () => {
    renderTellingBar(el, model());
    btn(el, 'Play')!.focus();
    renderTellingBar(el, model({ playing: true }));
    expect(document.activeElement).toBe(btn(el, 'Pause'));
  });

  it('moves focus to Replay when Next is disabled by reaching the ending', () => {
    renderTellingBar(el, model({ at: 4 }));
    btn(el, 'Next')!.focus();
    renderTellingBar(el, model({ at: 5 }));
    expect(document.activeElement).toBe(btn(el, 'Replay'));
  });

  it('moves focus to the main button when Back is disabled at step 1', () => {
    renderTellingBar(el, model({ at: 2 }));
    btn(el, 'Back')!.focus();
    renderTellingBar(el, model({ at: 1 }));
    expect(document.activeElement).toBe(btn(el, 'Play'));
  });

  it('moves focus to Exit when the main button is disabled too', () => {
    renderTellingBar(el, model({ at: 2, reduced: true }));
    btn(el, 'Back')!.focus();
    renderTellingBar(el, model({ at: 1, reduced: true }));
    expect(document.activeElement).toBe(btn(el, 'Exit'));
  });

  it('moves focus to Exit when a focused Pause swaps to a disabled Play', () => {
    renderTellingBar(el, model({ playing: true }));
    btn(el, 'Pause')!.focus();
    renderTellingBar(el, model({ playing: false, reduced: true }));
    expect(document.activeElement).toBe(btn(el, 'Exit'));
  });

  it('fills progress through at', () => {
    renderTellingBar(el, model());
    const segs = el.querySelectorAll('.telling-progress > span');
    expect(segs).toHaveLength(5);
    expect([...segs].filter(s => s.classList.contains('done'))).toHaveLength(3);
  });

  it('does not replace the live element on repeat renders and treats text as text', () => {
    const m = model({ title: '<b>x</b>' });
    renderTellingBar(el, m);
    const live = el.querySelector('[aria-live]');
    renderTellingBar(el, m);
    renderTellingBar(el, model({ title: '<b>x</b>', at: 4 }));
    expect(el.querySelector('[aria-live]')).toBe(live);
    expect(live!.querySelector('b')).toBeNull();
  });

  it('null hides the bar', () => {
    renderTellingBar(el, model());
    renderTellingBar(el, null);
    expect(el.hidden).toBe(true);
  });
});
