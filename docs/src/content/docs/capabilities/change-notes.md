---
title: Change notes
description: Flag a migration or other risky change, and the code it breaks.
sidebar:
  order: 3
---

A change note marks a risky change on the board: a migration, a breaking API
change, data loss or a new dependency. It
sits on the database node and on every node whose code reads what changed, so a
reviewer sees the risk without reading the SQL.

## Ask your agent

```text
Write the migration that drops customers.name. Flag it on the board and cite every reader of that column.
```

## What the agent does

- `add_code_ref` cites the migration file first; the note hangs off that ref.
- `add_change_note` records the kind of change and whether it is destructive.
  It lists the migration steps, including the irreversible step.
  It also records changed columns and the readers the agent found.
- `add_code_ref` cites each reader. A reader the agent did not update shows as
  one that will break.

## What you see

The board flags nodes the change touches. Select one to inspect its readers,
numbered steps and stale reader locations. Use **mark reviewed** to record your review.

## Limits

- The board knows only the readers the agent cites. It does not search your
  repo for others.
- It flags; it never blocks a commit, merge or deploy.

Tools: `add_change_note`, `update_change_note`, `remove_change_note`.
