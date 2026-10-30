import { markCheckpointFlow, type SessionConn, type SessionDeps } from './session';

/** Routes are separate from evidence edges and from transient agent selection. */
export function routeSnapshot(conn: SessionConn, boardId: bigint) {
  const route = [...conn.db.visibleSessionRoute.iter()].find(r => r.boardId === boardId);
  if (!route) return null;
  const nodes = new Map([...conn.db.visibleNode.iter()].filter(n => n.boardId === boardId).map(n => [n.id, n]));
  const history = [...conn.db.visibleRouteEvent.iter()]
    .filter(e => e.boardId === boardId)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(e => ({
      id: e.id.toString(), kind: e.kind, revision: e.revision,
      nodeId: e.nodeId?.toString(), nodeIds: e.nodeIds.map(String), reason: e.reason, checkpoint: e.checkpoint,
    }));
  return {
    revision: route.revision,
    currentIndex: route.currentIndex,
    currentCheckpoint: route.currentCheckpoint,
    destinationId: route.nodeIds[route.nodeIds.length - 1]?.toString(),
    arrived: route.currentIndex + 1,
    complete: route.currentIndex === route.nodeIds.length - 1,
    waypoints: route.nodeIds.map((id, index) => ({
      nodeId: id.toString(),
      status: index < route.currentIndex ? 'done' : index === route.currentIndex ? 'current' : 'pending',
      missing: !nodes.has(id),
      hidden: nodes.get(id)?.hidden ?? false,
    })),
    history,
  };
}

export async function arriveFlow(
  input: { boardId: bigint; nodeId: bigint; exclude?: { reason: string; glob: string }[] },
  deps: SessionDeps
) {
  const { boardId, nodeId } = input;
  const state = await deps.call('read route', async conn => {
    const session = [...conn.db.visibleSession.iter()].find(s => s.boardId === boardId);
    if (!session) throw new Error('the active board has no session; call start_session first');
    const route = [...conn.db.visibleSessionRoute.iter()].find(r => r.boardId === boardId);
    if (!route) throw new Error('the active board has no route; call plan_route first');
    if (route.nodeIds[route.currentIndex] === nodeId) {
      return { existing: true as const, checkpoint: route.currentCheckpoint, route: routeSnapshot(conn, boardId) };
    }
    const index = route.nodeIds.indexOf(nodeId);
    if (index >= 0 && index < route.currentIndex) throw new Error(`waypoint ${nodeId} is already done; arrival cannot rewind the route`);
    const next = route.nodeIds[route.currentIndex + 1];
    if (nodeId !== next) throw new Error(`arrive at the next waypoint ${next ?? '(destination already reached)'}; read get_board first`);
    const node = [...conn.db.visibleNode.iter()].find(n => n.id === nodeId && n.boardId === boardId);
    if (!node) throw new Error(`waypoint ${nodeId} does not exist; reroute before arriving`);
    if (node.hidden) throw new Error(`waypoint ${nodeId} is hidden; unhide it or reroute before arriving`);
    return { existing: false as const, expectedRevision: route.revision, expectedCheckpoint: session.checkpoint };
  });
  if (state.existing) return state;
  const checkpoint = await markCheckpointFlow({
    boardId, exclude: input.exclude,
    arrival: { nodeId, expectedRevision: state.expectedRevision, expectedCheckpoint: state.expectedCheckpoint },
  }, deps);
  return deps.call('read committed arrival', async conn => {
    const route = routeSnapshot(conn, boardId);
    const event = [...conn.db.visibleRouteEvent.iter()].find(e => e.boardId === boardId && e.kind === 'arrive' && e.nodeId === nodeId);
    const number = event?.checkpoint ?? route?.currentCheckpoint ?? checkpoint.checkpoint;
    const session = [...conn.db.visibleSession.iter()].find(s => s.boardId === boardId);
    // A concurrent caller can win this stop, or advance the session again.
    // Only the session row at this arrival's checkpoint proves its coverage.
    if (!session || session.checkpoint !== number) return { checkpoint: number, existing: true, route };
    let coverage;
    try { coverage = JSON.parse(session.coverage); }
    catch { return { checkpoint: number, existing: true, route }; }
    const existing = session.headSha !== checkpoint.headSha || session.coverage !== JSON.stringify(checkpoint.coverage);
    const stored = { checkpoint: number, headSha: session.headSha, coverage, existing, route };
    return existing ? stored : { ...checkpoint, ...stored };
  });
}
