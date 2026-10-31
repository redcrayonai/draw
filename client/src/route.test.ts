import { describe, expect, it } from 'vitest';
import { buildRouteModel } from './route';
import type { SessionRoute } from './module_bindings/types';

const at = { toDate: () => new Date(0) } as SessionRoute['updatedAt'];
const route = { boardId: 7n, nodeIds: [1n, 2n, 3n], currentIndex: -1, revision: 1, currentCheckpoint: 0, updatedAt: at };
const nodes = new Map([
  [1n, { label: 'Plan', sublabel: '', hidden: false }],
  [2n, { label: 'Auth', sublabel: '', hidden: false }],
  [3n, { label: 'Tests', sublabel: '', hidden: false }],
]);

describe('session route model', () => {
  it('starts pending and counts arrived waypoints including the current waypoint', () => {
    const initial = buildRouteModel(route, [], nodes)!;
    expect(initial.waypoints.map(w => w.status)).toEqual(['pending', 'pending', 'pending']);
    expect(initial.progress).toBe('0/3 · next: Plan');
    expect(initial.destination).toBe('Tests');

    const arrived = buildRouteModel({ ...route, currentIndex: 1 }, [], nodes)!;
    expect(arrived.waypoints.map(w => w.status)).toEqual(['done', 'current', 'pending']);
    expect(arrived.progress).toBe('2/3 · now: Auth · next: Tests');
    expect(arrived.currentNodeId).toBe(2n);
  });

  it('keeps the destination current on completion and allows a new pending destination', () => {
    const complete = buildRouteModel({ ...route, currentIndex: 2 }, [], nodes)!;
    expect(complete.progress).toBe('3/3 · destination reached');
    expect(complete.waypoints[2].status).toBe('current');
    expect(complete.currentNodeId).toBe(3n);

    const extended = buildRouteModel({ ...route, nodeIds: [...route.nodeIds, 4n], currentIndex: 2, revision: 2 }, [], nodes)!;
    expect(extended.progress).toBe('3/4 · now: Tests · next: missing node 4');
    expect(extended.destination).toBe('missing node 4');
  });

  it('discloses missing and hidden nodes and retains route history with its checkpoint and reason', () => {
    const hidden = new Map(nodes);
    hidden.set(2n, { label: 'Auth', sublabel: '', hidden: true });
    hidden.delete(3n);
    const events = [
      { id: 2n, boardId: 7n, kind: 'reroute', revision: 2, nodeId: undefined, nodeIds: [1n, 2n, 3n], reason: 'Add verification', checkpoint: 4, at },
      { id: 1n, boardId: 7n, kind: 'arrive', revision: 1, nodeId: 2n, nodeIds: [1n, 2n], reason: '', checkpoint: 3, at },
      { id: 3n, boardId: 9n, kind: 'plan', revision: 1, nodeId: undefined, nodeIds: [1n], reason: '', checkpoint: 1, at },
    ];
    const m = buildRouteModel({ ...route, currentIndex: 1 }, events, hidden)!;
    expect(m.waypoints.map(w => w.availability)).toEqual(['visible', 'hidden', 'missing']);
    expect(m.progress).toBe('2/3 · now: Auth (hidden) · next: missing node 3');
    expect(m.history.map(e => e.text)).toEqual([
      'Arrived: Auth (hidden) · checkpoint 3 · revision 1',
      'Rerouted: Add verification · added: missing node 3 (#3) · checkpoint 4 · revision 2',
    ]);
    expect(buildRouteModel(null, events, hidden)).toBeNull();
  });

  it('names removed, added and reordered waypoint identities by comparing full history snapshots', () => {
    const events = [
      { id: 1n, boardId: 7n, kind: 'plan', revision: 1, nodeId: undefined, nodeIds: [1n, 2n, 3n], reason: '', checkpoint: 0, at },
      { id: 2n, boardId: 7n, kind: 'reroute', revision: 2, nodeId: undefined, nodeIds: [1n, 3n], reason: 'Skip optional auth', checkpoint: 1, at },
      { id: 3n, boardId: 7n, kind: 'reroute', revision: 3, nodeId: undefined, nodeIds: [1n, 3n, 2n, 4n], reason: 'Restore auth and verify', checkpoint: 1, at },
      { id: 4n, boardId: 7n, kind: 'reroute', revision: 4, nodeId: undefined, nodeIds: [1n, 2n, 3n, 4n], reason: 'Auth before tests', checkpoint: 1, at },
    ];
    const history = buildRouteModel({ ...route, nodeIds: [1n, 2n, 3n, 4n], revision: 4 }, events, nodes)!.history;
    expect(history.map(e => e.text)).toEqual([
      'Planned: Plan, Auth, Tests · checkpoint 0 · revision 1',
      'Rerouted: Skip optional auth · removed: Auth (#2) · checkpoint 1 · revision 2',
      'Rerouted: Restore auth and verify · added: Auth (#2), missing node 4 (#4) · checkpoint 1 · revision 3',
      'Rerouted: Auth before tests · reordered: Auth (#2), Tests (#3) · checkpoint 1 · revision 4',
    ]);
  });

  it('keeps insertion order and reroute transitions when the clock moves backwards', () => {
    const events = [
      { id: 3n, boardId: 7n, kind: 'reroute', revision: 3, nodeId: undefined, nodeIds: [1n, 3n, 2n], reason: 'Restore auth', checkpoint: 0, at },
      { id: 1n, boardId: 7n, kind: 'plan', revision: 1, nodeId: undefined, nodeIds: [1n, 2n, 3n], reason: '', checkpoint: 0, at: { toDate: () => new Date(100) } as typeof at },
      { id: 2n, boardId: 7n, kind: 'reroute', revision: 2, nodeId: undefined, nodeIds: [1n, 3n], reason: 'Skip auth', checkpoint: 0, at: { toDate: () => new Date(50) } as typeof at },
    ];
    const history = buildRouteModel({ ...route, nodeIds: [1n, 3n, 2n], revision: 3 }, events, nodes)!.history;
    expect(history.map(e => e.id)).toEqual([1n, 2n, 3n]);
    expect(history.map(e => e.text)).toEqual([
      'Planned: Plan, Auth, Tests · checkpoint 0 · revision 1',
      'Rerouted: Skip auth · removed: Auth (#2) · checkpoint 0 · revision 2',
      'Rerouted: Restore auth · added: Auth (#2) · checkpoint 0 · revision 3',
    ]);
  });
});
