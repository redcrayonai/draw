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
- `add_change_note` records the change: its kind, whether it is destructive
  (drops or rewrites data, or cannot be undone), the migration's steps with the
  one that cannot be undone, the table's columns (added, dropped or renamed),
  and the readers it found.
- `add_code_ref` cites each reader. A reader the agent did not update shows as
  one that will break.

## What you see

The nodes the change touches are flagged on the board. Select one for the full
change in the inspector: the code that reads it, the numbered steps, the line
each stale reader will break on, and **mark reviewed**.

## Limits

- The board knows only the readers the agent cites. It does not search your
  repo for others.
- It flags; it never blocks a commit, merge or deploy.

Tools: `add_change_note`, `update_change_note`, `remove_change_note`.
