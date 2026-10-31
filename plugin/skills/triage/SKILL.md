---
name: triage
description: Use when the user types /draw:triage [board link], or asks for help working an incident or an alert on a draw board.
argument-hint: [board link] [what is wrong]
allowed-tools: mcp__draw__*, mcp__plugin_draw_draw__*, Bash(git:*), Read
---

# redcrayon — triage an incident on the board

An alert opened an incident board, or the user has a board of the system that is
misbehaving. You help the room find which hop is broken. The drawing already
exists: you put measured numbers on the parts they describe, narrow everyone's
time window, and say what the evidence shows. People decide what is the cause.

**Tool names.** The draw tools carry a prefix: `mcp__plugin_draw_draw__`
when the draw plugin provides the server, `mcp__draw__` when the user added
it by hand, or another prefix chosen for the server. This skill names each tool
without its prefix (`start_session`). Use one prefix for the whole session.

**`board` on every call.** Every tool except `start_session` and `describe_charts`
takes `board`: the `id` that `start_session` returned, as a string of digits.

## Preflight — before anything else

Look for `start_session` and `get_board` under the configured server's prefix in
your tool list. If they are not there, say exactly
`The draw server is not connected. Run /mcp, choose draw, and sign in.`
and stop.

## Start

Read the **first word** of `$ARGUMENTS`. Everything after it is what the user
says is wrong.

- **A link** (it starts with `https://` or `http://`): call `start_session` with
  `{ "link": "<the word>" }`. If it answers `REJECTED: no board at <link>. …`,
  relay that text word for word and stop.
- **No link:** ask the user for the incident board's link and wait. Do not open a
  board by name: an incident is worked on the board the alert opened, or on the
  board the user names.

Relay `url` once, verbatim, in your next message, before any other tool call.
Read [results.md](../../references/results.md) the first time a result starts with
`REJECTED`, `UNAVAILABLE` or `UNCONFIRMED`.

Then call `get_board` and read it before you write anything: the components and
connections, the charts and what each one is pinned to, the focal nodes, and the
board's time window. The window is what everyone is looking at; work inside it.

## Gather evidence

draw shows evidence; it does not fetch it. Use the monitoring, tracing, logging
or cluster tools the user has connected, for the board's window. If there are
none, say which data you need and ask the user for it. Never invent a number,
and never pass an estimate as a measurement.

For each finding, put it where it belongs:

1. **A metric about one hop or component:** `create_chart` beside it, with a
   `source` that names the tool and query (`agent: <tool> <query> @ <window>`),
   then `pin_chart` to that edge or node so the chart stays attached to it.
   `describe_charts` lists what each chart type takes; a `timeseries` with ISO 8601
   times in UTC follows the board's window.
2. **New numbers for a chart already on the board:** `set_chart_data`, keeping
   its source honest. Do not create a second chart for the same series.
3. **One slow or failing request:** `play_trace` with measured spans, and
   `set_edge_latency` on the hops it measured. See
   [latency.md](../../references/latency.md); it also covers a live tap when the
   user can reproduce the problem locally.
4. **A narrower window:** `set_time_window` with `start` and `end` (ISO 8601 UTC)
   once the evidence points at a few minutes. Say in chat that you moved it: it
   moves every viewer's charts. Never clear a window someone else set without
   asking.

Send writes that do not need each other's results in one message.

## Suspects belong to people

Focal marks the suspects the room chose: at most two at once. Do not set or
clear `focal` on any node. When the evidence points at a component or hop, say
so in chat with the chart that shows it, and let a person promote it. To leave
the reasoning on the board, add one `create_node` of kind `note` beside the
component: observations first, then the hypothesis, labelled as one.

Separate what you measured from what you think. "billing → postgres p95 went
from 4 ms to 160 ms at 14:32 UTC" is an observation. "the connection pool is
exhausted" is a hypothesis until a measurement shows it.

## Finishing

End with the board URL, one line per finding with the chart or trace that
shows it, the open questions, and the data you could not get. Do not paste
chart data into chat; the board has it.
