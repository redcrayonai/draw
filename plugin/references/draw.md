# Draw — at every checkpoint, in this order

**Send independent calls together.** Every message you send is a wait for the
user, and the board fills in as each call lands. Put the calls of a step that do
not need each other's results in one message: every `create_node` of step 2
together, then every `create_edge` and `add_code_ref` of steps 3 and 4 together
(they need the node ids step 2 returned). Never send one write per message when
several are ready. Each call in a batch succeeds or fails on its own: act on a
`REJECTED` result and send that call again alone.

1. `get_board`. Humans may have moved things; never trust positions you remember.
   Each node's and edge's `refs` carry a `status` — `ok`, `stale`, or `ambiguous`
   — so you can see which refs need replacing (`remove_code_ref`, then
   `add_code_ref`) before you checkpoint.
2. **Nodes** — one per component you built or materially changed, plus the
   neighbours it calls or is called by. Pass `doc`: one or two present-tense
   sentences, *what this is and why it exists*. Revise with `set_node_doc` when
   the why changes.
3. **Edges** — one per flow you can cite. `label` is a verb phrase
   (`validates path`, `subscribes`); `evidence` is `source:<path>:<line>` for the
   call site you read.
4. **Code refs** — `add_code_ref` for **every symbol you wrote or materially
   changed** that is not on the board yet (step 1's `get_board` lists each
   node's refs; do not add them again at every checkpoint), on the node that
   owns it — and only for those: a ref on a symbol
   whose lines this session did not touch (a neighbour's declaration) is a
   misattribution; neighbours get a `doc`, not a ref. Do not put refs on edges:
   the edge's `evidence` already cites its call site. Set `author` to your
   subagent name if you are one; otherwise omit it.
5. **Layout** — `layout_board` once, after the nodes and edges of this pass
   exist, and only if this pass added nodes or edges. Skip it when step 1's
   `get_board` shows positions you did not leave (a human moved things), and say
   so in your final answer.

**Naming TypeScript/JavaScript symbols** (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`)
— never pass `startLine`/`endLine` in these files (the server rejects a range
there); the server resolves the name:
- top-level `function`, `class`, `interface`, `type`, `enum` and `namespace` by
  bare name: `renderInspector`, `RenderState`;
- class and interface members as `Class.member` (methods, properties,
  constructor): `Editor.toggleCodeOverlay`, `ManagedConnection.call`. A getter
  and setter pair is one ref, `Class.prop`;
- enum members as `Enum.member`, namespace members as `NS.member`, the default
  export as `default` and its members as `default.member`, and CommonJS
  `exports.x`, `module.exports` and `module.exports.member`;
- `const x = …` (destructured names too) by bare name — the ref spans the whole
  statement: `addCodeRef`;
- overload signatures resolve together with their implementation, as one ref.
  Same-named declarations of different shapes are one ref too: a `const` and a
  `type`, a class and an interface, a function and a namespace, a static and an
  instance member;
- the range excludes leading JSDoc; an exact top-level match beats a same-named
  member;
- **in these files, name only a declaration.** Every checkpoint re-finds each
  TS/JS ref by its `symbol` name when its file changed, so a ref named after a
  call site, a test case, a nested function, a method of an object literal held
  in a variable, or a local variable cannot hold. Cite the enclosing declaration
  that contains the change.
  Code outside every declaration — a top-level call such as
  `server.registerTool(…)`, an import, an export list — has no name at all:
  `exclude` its file at checkpoint with a reason. Test cases (`it(…)` blocks)
  have no declaration: ref a test helper you changed, or, when a test file's
  diff is only test cases, `exclude` that file at checkpoint with the reason
  `test cases (it blocks have no symbol)`.
- for every non-TypeScript file (`.svelte`, `.go`, `.md`, `.css`, …) pass
  `startLine`/`endLine` — 1-based, inclusive. A snippet holds at most 60 lines
  and 4000 characters. A longer range is clamped from the start: the server
  keeps `startLine` and moves `endLine` up until both limits hold. A single line
  longer than 4000 characters is rejected.

The server checks the symbol's **needle** against the snippet: the last dotted
segment of `symbol` (`allow` for `Limiter.allow`), or the whole symbol when it has
no dot. A member ref points at the member's own lines, which never spell the class
name — that is why the needle, not the full `Class.member`, must appear.

Read the result:
- `committed id=<n> <path>:<start>-<end> board=<name>` — the range the server
  resolved (a trailing `(clamped from <end>)` means the range hit the 60-line cap
  or the 4000-character cap, and `<end>` is the line you asked for). If it is not
  what you meant, `remove_code_ref` with `refId` set to that `id`, then
  `add_code_ref` the ref you meant. **Replace, never pile up:** a wrong ref left
  next to a right one is a false claim on the board.
- `already attached id=<n> <path>:<start>-<end> board=<name>` — that symbol is
  already on that node or edge; nothing new was written. Keep it, or replace it
  as above if its range is wrong. When the existing ref is not `ok`, the text
  adds `status=<stale|ambiguous> (remove_code_ref then add_code_ref under the
  current name)`: do that.
- `moved id=<n> <path>:<start>-<end> board=<name>` — you added a non-TypeScript
  ref again with other lines, and the server moved the existing ref there (same
  id, status `ok`).
- `REJECTED: ambiguous: '<symbol>' matches N declarations in <path>: …` — two or
  more declarations share that exact name, so no more specific name exists. The
  text ends with the remedy: `cite the enclosing '<Class>' instead` for repeated
  members, `cite their members (<symbol>.member) instead` for repeated blocks
  such as two `interface` declarations, or `exclude <path> at mark_checkpoint with
  a reason` when nothing encloses them (a JavaScript redeclaration). Do what it
  says.
- `REJECTED: not found: …` — no declaration has that name. Use one of its
  `did you mean` suggestions, or name the enclosing declaration. When the text
  says the code is outside every addressable declaration, exclude the file at
  checkpoint with a reason.
- `REJECTED: startLine/endLine are not accepted for <ext> files: …` — you passed
  a range in a TypeScript/JavaScript file. The text names the declaration that
  encloses those lines, or each declaration they touch: cite it by name and
  omit the range. Lines that no declaration reaches cannot be cited: exclude the
  file at checkpoint with a reason.
- `REJECTED: <path> does not parse (…)` means the file is mid-edit; finish the
  edit first, then add the ref by name.
- `REJECTED: '<ext>' files are not resolvable` — pass `startLine` and `endLine`.
- `REJECTED: symbol '…' does not occur in <path>:<start>-<end>` — the needle is
  not in that range; name the declaration that lives there, or (in a file that
  is not TypeScript/JavaScript) fix the range.
- `REJECTED: path '<path>' is not citable: …` — git ignores the file, or it is not
  a regular file. Do not cite it.

`create_node` and `create_edge` answer `committed id=<n> board=<name>`. Keep a
short id map in your working notes so refs land on the right node. If a whole
node is a mistake, `delete_node` it (its refs cascade) — it is your session board.

## Flag migrations and other risky changes

When you write a schema migration, drop or rename a column, delete data or break
an API, call `add_change_note` so the reviewer sees it on the board:

1. `add_code_ref` the migration file, then search the code for the changed
   column and `add_code_ref` every reader you find.
2. `add_change_note` with `anchorId` = the datastore node, `refId` = the
   migration ref, `steps` (line ranges inside it; mark the step that cannot be
   undone `irreversible`), `schema` (the table after the change), `subjects`
   (`{ table, column }`, plus `aliases` for ORM names) and `readers`.

Each reader's ref must contain the column or an alias, or the call is refused.
At each checkpoint, `changeNotes.staleReaders` lists readers that still read a
changed column: fix them. If the migration ref goes stale, `add_code_ref` the
migration again under another symbol, `update_change_note` with that `refId`,
then `remove_code_ref` the old one (a note's main ref cannot be removed while it
is in use). An additive migration that needs no note can go in `exclude`. Keep
notes for changes a reviewer must not miss; one per migration.

## Flag a vulnerable or compromised service

When a SIEM alert names a service on the board, call `add_threat` with
`anchorId` = that node and `stage: "compromised"`. For a scanner finding
(Trivy, Grype) use `stage: "vulnerable"`, and only for critical or high CVEs
that have a fix or are on the KEV list, at most 10 per node. One call is one
CVE or alert: `title` the CVE id, `severity` in lower-case (map `UNKNOWN` to
`low`), plus `cvss`, `package`, `fixedIn`, `flags` and `source` when you have
them. `update_threat` can raise a stage to compromised, never lower it; use
`remove_threat` for a wrong finding. The board then shows the blast radius.
