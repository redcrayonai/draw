# Local Draw

Local mode serves a repository's architecture boards from one process on loopback. Boards and review state live on disk; no account, database server, container, or hosted Draw service is required. Browser and MCP edits use the same validated operations.

**Handoff compatibility:** the adapter attaches an existing, already loaded conversation through a shared app-server control socket. A desktop conversation running behind private stdio cannot be attached by this adapter. Drawing, references, notes, and traffic remain usable; feedback is saved until a supported conversation connects. The real same-conversation handoff acceptance check has not passed in this checkout's desktop environment. Mock adapter tests are not proof of real handoff.

## Build and launch

Use Node 24 and pnpm 10 for building with the repository's current tooling. The packaged runtime uses Node 20 or later and git for protected code reads. The relocated distribution/browser journey was tested with Node 20.20.2 and 24.21.0. Install each package separately:

```sh
pnpm -C agent install --frozen-lockfile
pnpm -C client install --frozen-lockfile
pnpm -C helper install --frozen-lockfile
pnpm -C helper build:local
node helper/dist/redcrayon.mjs local --repo /absolute/path/to/repository
```

Open the startup URL, including its credential fragment. It exchanges the credential for a local, HttpOnly, same-site cookie and removes the credential from the address bar. Treat this link and `endpoint.json` as private. No browser resources are requested from external hosts.

The server prints its storage directory and URL. By default storage is `~/.redcrayon/local/<hash-of-canonical-repository-path>/`. `--store /path` chooses another directory; `--port 4200` chooses a port instead of an available random port. Stop with Ctrl-C. Reopen the new startup link after restarting.

To move the distribution, copy the entire `helper/dist/` directory, including `local-assets/`. Run its `redcrayon.mjs` from any working directory with an explicit `--repo`. There is no runtime package install. Hosted mode continues using its existing entry point and build.

## Connect agent tools

Configure your agent's MCP client with this stdio server (replace both absolute paths):

```json
{
  "mcpServers": {
    "draw-local": {
      "command": "node",
      "args": ["/absolute/path/to/dist/redcrayon.mjs", "local-mcp", "--repo", "/absolute/path/to/repository"]
    }
  }
}
```

Start `local` first. If it uses `--store`, pass the same option to `local-mcp` and `live`. Endpoint discovery reads the private store file automatically. The bridge does not write the store, start an agent, or create a conversation.

Tools: `list_boards`, `open_board` (creates a named board), `read_board`, `apply_board`, `read_code`, and `attach_conversation`. The read result contains stable string IDs and a revision. Mutations supply that revision; stale changes are refused and require a fresh read. `apply_board` takes a batch of operations:

```json
{
  "board": "<slug>",
  "revision": 0,
  "operations": [
    {"type":"node.put","patch":{"label":"API","x":100,"y":100}},
    {"type":"node.put","patch":{"label":"Database","kind":"datastore","x":420,"y":100}}
  ]
}
```

Read the returned IDs before creating connections. `edge.put` takes `patch.from` and `patch.to`; optional `id` updates an existing element. Node patch fields are `label`, `description`, `x`, `y`, `w`, `h`, `kind`, `refs`. Edge fields are `from`, `to`, `label`, `description`, `direction` (`forward`, `both`, `none`), `refs`. Omit position fields when updating labels or descriptions to preserve the user's layout. `element.delete` takes `id` and removes dependent edges, retaining notes as detached feedback.

References are `{ "path": "src/api.ts", "start": 10, "end": 30 }`. Paths are relative to the selected repository; line numbers start at one. Protected, ignored, binary, missing, oversized, and escaping files are unavailable. Code reads resolve symlinks and enforce the repository boundary.

Notes use `note.add` (`target`, `text`), `note.reply` (`id`, `text`), and `note.resolve` (`id`, `resolved`). Agent replies and resolution are durable. Nodes and edges retain their IDs across updates.

## Browser editing and review

Create a board, add nodes, drag to move, or use the inspector for exact position and size. Shift-click two nodes and choose **Connect selected**. Select an edge to edit its label, description, or direction. Drag empty canvas to pan; scroll to zoom; **Fit** frames the graph. Keyboard users can focus nodes, press Enter to select, and use arrow keys to move; Ctrl/Cmd-Z on the canvas undoes, Shift-Ctrl/Cmd-Z redoes.

