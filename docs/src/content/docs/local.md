---
title: Local boards
description: Keep boards on your machine, with no account and no server to run.
---

A local board lives in a folder on your machine. Draw serves it from one
process on your computer. You need no account, database or container. Your
agent and your browser edit the same board.

Draw runs on macOS and Linux (glibc), on arm64 and x64. You need git and one
of Claude Code, Codex or pi.

## Install

```sh
npm install -g @redcrayonai/draw
# Or:
bun install -g @redcrayonai/draw
```

Keep optional dependencies on: the installer picks the package for your
platform. After that, Draw needs no Node or Bun. Then install the plugin for
your agent and restart the agent:

```sh
draw install claude-code
# Or:
draw install codex
draw install pi
```

This is the same plugin that draws on [hosted boards](/connect/). It turns off
older Draw plugins it finds and keeps their settings and sign-in.

## Open a board

In your repository, ask your agent:

```text
Create a draw board for this repo.
```

`/draw:navigate` does the same. The agent starts the local server if needed,
opens a board and posts a private link. You can also run `draw` in the
repository to open the browser yourself; `draw --no-open` only prints the link.

| You ask for | You get |
|---|---|
| A new board, with no other detail | A local board |
| A **hosted** board | A board on your account. Sign in through your agent when asked |
| A board link | That board, where it already lives |

Draw never moves a board between the two, and never uploads a local board
because you asked to share it.

## Draw and review

Pick a node kind in the bottom toolbar and click the canvas to place it. Drag
to move. Shift-click two nodes and choose **Connect selected**. Ctrl/Cmd-Z
undoes the last 30 edits of this browser session.

Attach code references in the inspector, and click one to read the source from
your checkout. Open **Review**, select a node or edge, and leave a note. The
agent replies to the note and resolves it.

Open **Conversation** to send a message to the agent session that drew the
board, or to stop it. Draw never starts a second agent. A message shows as
saved, pending, delivered, uncertain or answered. Draw does not send an
uncertain message again; check your terminal first.

| Agent | How the board reaches your session |
|---|---|
| Claude Code | Session hooks. Approvals stay in the terminal |
| Codex | The shared app server of that conversation. You can answer command and file approvals from the board |
| pi | An extension in the current session |

## Codex permissions

`draw install codex` shows one summary for local and hosted boards. Board edits
and chat start as **Allow**. Reading source and uploading it to a hosted board
start as **Deny**. To change your choices later:

```sh
draw permissions codex
```

Restart Codex after a change.

## Where boards are kept

Boards, references, notes and replies are in
`~/.redcrayon/local/<hash of the repository path>/boards.json`. Draw writes
the file atomically. A board holds at most 2 MiB and a store 32 MiB. Stop the
server before you back the folder up.

Local Draw does not upload your source. The link the server prints carries a
credential, so treat it as private. Your agent still sends what it reads to its
own model provider.

## Update

```sh
draw update --check
draw update
```

An update does not restart running boards or agents. When Draw says the plugin
files are stale, run `draw install <agent>` again. Set
`DRAW_NO_UPDATE_CHECK=1` to stop the daily check.

## What local boards leave out

Sharing links, workspaces, the dashboard, charts, incidents, threats, branches
and walk-throughs need a hosted board or [your own server](/self-host/quickstart/).

[Connect your agent](/connect/) · [Your data and code consent](/data-and-consent/)
