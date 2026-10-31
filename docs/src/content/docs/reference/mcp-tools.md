---
title: MCP tools
description: Every tool the draw MCP server gives your agent, one line each.
---

Your agent calls these tools; you rarely call them yourself. Connect first
([Connect your agent](/connect/)). The agent opens a board with `start_session`,
then passes the returned `id` as `board` to calls on that board. `describe_charts` needs no board. `create_branch`
returns a different id for edits to the proposal.

Every write goes through the same rules as a person's edit. A refused write
says why, and the first word tells the agent what to do:

| Starts with | Meaning | Agent action |
|---|---|---|
| `REJECTED` | the write breaks a rule | read the sentence and fix the call |
| `UNAVAILABLE` | the server is busy or down | wait the stated time, then call again |
| `UNCONFIRMED` | the write outcome is unknown | call `get_board` before any retry |

## Session

| Tool | What it does |
|---|---|
| `start_session` | Opens the task's board (by name, or by a board link you gave it, full or only its `#b=` part) and returns its id and URL. |
| `get_board` | Reads the graph, ref metadata, chart summaries and route progress. Large results report omitted content. |

## Nodes and edges

| Tool | What it does |
|---|---|
| `create_node` | Adds a component: a service, data store, external system, boundary, note or text block. |
| `update_node` | Changes a node's label, sublabel, colour, kind or focus. |
| `move_node` | Moves a node. |
| `resize_node` | Resizes a node. |
| `layout_board` | Lays the board out left to right: entry points left, data stores right. |
| `hide_node` | Hides a node and its edges without deleting them. |
| `delete_node` | Deletes a node and its edges. |
| `create_edge` | Connects two nodes, with a label and the source line that proves the link. |
| `hide_edge` | Hides an edge without deleting it. |
| `delete_edge` | Deletes an edge. |

## Charts

| Tool | What it does |
|---|---|
| `describe_charts` | Lists the chart types and the data each one takes. |
| `create_chart` | Adds a chart node from CSV data, with a note on where the data came from. |
| `set_chart_data` | Replaces a chart's data. |
| `get_chart` | Reads a chart's type, data and options. |

## Code refs, notes and threats

| Tool | What it does |
|---|---|
| `add_code_ref` | Checks a node or edge ref against a file capture. Stores code text only with owner consent. |
| `remove_code_ref` | Removes a code ref. |
| `add_change_note` | Flags a migration or other risky change on a node, with the code that reads it. |
| `update_change_note` | Edits a change note. |
| `remove_change_note` | Removes a change note. |
| `add_threat` | Marks a node compromised (from a SIEM alert) or vulnerable (from a scanner finding). |
| `update_threat` | Edits a threat. |
| `remove_threat` | Removes a threat. |

## Traffic

| Tool | What it does |
|---|---|
| `start_tap` | Starts a live view of your app's local traffic on the board, while you run it. |
| `set_edge_latency` | Sets an edge's latency and where the number came from: production, local or an estimate. |
| `play_trace` | Replays one request on the board, span by span; errors show red. |

## Red crayon review

People create marks in the canvas. Agents claim and answer them through these tools.

| Tool | What it does |
|---|---|
| `watch_marks` | Returns a command for a background listener, using the seat from `start_session`. |
| `wait_for_marks` | Waits briefly, claims open marks for that seat, and groups them by shared files. |
| `reply_to_mark` | Answers a claimed mark with `fixed` or `kept`, a reply and the changed-file list. |
| `list_marks` | Reads sent marks, their states and replies, optionally for one round. |

The listener must run in an active coding session. Sending marks does not start
an agent. See [Review with the red crayon](/use-cases/feedback/).

## Board branches

| Tool | What it does |
|---|---|
| `create_branch` | Copies a board into an editable proposal and returns its own id and URL. |
| `submit_branch` | Sends the proposal for a person to review. Later graph edits return it to draft. |

Agents cannot accept, reject or merge proposals. These are human actions in the canvas.
See [Board branches](/capabilities/branches/).

## Walkthroughs and checkpoints

| Tool | What it does |
|---|---|
| `set_node_doc` | Writes a node's doc: at most two sentences on what it is and why it exists. |
| `set_selection` | Shows you which nodes the agent is working on. |
| `plan_route` | Plans the order in which the agent walks you through the change. |
| `arrive` | Marks the next stop on the route reached, with a checkpoint. |
| `reroute` | Changes the stops still ahead on the route, with a reason. |
| `mark_checkpoint` | Records which changed files the board covers. The agent calls it before every commit and before its final answer. |

## Session requirements and consent

Code refs, checkpoints, change notes and routes need a session board.
If a tool requests a capture, run the exact helper command it returns and retry
with the upload id. A drawing-only board still supports diagrams and charts.

Snippet storage is off by default. Code metadata and temporary captures still
exist. Agents cannot change the owner's storage setting. See
[Your data and code consent](/data-and-consent/).

Share links, embeds, workspace membership and consent are human controls. This
reference lists the board tools, not dashboard access-management actions.
