---
title: Explain it with a walk-through
description: Turn something you know in depth into a short walk-through on a board, one per audience.
sidebar:
  order: 9
---

Use this when you have to get something across to people who do not share your
depth: why a change is harder than it looks, what happened in an incident, how
a system fits together.

## Ask for it

In Claude Code, with the draw plugin:

```text
/draw:make-it-make-sense why renaming this field takes several releases, for product
```

With any other agent, ask in plain words and name the audience:

```text
Explain last Tuesday's checkout outage on a draw board. Save one walk-through for leadership and one for engineers.
```

The agent reads the code or notes first, draws a few boxes, and saves a
walk-through for each audience you named. One board carries all of them, so
they rest on the same boxes and cannot disagree on the facts.

## What a reader sees

Open the board and press **Play walk-through**. Boxes appear in order, starting
from something the reader already knows. Each step shows a short title and one
sentence. With more than one audience, the reader picks theirs in the bar.

| Audience | The walk-through uses |
|---|---|
| Outside the work: product, leadership, customers | Their words, one analogy, no file names |
| Inside the work: engineers, on-call, security | Exact terms, with the source of each step |

Back, Next, Pause and the arrow keys step through at the reader's pace. With
reduced motion turned on, nothing moves by itself; use Next.

## Send it

Share a view link ([Share an explanation or report](/use-cases/share/)). The
reader installs nothing. Everyone who can view the board can read every word of
a walk-through, so keep secrets and customer names out of it.

## When it still does not make sense

Circle the box with the [red crayon](/use-cases/feedback/) and press Send. The
agent answers on the board and can rewrite that step.
