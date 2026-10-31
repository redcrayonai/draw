---
name: navigate
description: Use when the user types /draw:navigate [session-name | board link], or asks to open a live board, diagram, or whiteboard for the current task.
argument-hint: [session-name | board link]
allowed-tools: mcp__draw__*, mcp__plugin_draw_draw__*, Bash(git:*), Read
---

# redcrayon — draw what you build

You are working a task in this repo. While you work, you keep a live architecture
board of the task current, so the user reads the board instead of a prose summary.
The board is a claim about the code, and every claim on it is something the server
can check: every edge cites a line you read, every code ref is a snippet the server
read from the user's files, and every changed file you did not draw is a number on
the chrome.

You draw, the user reads. Feedback comes back through chat, or as red crayon marks
when the user asks for a review ([marks.md](../../references/marks.md)).

**Tool names.** The draw tools carry a prefix: `mcp__plugin_draw_draw__`
when the draw plugin provides the server, `mcp__draw__` when the user added
it by hand, or another prefix chosen for the server. This skill names each tool
without its prefix (`start_session`). Use one prefix for the whole session.

**`board` on every call.** Every tool except `start_session` and `describe_charts`
takes `board`: the `id` that `start_session` returned, as a string of digits
(`"42"`). Pass it on every call, yours and your subagents'.

## Preflight — before anything else

Look for `start_session` and `get_board` under the configured server's prefix in
your tool list. If they are not there, say exactly
`The draw server is not connected. Run /mcp, choose draw, and sign in.`
and stop. Never carry on without a board and never pretend one exists.

## Start

Open the board first, before you read code or plan the task. Read the **first word** of `$ARGUMENTS`. Everything after the first space is the
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

Leave `capture` empty ([results.md](../../references/results.md), Captures).

If `start_session` is rejected, act on the sentence ([results.md](../../references/results.md)) and call it
again; if you cannot fix the cause, tell the user the rejection verbatim and
stop. Every other tool needs the `id`, so **never call `create_node`,
`create_edge`, `add_code_ref` or any other board write before `start_session`
has returned a `url`.**

The result is `{ board, id, url, seat, session, checkpoint?, repoRoot?, baseSha?, note?, dashboard?, dashboardNote? }`.
When `dashboard` and `dashboardNote` are present, relay both to the user verbatim
in your next message. This link lets them pair the agent with the browser that
opens the canvas; a newer `start_session` replaces it.
Relay `url` **once, verbatim, in your very next message** — that link is how the
user finds the board. Send it as text on its own, before any other tool call: no
file reads, no `get_board`, no `create_node` until the user has the link. If
`note` is present, relay it once in that same message:
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
`create_node` with a `doc` ([editorial.md](../../references/editorial.md)) per component, all in one message. Then
keep the board current as you work, and redraw at every checkpoint.

## Modules

Each module is a reference file. Read a module with `Read` the first time its
step comes up in the session, and follow it as part of this skill.

| When | Read |
|---|---|
| A tool result starts with `REJECTED`, `UNAVAILABLE` or `UNCONFIRMED`, or asks for a capture | [results.md](../../references/results.md) |
| Before your first `create_node` | [editorial.md](../../references/editorial.md) |
| Each time you draw: nodes, edges, code refs, change notes, threats | [draw.md](../../references/draw.md) |
| Before every `mark_checkpoint` | [checkpoint.md](../../references/checkpoint.md) |
| Before you delegate to a subagent | [subagents.md](../../references/subagents.md) |
| Before `set_selection`, and before the final checkpoint | [focus.md](../../references/focus.md) |
| When ordered milestones help the reader (optional) | [route.md](../../references/route.md) |
| When the user asks how a request flows or where time goes (optional) | [latency.md](../../references/latency.md) |
| When the user asks you to propose a change as a branch (optional) | [branch.md](../../references/branch.md) |
| After you draw the board: red crayon marks | [marks.md](../../references/marks.md) |

## Finishing

Read [checkpoint.md](../../references/checkpoint.md) before you finish.
After the last checkpoint, the final answer carries: the board URL, the checkpoint
number, and one line per debt you chose to leave
(`uncovered: client/src/style.css — CSS only, nothing to cite`). Do not paste
snippets or node lists into the answer — the board has them. Do not touch the
board or the tree after that checkpoint.
