import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armChime, chime, resetChime, setSound } from './chime';

class FakeContext {
  static started: number[] = [];
  state = 'running';
  currentTime = 0;
  destination = {};
  resume() { return Promise.resolve(); }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (n: unknown) => n }; }
  createOscillator() {
    return { type: '', frequency: { value: 0 }, connect: (n: unknown) => n, start() { FakeContext.started.push(this.frequency.value); }, stop() {} };
  }
}

describe('chime', () => {
  beforeEach(() => {
    FakeContext.started = [];
    localStorage.clear();
    resetChime();
    vi.stubGlobal('AudioContext', FakeContext);
  });
  afterEach(() => vi.unstubAllGlobals());

  const click = () => document.dispatchEvent(new Event('pointerdown'));

  it('arms sound from keyboard interaction', () => {
    armChime();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    chime('done', false);
    expect(FakeContext.started).toEqual([784, 523.25]);
  });

  it('is silent until the page has had a click', () => {
    armChime();
    chime('done', false);
    expect(FakeContext.started).toEqual([]);
    click();
    chime('done', false);
    expect(FakeContext.started).toEqual([784, 523.25]);
  });

  it('is silent while the person is looking, and when they turned sound off', () => {
    armChime();
    click();
    chime('attention', true);
    setSound(false);
    chime('attention', false);
    expect(FakeContext.started).toEqual([]);
    setSound(true);
    chime('attention', false);
    expect(FakeContext.started).toEqual([659.25, 987.77]);
  });
});
