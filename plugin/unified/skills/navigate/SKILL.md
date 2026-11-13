---
name: navigate
description: Create or update a Draw board, diagram a repository or flow, continue from board feedback, reconnect board chat, or investigate an incident on a Draw board. Use local boards by default; use hosted boards when explicitly requested or linked.
---

# Draw with this conversation

This is the single Draw entry point. Natural requests such as "create a draw
board" use this skill; `/draw:navigate` is optional. Choose the board's backend
before calling tools, then read only the relevant workflow below.

## Choose the board

1. **An existing board comes first.** Keep a supplied link intact, including its
   credential fragment. Continue on the active board when the user asks to
   continue, reconnect, or respond to its feedback. Preserve its backend and
   identity; never copy it to another backend or create a replacement silently.
2. **For a supplied link**, use the known board's backend when available.
   Otherwise parse its URL hostname: `localhost`, IPv4 loopback (`127.0.0.0/8`),
   and IPv6 loopback (`::1`) select local; a non-loopback board link selects
   hosted. Do not match hostnames by substring. If a link conflicts with an
   explicit backend request, clarify before opening or changing a board.
3. **For a new board**, choose hosted only when the user explicitly asks for a
   hosted or remote board. Otherwise choose local, including a bare board name,
   "create a draw board", or "draw this repo". Merely having hosted tools or an
   authenticated account does not select hosted. A request to share a local
   board does not authorize uploading it.

Use only the selected server for board operations. Local tools come from the
`draw-local` MCP server (`open_board`, `read_board`, `apply_board`); hosted tools
come from `draw` (`start_session`, `get_board`, `create_node`). Installed tool
prefixes can vary: discover the server and its tools instead of guessing a
prefix. Never send local slugs to hosted tools or hosted IDs to local tools.

If the selected server is missing, denied, or fails to open the requested board,
report the failure and follow its workflow's recovery steps. Never silently
fall back to the other backend. Local boards need no sign-in. Hosted sign-in
uses the agent's existing Draw MCP connection and OAuth controls; do not invent
a `draw login` command or ask for credentials in chat.

## Read the selected workflow

All paths below are relative to this `SKILL.md`.

| Selected task | Read |
|---|---|
| Local board, local feedback, or local conversation attachment | [Local workflow](references/local.md) |
| Hosted board creation or drawing | [Hosted workflow](references/hosted.md) |
| Hosted conversation reconnect or handoff | [Hosted handoff](references/handoff.md) |
| Hosted incident or alert investigation | [Hosted triage](references/triage.md) |

For a local incident, use the local workflow and its available nodes and notes.
Hosted incident tools are not available locally; explain the limitation if the
requested operation requires them. Do not switch backends to obtain a feature.

The local workflow's helper lookup (`../../mcp.json`) is relative to the
directory containing **this main `SKILL.md`**, not `references/local.md`.
Supporting links inside the hosted references are relative to their own files.
Treat workflow references as instructions for the selected backend only; this
entry point governs routing and preserves the user's existing board.

## Respect access choices

Local and hosted permission choices are separate. Respect denied tools, source
reads, captures, uploads, and conversation attachment. Do not bypass a denial
through another server, a terminal command, or a browser. The user can review
their policy with `draw permissions codex --mode local` or `--mode hosted`, then
restart Codex. Do not change their choices for them.

Board and chat choices are Ask/Allow; source reads and uploads are Ask/Deny.
Allow skips routine tool prompts; Ask uses the agent's approval controls. If Draw opens a browser approval page,
only the human may choose **Allow once**; never submit or approve it
programmatically. Opening a board does not authorize attaching a conversation
or uploading source files. Follow the selected workflow's explicit attachment
steps, keep the same conversation, and verify the connection before saying
board chat is ready.
