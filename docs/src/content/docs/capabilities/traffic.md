---
title: Live traffic
description: Latency on edges, replayed requests, and live local traffic.
sidebar:
  order: 6
---

Edges can carry how a request moves through the system: how long each hop
takes, one request replayed span by span, or live traffic from your app while
you run it.

## Ask your agent

```text
Replay the slowest checkout trace from the last hour on the board.
```

## What the agent does

- `set_edge_latency` sets a hop's latency and where the number came from:
  `prod` (production traces), `local` (measured on your machine) or `estimate`
  (read from the code). Estimates are drawn differently.
- `play_trace` replays one request: dots run from each span's parent node to
  its own, timed by the spans and slowed down to watch. Error spans turn red. A
  trace carries only span ids, nodes, timings and status: no attributes, URLs
  or payloads.
- `start_tap` shows live traffic while you run your app locally: request rate,
  latency and errors per edge, about once a second. Raw telemetry stays on your
  machine; only per-edge summaries leave it, and only while someone watches with
  **Live** on.

The agent starts the tap for you: it writes `.redcrayon/tap.json` (which
service is which node) and runs `npx -y @redcrayonai/draw@1 tap`. Point your
app's OpenTelemetry exporter at `http://127.0.0.1:4318` (HTTP), then press
**Live** on the board.

![One request replayed hop by hop on a draw board](/trace-replay.gif)

Tools: `set_edge_latency`, `play_trace`, `start_tap`.
