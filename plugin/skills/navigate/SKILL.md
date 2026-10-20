---
name: navigate
description: Use when the user types /draw:navigate [session-name | board link], or asks to open a live board, diagram, or whiteboard for the current task.
argument-hint: [session-name | board link]
allowed-tools: mcp__redcrayon__*, mcp__plugin_draw_redcrayon__*, Bash(git:*), Read
---

# redcrayon — draw what you build

You are working a task in this repo. While you work, you keep a live architecture
board of the task current, so the user reads the board instead of a prose summary.
The board is a claim about the code, and every claim on it is something the server
can check: every edge cites a line you read, every code ref is a snippet the server
read from the user's files, and every changed file you did not draw is a number on
the chrome.

One-way: you draw, the user reads. Feedback comes back through chat, not the board.

**Tool names.** The redcrayon tools carry a prefix: `mcp__plugin_draw_redcrayon__`
when the redcrayon plugin provides the server, `mcp__redcrayon__` when the user added
it by hand, or another prefix with redcrayon in it. This skill names each tool
without its prefix (`start_session`). Use one prefix for the whole session.

**`board` on every call.** Every tool except `start_session` and `describe_charts`
takes `board`: the `id` that `start_session` returned, as a string of digits
(`"42"`). Pass it on every call, yours and your subagents'.

## 0. Preflight — before anything else

Look for `start_session` and `get_board` under a redcrayon prefix in your tool
list. If they are not there, say exactly
`The redcrayon server is not connected. Run /mcp, choose redcrayon, and sign in.`
and stop. Never carry on without a board and never pretend one exists.

## 1. Start

Read the **first word** of `$ARGUMENTS`. Everything after the first space is the
task, never part of the name or link (`accept-r2 — fix the loop` names the board
`accept-r2`).

- **A link.** If the first word starts with `https://` or `http://`, call
  `start_session` with `{ "link": "<the word>" }`. If it answers
  `REJECTED: no board at <link>. …`, relay that text to the user word for word and
  stop. Never open a different board instead, and never fall back to a name.
- **A name.** Otherwise the first word is the session name. With no arguments, the
  name is the current branch from `git rev-parse --abbrev-ref HEAD` (keep the `/`).
  If that prints `HEAD`, you are on a detached HEAD: do not name the board `HEAD`
  (every detached task would share it). Ask the user for a session name and wait
  for the answer. Call `start_session` with `{ "name": "<name>" }` (one line, at
  most 100 characters, no control characters).

Leave `capture` empty (Section 2, Captures).

If `start_session` is rejected, act on the sentence (Section 2) and call it
again; if you cannot fix the cause, tell the user the rejection verbatim and
stop. Every other tool needs the `id`, so **never call `create_node`,
`create_edge`, `add_code_ref` or any other board write before `start_session`
has returned a `url`.**

The result is `{ board, id, url, session, checkpoint?, repoRoot?, baseSha?, note? }`.
Relay `url` **once, verbatim, in your very next message** — that link is how the
user finds the board. If `note` is present, relay it once in that same message:
it says why the board took another name (`main (2)`), or why code refs and
checkpoints are off. `session: false` means a drawing-only board: draw, but skip
code refs, checkpoints and routes, and end with the board URL. If `checkpoint` is greater than 0 you
re-adopted an existing session board (this works only from the checkout that
started it): call `get_board` and read it before drawing, so you extend it
instead of redrawing it. Write results end with ` board=<name>`; if one names a
board other than your session's, stop writing and call `get_board` to check the
`board` id you passed.

**Draw before you edit.** The user watches the board from the moment you relay
the `url`, and an empty board reads as a stalled agent. As soon as you know which
components the task touches, and before your first file edit, draw them: one
`create_node` with a `doc` (Section 3) per component, all in one message. Then
keep the board current as you work, and redraw at every checkpoint.

## 2. Results and failures

Every tool answers within 15 s, or says why. A failure starts with one of three
prefixes:

- `REJECTED: …` — a rule refused the call. Read the sentence, fix the input or
  do what it says, and call again. Never repeat a rejected call with the same
  input (unless its text says `call again`); never give up on a rejected write.
- `UNAVAILABLE: …` — redcrayon could not do the call. Wait the time the text
  states (`Call again in 30 s`), then call again with the same arguments. If it
  repeats, tell the user and give them the `ref` the text names.
- `UNCONFIRMED: …` — the write may have landed. Call `get_board` before any
  retry, and retry only if the node, edge or ref is missing. A blind retry can
  draw a second copy, which is a false claim on the board.

