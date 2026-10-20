---
title: Code refs
description: Links from a node or edge to the exact lines of code behind it.
sidebar:
  order: 2
---

A code ref points from a node or edge to a symbol and its lines, for example
`renderInspector → client/src/inspector.ts:40–88`. The server reads the snippet
from your checkout; the agent never types code onto the board.

## Ask your agent

```text
Draw what you changed, and add a code ref for every function you touched.
```

## What the agent does

- `add_code_ref` names a declaration (for TypeScript and JavaScript) or a line
  range (other languages). The server finds the lines and keeps the snippet.
- `create_edge` cites the line that proves the link, as `source:<path>:<line>`.
- `mark_checkpoint`, before every commit, finds each ref again after edits and
  reports which changed files the board does not cover yet. Uncovered files are
  a number on the board, never a silent gap.

## Limits

- A snippet holds at most 60 lines and 4000 characters.
- Code at the top level of a file, outside every declaration, cannot be cited.
- Code refs need git and Node 20 or later. In Claude Code the plugin captures
  your checkout for you; other agents run the command the tool gives them. See
  [Connect your agent](/connect/#code-refs-outside-claude-code).

Tools: `add_code_ref`, `remove_code_ref`, `mark_checkpoint`.
