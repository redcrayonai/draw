/**
 * layout_board's plan split into units the hosted server applies whole (spec:
 * a call may stop at its time budget). A unit is a top-level container with
 * everything inside it in the current geometry, nested boundaries included;
 * a node outside every container is a unit of its own. planLayout reads
 * membership from geometry, so re-planning after a stop is idempotent only
 * across complete units: half a unit (members moved, boundary not yet resized)
 * could drop members out of their boundary on the next call.
 *
 * tools.ts imports this module lazily: it pulls in the layout engine.
 */
import { containersOf, parentOf, type LayoutNode, type LayoutPlan } from '../../agent/src/layout';

export { planLayout } from '../../agent/src/layout';

/** The plan's moves and resizes grouped by unit, in order of the unit's top-level id; moves before resizes in each. */
export function layoutUnits(nodes: LayoutNode[], plan: LayoutPlan): LayoutPlan[] {
  const visible = nodes.filter(n => !n.hidden);
  const boundaries = containersOf(visible);
  const parent = new Map(visible.map(n => [n.id, parentOf(n, boundaries)]));
  const top = (id: bigint): bigint => {
    let at = id;
    for (let p = parent.get(at); p; p = parent.get(at)) at = p.id;
    return at;
  };
  const units = new Map<bigint, LayoutPlan>();
  const unit = (id: bigint) => {
    const key = top(id);
    if (!units.has(key)) units.set(key, { moves: [], resizes: [] });
    return units.get(key)!;
  };
  for (const m of plan.moves) unit(m.id).moves.push(m);
  for (const r of plan.resizes) unit(r.id).resizes.push(r);
  return [...units.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, u]) => u);
}
