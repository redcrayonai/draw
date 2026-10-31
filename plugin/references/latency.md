# Optional: latency and request flow

When the user asks how a request flows or where time goes, put numbers on the
board. Two tools do it: `set_edge_latency` labels one hop, and `play_trace`
replays one whole request as dots that every viewer watches.

Every number carries a `source`. Pick the first one you can honestly use:

| source | where the numbers come from |
|---|---|
| `prod` | A monitoring tool the user has connected (any tracing or APM tool). Fetch one recent trace, or the slowest few. |
| `local` | Your own measurement on this machine: browser network timings, curl request timings, test timings, or a console trace exporter the user agreed to run. |
| `estimate` | Your reading of the code (a database call, an outside API, a cache hit). The board draws it as `~4ms`. |

Never pass an estimate as `prod` or `local`. Only measured numbers are `prod` or `local`.

1. Draw the nodes the request touches first ([draw.md](draw.md)). Map each service or
   operation in the trace to one node id. Leave out spans with no node.
2. For each hop, call `set_edge_latency` with `{ "board": "<id>", "edgeId": "<id>", "latencyMs": 38, "source": "prod" }`.
   Pass `"latencyMs": -1` to clear one.
3. For one request, call `play_trace` with `{ "board": "<id>", "source": "prod", "title": "GET /checkout", "spans": [...] }`.
   Each span is `{ "id", "parent", "node", "startMs", "durationMs", "status" }`:
   `startMs` counts from the start of the trace, `parent` is the calling span's id,
   and `status` is `ok` or `error`. Send nothing else. Attributes, URLs, headers,
   payloads and user data never go on a board, and the server refuses any other field.
4. A new trace replaces the last one. Viewers can replay it from the board.

Refresh numbers only when the user asks. Do not loop on a timer to stream them.

## Live traffic while the user runs the app

When the user wants to watch traffic move while they run their app locally, use the live tap instead of refreshing numbers yourself:

1. Draw each service the app runs as a node, with edges for the calls between them.
2. Call `start_tap` with `{ "board": "<id>" }`. It returns a token and the command to run.
3. Write `.redcrayon/tap.json` in the project root: `{ "board": "<id>", "services": { "<service.name>": "<node id>" } }`, one entry per OpenTelemetry service name.
4. Run the command `start_tap` returned, in the background, from the project root. It needs Node 22.
5. Tell the user to point their exporter at `http://127.0.0.1:4318` with `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, and to switch on **live traffic** on the board.
6. Call `tap_status` with `{ "board": "<id>" }` to confirm the tap connected.
7. When the user is done watching, call `stop_tap` with `{ "board": "<id>" }`. The command exits, and the token no longer works.

The tap drops span attributes on the user's machine and sends only per-edge rates, latencies and errors, and only while someone watches. It prints unmapped service names once a minute: add them to the file, which it rereads. The token lasts 12 hours.
