# Local Draw

Local mode serves a repository's architecture boards from one process on loopback. Boards and review state live on disk; no account, database server, container, or hosted Draw service is required. Browser and MCP edits use the same validated operations.

**Agent compatibility:** standalone Codex 0.166.0, Claude Code 2.1.322, and pi 1.4.0 passed real same-session browser feedback, diagram updates, and review reply/resolution tests. Codex uses its shared app-server socket; Claude Code uses session hooks; pi uses an extension inside the current session. Conductor integration is out of scope.

## Install the standalone executable

Download the `draw-local` artifact for your operating system and architecture from this PR's **session-flows → local-binary** CI job, then extract the artifact ZIP. The `.tgz` inside is installable with Bun; it contains a native executable, its runtime, the UI, and licenses, with no dependencies or install scripts:

```sh
bun install -g ./draw-darwin-arm64.tgz  # use the filename for your platform
# Ensure Bun's global bin directory is on PATH.
draw install codex
cd /path/to/your-project
codex
```

Ask Codex: **Use `$draw-local:local` to open a board for this repository.** The skill starts the local server and connects this conversation. You can also run `draw` directly in your repository to open the browser; `draw --no-open` only prints the URL. Running `draw` again opens the existing server. Keep the terminal serving the board open; Ctrl-C stops it without deleting boards.

Bun is only needed for this install command. The installed executable runs without Node, Bun, pnpm, or a source checkout; git and your chosen coding agent remain prerequisites. Keep the executable in place after `draw install codex`, or rerun that command if you move it. Existing boards use the same storage as the source distribution.

To install without Bun, extract the `.tgz` with `tar -xzf`, put `package/draw` on PATH, and retain its accompanying licenses. There is no published registry package or public release download yet; CI artifacts are the current distribution. macOS artifacts are not notarized.

For maintainers, use Bun 1.4.4 and the build dependencies below, then run `pnpm -C helper build:binary` (or `bun helper/build-binary.mjs` from the repository root). Outputs are `helper/dist/binary/draw`, a platform-specific `.tgz`, and `SHA256SUMS`. CI builds and runs the packaged browser journey on macOS and Linux. The source/Node distribution remains supported.

## Build and launch from source

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

## Try the source distribution with Codex

The local build is also a self-contained Codex plugin, with a local-only skill and MCP bridge. Install this checkout once:

```sh
pnpm -C helper build:local
node helper/dist/redcrayon.mjs install codex
codex
```

In Codex, ask: **Use `$draw-local:local` to open a board for this repository.** The skill starts the local server if needed, reuses or creates a named board, shares its private browser link, and attaches the current thread using `CODEX_THREAD_ID`. Approve the requested local server/tool operations in Codex as usual. You do not need to copy a thread ID or configure MCP manually. Start Codex from the repository you want to draw. Do not use `--no-daemon`, which removes the shared connection needed by board chat.

This development marketplace is named `draw-local-dev`; it installs `draw-local` alongside any existing hosted Draw plugin. It does not replace the hosted plugin or its account connection. The build fingerprints the packaged code and skill to avoid stale installed copies. After changing/rebuilding the local plugin, reinstall with `draw install codex` (or `node helper/dist/redcrayon.mjs install codex` for the source distribution) and start a new Codex session to load the update. The plugin is built for standalone Codex; Claude and pi setup is documented below.

To remove this development install: `codex plugin remove draw-local@draw-local-dev`, then `codex plugin marketplace remove draw-local-dev`. Existing local boards remain in the storage directory.

## Connect agent tools

For a standalone install, use the absolute `draw` executable as `command` and omit the `redcrayon.mjs` argument below. Likewise, replace `node /absolute/path/to/dist/redcrayon.mjs` with `draw` in the Claude and activity commands.

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

Local mode uses the hosted canvas chrome and theme picker, with bundled fonts and no external font requests. Material Light is the default; theme choices persist in this browser.

Create a board with **+**, choose a node kind in the bottom toolbar, and click the canvas to place it. Drag nodes to move them, or use the Board panel for exact position and size. The Hand tool pans even when dragging over a node. Shift-click two nodes and choose **Connect selected**. Select an edge to edit its label, description, or direction. Drag empty canvas to pan; scroll to zoom; **Fit** frames the graph. Keyboard users can focus nodes, press Enter to select, and use arrow keys to move; Ctrl/Cmd-Z on the canvas undoes, Shift-Ctrl/Cmd-Z redoes.

Undo/redo retains the last 30 graph edits in the browser session, including deletion with stable IDs. It refuses to overwrite a graph changed elsewhere. Review notes are retained across graph undo. Inspector drafts are not silently replaced by incoming updates; a stale save is refused. **Reload fields** discards the draft and reads the current values.

Attach code references through the inspector and click a reference to inspect local source. Open **Review** in the header and select a node or edge to anchor a review note. The review list distinguishes open/resolved and detached notes.

## Existing-conversation feedback

