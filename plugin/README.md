# redcrayon

redcrayon draws what your coding agent builds on a live board: the components it
touched, the flows between them, each one citing a line the agent read, and code
refs that point into the exact symbols. You read the board instead of a prose
summary, and you find it again on your dashboard.

This plugin adds the draw server, drawing skills, code refs, and private board
chat. Claude Code and Codex connect their existing conversation automatically
when they open a board. Other agents can draw through the same server URL.

**Server URL:** `http://localhost:8788/mcp`

## Local boards without a server account

The hosted plugin below uses the hosted tool and sign-in flow. For standalone
repository boards, build and install the separate `draw-local` package described
in [Local Draw](../LOCAL_MODE.md#try-it-with-codex). It includes a local MCP bridge
and `$draw-local:local` skill, which starts Draw and connects the current Codex
conversation. The local and hosted packages can be installed alongside each other.

## Install

### Claude Code

1. Install the plugin:

   ```sh
   claude plugin marketplace add redcrayonai/draw && claude plugin install draw@redcrayonai
   ```

   Or, inside Claude Code, run `/plugin marketplace add redcrayonai/draw`,
   then `/plugin install draw@redcrayonai`.
2. Sign in: start Claude Code in your project, run `/mcp`, choose draw, then
   Authenticate. Approve in the browser tab that opens.
3. Start drawing: run `/draw:navigate`. Your agent opens a board named after
   your branch and posts its link. `/draw:navigate <name>` names the board;
   `/draw:navigate <board link>` draws on a board you already have.
   Open that link to continue the same conversation beside the diagram. Chat
   connects automatically; `/draw:handoff` is available for explicit reconnects.

   During an incident, `/draw:triage <board link>` works the board an alert
   opened: it charts measured evidence beside the hops it describes and leaves
   the suspects to you.

Code refs and checkpoints need git and Node 20 or later on your PATH. Board chat
needs Node 22 or later. Without Node, drawing still works. Automatic Claude Code
chat requires a version supporting `MessageDisplay` and `asyncRewake` hooks.

### Cursor

1. Add the server to `~/.cursor/mcp.json`, with the server URL above:

   ```json
   {
     "mcpServers": {
       "draw": {
         "url": "<server URL>"
       }
     }
   }
   ```

2. Sign in: in Cursor Settings → MCP, draw shows a login button. Click it
   and approve in the browser.
3. Give your agent the prompt below. For code refs the agent runs
   `npx -y @redcrayonai/draw@1 capture` in your project (git, Node 20+).

### Codex

Install the plugin with a Codex version that supports plugins:

```sh
codex plugin marketplace add redcrayonai/draw && codex plugin add draw@redcrayonai
```

After adding the marketplace, you can also install Draw from `/plugins`.
Start a new Codex session in your project. Connect Draw when prompted and
approve in the browser with the account you use for your boards. Ask it to
open a board using the prompt below.

For your own server, set `REDCRAYON_MCP_URL` to the server URL when starting
Codex, just as you would for Claude Code. No `start.command` launcher is needed
for the released plugin; that launcher is for local development testing.

If your client has no plugin support, use the MCP-only connection:

```sh
codex mcp add draw --url <server URL>
codex mcp login draw
```

This provides drawing tools without bundled skills, automatic code-ref hooks,
or board chat. When switching from MCP-only setup to the plugin, remove the
manual entry with `codex mcp remove draw` to avoid duplicate tools.

### Connected conversation

The Claude Code and Codex plugins connect board chat when `start_session` opens
a board. Open its link to continue the conversation. Board chat needs Node 22+.
MCP-only installation provides drawing, without automatic chat.
Codex chat attaches to the exact thread already loaded on its shared local
app server. Standalone sessions and host-managed sessions without that connection
remain available in their original interface; chat never starts a second agent.

- Select a node or edge, then ask about it or request a change.
- The pencil Draw button reveals drawing tools while chat is open. Back to chat
  restores your draft; sending marks returns to chat with a receipt. An active
  review watcher handles marks without a second chat request.
- Replies, work steps, and supported approvals appear in the board. Sensitive
  approvals stay in your agent; declining never grants permission.
- Stop requests cancellation and confirms it when the agent stops. Claude Code
  stops at the next hook and attempts to stop its current foreground shell;
  Codex uses its native turn interruption. Completed changes are not undone.
- Additional messages wait in a deletable queue. A failed delivery remains paused
  for review; it is never automatically replayed.
- Reconnection restores history. Drafts and attached selections survive board and
  conversation switches in the current tab. Sounds can be muted in the panel.
- Multiple conversations remain separate even in one checkout. The panel only
  asks you to choose when more than one conversation is available.

Chat is private to the person linked to the agent. Known secret patterns are
filtered locally before relay; this cannot identify every secret. History stays
on the agent's machine, not in board exports or shared board views. Chat credentials
expire after twelve hours; reconnecting through `start_session` or `start_chat`
refreshes them.

### claude.ai

1. In claude.ai: Customize → Connectors → Add custom connector. Name it draw
   and paste the server URL. On Team and Enterprise plans an owner adds it once
   for everyone.
2. Click Connect next to draw and approve in the tab that opens.
3. Give Claude the prompt below. claude.ai draws from the conversation. Code refs
   and checkpoints need a coding agent in your project.

### Other clients

Any MCP client with remote servers and sign-in works: give it the server URL, or
the Cursor JSON above. VS Code uses `"servers"` and `"type": "http"`. Your client
opens a browser to sign in the first time it connects.

### The prompt

```text
Open a Draw board for this task and draw what you build on it as you go.
```

## Sign-in

If you connected before the rename, your `redcrayon` connection still works.
To rename it to `draw`, remove that server entry in your client, add it again
with the name above, and sign in again.

Each client signs in once, in the browser, and stays signed in. Your agent shows
on the board as `agent of <your name>`. To sign a client out:

- Claude Code: `/mcp` → draw → clear authentication
- Codex: manage the plugin connection from `/plugins`. For MCP-only setup,
  use `codex mcp logout draw`.
- Cursor: Settings → MCP → log out
- claude.ai: Connectors → Disconnect

The next call after a sign-out asks you to sign in again. Your boards stay as
they are.

## What leaves your machine

To check code refs, redcrayon uploads each file your agent cites and deletes it within 10 minutes. It keeps paths, line numbers, git hashes, hashes of the cited lines and the GitHub repo address. It keeps the cited lines themselves only if you turn on storing code.

Drawing needs only the server URL: nodes, edges and their labels go to the
server as your agent writes them. Code refs, `source:` citations and checkpoints
need a capture of your checkout. The Claude Code and Codex plugins capture it
through hooks; in other clients the agent runs
`npx -y @redcrayonai/draw@1 capture …`. Each capture is one upload:

| kind | Uploads | Claimed by |
|---|---|---|
| start | The absolute path of the checkout; HEAD (the empty-tree hash in a repo with no commits); the object format; the GitHub remote, as `https://github.com/<owner>/<repo>` (owner and repo, no credentials; a remote that is not on GitHub is not sent) | `start_session` |
| ref | The above, plus one file: its path as git spells it, its bytes, git's blob hash, and whether git tracks it | `add_code_ref` |
| cite | The same, for the cited file | `create_edge` with `source:` evidence |
| checkpoint | The session's base commit, HEAD, the changed and deleted paths, the untracked paths git does not ignore, the line numbers of each change (numbers only, no diff text), the bytes and git hash of every file this board cites, the GitHub remote (owner and repo, no credentials), whether HEAD is pushed, and which cited files differ from HEAD | `mark_checkpoint`, `arrive` |

Never uploaded: the list of tracked files in your repo, files not cited on that board,
diff text, files git ignores, and files on the secret list.

Refused on your machine, with no network request: files git would not list
(ignored, under `.git/`, or in a nested repository); paths that match `.env*`,
`*.env`, `*.pem`, `*.key`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`,
`*.p12`, `*.pfx`, `.npmrc` or `.netrc`; symlinks that leave the repo; binary
files; files over 1 MB; checkpoint captures over 8 MB.

On the server, a capture can be claimed once, by the call it was made for, and
is deleted 10 minutes after upload. It is stored encrypted with a key derived
from its upload id, which is never stored, so nobody can read it once it is
claimed or expires. A cited file passes through the server's memory while the
call that claims it runs. File bytes are deleted when that call ends. The server
keeps paths (including the changed and deleted files the board does not cover),
line numbers, git hashes, a hash of each cited line, the GitHub repo address and
the checkout path. It keeps snippet text (at most 60 lines and 4,000 characters
each) and cited lines only when you turn on "Store code snippets on my boards"
in your dashboard settings. That setting is off by default. Every `source:`
citation's line is checked for secrets such as private keys and access tokens,
whether or not its text is kept, and a line with a secret is refused. Snippet
text is checked too, where it is stored, on boards with consent. A board without
consent stores only hashes for its code refs, so a code ref to a line that holds
a secret is accepted.

On your machine, the helper keeps two small files in `<git-common-dir>/redcrayon/`
(shared by your worktrees): `cited/<board id>`, the files a board cites, and
`boards.json`, the commit each board started from. It never changes
`git status`.

## Boards and links

Boards your agent opens are private to your account until you share them from your dashboard.

- Each branch gets its own board, named after the branch, for each checkout. A
  second checkout of the same branch gets `<branch> (2)`.
- Your agent posts the board's link once. Open it signed in to see the board
  live; your dashboard lists every board your agent opened.
- To draw on a board you already have, give its link:
  `/draw:navigate <board link>`, or put the link in your prompt. A board
  made in the browser opens for your agent once you share it with your agent
  from the dashboard. A link redcrayon does not know is refused, and nothing is
  drawn.

## Remove everything

1. Uninstall the plugin: `claude plugin uninstall draw@redcrayonai`, then
   `claude plugin marketplace remove redcrayonai` (or `/plugin` inside Claude Code).
   For Codex, use `codex plugin remove draw@redcrayonai`, then
   `codex plugin marketplace remove redcrayonai`.
   This removes the server entry, the command and the hooks.
2. In each project you used, delete the helper's files:
   `rm -rf "$(git rev-parse --git-common-dir)/redcrayon"`.
3. Clear the npx cache entry for the helper:
   `for d in ~/.npm/_npx/*/; do [ -d "$d/node_modules/@redcrayonai/draw" ] && rm -rf "$d"; done`.
4. Disconnect draw in each client you connected, which drops its sign-in
   grant: the sign-out steps under [Sign-in](#sign-in), then remove the server
   from the client (`codex mcp remove draw`, the `draw` entry in
   `~/.cursor/mcp.json`, the claude.ai connector).

To delete your boards or your account, write to support@redcrayon.ai. We
delete them within 30 days.

## Windows

Code refs and checkpoints run on macOS and Linux. On Windows the helper prints
`redcrayon: Windows is not supported yet.` and the plugin's hook does nothing,
so your agent draws boards without code refs or checkpoints.

## Develop

- For a plugin release, set the GitHub repository variable `PLUGIN_MCP_ORIGIN`
  to `https://mcp.<domain>`. The tag workflow configures the plugin and helper
  together; keep the committed defaults local.
- `bin/redcrayon.mjs` is the helper, built and copied in by each release. The
  plugin and the helper ship as one npm package, `@redcrayonai/draw`, so the
  plugin pins its helper.
- Load a checkout of this plugin for one session with
  `claude --plugin-dir <path to this folder>`.
- `REDCRAYON_MCP_URL` points the plugin's server and the helper at a server you
  run yourself, e.g. `REDCRAYON_MCP_URL=https://mcp.example.com/mcp claude`.
- `REDCRAYON_ORIGIN` points the helper at another server origin, for development
  only.

## License

Apache-2.0. See [LICENSE](LICENSE).
