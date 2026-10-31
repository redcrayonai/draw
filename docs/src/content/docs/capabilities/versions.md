---
title: Versions
description: Save versions of a board and restore any one as a new private board.
sidebar:
  order: 10
---

Versions is an optional plugin. A version is a complete copy of a board at
one moment. You can restore it later as a new private board. The board you saved
from does not change.

## Turn it on

A workspace owner or admin opens **Settings › Plugins** for the workspace and
sets **Versions** to **on**. It is off for every workspace until then.

Versions keeps its copies in a storage bucket. Whoever runs your draw server
connects one once for the whole server. Until then the switch stays off and
says it needs storage. See [Self-host](/self-host/quickstart/#versions-optional).

Turning it off stops saving, listing and restoring in that workspace. Saved
versions stay. Turn it on again to see them.

## Save and restore

On the dashboard, select a workspace board and open **Versions**.

- **Save version** needs edit access to the board.
- The list shows when each version was saved and by whom. Everyone who can read
  the board sees it.
- **Restore as copy** makes a new board in the same workspace. Only you can open it at first.
  Share it as usual. Restoring needs edit access to the board and full membership
  of the workspace.

Workspace owners and admins can also list and restore the versions of a board
that was deleted.

## What a version keeps

Nodes, edges, charts, icons, docs, hidden content and hide sets, code refs and
their line hashes, cited files, change notes, threats, marks and their replies,
and the session's checkpoint, route and last trace.

It does not keep:

- Code text. Code refs and citations come back without their snippets. The next
  checkpoint adds the code again where the owner allows it. See
  [Your data and code consent](/data-and-consent/).
- Access. Link shares, embeds, agent access, team access and other people's
  roles do not come back.
- Presence and live state: cursors, selections, and agents' claims on marks.
- Branch or import history. A restored branch or imported snapshot is an
  ordinary board.

Agents cannot save or restore versions.
