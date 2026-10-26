---
title: Code refs
description: Connect a component to its code, with optional inline snippets.
sidebar:
  order: 2
---

A code ref points from a node or edge to a symbol and its lines, for example
`renderInspector → client/src/inspector.ts:40–88`. The server checks the reference
against a capture of your file. Your agent does not paste code onto the board.

## Ask your agent

```text
Draw what you changed, and add a code ref for each function you touched. Refresh the refs at the final checkpoint and report changed files the board does not cover.
```

## What the agent does

- `add_code_ref` names a declaration for TypeScript or JavaScript, or a line range for another language.
- `create_edge` cites the source line behind a connection as `source:<path>:<line>`.
- `mark_checkpoint` finds refs again after edits and records uncovered changed files.

Uncovered files are explicit gaps in the drawing. A checkpoint is not a test
result and does not prove that every dependency appears on the board.

## What readers see

By default, a ref stores the path, symbol, lines and hashes without code text.
For a GitHub origin, **open on GitHub** links to the pushed commit recorded at
a checkpoint. This link requires a cited file without uncommitted changes.
GitHub checks the reader's repository access. Otherwise the ref shows **not pushed yet** or
**open in editor**.

The owner can enable **Store code snippets on my boards** under dashboard
**Settings → Code**. Later refs and checkpoints can then store inline snippets.
[Your data and code consent](/data-and-consent/) explains temporary uploads,
retention and deletion.

## Limits and setup

- A stored snippet holds at most 60 lines and 4,000 characters.
- Code outside declarations cannot be cited through the TypeScript or JavaScript declaration workflow.
- Code refs need git and Node 20 or later.
- The Claude Code plugin captures your checkout. Other agents run the capture command that the tool supplies.
- A drawing-only board has no code refs or checkpoints.

See [Connect your agent](/connect/#code-refs-outside-claude-code).
Tools: `add_code_ref`, `remove_code_ref`, `mark_checkpoint`.
