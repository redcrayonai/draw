# Editorial rules

The server enforces the hard rules and rejects a violation with one sentence naming
the rule, as `REJECTED: <sentence> board=<name>`. `create_edge` with `source:`
evidence can also answer `REJECTED: path '<path>' is not citable: …` before it
writes anything, and `create_chart` and `set_chart_data` check the CSV and the
source first.

**Scope.** This is a session board, not the repo's architecture. It shows **the
components you built or materially changed in this session, and the direct
neighbours they talk to.** Nothing else. The rail's debt chip, a warning icon
and `N changed files not on board`, counts what you leave out — that number is
a feature as long as it is honest.
Nothing here is imported, so the hide-not-delete rule does not apply: delete your
own mistakes freely.

**Truth rules — these outrank every aesthetic rule:**
- Never create an edge you cannot cite. `evidence` is `source:<path>:<line>` where
  `<line>` is a line you read with `Read` in this session and `<path>` is tracked,
  or untracked and not ignored, under the repo root (the server checks both).
  `import` and `test-import` belong to imported boards; `human:<identity>` is
  refused for agents. A flow that seems likely but that you did not read: read
  it, or leave it out. A flow the user describes that no code shows (a scenario,
  a demo, infra outside the repo): `agent:<what it rests on>`, for example
  `agent:user described the topology`. The board draws it as an unverified claim.
- Never type code into the board. `add_code_ref` takes a symbol (plus a range,
  but only in a file that is not TypeScript/JavaScript); the server takes the
  snippet from the user's file and hashes it. If the server rejects a ref, the ref
  is wrong, not the server.
- Never paste code into labels, docs, change notes or threats; cite it with add_code_ref or a source: edge.
- When a component's purpose is unclear, read its source before naming, grouping,
  or wiring it. Do not infer purpose from a file name.

**Grammar (server-enforced where noted):**
- Every `x, y, w, h` divisible by 4 — enforced; rejected, never rounded.
- `token` is `ink` (normal) or `muted` (infrastructure, containers, neighbours you
  did not change). Never set `accent`; accent renders from `focal`.
- Exactly one `focal: true` node — the thing you built that a reader should see
  first. The server allows two for hand-drawn boards; a session board never uses
  the second.
- `kind` carries the visual grammar: `service` (code you wrote), `datastore`
  (tables, files, caches), `external` (outside this repo), `boundary` (a container
  — create it first and large, `token: muted`, then place members inside with
  24 px padding), `note` (bare text; at most one, a one-line checkpoint summary,
  only if the board benefits).
- **Icons.** `create_node` and `update_node` take an optional `icon` from the
  library: agent parts (`agent`, `orchestrator`, `subagent`, `model`, `tool`,
  `mcp-server`, `memory`, `knowledge-base`, `prompt`, `human`, `guardrail`,
  `evaluator`), system parts (`queue`, `cache`, `scheduler`, `event`, `gateway`,
  `function`, `browser`, `sandbox`), AI products (`claude`, `claude-code`,
  `openai`, `cursor`, `github-copilot`, `devin`, `grok`, `mistral`, …) and clouds (`aws`,
  `azure`, `vercel`, `supabase`, `firebase`, `neon`, `kubernetes`); the tool text
  lists them all. A product without a logo (for example Gemini or Codex) gets the
  generic icon for what it is, such as `model` or `agent`, with its name as the
  label.
  Give one only when the node is that kind of part or that product, so a reader
  can tell an orchestrator from a queue at a glance; leave plain code without
  one. An icon sits above the label: make the node 160×96 (the result says when
  the box is too short). `icon: ""` on `update_node` removes it. Icons are
  pictures, not kinds: still pick the `kind` by the grammar above. Notes, charts
  and architecture boards take none.
- **Fan-out.** At most four edges on any node. When a component talks to more,
  draw the four that matter to this task and leave the rest off — the board reads
  as a diagram, not a call graph.
- **Charts** are not a `kind`: `create_node` with `kind: chart` answers
  `use create_chart for charts`. Chart only a result you measured in this
  session, such as perf before and after a change, a test count or a bundle
  size, or work you read: a `schedule` of a plan's phases or a `kanban` of a
  tracker's tasks, with `source` naming the file or the query it came from.
  Call `describe_charts` first: it lists each type's columns, options,
  limits and a valid example. Then call `create_chart` with the numbers the
  command printed as CSV, and set `source` to the command and the commit that
  produced them, as `agent: <command> @ <sha7>`. Never invent or round numbers. A
  chart without a source is rejected, and `source: sample` is reserved for
  library examples. The result adds what was drawn, `committed id=<n> (<rows>
  rows; series: …) board=<name>`; read its warnings (folded slices, cut rows). A
  chart is at least 224×144. `set_chart_data` changes the data, `get_board` shows
  a chart's summary, and `get_chart` returns its CSV.
- Place new nodes anywhere on the grid — members fully inside their boundary
  (membership is geometric) — then, on a pass that added nodes or edges, call
  `layout_board`: it lays the board out left to right (entry points left, data
  stores right), keeps members inside their boundaries, and leaves room for edge
  labels. Do not hand-tune positions after it. When `get_board` shows positions
  you did not leave (a human arranged the board), skip `layout_board` and say so
  in your final answer. Default node 160×80. On a node 200 px or
  wider the ref badge can also name a symbol (`3 refs · Limiter.allow`); a
  narrower node shows the count only.
- **Size for the text.** The board draws exactly the box you store. The label
  wraps to at most two lines inside `w` (16 px padding each side) and is cut off
  with `…` after that; the sublabel takes one line below it and is dropped when
  `h` has no room; while the code overlay shows a node's ref badge, the text
  keeps clear of a row at the bottom for it.
  At the default text size a one-line label and a sublabel need `h = 48`, a
  two-line label and a sublabel `h = 68`; with refs, `72` and `88`. A sublabel of
  n characters needs `w` of at least `7.2 × n + 32`, rounded up to a multiple of
  4 — `client/src/chrome.ts` (20 characters) needs `w = 176`.
  `create_node`, `update_node` and `resize_node` add a note to `committed` when
  the box cuts text off, and the note names the size that shows it:
  `(label wraps to N lines; cut off below w=W — widen to W to show it in full)`,
  `(sublabel cut off below w=W)`, `(needs h=H to show label and sublabel)`. Act on
  it with `resize_node` (all four values on the 4 px grid, at least 64×48).
- **Edge labels** are one or two words (`validates`, `reads rows`). `layout_board`
  leaves room for them.
- `label` is what a reader calls the thing (`inspector`, `MCP server`); `sublabel`
  is the mono path or identifier (`client/src/chrome.ts`), or empty.
