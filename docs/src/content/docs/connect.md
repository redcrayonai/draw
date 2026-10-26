---
title: Connect your agent
description: Add the draw MCP server to Claude Code, Cursor, Codex, claude.ai or any MCP client.
---

**Server URL:** `https://mcp.redcrayon.ai/mcp`

Every client signs in once, in the browser. Your agent then shows on the board
as `agent of <your name>`, and the boards it draws are yours.

## Claude Code

The plugin adds the server, the `/draw:navigate` command and code refs. Inside
Claude Code you can also run `/plugin marketplace add redcrayonai/draw`, then
`/plugin install draw@redcrayonai`.

```sh
claude plugin marketplace add redcrayonai/draw && claude plugin install draw@redcrayonai
```

1. Start Claude Code in your project, run `/mcp`, choose **redcrayon**, then
   **Authenticate**. Approve in the browser tab that opens.
2. Run `/draw:navigate`. The agent opens a board named after your branch
   and posts its link. `/draw:navigate <board link>` draws on a board you
   already have.

Code refs and checkpoints need git and Node 20 or later on your PATH. Without
Node, drawing still works.

## Cursor

Add the server to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "redcrayon": { "url": "https://mcp.redcrayon.ai/mcp" }
  }
}
```

In **Cursor Settings → MCP**, click the login button next to redcrayon and
approve in the browser.

## Codex

```sh
codex mcp add redcrayon --url https://mcp.redcrayon.ai/mcp
codex mcp login redcrayon
```

## claude.ai

**Customize → Connectors → Add custom connector.** Name it redcrayon, paste the
server URL, then click **Connect**. claude.ai draws from the conversation; code
refs need a coding agent in your project.

## Other clients

Any MCP client with remote servers and sign-in works: give it the server URL.
VS Code uses `"servers"` and `"type": "http"`.

## The prompt

Outside Claude Code, start with:

```text
Open a redcrayon board for this task and draw what you build on it as you go.
```

## Code refs outside Claude Code

When a tool needs a capture of your checkout, it tells the agent the exact
command, and the agent runs it. Nothing to install; Node 20+ and git on your
PATH. To check your setup:

```sh
npx -y @redcrayonai/draw@1 doctor
```

## Code storage is your choice

Code snippet storage is **off by default**. A code ref keeps paths, symbols,
line numbers and hashes without code text. For pushed GitHub code, readers can
open the source with their own repository access.

Code refs and checkpoints still upload each cited file temporarily so the server
can check it. The server reads it in memory. Captures expire within ten minutes
and cannot be read again after the call claims them.

To enable inline snippets, open dashboard **Settings → Code → Store code snippets
on my boards**. The next ref or checkpoint can then store code text. Disabling
this setting deletes stored snippets after a warning, without deleting ref metadata.

Sharing is a separate choice. View links exclude **Code** and **Threats** by
default. Edit links always include code refs, with snippet text only if the
owner consents to storage.

[Your data and code consent](/data-and-consent/) explains uploads, operator
access, deletion and backups. Hosted board data is not end-to-end encrypted.

## Try a first task

```text
Draw one request path through this repo. Cite each connection, post the board link, and listen for my red crayon marks.
```

Then [review with the red crayon](/use-cases/feedback/),
[investigate an incident](/use-cases/investigate/), or
[propose an architecture change](/use-cases/propose/).

## Your own server

To point the Claude Code plugin at a server you run
([Self-host quickstart](/self-host/quickstart/)), start Claude Code with:

```sh
REDCRAYON_MCP_URL=http://localhost:8788/mcp claude
```

Other clients take that URL in place of the hosted one.
