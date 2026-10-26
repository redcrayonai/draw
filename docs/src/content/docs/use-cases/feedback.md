---
title: Review with the red crayon
description: Mark a component, send feedback, and read the agent's answer on the board.
sidebar:
  order: 2
---

Use the red crayon to point at the part of a diagram you want the agent to
revisit. Each mark carries the node and your note, so you do not need to explain
which component you mean in chat.

## Start the review

Ask your connected coding agent:

```text
Draw the checkout flow on this board, then listen for my red crayon marks. For each mark, inspect the related code and either fix it or explain why you kept it. Reply on the board with the files you changed.
```

The agent must stay available to process marks. Sending a mark does not start
a new agent session.

## Mark and send

1. Sign in with edit access to the board.
2. Press **C**, or choose the red crayon in the toolbar.
3. Click a node to circle it and open its note.
4. Write specific feedback, such as “Add a timeout and explain the failure path.”
5. Mark any other nodes you want reviewed.
6. Press **Send** to send the batch as one review round.

An empty note is allowed. A written question gives the agent a clearer task.
Draft marks stay in your browser until you press **Send**. Other editors and
agents do not see them. A round holds at most 20 marks.

## Read the answer

Open **Review** to read each round. Marks move through these states:

| State | Meaning |
|---|---|
| `sent` | The mark awaits an agent. |
| `claimed` | An agent took the mark and is working on it. |
| `fixed` | The agent reports a code change, with its reply and changed files. |
| `kept` | The agent left the code as it was and explains why. |

Choose a row to return to its node. A reply reports what the agent did.
It is not an independent check that the fix works.
If the answer or change needs more work, send another round.

## If no agent is listening

The board shows **No agent listening**. Open the board and tell your agent:

```text
Review my marks on this board: <board link>. Keep listening after you answer this round.
```

The background listener stops after nobody opens the board for ten minutes.
An ended coding session also needs you to resume the agent.

## How an MCP agent handles it

The agent keeps the `seat` from `start_session`. It calls `watch_marks` and runs
the returned command in the background. Then `wait_for_marks` returns claimed
marks grouped by shared files. Without background tasks, the agent can use
`wait_for_marks` directly.

Every mark receives `reply_to_mark` with `fixed` or `kept`, a reply, and a file
list. `list_marks` reads previous rounds. See [MCP tools](/reference/mcp-tools/).

[Watch the agent build](/use-cases/build/) · [Review a risky change](/use-cases/review/)
