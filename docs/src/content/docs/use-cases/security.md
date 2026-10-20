---
title: Triage security findings
description: Mark what an alert or CVE affects, and fix what exposes most first.
sidebar:
  order: 5
---

## You ask

```text
Here is this morning's SIEM alert and the scanner report. Mark what they affect on the architecture board, and tell me what to fix first.
```

## The agent does

- Reads the alert and the findings through your SIEM or scanner MCP server.
- Marks a service named by the alert as `compromised` (`add_threat`).
- Marks scanner findings as `vulnerable`, only critical or high CVEs that have
  a fix or are on KEV, so the board does not cry wolf.

## You see

![A compromised admin portal; its blast radius spreads to the services that reach it and the databases it reads](../../../assets/siem-blast-radius.png)

[Open the demo board →](https://draw.redcrayon.ai/#s=0e265bfd5eee31353e7cc39ec824771e)

Open a threat's marker to see its blast radius: what the service reaches and
what trusts it, hop by hop. Fix first the finding whose blast radius holds the
most, or the most sensitive, services. **Mark contained** when it is dealt
with.

## Try it

[Connect your agent](/connect/) · [Threats](/capabilities/threats/)