`MCP error -32602: Input validation error: …` comes from the tool's argument
schema, before the server runs: an unknown argument, a `symbol` that ends with a
dot, a session name longer than 100 characters, an id that is not a string of
digits, a coordinate that is not an integer. Nothing was written. Fix the
argument that the text names and call again.

A create repeated within 30 s answers with the first result and ends with
`(same call <n> s ago; nothing new written)`: nothing new was drawn.

A `REJECTED: …` from `start_session`, `mark_checkpoint` or `arrive` that says
`call again to continue` or `call again to record the checkpoint`, or one from
`add_code_ref` or `create_edge` that ends with `calling again is safe`, stopped
at its time budget; the text says what was written. Call the same tool again
with the same arguments until it returns its result. `mark_checkpoint` records
no checkpoint until a call completes.

**Captures.** Code refs, `source:` evidence, checkpoints and arrivals read the
user's files through a capture of the checkout. Leave `capture` empty: the
redcrayon plugin fills it in before each call runs.
- A call stopped by a line that starts with `redcrayon: ` comes from the plugin,
  before the call ran (an ignored or secret file, a binary or large file, not a
  git checkout, no network). Do what the line says, such as cite another file.
- `REJECTED: <tool> needs a capture of your local file. …` (or `… of your local
  checkout`) means nothing filled the capture in: the plugin is not installed, or
  Node 20+ is missing. Run the `npx -y @redcrayonai/draw@1 capture …` command the text
  names, in the project, and call again with `capture` set to the `cap_…` id it
  prints. If the command fails, tell the user its line and go on drawing without
  refs.
- A capture works once, within 10 minutes. On `capture cap_… expired or was
  already used`, or a text that names another capture command (a checkpoint that
  needs `--also` files), run that command and pass the new id. Run no other
  redcrayon command.

## 3. Editorial rules

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

## 4. Draw — at every checkpoint, in this order

**Send independent calls together.** Every message you send is a wait for the
user, and the board fills in as each call lands. Put the calls of a step that do
not need each other's results in one message: every `create_node` of step 2
together, then every `create_edge` and `add_code_ref` of steps 3 and 4 together
(they need the node ids step 2 returned). Never send one write per message when
several are ready. Each call in a batch succeeds or fails on its own: act on a
`REJECTED` result and send that call again alone.

1. `get_board`. Humans may have moved things; never trust positions you remember.
   Each node's and edge's `refs` carry a `status` — `ok`, `stale`, or `ambiguous`
   — so you can see which refs need replacing (`remove_code_ref`, then
   `add_code_ref`) before you checkpoint.
2. **Nodes** — one per component you built or materially changed, plus the
   neighbours it calls or is called by. Pass `doc`: one or two present-tense
   sentences, *what this is and why it exists*. Revise with `set_node_doc` when
   the why changes.
3. **Edges** — one per flow you can cite. `label` is a verb phrase
   (`validates path`, `subscribes`); `evidence` is `source:<path>:<line>` for the
   call site you read.
