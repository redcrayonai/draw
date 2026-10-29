---
title: Review a risky change
description: Find the readers a migration can break, then review the proposed fix on the board.
sidebar:
  order: 4
---

Use this before a schema migration or another change that can break callers.
The board puts the changed component beside the code that depends on it.

## You ask

```text
We want to retire customers.name in favor of display_name. Find every reader and writer before changing the schema. Draw the dependencies, cite each reader, and add a change note with the migration steps and the irreversible step. Identify anything that will break.
```

## What happens

1. The agent draws the database and its callers.
2. It cites the migration and adds a change note with the affected columns and steps.
3. It cites each reader it finds and records whether that reader still depends on the old column.

## What to look for

![Migration 0042 on customers-db: display_name is added, name is dropped, and the welcome email still reads customers.name](../../../assets/migration-review.png)

[Open the demo board →](https://draw.redcrayon.ai/#s=8a2555d85c7fe7728811f82770b9cedf)

In this example, the welcome email still reads the dropped column. Open its
marker to inspect the evidence and migration steps before you approve the work.
The board knows only the readers the agent cites. An absent reader is not proof
that the repository contains no other caller.

## Ask for the next revision

Circle the stale reader with the [red crayon](/use-cases/feedback/).
Write “Update this reader before the column disappears,” then press **Send**.
The agent replies with the files it changed or a reason to keep the code.

For an architectural alternative, ask for a
[board branch](/use-cases/propose/) before the agent changes the shared diagram.
A board branch is separate from your Git branch.

**Mark reviewed** records your review of a change note. It does not block or
authorize a code commit, merge, migration, or deployment.

[Change notes](/capabilities/change-notes/) · [Code refs](/capabilities/code-refs/) ·
[Code consent](/data-and-consent/)
