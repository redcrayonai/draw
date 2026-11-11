import type { LocalBoard } from '../../shared/local';
import type { LocalTrafficWindow } from '../../shared/local-activity';
import type { LiveEdge } from './render';

export function mountLocalActivity(container: HTMLElement, world: SVGGElement, board: () => LocalBoard | undefined, redraw: () => void) {
  const section = document.createElement('section');
  section.innerHTML = '<h2>Live activity</h2><p data-state>No source connected</p><div data-summary></div>';
  container.append(section);
  let window: LocalTrafficWindow | undefined;
  let received = 0;
  const live = new Map<bigint, LiveEdge>();
  function sync() {
    world.querySelectorAll('.local-reverse').forEach(path => path.remove());
    if (!window || window.stale) return;
    for (const reverse of window.traffic.filter(t => t.reverse && window!.traffic.some(f => f.edge === t.edge && !f.reverse))) {
      const hit = world.querySelector(`[data-edge-id="${reverse.edge}"]`);
      const path = hit?.parentElement?.querySelector<SVGPathElement>('.edge-line');
      if (!path) continue;
      const copy = path.cloneNode() as SVGPathElement;
      copy.classList.add('local-reverse'); copy.removeAttribute('marker-start'); copy.removeAttribute('marker-end');
      copy.style.animationDirection = 'reverse'; copy.style.pointerEvents = 'none'; copy.setAttribute('transform', 'translate(0 4)');
      path.parentElement!.append(copy);
    }
  }
  function render() {
    live.clear();
    section.querySelector('[data-state]')!.textContent = !window ? 'No source connected' : window.stale ? 'Source stale · last window' : 'Receiving activity';
    const summary = section.querySelector('[data-summary]')!; summary.replaceChildren();
    for (const row of window?.traffic ?? []) {
      const edge = board()?.edges.find(e => e.id === row.edge); if (!edge) continue;
      const from = board()?.nodes.find(n => n.id === (row.reverse ? edge.to : edge.from));
      const to = board()?.nodes.find(n => n.id === (row.reverse ? edge.from : edge.to));
      const p = document.createElement('p');
      p.textContent = `${from?.label} → ${to?.label}: ${row.count} calls · ${row.errors} errors · ${row.p50 === null ? 'latency unknown' : `p50 ${row.p50}ms, p95 ${row.p95}ms (${row.samples} measured)`}`;
      summary.append(p);
      if (!window!.stale && (!live.has(BigInt(row.edge)) || !row.reverse)) live.set(BigInt(row.edge), { count: row.count, errors: row.errors, p50: row.p50 ?? -1, p95: row.p95 ?? -1, rps: row.count * 1000 / window!.duration, reverse: row.reverse });
    }
    redraw();
  }
  setInterval(() => { if (window && !window.stale && Date.now() - received > 3500) { window.stale = true; render(); } }, 1000);
  return { live, sync, update(value: LocalTrafficWindow) { window = value; received = Date.now(); render(); }, reset() { window = undefined; render(); } };
}
