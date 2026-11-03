---
title: Example boards
description: Open boards that map well-known open source projects, with a cited line behind each connection.
sidebar:
  order: 1
---

These boards map open source projects at a fixed commit. Open one without signing
in, select a component for its explanation and code, and select a connection to
see the line it cites.

## PostgreSQL: how a query runs and survives a crash

Follows a query from the client through parsing, planning and execution, then
shows why committed work survives a crash: WAL reaches disk before the data it
protects.

[Open the board →](https://draw.redcrayon.ai/#s=92382e6d358220457d3438ce83cc6d89) · Commit `3168611`

## OpenObserve: one log line from ingest to search

A log line is searchable before it reaches object storage. Queriers read uploaded
files, while ingesters add their in-memory tables and local parquet files.

[Open the board →](https://draw.redcrayon.ai/#s=8165815b74ffcf425cddca17aece1970) · Commit `e6a65bf`

## MCP TypeScript SDK: one tool call, end to end

Client and server extend the same `Protocol` class, so stdio and HTTP differ only
in their transport.

[Open the board →](https://draw.redcrayon.ai/#s=913cd78d75f30b5e76035b814093fc6a) · Commit `1e608ca`

## umami: how a page view gets stored

One `saveEvent` call writes to PostgreSQL, ClickHouse or Kafka, depending on
environment variables. The board marks the one connection the repository cannot
prove.

[Open the board →](https://draw.redcrayon.ai/#s=5d1582bd8d2a971969875eeeb9858e58) · Commit `559e3c6`

## Flask: one request through the app

The session opens before URL matching, and a 404 is only raised after
`before_request` hooks have run.

[Open the board →](https://draw.redcrayon.ai/#s=0be301253c73e9a8562d1eb12a8a1711) · Commit `49943b5`

## Draw one of your own

```text
Draw how a request moves through this repo: entry point, services, queues and data stores. Cite the line behind every connection. Give each component a short explanation, and distinguish facts from connections you cannot prove.
```

[Connect your agent](/connect/) to try it. For more on this kind of board, see
[Map an unfamiliar codebase](/use-cases/map/).
