// jsdom has no canvas: its getContext prints "Not implemented" and returns
// null. Return null quietly; text measurement falls back to its estimate.
HTMLCanvasElement.prototype.getContext = function noCanvas() {
  return null;
} as typeof HTMLCanvasElement.prototype.getContext;