Open **Conversation** in the header to send feedback or stop the agent. Manual connection fields are under **Connection settings**; an attached conversation needs no reconfiguration. Review and conversation drafts survive closing their panels.

### Codex

Configure the local MCP server in Codex's config, using the equivalent TOML shape:

```toml
[mcp_servers.draw-local]
command = "node"
args = ["/absolute/path/to/dist/redcrayon.mjs", "local-mcp", "--repo", "/absolute/path/to/repository"]
```

The thread must already be loaded in a shared app server and use the exact board repository directory. For a standalone setup, start a shared server and connect your terminal to it before working:

```sh
codex app-server --listen unix:///absolute/private/path/draw-codex.sock
# In another terminal:
codex --remote unix:///absolute/private/path/draw-codex.sock -C /absolute/path/to/repository
```

In that conversation, ask the agent to call `attach_conversation` with the board slug, its current thread ID, and the absolute socket path. The browser's **Conversation → Connection settings** form accepts the same values. A terminal already using the default shared daemon can omit the socket path. The adapter reads and resumes that loaded thread after checking its working directory; it never creates a replacement conversation. A private stdio server cannot be attached through this socket adapter.

### Claude Code

Create a board first. Generate a settings file for that board, then load it into Claude Code from the repository directory:

```sh
node /absolute/path/to/dist/redcrayon.mjs local-claude-settings \
  --repo /absolute/path/to/repository --board <slug> > /private/path/draw-hooks.json
claude --settings /private/path/draw-hooks.json --mcp-config /private/path/draw-mcp.json
```

`draw-mcp.json` contains the `mcpServers` JSON from **Connect agent tools**. To connect an existing saved conversation, add `--resume <session-id>`; this keeps its identity. The generated settings add session hooks only and do not change permissions or global configuration. The hooks bind to Claude's actual session ID and repository, deliver idle feedback through `asyncRewake`, and return replies through `Stop`. Claude approvals stay in its terminal. Board Stop takes effect at the next tool boundary; it does not kill a command already running.

Wake notifications bypass `UserPromptSubmit` in the tested Claude version. The hook therefore confirms receipt by finding its delivery ID in that same session's transcript, reading at most its last 1 MiB. A missing or late receipt stays uncertain; it is never automatically resent.

### pi

The tarball includes `local-pi-extension.mjs` alongside the executable; source builds put it in `helper/dist/`. The packaged extension connects chat and registers the local MCP tools inside the current pi session:

```sh
DRAW_LOCAL_BOARD=<slug> pi -e /absolute/path/to/dist/local-pi-extension.mjs
```

Run from the board's repository. Add `--resume <session-id>` to reconnect a saved conversation. If using a custom store, also set `DRAW_LOCAL_STORE=/absolute/path/to/store`. The extension requires pi's built-in MCP support. If you use `--no-extensions`, explicitly add `-e builtin:mcp` alongside the Draw extension. It uses `sendUserMessage` and `abort` on the current session; it never launches a second agent. Normal pi tool policy remains in effect.

For Claude and pi, pass the custom store to every setup command, and restart/resume the same conversation with its hooks/extension after restarting Draw. Disconnected hooks expire after 45 seconds. These integrations are opt-in for the named board; they do not discover or attach unrelated terminal sessions.

Feedback is saved before delivery, with a message ID, board identity/revision, selected element context/code refs, and open review notes. Explicit user instructions are separated from untrusted diagram context. States are **saved**, **pending**, **delivered**, **uncertain**, and **answered**. A saved message can be sent after connection; uncertain messages are never automatically replayed. Check the terminal before issuing an uncertain instruction again. Reusing a message ID cannot submit it twice. This is not an exactly-once guarantee across crashes.

Codex command/file approvals can be accepted or declined once from the board. MCP elicitations and other terminal input remain in Codex; the board shows that input is needed. No blanket approvals are granted. Replies persist locally. Model inference still uses the attached agent's provider; local mode does not imply offline model inference.

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

The local browser journey uses a relocated packaged distribution, no database server, and covers stdio MCP, browser/tool updates, two tabs, dragging, undo/redo, references, review replies, NDJSON traffic with malformed input, and restart recovery. It rejects unexpected external browser requests. Deterministic adapter tests cover delivery failures and approvals. Real agent tests are separate and opt-in because they require your installed, authenticated CLI and make model calls:

```sh
node scripts/local-agent-smoke.mjs codex
node scripts/local-agent-smoke.mjs claude-code
node scripts/local-agent-smoke.mjs pi
```

Each test establishes a standalone test conversation, records its ID, then sends feedback from a real browser to that same conversation. The agent must recall an earlier marker, update the selected node through local MCP, preserve its position and note anchor, reply to and resolve the note, and update the open browser without reloading. JSON evidence and screenshots are saved under `.context/<agent>-handoff-evidence.json` and `.context/<agent>-handoff.png`. The test owns and stops its server/agent processes; it does not modify global agent configuration. The Codex test terminal grants individual approvals only for that test board's read/apply tools; the Claude test enables only those two MCP tools. All three passed on the versions above.
