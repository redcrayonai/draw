# Results and failures

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
