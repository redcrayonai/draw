import { mountThinkingOrb } from './thinking-orb';

export function initBoardLoading(): void {
  const canvas = document.getElementById('loading-orb') as HTMLCanvasElement | null;
  if (canvas) mountThinkingOrb(canvas, 'connecting', 64);
  document.getElementById('loading-retry')?.addEventListener('click', () => location.reload());
}

export function finishBoardLoading(): void {
  const panel = document.getElementById('board-loading');
  if (panel) panel.hidden = true;
  document.getElementById('canvas-wrap')?.setAttribute('aria-busy', 'false');
  document.getElementById('canvas-wrap')?.removeAttribute('inert');
  document.body.classList.remove('board-loading');
}

export function failBoardLoading(): void {
  document.getElementById('board-loading')?.setAttribute('role', 'alert');
  document.getElementById('canvas-wrap')?.setAttribute('aria-busy', 'false');
  const canvas = document.getElementById('loading-orb');
  if (canvas) canvas.hidden = true;
  const caption = document.getElementById('loading-caption');
  if (caption) caption.textContent = 'The board could not load. Please reload.';
  const retry = document.getElementById('loading-retry');
  if (retry) retry.hidden = false;
}
