---
title: Your data and code consent
description: What leaves your machine, what draw stores, and what readers can see.
---

**Code snippet storage is off by default.** Code refs still keep paths, symbols,
line numbers and hashes. Cited files still pass through the server for checks.
Board content is not end-to-end encrypted. Hosted operators can read stored data.

## Three separate choices

| Choice | Where | What it controls |
|---|---|---|
| Store captured code text | Dashboard → Settings → Code | Whether your boards keep snippets and cited source lines |
| Let people read or edit a board | Board → Share, or workspace access controls | Who can open the board |
| Include sensitive layers in a link | Board → Share → Code / Threats | Whether link visitors see those layers |

Enabling snippet storage does not share a board. Disabling it does not stop
temporary file uploads or hide the board's other content. Including **Code**
in a link exposes code-ref metadata even when the board stores no snippet text.

## Use code refs without stored snippets

Leave **Store code snippets on my boards** off in dashboard **Settings → Code**.
This is also the default for self-hosted stacks.

The board keeps the file path, symbol, line range, git blob hash and hashes of
cited lines. These let refs follow code at checkpoints without stored code text.
Hashes can reveal whether a guessed line matches.

For a GitHub origin, **open on GitHub** appears after a checkpoint records a
pushed commit and no uncommitted change in the cited file. GitHub checks the
reader's repository access. A draw link grants no GitHub access.
Other refs show **not pushed yet** or **open in editor**.

## Opt in to inline snippets

1. Open dashboard **Settings → Code**.
2. Enable **Store code snippets on my boards**.
3. Ask your agent to refresh its refs or make another checkpoint.

Enabling storage does not restore old snippets immediately. Later code refs,
source citations and checkpoints fill them in. Each ref holds at most 60 lines
and 4,000 characters. A source citation can keep its cited line.

The setting applies to your boards, including boards owned by your linked
agent. Agents cannot enable consent for you. Ownership or agent-link changes
can delete text when the new effective owner has not opted in.

## Stop storing snippets

Disable **Store code snippets on my boards**. If your boards contain stored
snippets, the dashboard shows the affected board count and asks you to choose
**delete snippets**.

This deletes snippet text and stored citation lines from the live database.
Paths, ranges, hashes and links remain. You cannot undo the deletion. Existing
database backups retain deleted text until those backups expire.

## What leaves your machine

Drawing sends the content your agent writes: names, labels, docs, charts,
change notes, threats and review replies. draw stores this text as written.
Snippet consent does not scan or redact it. Do not ask the agent to paste code
or secrets into these fields.

For code refs, citations and checkpoints, the helper sends captures:

| Capture | Contents |
|---|---|
| Session start | Absolute checkout path, HEAD commit and GitHub repository address when available |
| Code ref or source citation | The cited file, including text outside the cited range |
| Checkpoint | Base and HEAD commits, changed and deleted paths, changed line ranges, cited files, pushed status and which cited files differ from HEAD |

The helper refuses ignored files, known secret filenames such as `.env`, binary
files and files larger than 1 MB. It does not scan file contents before upload.
A permitted source file can still contain sensitive text.
The server checks cited source lines for secrets and checks snippets before storage.
Without snippet storage, a code ref can keep hashes of sensitive lines.

The server reads each capture in memory to check the citation. Captures expire
within ten minutes and cannot be read again after the call claims them. Their
stored form is encrypted. The upload identifier supplies the decryption key,
which the service does not store.

Session metadata remains on the board until deletion. This includes the absolute
checkout path, commit and repository details, and paths the drawing does not cover.
Only board members see the session checkout path and its cited-file list.
Readers with code access can see ref paths, symbols, ranges and repository names.

## Who can read stored data

Board and workspace permissions control access in the app. A view link includes
code refs only when **Code** is enabled. An edit link always includes them.
A public board includes code refs but never threats. Stored snippets appear
only when the owner consents to their storage.

These controls do not exclude hosted operators. Maintainers with database or
deployment credentials can read stored board data, including opted-in snippets.
Operator reads are not logged. Hosted server credentials and infrastructure
providers also sit outside the per-board access boundary.

Hosted connections use HTTPS and secure WebSockets. draw makes no claim about
database disk encryption. [Self-hosting](/self-host/quickstart/) keeps this data
on infrastructure you control.

## Delete data

- Delete a board from the dashboard to delete its content and related records from the live database.
- Delete an architecture history to delete its versions and boards.
- Delete saved library items separately. Board deletion does not delete those items or your profile.
- For account deletion, contact support@redcrayon.ai. The support process deletes your account and boards within 30 days.

Account deletion has no self-service control. Database backups can retain deleted
board data until they expire. Revoking a
[share link](/capabilities/boards/#sharing) or [embed](/capabilities/embeds/)
ends that access. It cannot retract a copy someone already saved.

## Other hosted records

The service keeps your profile id, display name and last-seen time. Request logs
hold user and board ids, tool names, outcomes and timings, without labels, paths
or code. Platform logs last seven days. Usage analytics last about three months.
Monthly call counts have no expiry. A telemetry provider receives a copy of logs.
The canvas and dashboard load Google Fonts, which receives your IP address and browser information.
