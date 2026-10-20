---
title: Watch the agent build
description: The agent draws what it is about to change, with code refs to the exact lines.
sidebar:
  order: 1
---

## You ask

```text
Add rate limiting to the public API. Draw what you change on a redcrayon board.
```

## The agent does

- Opens a board named after your branch (`start_session`) and posts its link.
- Draws the components it is about to change before its first edit
  (`create_node`, `create_edge`), each edge citing the line that proves it.
- Adds a code ref for every symbol it touches (`add_code_ref`).
- Before each commit, records which changed files the board covers
  (`mark_checkpoint`).

## You see

:::note
Screenshot coming: a session board with the API, the new limiter and its
store, code refs open on the limiter.
:::

You read the board instead of a prose summary. Changed files the agent did not
draw are a number on the board.

## Try it

[Connect your agent](/connect/) · [Code refs](/capabilities/code-refs/) ·
[Boards and sharing](/capabilities/boards/)
