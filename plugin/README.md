# redcrayon

redcrayon draws what your coding agent builds on a live board: the components it
touched, the flows between them, each one citing a line the agent read, and code
refs that point into the exact symbols. You read the board instead of a prose
summary, and you find it again on your dashboard.

This plugin adds three things to Claude Code: the redcrayon server, the
`/draw:navigate` command, and code refs (a hook that reads the files your
agent cites). Other agents connect to the same server by its URL.

**Server URL:** `https://mcp.redcrayon.ai/mcp`

## Install

### Claude Code

1. Install the plugin:

   ```sh
   claude plugin marketplace add redcrayonai/draw && claude plugin install draw@redcrayonai
   ```

   Or, inside Claude Code, run `/plugin marketplace add redcrayonai/draw`,
   then `/plugin install draw@redcrayonai`.
2. Sign in: start Claude Code in your project, run `/mcp`, choose redcrayon, then
   Authenticate. Approve in the browser tab that opens.
3. Start drawing: run `/draw:navigate`. Your agent opens a board named after
   your branch and posts its link. `/draw:navigate <name>` names the board;
   `/draw:navigate <board link>` draws on a board you already have.

Code refs and checkpoints need git and Node 20 or later on your PATH. Without
Node, drawing still works.

### Cursor

1. Add the server to `~/.cursor/mcp.json`, with the server URL above:

   ```json
   {
     "mcpServers": {
       "redcrayon": {
         "url": "<server URL>"
       }
     }
   }
   ```

2. Sign in: in Cursor Settings → MCP, redcrayon shows a login button. Click it
   and approve in the browser.
3. Give your agent the prompt below. For code refs the agent runs
   `npx -y @redcrayonai/draw@1 capture` in your project (git, Node 20+).

### Codex

1. `codex mcp add redcrayon --url <server URL>`
2. `codex mcp login redcrayon`. A browser tab opens. Approve, then start codex in
   your project.
3. Give your agent the prompt below. For code refs the agent runs
   `npx -y @redcrayonai/draw@1 capture`. Allow network access when Codex asks.

### claude.ai

1. In claude.ai: Customize → Connectors → Add custom connector. Name it redcrayon
   and paste the server URL. On Team and Enterprise plans an owner adds it once
   for everyone.
2. Click Connect next to redcrayon and approve in the tab that opens.
3. Give Claude the prompt below. claude.ai draws from the conversation. Code refs
   and checkpoints need a coding agent in your project.

### Other clients

Any MCP client with remote servers and sign-in works: give it the server URL, or
the Cursor JSON above. VS Code uses `"servers"` and `"type": "http"`. Your client
opens a browser to sign in the first time it connects.

### The prompt

```text
Open a redcrayon board for this task and draw what you build on it as you go.
```

## Sign-in

Each client signs in once, in the browser, and stays signed in. Your agent shows
on the board as `agent of <your name>`. To sign a client out:

- Claude Code: `/mcp` → redcrayon → clear authentication
- Codex: `codex mcp logout redcrayon`
- Cursor: Settings → MCP → log out
- claude.ai: Connectors → Disconnect

The next call after a sign-out asks you to sign in again. Your boards stay as
they are.

## What leaves your machine

To check code refs, redcrayon uploads each file your agent cites, keeps only the cited lines, paths and git hashes, and deletes the file within 10 minutes.

Drawing needs only the server URL: nodes, edges and their labels go to the
server as your agent writes them. Code refs, `source:` citations and checkpoints
need a capture of your checkout. In Claude Code the plugin's hook makes it; in
other clients the agent runs `npx -y @redcrayonai/draw@1 capture …`. Each capture is one
upload:

| kind | Uploads | Claimed by |
|---|---|---|
| start | The absolute path of the checkout; HEAD (the empty-tree hash in a repo with no commits); the object format | `start_session` |
| ref | The above, plus one file: its path as git spells it, its bytes, git's blob hash, and whether git tracks it | `add_code_ref` |
| cite | The same, for the cited file | `create_edge` with `source:` evidence |
| checkpoint | The session's base commit, HEAD, the changed and deleted paths, the line numbers of each change (numbers only, no diff text), and the bytes and git hash of every file this board cites | `mark_checkpoint`, `arrive` |

Never uploaded: the list of files in your repo, files not cited on that board,
diff text, files git ignores, and files on the secret list.

Refused on your machine, with no network request: files git would not list
(ignored, under `.git/`, or in a nested repository); paths that match `.env*`,
`*.env`, `*.pem`, `*.key`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`,
`*.p12`, `*.pfx`, `.npmrc` or `.netrc`; symlinks that leave the repo; binary
files; files over 1 MB; checkpoint captures over 8 MB.

On the server, a capture can be claimed once, by the call it was made for, and
is deleted 10 minutes after upload. File bytes are deleted when the call that
claims them ends; redcrayon keeps only what the board shows: snippets (at most 60 lines and 4,000 characters each), cited
lines, paths, coverage counts, git hashes and the checkout path. Each snippet is
checked for secrets such as private keys and access tokens before it is stored.

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
   This removes the server entry, the command and the hooks.
2. In each project you used, delete the helper's files:
   `rm -rf "$(git rev-parse --git-common-dir)/redcrayon"`.
3. Clear the npx cache entry for the helper:
   `for d in ~/.npm/_npx/*/; do [ -d "$d/node_modules/@redcrayonai/draw" ] && rm -rf "$d"; done`.
4. Disconnect redcrayon in each client you connected, which drops its sign-in
   grant: the sign-out steps under [Sign-in](#sign-in), then remove the server
   from the client (`codex mcp remove redcrayon`, the `redcrayon` entry in
   `~/.cursor/mcp.json`, the claude.ai connector).

To delete your boards or your account, write to support@redcrayon.ai. We
delete them within 30 days.

## Windows

Code refs and checkpoints run on macOS and Linux. On Windows the helper prints
`redcrayon: Windows is not supported yet.` and the plugin's hook does nothing,
so your agent draws boards without code refs or checkpoints.

## Develop

- `bin/redcrayon.mjs` is the helper, built and copied in by each release. The
  plugin and the helper ship as one npm package, `@redcrayonai/draw`, so the
  plugin pins its helper.
- Load a checkout of this plugin for one session with
  `claude --plugin-dir <path to this folder>`.
- `REDCRAYON_MCP_URL` points the plugin's server and the helper at a server you
  run yourself, e.g. `REDCRAYON_MCP_URL=http://localhost:8788/mcp claude`.
- `REDCRAYON_ORIGIN` points the helper at another server origin, for development
  only.

## License

Apache-2.0. See [LICENSE](LICENSE).
