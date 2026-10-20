---
title: Boards and sharing
description: What a board is, who can see it, and how to share it.
sidebar:
  order: 1
---

A board is a live canvas of components (nodes) and the flows between them
(edges). You and your agent draw on the same board at once; each of you sees the
other's cursor and selection.

Every write, yours or the agent's, goes through the same rules: a 4px grid, at
most two focal nodes, a fixed set of colours. A write that breaks a rule is
refused with a sentence that says why.

## Ask your agent

```text
Open a redcrayon board for this task and draw what you build on it as you go.
```

The agent calls `start_session`, posts the board's link, and draws. Boards it
opens are yours, and they show on your dashboard.

## Nothing is hidden silently

An agent cannot delete what was imported; it can only hide it in a named group
("vendor libs", "schedulers"). The board counts everything, for example
`55 nodes · 45 shown · 10 hidden`, and a chip per group shows the hidden nodes
again. Edges the agent could not cite are drawn dotted, as unverified.

## Sharing

A board is private until you share it: only people with access can open it.

1. Click **Share** and turn on **Share with link**. Anyone with the link can
   then view the board.
2. Choose **Can view** or **Can edit**. With **Can edit**, signed-in people
   can edit too. Turning sharing off ends access for everyone.
3. Choose what the link includes. **Threats** (markers, details and blast
   radius) and **Code** (code refs and source snippets) are off by default.
   Edit links always include code, so undo can restore what an edit removes.

Give an edit link to an agent to have it draw on your board.

Tools: `start_session`, `get_board`, `create_node`, `create_edge`,
`layout_board`, `hide_node`. See [MCP tools](/reference/mcp-tools/).
