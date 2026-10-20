---
title: Review a risky change
description: A migration is flagged on the board, and every reader of what it changes is cited.
sidebar:
  order: 2
---

## You ask

```text
Drop the unused customers.name column. Flag the migration on the board and cite every reader of that column.
```

## The agent does

- Draws the database and the services that read it.
- Writes the migration and records it with `add_change_note`: what changes,
  the steps, the readers.
- Cites each reader with `add_code_ref`. A reader it did not update shows as
  one that will break.

## You see

![Migration 0042 flagged on customers-db: display_name added, name dropped; the welcome email still reads customers.name and is marked as a reader that will break](../../../assets/migration-review.png)

[Open the demo board →](https://draw.redcrayon.ai/#s=8a2555d85c7fe7728811f82770b9cedf)

Without reading the SQL you can say: one migration drops a column, and one
worker will break.

## Try it

[Connect your agent](/connect/) · [Change notes](/capabilities/change-notes/) ·
[Code refs](/capabilities/code-refs/)
