import type { Node } from './module_bindings/types';

export function positionOnly(before: Node, after: Node): boolean {
  const keys = Object.keys(before) as (keyof Node)[];
  return keys.length === Object.keys(after).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(after, key) && (key === 'x' || key === 'y' || before[key] === after[key]));
}

/** Coalesce a frame, with a full refresh taking precedence over movement. */
export function scheduleTableRefresh(full: () => void, positions: () => void) {
  let pending = false;
  let needsFull = false;
  return (positionsOnly: boolean) => {
    needsFull ||= !positionsOnly;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      const refresh = needsFull ? full : positions;
      pending = false;
      needsFull = false;
      refresh();
    });
  };
}
