# Optional session route

Routes are optional. When ordered milestones help the reader follow the task,
use a route. Node writes change focus, but route progress remains unchanged.
Only `arrive` advances the route. Evidence edges remain independent of route
order. Do not encode routes in labels, notes, tokens, or focal flags.

1. Create the waypoint nodes on the session board.
2. Call `plan_route` with `{ "board": "<id>", "nodeIds": ["<first>", "<next>", "<destination>"] }`.
   Use unique node IDs in the intended order. The final node is the destination.
   Every waypoint starts as `pending`.
3. Before each arrival, draw the completed work and attach its code refs ([draw.md](draw.md)).
4. Call `arrive` with `{ "board": "<id>", "nodeId": "<next-pending-id>" }`.
   Pass optional `exclude` groups with `{ "reason": "…", "glob": "…" }`, as for
   `mark_checkpoint`. An arrival runs a checkpoint, so it takes a capture like
   `mark_checkpoint` ([results.md](results.md)).
5. Read the returned checkpoint and coverage ([checkpoint.md](checkpoint.md)).
6. If the plan changes, call `reroute` with `add`, `remove`, and a nonempty `reason`.

Arrival commits the checkpoint, route transition, history, and agent focus in one
step. The previous current waypoint becomes `done`. The next pending
waypoint becomes `current`. The last arrival completes the route and leaves the
destination `current`. Progress includes the current waypoint: `5/5 · destination reached`.
An arrival also satisfies a checkpoint trigger when no later edit occurs.
The final selection clear still requires a final `mark_checkpoint`.

`reroute` accepts `add: [{ nodeId, index }]` and `remove: [nodeId]`.
Reroutes change only pending waypoints.
The index is zero-based within the pending list after removals, at each insertion.
The server first removes named pending nodes, including existing nodes named in
`add`. It then inserts additions in argument order. Current and done waypoints
keep their order. A reroute can extend a completed route with new pending nodes.
Remove a pending waypoint through `reroute` before deleting its node.

`get_board` includes route state and history. Inspect this state after an
`UNCONFIRMED` route write. Missing and hidden waypoints remain disclosed.
Arrival cannot reach a missing or hidden node.

An identical `plan_route` is safe to retry. A different plan requires `reroute`.
An unchanged reroute adds no history. Retry the current arrived node to recover
its original checkpoint, including after a reroute. This retry does not change
an explicit selection override. Arrivals out of order or at older done waypoints
are rejected. If the server reports a concurrent revision or checkpoint change,
read `get_board` before preparing another arrival.
