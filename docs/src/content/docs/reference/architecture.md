---
title: Architecture
description: How the parts of draw connect, shown on a live draw board.
---

draw is one database module with clients around it. Every write, from a person
or an agent, goes through the same rules in that module.

This is a real board, not a picture. Pan and zoom it here, or
[open it read-only](https://draw.redcrayon.ai/#s=77b218d5efcc9401793c85579b06426b).

<iframe src="https://draw.redcrayon.ai/embed.html?kind=board#e=4aa3b6d0becd9863385b083c9e30490f" title="draw architecture board" width="100%" style="border:0;height:520px" loading="lazy" referrerpolicy="no-referrer"></iframe>

| Part | Source | What it does |
|---|---|---|
| Database module | `module/` | Holds the tables and the board rules. It is the single source of truth. |
| MCP Worker | `mcp/` | Serves the agent tools, checks sign-in, holds temporary file captures and relays live traffic. It writes as the calling user. |
| Canvas and embeds | `client/` | The board editor, and the read-only viewer shown above. Both stay connected to the module. |
| Dashboard | `web/` | Lists and manages boards and workspaces. Its server side starts repository imports. |
| Import runner | `importer/` | Reads one public GitHub commit and returns an architecture graph to the dashboard. It has no database connection. |
| Coding agent | `plugin/` | Any MCP client. The plugin adds a skill, hooks and the MCP config. |
| `redcrayon` CLI | `helper/` | Uploads the files an agent cites, and forwards traffic summaries during a tap. |
| Your running app | | Sends traces to the CLI during a tap. Raw traces stay on your machine. |

## Follow one edit

An agent draws a node. These excerpts show the same edit at each step.

The Worker writes as the calling user, not as a shared service account:

```ts title="mcp/src/app.ts"
const db = database(env, () => mint(env, principalSubject(principal)), stats);
```

```ts title="mcp/src/tools.ts"
t.ctx.db.call('create_node', { boardId, ...input }, t.signal)
```

The module checks the rules. The canvas calls the same `create_node`, so a
person and an agent get the same answer. This excerpt is shortened:

```ts title="module/src/index.ts"
function assertOnGrid(field: string, value: number): void {
  if (value % GRID !== 0) {
    // refuses the write: "grid rule: x = 6 is not divisible by 4; ..."
  }
}
```

Open clients then receive the change. The canvas subscribes to the board's
tables, and the viewer on this page subscribes to its published scene:

```ts title="client/src/subscribe.ts"
conn.subscriptionBuilder().onApplied(onApplied).onError(onError).subscribe(all(CORE_TABLES));
```

```ts title="client/src/embed.ts"
.subscribe([boardMode ? 'SELECT * FROM embedded_board' : 'SELECT * FROM embedded_chart']);
```

## What the board leaves out

A sign-in provider is optional. Postgres stores long-term activity history, and
the [self-host stack](/self-host/quickstart/) includes it.
