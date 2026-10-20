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

## What leaves your machine

Drawing sends what the agent draws: nodes, edges and labels. Code refs and
checkpoints also send a capture of your checkout:

- At the start: the checkout's absolute path and its HEAD commit.
- For each code ref or cited line: that one file. draw keeps the cited
  lines, the path and the git hash, and deletes the file within 10 minutes.
- At a checkpoint: the base and HEAD commits, the changed and deleted paths,
  the line numbers of each change (numbers only, no diff text), and every file
  the board cites.

It never uploads your file list, uncited files, diff text, files git ignores, or
secrets such as `.env` and key files. The full list is in the
[plugin README](https://github.com/redcrayonai/draw/blob/main/plugin/README.md#what-leaves-your-machine).

## Your own server

To point the Claude Code plugin at a server you run
([Self-host quickstart](/self-host/quickstart/)), start Claude Code with:

```sh
REDCRAYON_MCP_URL=http://localhost:8788/mcp claude
```

Other clients take that URL in place of the hosted one.
