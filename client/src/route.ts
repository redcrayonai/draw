import type { Node, RouteEvent, SessionRoute } from './module_bindings/types';

export type WaypointStatus = 'pending' | 'current' | 'done';
export interface RouteMarker {
  number: number;
  status: WaypointStatus;
}

export interface RouteModel {
  key: string;
  destination: string;
  progress: string;
  currentNodeId: bigint | null;
  waypoints: Array<RouteMarker & { nodeId: bigint; label: string; availability: 'visible' | 'hidden' | 'missing' }>;
  history: Array<{ id: bigint; text: string }>;
  byNode: ReadonlyMap<bigint, RouteMarker>;
}

/** Route state comes only from its durable rows, never an agent's selection. */
export function buildRouteModel(
  route: SessionRoute | null,
  events: readonly RouteEvent[],
  nodes: ReadonlyMap<bigint, Pick<Node, 'label' | 'sublabel' | 'hidden'>>
): RouteModel | null {
  if (route === null) {
    return null;
  }
  const name = (id: bigint): string => {
    const n = nodes.get(id);
    return n === undefined ? `missing node ${id}` : `${n.label || n.sublabel || `node ${id}`}${n.hidden ? ' (hidden)' : ''}`;
  };
  const waypoints = route.nodeIds.map((nodeId, index) => ({
    nodeId,
    number: index + 1,
    status: (index < route.currentIndex ? 'done' : index === route.currentIndex ? 'current' : 'pending') as WaypointStatus,
    label: name(nodeId),
    availability: (!nodes.has(nodeId) ? 'missing' : nodes.get(nodeId)!.hidden ? 'hidden' : 'visible') as 'visible' | 'hidden' | 'missing',
  }));
  const arrived = Math.max(0, route.currentIndex + 1);
  const complete = waypoints.length > 0 && arrived === waypoints.length;
  const current = waypoints[route.currentIndex];
  const next = waypoints[route.currentIndex + 1];
  const progress = `${arrived}/${waypoints.length}` + (complete
    ? ' · destination reached'
    : `${current ? ` · now: ${current.label}` : ''}${next ? ` · next: ${next.label}` : ''}`);
  let previous: bigint[] | null = null;
  const history = events.filter(e => e.boardId === route.boardId)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(e => {
      const targets = e.nodeIds.map(name).join(', ');
      let action = e.kind === 'arrive' ? `Arrived: ${e.nodeId === undefined ? 'waypoint' : name(e.nodeId)}` : `Planned: ${targets}`;
      if (e.kind === 'reroute') {
        const changes: string[] = [];
        if (previous === null) {
          changes.push(`waypoints: ${targets}`);
        } else {
          const prior = new Set(previous);
          const next = new Set(e.nodeIds);
          const commonBefore = previous.filter(id => next.has(id));
          const commonAfter = e.nodeIds.filter(id => prior.has(id));
          const groups = [
            ['added', e.nodeIds.filter(id => !prior.has(id))],
            ['removed', previous.filter(id => !next.has(id))],
            ['reordered', commonAfter.filter((id, i) => id !== commonBefore[i])],
          ] as const;
          for (const [kind, ids] of groups) {
            if (ids.length > 0) changes.push(`${kind}: ${ids.map(id => `${name(id)} (#${id})`).join(', ')}`);
          }
        }
        action = `Rerouted: ${e.reason}${changes.length > 0 ? ` · ${changes.join(' · ')}` : ''}`;
      }
      previous = e.nodeIds;
      return { id: e.id, text: `${action} · checkpoint ${e.checkpoint} · revision ${e.revision}` };
    });
  return {
    key: JSON.stringify([route.revision, route.currentCheckpoint, progress, waypoints.map(w => [w.nodeId.toString(), w.label, w.status, w.availability]), history.map(e => [e.id.toString(), e.text])]),
    destination: waypoints[waypoints.length - 1]?.label ?? '',
    progress,
    currentNodeId: current?.nodeId ?? null,
    waypoints,
    history,
    byNode: new Map(waypoints.map(w => [w.nodeId, { number: w.number, status: w.status }])),
  };
}