4. **Code refs** — `add_code_ref` for **every symbol you wrote or materially
   changed** that is not on the board yet (step 1's `get_board` lists each
   node's refs; do not add them again at every checkpoint), on the node that
   owns it — and only for those: a ref on a symbol
   whose lines this session did not touch (a neighbour's declaration) is a
   misattribution; neighbours get a `doc`, not a ref. Do not put refs on edges:
   the edge's `evidence` already cites its call site. Set `author` to your
   subagent name if you are one; otherwise omit it.
5. **Layout** — `layout_board` once, after the nodes and edges of this pass
   exist, and only if this pass added nodes or edges. Skip it when step 1's
   `get_board` shows positions you did not leave (a human moved things), and say
   so in your final answer.

**Naming TypeScript/JavaScript symbols** (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`)
— never pass `startLine`/`endLine` in these files (the server rejects a range
there); the server resolves the name:
- top-level `function`, `class`, `interface`, `type`, `enum` and `namespace` by
  bare name: `renderInspector`, `RenderState`;
- class and interface members as `Class.member` (methods, properties,
  constructor): `Editor.toggleCodeOverlay`, `ManagedConnection.call`. A getter
  and setter pair is one ref, `Class.prop`;
- enum members as `Enum.member`, namespace members as `NS.member`, the default
  export as `default` and its members as `default.member`, and CommonJS
  `exports.x`, `module.exports` and `module.exports.member`;
- `const x = …` (destructured names too) by bare name — the ref spans the whole
  statement: `addCodeRef`;
- overload signatures resolve together with their implementation, as one ref.
  Same-named declarations of different shapes are one ref too: a `const` and a
  `type`, a class and an interface, a function and a namespace, a static and an
  instance member;
- the range excludes leading JSDoc; an exact top-level match beats a same-named
  member;
- **in these files, name only a declaration.** Every checkpoint re-finds each
  TS/JS ref by its `symbol` name when its file changed, so a ref named after a
  call site, a test case, a nested function, a method of an object literal held
  in a variable, or a local variable cannot hold. Cite the enclosing declaration
  that contains the change.
  Code outside every declaration — a top-level call such as
  `server.registerTool(…)`, an import, an export list — has no name at all:
  `exclude` its file at checkpoint with a reason. Test cases (`it(…)` blocks)
  have no declaration: ref a test helper you changed, or, when a test file's
  diff is only test cases, `exclude` that file at checkpoint with the reason
  `test cases (it blocks have no symbol)`.
- for every non-TypeScript file (`.svelte`, `.go`, `.md`, `.css`, …) pass
  `startLine`/`endLine` — 1-based, inclusive. A snippet holds at most 60 lines
  and 4000 characters. A longer range is clamped from the start: the server
  keeps `startLine` and moves `endLine` up until both limits hold. A single line
  longer than 4000 characters is rejected.

The server checks the symbol's **needle** against the snippet: the last dotted
segment of `symbol` (`allow` for `Limiter.allow`), or the whole symbol when it has
no dot. A member ref points at the member's own lines, which never spell the class
name — that is why the needle, not the full `Class.member`, must appear.

Read the result:
- `committed id=<n> <path>:<start>-<end> board=<name>` — the range the server
  resolved (a trailing `(clamped from <end>)` means the range hit the 60-line cap
  or the 4000-character cap, and `<end>` is the line you asked for). If it is not
  what you meant, `remove_code_ref` with `refId` set to that `id`, then
  `add_code_ref` the ref you meant. **Replace, never pile up:** a wrong ref left
  next to a right one is a false claim on the board.
- `already attached id=<n> <path>:<start>-<end> board=<name>` — that symbol is
  already on that node or edge; nothing new was written. Keep it, or replace it
  as above if its range is wrong. When the existing ref is not `ok`, the text
  adds `status=<stale|ambiguous> (remove_code_ref then add_code_ref under the
  current name)`: do that.
- `moved id=<n> <path>:<start>-<end> board=<name>` — you added a non-TypeScript
  ref again with other lines, and the server moved the existing ref there (same
  id, status `ok`).
- `REJECTED: ambiguous: '<symbol>' matches N declarations in <path>: …` — two or
  more declarations share that exact name, so no more specific name exists. The
  text ends with the remedy: `cite the enclosing '<Class>' instead` for repeated
  members, `cite their members (<symbol>.member) instead` for repeated blocks
  such as two `interface` declarations, or `exclude <path> at mark_checkpoint with
  a reason` when nothing encloses them (a JavaScript redeclaration). Do what it
  says.
- `REJECTED: not found: …` — no declaration has that name. Use one of its
  `did you mean` suggestions, or name the enclosing declaration. When the text
  says the code is outside every addressable declaration, exclude the file at
  checkpoint with a reason.
- `REJECTED: startLine/endLine are not accepted for <ext> files: …` — you passed
  a range in a TypeScript/JavaScript file. The text names the declaration that
  encloses those lines, or each declaration they touch: cite it by name and
  omit the range. Lines that no declaration reaches cannot be cited: exclude the
  file at checkpoint with a reason.
- `REJECTED: <path> does not parse (…)` means the file is mid-edit; finish the
  edit first, then add the ref by name.
- `REJECTED: '<ext>' files are not resolvable` — pass `startLine` and `endLine`.
- `REJECTED: symbol '…' does not occur in <path>:<start>-<end>` — the needle is
  not in that range; name the declaration that lives there, or (in a file that
  is not TypeScript/JavaScript) fix the range.
- `REJECTED: path '<path>' is not citable: …` — git ignores the file, or it is not
  a regular file. Do not cite it.

`create_node` and `create_edge` answer `committed id=<n> board=<name>`. Keep a
short id map in your working notes so refs land on the right node. If a whole
node is a mistake, `delete_node` it (its refs cascade) — it is your session board.

### Flag migrations and other risky changes

When you write a schema migration, drop or rename a column, delete data or break
an API, call `add_change_note` so the reviewer sees it on the board:

1. `add_code_ref` the migration file, then search the code for the changed
   column and `add_code_ref` every reader you find.
2. `add_change_note` with `anchorId` = the datastore node, `refId` = the
   migration ref, `steps` (line ranges inside it; mark the step that cannot be
   undone `irreversible`), `schema` (the table after the change), `subjects`
   (`{ table, column }`, plus `aliases` for ORM names) and `readers`.

Each reader's ref must contain the column or an alias, or the call is refused.
At each checkpoint, `changeNotes.staleReaders` lists readers that still read a
changed column: fix them. If the migration ref goes stale, `add_code_ref` the
migration again under another symbol, `update_change_note` with that `refId`,
then `remove_code_ref` the old one (a note's main ref cannot be removed while it
is in use). An additive migration that needs no note can go in `exclude`. Keep
notes for changes a reviewer must not miss; one per migration.

### Flag a vulnerable or compromised service

When a SIEM alert names a service on the board, call `add_threat` with
`anchorId` = that node and `stage: "compromised"`. For a scanner finding
(Trivy, Grype) use `stage: "vulnerable"`, and only for critical or high CVEs
that have a fix or are on the KEV list, at most 10 per node. One call is one
CVE or alert: `title` the CVE id, `severity` in lower-case (map `UNKNOWN` to
`low`), plus `cvss`, `package`, `fixedIn`, `flags` and `source` when you have
them. `update_threat` can raise a stage to compromised, never lower it; use
`remove_threat` for a wrong finding. The board then shows the blast radius.

## 5. Checkpoint

Call `mark_checkpoint` with `board`:
- immediately **before every `git commit`**;
- immediately **before your final answer**;
- whenever **more than eight files** have changed since the last checkpoint
  (`git status --porcelain` lists more than eight lines).

Draw first (Section 4), then checkpoint. Pass `exclude` groups for changed files
that are not yours to draw, each with a reason a stranger understands:

```json
{ "exclude": [
  { "reason": "generated bindings", "glob": "**/module_bindings/**" },
  { "reason": "lockfiles", "glob": "**/pnpm-lock.yaml" }
] }
```

The result is `{ board, checkpoint, headSha, coverage: { changed, uncovered,
excluded, deleted }, reanchor: { shifted, drifted, stale, ambiguous, restored },
citedPaths, notes? }`. Read it (`citedPaths` is for the plugin; nothing to do).
`coverage.uncovered` is the debt chip: if it names files you
materially changed, draw them or exclude them with a reason, then checkpoint
again. A changed file is covered when an `ok` ref on the board intersects one of
its diff hunks; any `ok` ref on an untracked file covers it. Only an `ok` ref
covers: stale and ambiguous refs never cover. An `exclude` group takes only
files that no ref covers. A file renamed since the session started counts as
deleted under its old path and changed under its new one. `notes` is optional
and appears only when git could not compare or diff a file in full (too large,
too slow). Each entry names the file, the reason, and what that meant:
`<path>: <reason>; counted as changed`, or, for a diff git could not print,
`<path>: <reason>; its changed lines are unknown, so it counts as uncovered`.
A ref cannot cover a file whose changed lines are unknown: exclude it with a
reason, or leave it uncovered and name it in your final answer.

**Re-anchoring** runs inside every checkpoint, before coverage, for every ref
whose file changed since it was captured.

TypeScript/JavaScript refs are found again by `symbol` name:
- found once with the same text → `shifted` (lines moved; nothing for you to do);
- found once with different text → `drifted` (the ref now describes the current
  code and carries the new checkpoint number; nothing to do);
- found more than once → `status: ambiguous`, unless exactly one of the matches
  still holds the captured snippet exactly: then that match is the ref, and it
  counts as `shifted`;
- not found, **the file deleted**, or a new range too long for a snippet →
  `status: stale`, last known lines kept;
- a file with a parse error (mid-edit) is left exactly as it is and re-anchored
  at the next checkpoint.

Refs in other files follow their captured lines: the server looks for the
snippet as one exact block. Found exactly once → `shifted` to the new lines.
Edited, gone, deleted, or found more than once → `status: stale`.

A ref reported `stale` or `ambiguous` at an earlier checkpoint that holds again
(its file or symbol came back) is `ok` again and listed in `reanchor.restored`:
nothing to do, and do not remove it.

`reanchor.stale` and `reanchor.ambiguous` list the refs you must fix, each as
`<symbol> <path> id=<n>`: for each, `remove_code_ref` with `refId` set to that
`id`, then `add_code_ref` under the name that resolves now (follow the rejection
text if the name is ambiguous; a range only for non-TypeScript files), then
checkpoint again. Never leave a `stale` or `ambiguous` ref on the board at the
end. If the file really is gone, remove the ref and, if the node no longer exists
in the code, delete the node.

**The final `mark_checkpoint` is your last write.** The board shows the coverage
stored at the *last checkpoint*, so any board edit, ref, or file edit after it
leaves the board's ledger wrong.
Order at the end: finish editing files → draw → `layout_board` (only if this
pass added nodes or edges and no human moved things) → clear the selection
(Section 7) → `mark_checkpoint` → answer. Never let the final answer go out with a checkpoint
older than your last edit.

## 6. Subagents

Subagents use the same redcrayon tools and this board. They **never** call
`start_session`, `mark_checkpoint`, `plan_route`, `arrive`, `reroute`, or
`layout_board`. They never create, move, hide, or delete nodes or edges. They
only attach refs (and remove their own wrong ones). Put this paragraph, filled in (the prefix,
the board id, the node), in every delegation:

> **Board contribution.** A redcrayon board is already open for this session; do
> not start, checkpoint, plan, arrive, reroute, or lay out one. When you finish a
> symbol, call
> `<prefix>add_code_ref` with `board: "<id>"`, `targetKind: "node"`,
> `targetId: "<node id>"` (<label>), `path`, `symbol` (`Class.member` or a
> top-level name; a range only for non-TypeScript files), and
> `author: "<your name>"`. Leave `capture` empty; if the answer names an
> `npx -y @redcrayonai/draw@1 capture …` command, run it in the project and call again
> with `capture` set to the id it prints. If the committed range is not
> the symbol you meant, call `<prefix>remove_code_ref` with `board` and `refId`
> set to that id and add the right one. On `UNCONFIRMED: …`, call
> `<prefix>get_board` and retry only if your ref is missing. Report every
> `committed id=…` line back to me.

When you add a ref on a subagent's behalf, set `author` to its name too, so the
board tells the truth about who wrote what.

## 7. Focus

Successful `create_node`, `update_node`, `create_chart`, `set_chart_data`, and node-targeted `add_code_ref` writes
automatically select the node for an agent. A moved ref range also selects its
node. Rejected writes and unchanged ref retries do not move focus. Edges and
checkpoint ref refreshes do not move focus. Human selection stays under human
control.

For inspection or an explicit focus change, call `set_selection` with
`{ "board": "<id>", "nodeIds": ["<node id>"] }`. This selection lasts until the
next successful node write or arrival. The canvas shows a dashed selection, and
the rail shows `agent on <node>`. Clear it with `"nodeIds": []` right before your
final `mark_checkpoint`, so the checkpoint stays the last write.

## 8. Optional session route

Routes are optional. When ordered milestones help the reader follow the task,
use a route. Node writes change focus, but route progress remains unchanged.
Only `arrive` advances the route. Evidence edges remain independent of route
order. Do not encode routes in labels, notes, tokens, or focal flags.

1. Create the waypoint nodes on the session board.
2. Call `plan_route` with `{ "board": "<id>", "nodeIds": ["<first>", "<next>", "<destination>"] }`.
   Use unique node IDs in the intended order. The final node is the destination.
   Every waypoint starts as `pending`.
3. Before each arrival, draw the completed work and attach its code refs (Section 4).
4. Call `arrive` with `{ "board": "<id>", "nodeId": "<next-pending-id>" }`.
   Pass optional `exclude` groups with `{ "reason": "…", "glob": "…" }`, as for
   `mark_checkpoint`. An arrival runs a checkpoint, so it takes a capture like
   `mark_checkpoint` (Section 2).
5. Read the returned checkpoint and coverage (Section 5).
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

## 9. Optional: latency and request flow

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

1. Draw the nodes the request touches first (Section 4). Map each service or
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

### Live traffic while the user runs the app

When the user wants to watch traffic move while they run their app locally, use the live tap instead of refreshing numbers yourself:

1. Draw each service the app runs as a node, with edges for the calls between them.
2. Call `start_tap` with `{ "board": "<id>" }`. It returns a token and the command to run.
3. Write `.redcrayon/tap.json` in the project root: `{ "board": "<id>", "services": { "<service.name>": "<node id>" } }`, one entry per OpenTelemetry service name.
4. Run the command `start_tap` returned, in the background, from the project root. It needs Node 22.
5. Tell the user to point their exporter at `http://127.0.0.1:4318` with `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, and to switch on **live traffic** on the board.

The tap drops span attributes on the user's machine and sends only per-edge rates, latencies and errors, and only while someone watches. It prints unmapped service names once a minute: add them to the file, which it rereads. The token lasts 12 hours.

## 10. Finishing

After the last checkpoint, the final answer carries: the board URL, the checkpoint
number, and one line per debt you chose to leave
(`uncovered: client/src/style.css — CSS only, nothing to cite`). Do not paste
snippets or node lists into the answer — the board has them. Do not touch the
board or the tree after that checkpoint.
