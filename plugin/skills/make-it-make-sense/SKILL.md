---
name: make-it-make-sense
description: Use when the user types /draw:make-it-make-sense [board link] [what to explain, and for whom], or asks to explain, simplify or walk someone through a system, a change, an incident or a decision for a named audience such as product, leadership, customers or new engineers.
argument-hint: [board link] [what to explain, and for whom]
allowed-tools: mcp__draw__*, mcp__plugin_draw_draw__*, Bash(git:*), Read
---

# redcrayon — make it make sense

The user knows something in depth and has to get it across to people who do not.
You turn it into a walk-through on a board: a few boxes, shown in order, one plain
sentence at a time. The reader opens the board, presses **Play walk-through** and
watches; they install nothing. One board carries a walk-through per audience, and
all of them rest on the same boxes, so they cannot disagree on the facts.

**Tool names.** The draw tools carry a prefix: `mcp__plugin_draw_draw__`
when the draw plugin provides the server, `mcp__draw__` when the user added
it by hand, or another prefix chosen for the server. This skill names each tool
without its prefix (`start_session`). Use one prefix for the whole session.

**`board` on every call.** Every tool except `start_session` and `describe_charts`
takes `board`: the `id` that `start_session` returned, as a string of digits.

## Preflight — before anything else

Respect native Codex permission settings; do not bypass a denied operation with
another connection or a terminal command. The user can review them with
`draw permissions codex`, then restart Codex. Source uploads set
to Ask open a browser approval page. Never submit its form programmatically:
only the human may choose **Allow once**. Use an explicit `start_chat` call if
conversation attachment is needed; opening the board does not authorize it.

Look for `start_session` and `save_telling` under the configured server's prefix in
your tool list. If they are not there, say exactly
`The draw server is not connected. Run /mcp, choose draw, and sign in.`
and stop.

## Start

Read the **first word** of `$ARGUMENTS`.

- **A link** (it starts with `https://` or `http://`): call `start_session` with
  `{ "link": "<the word>" }`. Everything after it is what to explain. If it answers
  `REJECTED: no board at <link>. …`, relay that text word for word and stop.
- **Anything else:** all of `$ARGUMENTS` is what to explain. Call `start_session`
  with `{ "name": "<name>" }`, where the name is the current branch from
  `git rev-parse --abbrev-ref HEAD`. If that prints `HEAD`, ask the user for a
  name and wait.

Relay `url` once, verbatim, in your next message, before any other tool call.
Read [results.md](../../references/results.md) the first time a result starts with
`REJECTED`, `UNAVAILABLE` or `UNCONFIRMED`.

## 1. Know it before you draw it

Read the code, the document or the incident notes first. A walk-through says only
what you have read. Simpler is right; invented is wrong. A claim you could not
confirm gets no step.

Everyone who can view the board reads every word of a walk-through, through a
shared link too. It holds no secrets, credentials or customer names.

## 2. Name the audience

Take it from the user's words. One audience named: one walk-through. Several
named, or "for different audiences": one each, on the same board. None named:
write one for `Everyone` as an outside audience, and say that you did.

The audience label is one or two words the readers would call themselves:
`Product`, `Leadership`, `Customers`, `Engineers`, `On-call`.

| | Outside the craft | Inside the craft |
|---|---|---|
| Who | product, leadership, customers, sales, support | engineers, on-call, security, new teammates |
| Words | theirs; the only internal names are the labels on the boxes | the exact terms |
| `source` | left out | on every step: the file, section or document you read |
| Analogy | exactly one, on the hardest step | none |

## 3. Draw the boxes

Call `get_board` and reuse the boxes that are there. Otherwise draw 5 to 9 boxes
with `create_node`, each a thing the reader could point at, labelled in two or
three plain words, and join them with `create_edge`
([editorial.md](../../references/editorial.md), [draw.md](../../references/draw.md)).
One board serves every audience, so box labels stay plain.

## 4. Write the steps

A walk-through is 3 to 7 steps. While it plays, the reader sees only the boxes
named so far: the current step's are lit, earlier ones step back, the rest stay
hidden. Each step is:

- `nodes`: the boxes this step is about. A new box arrives next to a box already
  shown, 1 to 4 new boxes in a step.
- `frame`: those boxes plus the earlier box they hang off, so the view shows the
  join.
- `title`: 2 to 5 words that say the point, not the box's name.
- `body`: one sentence, 25 words at most, said to the reader as "you" or "we".
- `source`: by the audience table above.

The order:

1. **First step:** one box the reader already knows: what they asked for, what
   they saw go wrong, their own part.
2. **Middle steps:** follow the lines outward from there.
3. **Hardest step, outside audience:** its sentence begins `Think of it as`,
   gives an everyday picture, then a colon and the fact itself.
4. **Last step:** what happens next, or what changes for them.

An outside-audience walk-through of an outage, for `Leadership`:

```json
{
  "board": "42",
  "audience": "Leadership",
  "title": "Why could nobody pay on Tuesday?",
  "steps": [
    { "nodes": ["11"], "title": "What people saw",
      "body": "For forty minutes on Tuesday, shoppers who pressed Pay saw an error and no order was placed." },
    { "nodes": ["12"], "frame": ["11", "12"], "title": "Where it stopped",
      "body": "Their orders reached checkout, which waits for a yes or no on each payment before it confirms." },
    { "nodes": ["13", "14"], "frame": ["12", "13", "14"], "title": "The slow answer",
      "body": "Think of it as a cashier holding the whole line: payments waited on a card processor that had stopped answering." },
    { "nodes": ["15"], "frame": ["13", "15"], "title": "Why it spread",
      "body": "Every waiting payment was tried again, so the pile of retries grew faster than it could clear." },
    { "nodes": ["13"], "frame": ["12", "13", "14"], "title": "What changes",
      "body": "From now on payments gives up after two seconds and asks you to retry, so one slow partner cannot stop checkout." }
  ]
}
```

## 5. Save and hand over

Call `save_telling` once per audience; the walk-through's `title` is the question
in the reader's own words. Saving again for the same audience replaces it. A
`REJECTED` answer names the audiences the board already has;
`remove_telling` takes away one the user no longer wants.

Then tell the user, in one short message: the board link, the audiences you
saved, and `Open the link and press Play walk-through.` Readers need only a view
link, which the user makes with Share on the board.

## 6. Listen

Follow [marks.md](../../references/marks.md). On this board a red crayon mark
means "this part still does not make sense". Answer it with `reply_to_mark`:
one plain sentence, `status: "kept"`, `files: []`. When the step itself was
unclear, rewrite it and call `save_telling` again.
