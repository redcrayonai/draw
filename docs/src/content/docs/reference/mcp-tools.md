---
title: MCP tools
description: Every tool the draw MCP server gives your agent, one line each.
---

Your agent calls these tools; you rarely call them yourself. Connect first
([Connect your agent](/connect/)). The agent calls `start_session` once, then
passes the board id it returns to every other tool.

Every write goes through the same rules as a person's edit. A refused write
says why, and the first word tells the agent what to do:

| Starts with | Meaning | The agent should |
|---|---|---|
| `REJECTED` | the write breaks a rule | read the sentence and fix the call |
| `UNAVAILABLE` | the server is busy or down | wait the stated time, then call again |
| `UNCONFIRMED` | the write may or may not have landed | call `get_board` before any retry |

## Session

| Tool | What it does |
|---|---|
| `start_session` | Opens the task's board (by name, or by a board link you gave it) and returns its id and URL. |
| `get_board` | Reads every node and edge on the board, with code refs and route progress. |

## Nodes and edges

| Tool | What it does |
|---|---|
| `create_node` | Adds a component: a service, data store, external system, boundary or note. |
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
| `add_code_ref` | Points a node or edge at the exact lines of code behind it. |
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

## Review and checkpoints

| Tool | What it does |
|---|---|
| `set_node_doc` | Writes a node's doc: at most two sentences on what it is and why it exists. |
| `set_selection` | Shows you which nodes the agent is working on. |
| `plan_route` | Plans the order in which the agent walks you through the change. |
| `arrive` | Marks the next stop on the route reached, with a checkpoint. |
| `reroute` | Changes the stops still ahead on the route, with a reason. |
| `mark_checkpoint` | Records which changed files the board covers. The agent calls it before every commit and before its final answer. |
