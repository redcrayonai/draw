// A build's extra for e2e/tests/canvas-extra.spec.ts: records what the canvas hands it,
// then throws, so the journey also proves a failing extra leaves the board working.
import type { BoardReady, CanvasExtra } from '../client/src/extra';

const seen: BoardReady[] = [];
Object.assign(window, { __canvasExtra: seen });

const extra: CanvasExtra = {
  boardReady(ctx) {
    seen.push(ctx);
    throw new Error('canvas extra failed on purpose');
  },
};
export default extra;
