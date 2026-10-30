# Subagents

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