Undo/redo retains the last 30 graph edits in the browser session, including deletion with stable IDs. It refuses to overwrite a graph changed elsewhere. Review notes are retained across graph undo. Inspector drafts are not silently replaced by incoming updates; a stale save is refused. **Reload fields** discards the draft and reads the current values.

Attach code references through the inspector and click a reference to inspect local source. Select a node or edge to anchor a review note. The review list distinguishes open/resolved and detached notes.

## Existing-conversation feedback

The existing attachment adapter is `helper/src/chat-codex.ts`; compatibility was inspected with CLI 0.166.0. It invokes `app-server proxy`, then reads and attaches the given loaded thread, checking its working directory. It does not start a daemon, create a thread, or spawn another execution session.

In a supported environment, the current agent calls `attach_conversation` with `board`, its existing `threadId`, and optional absolute `socketPath`. The browser's connection form exposes the same operation. The thread must already be loaded in that shared server and use the exact board repository directory. The default socket is managed by the agent's shared app-server setup.

This checkout's desktop-managed servers use `--listen stdio://`, and the default shared control socket is absent. There is no socket path to copy from that setup. Changing this requires host support for attaching to its existing conversation; starting another conversation is not an equivalent workaround.

Feedback is saved before delivery, with a message ID, board identity/revision, selected element context/code refs, and open review notes. Explicit user instructions are separated from untrusted diagram context. States are **saved**, **pending**, **delivered**, **uncertain**, and **answered**. A saved message can be sent after connection; uncertain messages are never automatically replayed. Check the terminal before issuing an uncertain instruction again. Reusing a message ID cannot submit it twice. This is not an exactly-once guarantee across crashes.

Stop and one-time approval/decline controls use the existing adapter. No blanket approvals are granted. Replies persist locally. Model inference still uses the attached agent's provider; local mode does not imply offline model inference.

## Pipe observed interactions

Read board node IDs through `read_board`, then write an explicit mapping file:

```json
{"api":"1","database":"2"}
```

```sh
your-event-source | node /absolute/path/to/dist/redcrayon.mjs live \
  --repo /absolute/path/to/repository \
  --board <slug> --map /absolute/path/to/mapping.json
```

Each nonempty line is one observed interaction:

```json
{"from":"api","to":"database","duration_ms":12,"error":false}
```

`from` and `to` are required service identifiers. Duration is optional, finite, and nonnegative; missing duration stays unknown. Error is an optional boolean. Extra event fields are discarded; requests are never replayed. Both directions are counted separately, including traffic against the drawn arrow. Missing mappings/connections and ambiguous parallel edges are reported rather than guessed.

The CLI streams with backpressure in batches of 250 and flushes the final partial window at EOF. The server aggregates by receipt time in one-second windows. Limits: 4 KiB per input line, 10,000 accepted events per board/second, 1,000 directional edge buckets per window, 1,024 latency samples per bucket, 32 active traffic boards, 32 browser streams, and 64 server connections. Events beyond a limit are rejected with counts; accepted totals are never silently sampled. Slow viewers are disconnected instead of accumulating updates. Activity becomes stale after three seconds without events. Raw events and traffic history are never written to disk.

## Storage and recovery

`boards.json` contains a versioned snapshot with boards, graph, references, notes, replies, and feedback delivery state. A single writer applies whole validated batches to private copies, fsyncs a temporary file, then atomically renames it before acknowledging. Failed writes keep the prior acknowledged state. Multiple tabs converge through revisioned notifications. Limits of 2 MiB per board and 32 MiB per store fail explicitly; each browser notification queue is bounded to 4 MiB.

`writer.lock` prevents independent writers. After a process crash, verify that its recorded PID is no longer running before removing **only** `writer.lock`; never delete `boards.json` to recover a lock. Interrupted pending delivery is restored as uncertain. Unsupported schema versions fail without overwriting the file. Back up the store while the server is stopped.

## Verification

```sh
pnpm -C helper test
pnpm -C helper typecheck
pnpm -C client test
pnpm -C helper build:local
pnpm -C e2e install --frozen-lockfile
pnpm -C e2e exec playwright install chromium
pnpm -C e2e exec playwright test --config local.config.ts
```

The local browser journey uses a relocated packaged distribution, no database server, and covers stdio MCP, browser/tool updates, two tabs, dragging, undo/redo, references, review replies, NDJSON traffic with malformed input, and restart recovery. It rejects unexpected external browser requests. Deterministic adapter tests cover delivery failures and approvals. A real existing-thread handoff must be verified separately before claiming the entire local-mode acceptance contract is complete.
