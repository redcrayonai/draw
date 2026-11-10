import type { CanvasPanel } from '@draw/canvas';

// The builder's test canvas part: a panel showing its canvas setting and the board.
export const panel: CanvasPanel = {
  label: 'Pinboard',
  mount(el, canvas) {
    const line = document.createElement('p');
    line.className = 'pinboard-banner';
    line.textContent = `${canvas.settings.PINBOARD_BANNER} (board ${canvas.board.id})`;
    el.append(line);
  },
};
