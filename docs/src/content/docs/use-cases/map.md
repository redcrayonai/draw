---
title: Map an unfamiliar codebase
description: Ask the agent to draw how a repo fits together, for onboarding.
sidebar:
  order: 3
---

## You ask

```text
Draw how this repo fits together: entry points, services, data stores and the calls between them. Cite a line for every edge.
```

## The agent does

- Reads the code and draws each component (`create_node`) with a two-sentence
  doc on what it is and why it exists (`set_node_doc`).
- Connects them (`create_edge`), each edge citing the line that proves it.
- Lays the board out left to right, entry points left and data stores right
  (`layout_board`).
- Hides noise such as vendor libraries in named groups (`hide_node`), so the
  board still counts them.

## You see

:::note
Screenshot coming: an onboarding map of a mid-size repo, one hidden group
chip on the chrome.
:::

Share the board with a new teammate as a view link
([Boards and sharing](/capabilities/boards/)).

## Try it

[Connect your agent](/connect/) · [Boards and sharing](/capabilities/boards/)
