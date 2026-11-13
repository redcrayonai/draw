---
title: Connect your agent
description: Install Draw for Claude Code, Codex or pi, or connect another MCP client.
---

**Server URL**

```text
https://mcp.redcrayon.ai/mcp
```

Every client signs in once, in the browser. Your agent then shows on the board
as `agent of <your name>`, and the boards it draws are yours.

## One install for Claude Code, Codex and pi

On macOS and Linux, one command installs Draw and one more adds the plugin to
your agent:

```sh
npm install -g @redcrayonai/draw
draw install claude-code   # or: draw install codex, draw install pi
```

Restart the agent. The plugin includes drawing skills, automatic code refs and
board chat, and it needs no Node. It draws [local boards](/local/) unless you
ask for a hosted one, so start with:

```text
Open a hosted Draw board for this task and draw what you build on it as you go.
```

Sign in when your agent asks: in Claude Code, `/mcp`, choose **draw**, then
**Authenticate**. A board link you paste opens that board where it lives.

Do not also install from the marketplace below. `draw install` turns off an
older Draw plugin and keeps its settings and sign-in. On Windows, or to use
hosted boards only, use the marketplace plugin.

## Claude Code

The marketplace plugin includes the server connection, drawing skills, automatic code refs,
and private board chat. Inside
Claude Code you can also run `/plugin marketplace add redcrayonai/draw`, then
`/plugin install draw@redcrayonai`.

```sh
claude plugin marketplace add redcrayonai/draw && claude plugin install draw@redcrayonai
```

1. Start a new Claude Code session in your project, run `/mcp`, choose **draw**, then
   **Authenticate**. Approve in the browser tab that opens.
2. Run `/draw:navigate`. The agent opens a board named after your branch
   and posts its link. `/draw:navigate <board link>` draws on a board you
   already have.
3. Open the board link to continue the same conversation in private chat.
   Chat connects automatically; `/draw:handoff` reconnects it when needed.

Code refs and checkpoints need git and Node 20 or later on your PATH. Without
Node, drawing still works. Board chat needs Node 22+ and a Claude Code version
that supports `MessageDisplay` and `asyncRewake` hooks.

## Cursor

Add the server to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "draw": { "url": "https://mcp.redcrayon.ai/mcp" }
  }
}
```

In **Cursor Settings → MCP**, click the login button next to draw and
approve in the browser.

## Codex

Install the marketplace plugin to get drawing skills, automatic code refs, and board chat
support together. Use a Codex version with plugin support:

```sh
codex plugin marketplace add redcrayonai/draw && codex plugin add draw@redcrayonai
```

After adding the marketplace, you can also open `/plugins` and install Draw there.
Start a **new Codex session** in your project. When Draw asks you to connect,
approve in the browser with the account you use for your boards. Then ask:

```text
Open a Draw board for this task and draw what you build on it as you go.
```

Open the board link. Private chat needs Node 22+ and an accessible shared
Codex app-server connection to the same conversation. Installing the plugin
alone does not make every Codex session available to board chat. If chat cannot
attach, keep chatting in Codex; the board tools still work. Draw never starts
a second agent conversation to replace yours.

### MCP-only connection

If your client does not support plugins, add the server directly:

```sh
codex mcp add draw --url https://mcp.redcrayon.ai/mcp
codex mcp login draw
```

This provides drawing tools without the plugin's skills, automatic code-ref
hooks, or board-chat connection. If you already use this setup, remove the
manual entry with `codex mcp remove draw` when switching to the plugin, so Draw
is not listed twice.

## Chat beside your board

The spark button opens the board's one chat panel. Chat is private to the
person linked to the agent; sharing a board does not share control of that
agent. Select a node or edge to attach it to your message.

When no agent is connected, the panel offers **Copy prompt for agent**. Paste
it into your coding agent to connect chat to the board on screen. In Claude
Code, `/draw:handoff` with no argument reconnects the last board shared in
that conversation.

**End chat** disconnects your agent from the board. The agent carries on in its
own conversation, and you can reconnect later.

If your workspace turned on a plugin with an agent, that agent uses the same
panel. Your own agent comes first; the plugin's agent answers when yours is not
connected.

With chat open, the pencil **Draw** button temporarily reveals the drawing tools.
**Back to chat** restores your conversation and unfinished message. Sending
red-crayon marks returns to connected chat and adds a receipt. If a review watcher
is already listening, chat does not send a second review request.

You do not need a `start.command` launcher for the released plugin. That launcher
is only used to test local development builds. Codex's shared-session requirement
still applies.

## claude.ai

**Customize → Connectors → Add custom connector.** Name it draw, paste the
server URL, then click **Connect**. claude.ai draws from the conversation; code
refs need a coding agent in your project.

## Other clients

Any MCP client with remote servers and sign-in works: give it the server URL.
VS Code uses `"servers"` and `"type": "http"`.

## Existing connections

When switching from a manual MCP connection to the plugin, remove the old
Draw server entry first so your agent does not see duplicate tools. In Claude
Code, use `/mcp` to find the manual entry; in Codex, use `codex mcp remove draw`.
Then install the plugin and start a new session.

If you connected before the rename, your `redcrayon` connection still works.
To rename it to `draw`, remove that server entry in your client, add it again
with the name above, and sign in again.

## The prompt

Outside Claude Code, start with:

```text
Open a Draw board for this task and draw what you build on it as you go.
```

## Code refs outside Claude Code

The Claude Code, Codex and pi plugins capture code refs through hooks. With an
MCP-only connection, when a tool needs a capture of your checkout, it tells the agent the exact
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

To enable inline snippets, open dashboard **Account settings → Code → Store code snippets
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

To point either plugin at a server you run
([Self-host quickstart](/self-host/quickstart/)), set the server URL when starting your agent (macOS or Linux):

```sh
REDCRAYON_MCP_URL=http://localhost:8788/mcp claude
# Or, for Codex:
REDCRAYON_MCP_URL=http://localhost:8788/mcp codex
```

Other clients take that URL in place of the hosted one.
