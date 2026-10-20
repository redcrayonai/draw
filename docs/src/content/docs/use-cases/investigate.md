---
title: Investigate an incident
description: A scratch board with metrics beside the services they describe.
sidebar:
  order: 4
---

## You ask

```text
Pods in checkout keep restarting since 14:00. Pull the restarts and error rates, and lay out what you find on a scratch board.
```

## The agent does

- Queries your metrics through another MCP server, such as Grafana or
  Kubernetes.
- Draws the services involved and puts charts beside them (`create_chart`): a
  `timeseries` of restarts, a `toplist` of error rates, a `scatter` of memory
  against restarts. Each chart says where its data came from.
- Sets measured latencies on the edges (`set_edge_latency`) and can replay a
  slow trace (`play_trace`).

## You see

![A scratch pad beside the MCP Worker and its database: request time against database time, and p50/p95 per endpoint](../../../assets/incident-scratchpad.png)

[Open the demo board →](https://draw.redcrayon.ai/#s=32b61159274bbf0f64f1d64bdd278234)

The board is a scratch pad: it explains one incident. Delete it when you are
done, or keep it for the write-up.

## Try it

[Connect your agent](/connect/) · [Charts](/capabilities/charts/) ·
[Live traffic](/capabilities/traffic/)
