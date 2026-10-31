import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ mount: vi.fn() }));
vi.mock('./thinking-orb', () => ({ mountThinkingOrb: h.mount }));

import { initBoardLoading, finishBoardLoading, failBoardLoading } from './board-loading';

beforeEach(() => {
  vi.clearAllMocks();
  document.body.className = 'board-loading';
  document.body.innerHTML = '<main id="canvas-wrap" aria-busy="true" inert></main><div id="board-loading" role="status"><canvas id="loading-orb"></canvas><p id="loading-caption">Loading board…</p><button id="loading-retry" hidden>Reload</button></div>';
});

describe('board loading', () => {
  it('shows the existing orb while the canvas is waiting for its data', () => {
    initBoardLoading();
    expect(h.mount).toHaveBeenCalledWith(document.getElementById('loading-orb'), 'connecting', 64);
    expect(document.getElementById('board-loading')!.hidden).toBe(false);
    expect(document.getElementById('canvas-wrap')!.getAttribute('aria-busy')).toBe('true');
    expect(document.getElementById('canvas-wrap')!.hasAttribute('inert')).toBe(true);
  });

  it('releases the canvas after rendering or an existing error screen', () => {
    initBoardLoading();
    finishBoardLoading();
    finishBoardLoading();
    expect(document.getElementById('board-loading')!.hidden).toBe(true);
    expect(document.getElementById('canvas-wrap')!.getAttribute('aria-busy')).toBe('false');
    expect(document.getElementById('canvas-wrap')!.hasAttribute('inert')).toBe(false);
    expect(document.body.classList.contains('board-loading')).toBe(false);
  });

  it('replaces the orb with an error and reload control if the app cannot start', () => {
    initBoardLoading();
    failBoardLoading();
    expect(document.getElementById('board-loading')!.getAttribute('role')).toBe('alert');
    expect(document.getElementById('loading-caption')!.textContent).toBe('The board could not load. Please reload.');
    expect(document.getElementById('loading-retry')!.hidden).toBe(false);
    expect(document.getElementById('loading-orb')!.hidden).toBe(true);
    expect(document.getElementById('canvas-wrap')!.getAttribute('aria-busy')).toBe('false');
  });
});
