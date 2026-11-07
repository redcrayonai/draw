// A build's extra for e2e/tests/canvas-extra.spec.ts: records what the canvas hands it.
import type { BoardReady, CanvasExtra } from '../client/src/extra';

const seen: BoardReady[] = [];
Object.assign(window, { __canvasExtra: seen });

const extra: CanvasExtra = {
  boardReady(ctx) {
    seen.push(ctx);
  },
};
export default extra;
