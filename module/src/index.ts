import type { EmbedGraph, EmbedScene } from './embed-contracts';
import { schema, table, t, SenderError } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import { checkEvidencePrefix, evidenceClass, parseCoverage } from './health-rules';
import { validateGraph, edgeKey, graphSignature, proposalSatisfied, type Graph } from './architecture';
import {
  parseChart,
  utf8Bytes,
  MAX_SOURCE_CHARS,
  MAX_LIBRARY_PAYLOAD_BYTES,
  CHART_MIN_W,
  CHART_MIN_H,
  SAMPLE_SOURCE,
  CHART_KIND_RULE,
  AGENT_SOURCE_RULE,
  SAMPLE_RESERVED,
  SAMPLE_NEEDS_SOURCE,
  HUMAN_DATA_NEEDS_SOURCE,
  HUMAN_SOURCE_RESERVED,
  isHumanSource,
  ARCHITECTURE_CHART_RULE,
} from './chart-contracts';
import {
  checkAliases,
  checkKind,
  checkSeverity,
  checkText,
  hasTerm,
  mergeSchemas,
  parseReaderInputs,
  parseReaders,
  parseSchema,
  parseSteps,
  parseSubjects,
  rebaseSteps,
  schemaCardHeight,
  storeSteps,
  termsOf,
  NOTE_JSON_RULE,
  READER_SUBJECT_RULE,
  READER_TERM_RULE,
  type Reader,
  type Schema,
  type Subject,
} from './change-notes';
import {
  checkSeverity as checkThreatSeverity,
  checkStage,
  checkThreatFields,
  checkThreatText,
  canRaiseStage,
  isThreatKind,
  parseFlags,
  parseSource,
  THREAT_STAGE_LOWER_RULE,
} from './threats';
import { ISSUERS } from './issuers'; // written per environment by scripts/module-env.mjs
import { LIMITS } from './limits';
import { ARCHITECTURE_ICON_RULE, ICON_IDS, ICON_KIND_RULE, ICON_NODE_KINDS, isIconId } from './node-icons';
import { isAccountSender, isBrowserSession, isLinkMode, isShareToken } from './link-share';
import { workspaceTables, workspaceFeatures, humanBoardRole, humanBoardIds, nativeBoardRole, membership, assignBoardWorkspace } from './workspaces';
import { workspaceServiceAccountTables, workspaceApiKeyExpiry, workspaceServiceAccountFeatures, isWorkspaceMachine, workspaceMachineBoardRole, workspaceMachineBoardIds, registerWorkspaceMachine } from './workspace-service-accounts';
import { roleRank, strongestRole } from './workspace-policy';
import { parseTraceSpans } from './trace';
import { backfillSlugs, newSlug } from './slug';
import { FEED_SIZE, KEEP_PER_BOARD, activityLayer, beyondKeep, newestFirst } from './activity-feed';
import {
  claimable,
  replyRefusal,
  validateReply,
  validateSend,
  LEASE_MICROS,
  SEAT_RE,
  staleWaiter,
  waiterDue,
  MARK_AGENTS_RULE,
  MARK_HUMANS_RULE,
  MARK_RECLAIMED_RULE,
  MARK_SEAT_MISMATCH_RULE,
  MARK_SEAT_RULE,
  MARK_SEND_RULE,
} from './marks';

const architectureHistory = table({}, {
  id: t.u64().primaryKey().autoInc(),
  owner: t.identity().index('btree'),
  name: t.string(),
  repository: t.string(),
  refsJson: t.string(),
  requestKey: t.string(),
  status: t.string(),
  error: t.string(),
  curationJson: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const boardCreation = table({}, {
  requestKey: t.string().primaryKey(),
  owner: t.identity().index('btree'),
  boardId: t.u64().index('btree'),
});

// RC-530: board activity waiting for the dashboard Worker to drain it into
// Postgres (service_outbox view, then ack_activity). Declared outside schema()
// so the service_outbox view can return its row type. Private, like every
// dashboard table.
const activityOutbox = table(
  {},
  {
    id: t.u64().primaryKey().autoInc(),
    boardId: t.u64().index('btree'),
    type: t.string(),
    actor: t.identity(),
    actorName: t.string(),
    actorKind: t.string(),
    at: t.timestamp(),
    lastAt: t.timestamp(),
    count: t.u32(),
    payload: t.string(), // JSON
  }
);

// Chart library: a person's saved selections (nodes, their chart rows, and the
// edges between them) as one JSON payload. Private; read only through the
// my_library view, so it is declared outside schema() for its row type.
// orgId leaves room for team libraries and is always '' in v1.
const libraryItem = table(
  {},
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    orgId: t.string(),
    name: t.string(),
    payload: t.string(), // JSON, LibraryPayloadV1
    createdAt: t.timestamp(),
  }
);

const tables = {
  ...workspaceTables,
  ...workspaceServiceAccountTables,
  workspaceApiKeyExpiry,
  architectureHistory,
  boardCreation,
  architectureVersion: table({}, {
    boardId: t.u64().primaryKey(),
    historyId: t.u64().index('btree'),
    index: t.u32(),
    assertionMode: t.string(),
    baseBoardId: t.u64().index('btree'),
    ref: t.string(),
    sha: t.string(),
    status: t.string(),
    requestKey: t.string(),
    reviewedSignature: t.string(),
    implementedBoardId: t.u64(),
  }),
  board: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      name: t.string(),
      // Appended last (see node.kind): older decoders read rows positionally.
      slug: t.string().default('').index('btree'),
    }
  ),
  node: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      label: t.string(),
      sublabel: t.string(),
      x: t.i32(),
      y: t.i32(),
      w: t.i32(),
      h: t.i32(),
      token: t.string(),
      focal: t.bool(),
      // stage 9: grounding metadata (defaults let pre-existing rows migrate)
      doc: t.string().default(''),
      hidden: t.bool().default(false),
      imported: t.bool().default(false),
      // canvas design: node kind drives the visual grammar. Kept LAST so
      // publishing over a pre-canvas database is a column *append* (auto
      // migrated, data preserved) rather than a reorder (manual migration).
      kind: t.string().default('service'),
      // Sub-project C: freeform styling. Appended AFTER kind for the same
      // reason kind itself is last — publishing over an existing database
      // must stay a column *append* (auto-migrated, data preserved) rather
      // than a reorder, which needs a manual migration.
      shape: t.string().default('rect'),
      // '' means "derive from kind", so every pre-C row keeps its semantic
      // look until someone deliberately recolours it.
      color: t.string().default(''),
      strokeStyle: t.string().default('solid'),
      size: t.string().default('m'),
      sourceKey: t.string().default(''),
    }
  ),
  edge: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      // indexed so deleteNode finds a node's edges without reading every board's edges
      fromNode: t.u64().index('btree'),
      toNode: t.u64().index('btree'),
      label: t.string(),
      // stage 9: every new edge carries evidence; legacy rows have ''
      evidence: t.string().default(''),
      hidden: t.bool().default(false),
      imported: t.bool().default(false),
      // Sub-project C, appended last. '' keeps the evidence overlay in charge
      // of an edge's appearance unless it has been styled by hand.
      color: t.string().default(''),
      strokeStyle: t.string().default('solid'),
      // RC-538: append for automatic migration; old source citations have no
      // anchor and must be treated as stale rather than adopting today's line.
      evidenceSnippet: t.string().default(''),
      evidenceStatus: t.string().default(''),
      relation: t.string().default(''),
      // Flow visuals, appended last: measured or estimated hop latency.
      // latencyMs < 0 = unknown; latencySource is '' then, else prod | local | estimate.
      latencyMs: t.f32().default(-1),
      latencySource: t.string().default(''),
    }
  ),
  // RC-688: an edge's line weight, set by hand. Its own table and view, not a
  // column on edge: visible_edge's public row shape is frozen
  // (scripts/check-wire-compat.mjs). A row exists only for a weight other than
  // regular, and goes with its edge.
  edgeWeight: table(
    {},
    {
      edgeId: t.u64().primaryKey(),
      boardId: t.u64().index('btree'),
      weight: t.string(), // 'medium' | 'bold'
    }
  ),
  // named hide-sets: a labeled editorial stance ("vendor libs", "schedulers")
  // that the chrome can enumerate and a reader can toggle. Rows belong to sets
  // via hide_set_member, so a row can be in several sets and a set is a
  // first-class, eventually shareable object.
  hideSet: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      name: t.string(),
      createdBy: t.string().default(''),
    }
  ),
  hideSetMember: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      setId: t.u64().index('btree'),
      targetKind: t.string(),
      targetId: t.u64().index('btree'),
    }
  ),
  // files present in the repo an import came from — the validation set for
  // source:<path>:<line> citations
  repoFile: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      path: t.string(),
    }
  ),
  // Build companion: one row per session board (1:1 with board). boardId is
  // .unique(), which already creates the btree index — do not add a second
  // one. New table, so publishing is additive (no column migration).
  session: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().unique(),
      repoRoot: t.string(),
      baseSha: t.string(),
      headSha: t.string(),
      checkpoint: t.u32(),
      coverage: t.string(),
      startedAt: t.timestamp(),
      updatedAt: t.timestamp(),
    }
  ),
  sessionRoute: table(
    {},
    {
      boardId: t.u64().primaryKey(),
      nodeIds: t.array(t.u64()),
      currentIndex: t.i32().default(-1),
      revision: t.u32().default(1),
      currentCheckpoint: t.u32().default(0),
      updatedAt: t.timestamp(),
    }
  ),
  // The latest trace played on a board (play_trace): whitelisted spans as
  // JSON. seq grows with each play so every viewer replays the new one.
  tracePlayback: table(
    {},
    {
      boardId: t.u64().primaryKey(),
      spans: t.string(),
      source: t.string(),
      title: t.string(),
      seq: t.u32(),
      playedAt: t.timestamp(),
    }
  ),
  routeEvent: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      kind: t.string(),
      revision: t.u32(),
      nodeId: t.option(t.u64()),
      nodeIds: t.array(t.u64()),
      reason: t.string(),
      checkpoint: t.u32(),
      at: t.timestamp(),
    }
  ),
  // Build companion: a code ref points a node or edge at a symbol in the
  // session's repo. The snippet is read from disk by the MCP server at the
  // checkpoint, never typed by the model. symbol is the ref's identity;
  // startLine/endLine/snippet/blobSha are a cache refreshed by re-anchoring.
  codeRef: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      targetKind: t.string(),
      targetId: t.u64().index('btree'),
      path: t.string(),
      symbol: t.string(),
      startLine: t.u32(),
      endLine: t.u32(),
      blobSha: t.string(),
      snippet: t.string(),
      author: t.string(),
      checkpoint: t.u32(),
      status: t.string(),
    }
  ),
  // Chart objects: the data of a node with kind 'chart', one row per chart
  // node, keyed by its id. A new table, so publishing is additive; no column
  // is added to node. parseChart (chart-contracts.ts) checks every write.
  // Private like the graph tables; clients read it through visible_chart.
  chart: table(
    {},
    {
      nodeId: t.u64().primaryKey(),
      boardId: t.u64().index('btree'),
      type: t.string(),
      csv: t.string(),
      options: t.string(), // JSON
      source: t.string(), // never empty
      updatedAt: t.timestamp(), // the client's render cache key
    }
  ),
  // Node icons (spec 2026-10-18, RC-687): the library icon or logo a node shows,
  // one row per decorated node, keyed by its id. A new table, so publishing is
  // additive; no column is added to node. node-icons.ts lists the ids.
  // Private like the graph tables; clients read it through visible_node_icon.
  nodeIcon: table(
    {},
    {
      nodeId: t.u64().primaryKey(),
      boardId: t.u64().index('btree'),
      icon: t.string(),
    }
  ),
  // Change notes (spec 2026-10-16): an agent flags a big or risky change on the
  // node it is about. A new table, so publishing is additive. steps, schema,
  // subjects and readers are JSON that change-notes.ts checks on every write.
  // Private like the graph tables; clients read it through visible_change_note.
  changeNote: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      anchorId: t.u64().index('btree'),
      refId: t.u64().index('btree'),
      kind: t.string(),
      severity: t.string(),
      title: t.string(),
      summary: t.string(),
      steps: t.string(),
      schema: t.string(),
      subjects: t.string(),
      readers: t.string(),
      // the main ref's file sha at the latest checkpoint; a review holds while it matches reviewedSha
      refFileSha: t.string(),
      author: t.string(),
      checkpoint: t.u32(),
      reviewedBy: t.string(),
      reviewedAt: t.timestamp(),
      reviewedSha: t.string(),
    }
  ),
  // Threats (spec 2026-10-16): an agent flags a service, datastore or external node as
  // vulnerable or compromised. A new table, so publishing is additive. flags and source are
  // JSON that threats.ts checks on every write. Members only: clients read it through
  // visible_threat, which never follows a link visit or a public board.
  threat: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      anchorId: t.u64().index('btree'),
      stage: t.string(),
      severity: t.string(),
      title: t.string(),
      summary: t.string(),
      cvss: t.string(),
      package: t.string(),
      fixedIn: t.string(),
      flags: t.string(), // JSON
      source: t.string(), // JSON
      author: t.string(),
      createdAt: t.timestamp(),
      containedBy: t.string(),
      containedAt: t.timestamp(),
    }
  ),
  // Red crayon review (spec 2026-10-19): a person circles nodes and sends a round of marks; agents claim
  // them under a lease (claimGen is the fencing token) and answer. New tables, so publishing is additive.
  // Read through visible_mark*, never by link visitors on a view link or public readers (D14).
  mark: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      nodeId: t.u64().index('btree'),
      nodeLabel: t.string(), // at Send, so a deleted node's mark still names it
      note: t.string(),
      author: t.identity(),
      round: t.u32(),
      preferredAgent: t.string(), // identity hex from nodeTouch, or ''
      claimedBy: t.string(), // '<identity hex>/<seat>', or ''
      leaseUntil: t.timestamp(),
      claimGen: t.u32(),
      status: t.string(), // sent | claimed | fixed | kept
      reply: t.string(),
      files: t.string(), // JSON array of paths
      sentAt: t.timestamp(),
      answeredAt: t.timestamp(),
    }
  ),
  // The last claim_marks of each seat: the canvas says whether an agent is listening.
  markWaiter: table(
    {},
    {
      owner: t.string().primaryKey(), // '<identity hex>/<seat>'
      boardId: t.u64().index('btree'),
      lastWaitAt: t.timestamp(),
    }
  ),
  // Each person's read cursor per board, for the replies badge.
  markRead: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      identity: t.identity().index('btree'),
      boardId: t.u64().index('btree'),
      lastReadAt: t.timestamp(),
    }
  ),
  // The agent that last created or edited each node: a mark's preferredAgent (first dibs). Private, no view.
  // A side table, as a column on node would change the public visible_node row.
  nodeTouch: table(
    {},
    {
      nodeId: t.u64().primaryKey(),
      boardId: t.u64().index('btree'),
      agent: t.string(),
    }
  ),
  // RC-605: boardId is indexed so the views read one board's rows, not the
  // table. An index on an existing column is an automatic migration.
  cursor: table(
    {},
    {
      identity: t.identity().primaryKey(),
      boardId: t.u64().index('btree'),
      x: t.f32(),
      y: t.f32(),
    }
  ),
  selection: table(
    {},
    {
      identity: t.identity().primaryKey(),
      boardId: t.u64().index('btree'),
      nodeIds: t.array(t.u64()),
    }
  ),
  participant: table(
    {},
    {
      identity: t.identity().primaryKey(),
      displayName: t.string(),
      kind: t.string(),
      connectedAt: t.timestamp(),
      // RC-528: participant rows are durable per stable OIDC identity.
      // Defaults let pre-existing rows migrate (same rule as stage 9).
      // connections counts live connections; 0 means offline, row kept.
      connections: t.u32().default(0),
      lastSeenAt: t.timestamp().default(Timestamp.UNIX_EPOCH),
      // Raw `iss` claim of the caller's JWT, for audit/attribution only.
      // NOT an auth discriminator: anonymous connections carry the host's
      // local issuer ('localhost' on a hosted server), CLI tokens carry
      // auth.spacetimedb.com, and until RC-529 any OIDC issuer is accepted.
      authIssuer: t.string().default(''),
    }
  ),
  // RC-530 dashboard. Every table from here on is NEW and private: clients
  // read them only through the views at the end of this file, and publishing
  // adds tables without disconnecting anyone. Dashboard state never goes into
  // new columns on the tables above.
  //
  // Board health, precomputed by refreshStats on every content write so the
  // my_boards view never reads node/edge/code_ref. One row per board.
  boardStats: table(
    {},
    {
      boardId: t.u64().primaryKey(),
      createdBy: t.identity(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
      nodes: t.u32(),
      shownNodes: t.u32(),
      edges: t.u32(),
      shownEdges: t.u32(),
      // evidence mix over SHOWN edges, the canvas legend's rule
      evImport: t.u32(),
      evSource: t.u32(),
      evTest: t.u32(),
      evHuman: t.u32(),
      evNone: t.u32(),
      refsOk: t.u32(),
      refsStale: t.u32(),
      refsAmbiguous: t.u32(),
      repoFiles: t.u32(),
      isSession: t.bool(),
      sessionCheckpoint: t.u32(),
      sessionUpdatedAt: t.timestamp(),
      covChanged: t.u32(),
      covOnBoard: t.u32(),
      covExcluded: t.u32(),
      covUncovered: t.u32(),
      covDeleted: t.u32(),
      // last board.stats snapshot written to the outbox
      snapshotAt: t.timestamp(),
      // outbox row the next same-type event may merge into; 0 = none
      lastEventId: t.u64(),
      // RC-538 stale source citations (not proven). Appended with a default so
      // a database that already has board_stats migrates automatically.
      evStale: t.u32().default(0),
    }
  ),
  // Who lists a board on their dashboard. role is 'owner' (the creator)
  // until RC-529 brings real roles.
  boardGrant: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      grantee: t.identity().index('btree'),
      role: t.string(),
    }
  ),
  // Identities trusted with the service reducers (the dashboard Worker).
  // The database owner seeds rows with SQL; no reducer adds one.
  serviceAccount: table(
    {},
    {
      identity: t.identity().primaryKey(),
      label: t.string(),
    }
  ),
  guestBoard: table({}, {
    identity: t.identity().primaryKey(),
    boardId: t.u64().unique(),
  }),
  guestClaimOffer: table({}, {
    code: t.string().primaryKey(),
    boardId: t.u64().unique(),
    guest: t.identity(),
    expiresAt: t.timestamp(),
  }),
  activityOutbox,
  libraryItem,
  // A board shared with a team (an organization).
  teamGrant: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      orgId: t.string().index('btree'),
      grantedBy: t.identity(),
    }
  ),
  // Service-written projection of organization memberships, keyed by the member's
  // SpacetimeDB identity (the Worker derives it from iss|sub).
  orgMember: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      member: t.identity().index('btree'),
      orgId: t.string().index('btree'),
      role: t.string(),
    }
  ),
  // Boards every caller lists (the seeded Demo).
  publicBoard: table(
    {},
    {
      boardId: t.u64().primaryKey(),
    }
  ),
  // One pending pairing offer per agent; redeemed once, within 30 minutes.
  agentLinkOffer: table(
    {},
    {
      code: t.string().primaryKey(),
      agent: t.identity().unique(),
      expiresAt: t.timestamp(),
    }
  ),
  // A linked agent's boards are listed on its owner's dashboard.
  agentLink: table(
    {},
    {
      agent: t.identity().primaryKey(),
      owner: t.identity().index('btree'),
      linkedAt: t.timestamp(),
    }
  ),
  // One board an owner shares with one of their linked agents (read and edit).
  // Honored only while the agent is linked; deleted with the link, the board
  // or the board's owner (unlinkAgent, redeemAgentLink, deleteBoard,
  // claimGuestBoard) and by revokeAgentBoard.
  agentGrant: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      agent: t.identity().index('btree'),
      grantedBy: t.identity(),
    }
  ),
  // Anyone-with-the-link sharing: one link per board. The owner's browser
  // makes the token; ctx.random is timestamp-seeded, so it cannot make a secret.
  linkShare: table(
    {},
    {
      boardId: t.u64().primaryKey(),
      token: t.string().unique(),
      mode: t.string(), // 'view' | 'edit'
      createdBy: t.identity(),
      createdAt: t.timestamp(),
      // Appended last (see node.kind). Layers a link visitor also sees; off unless the owner turns them on.
      includeThreats: t.bool().default(false),
      includeCode: t.bool().default(false), // code refs and edge source snippets
    }
  ),
  // One row per person who opened a board's link. It counts only while the
  // board's linkShare row exists; stopLinkShare and deleteBoard delete it.
  linkVisit: table(
    {},
    {
      id: t.u64().primaryKey().autoInc(),
      boardId: t.u64().index('btree'),
      viewer: t.identity().index('btree'),
      openedAt: t.timestamp(),
    }
  ),
  // Chart embeds are independent capabilities, never board grants or link visits.
  chartEmbed: table({}, {
    nodeId: t.u64().primaryKey(),
    boardId: t.u64().index('btree'),
    token: t.string().unique(),
  }),
  // One capability per live connection. Nothing is persisted in a viewer's browser.
  chartEmbedVisit: table({}, {
    connectionId: t.connectionId().primaryKey(),
    viewer: t.identity().index('btree'),
    nodeId: t.u64().index('btree'),
    token: t.string(),
  }),
  boardEmbed: table({}, {
    boardId: t.u64().primaryKey(), token: t.string().unique(),
    createdBy: t.identity(), threats: t.bool(), comparisonBoardId: t.u64().index('btree'),
  }),
  boardEmbedVisit: table({}, {
    connectionId: t.connectionId().primaryKey(), viewer: t.identity().index('btree'),
    boardId: t.u64().index('btree'), token: t.string(),
  }),
  // RC-605: the boards each canvas connection shows (openBoards), closed when it
  // disconnects (closeBoards). A sender with a row gets only those boards' rows
  // from the board views; agents, the MCP server and the dashboard have none and
  // read every board they can, as before.
  openBoard: table(
    {},
    {
      connectionId: t.connectionId().primaryKey(),
      identity: t.identity().index('btree'),
      boardIds: t.array(t.u64()),
    }
  ),
  // RC-568: when resetDemo last put Demo back to its seed, so an unchanged Demo is not reset again.
  demoReset: table(
    {},
    {
      boardId: t.u64().primaryKey(),
      resetAt: t.timestamp(),
    }
  ),
  // RC-571: each sender's write budget (spendWrite). Private: no view reads it.
  writeBudget: table(
    {},
    {
      identity: t.identity().primaryKey(),
      tokens: t.f64(),
      refilledAt: t.timestamp(),
    }
  ),
  // RC-690: whether a member's boards keep code text (codeRef.snippet, edge.evidenceSnippet).
  // No row means off. key is `<scope>:<subject>`; only scope 'user' (subject: identity hex)
  // exists at launch, 'org' and 'team' are reserved. Read through storesCode and the views.
  codeConsent: table(
    {},
    {
      key: t.string().primaryKey(),
      scope: t.string(),
      subject: t.string(),
      storeCode: t.bool(),
      updatedBy: t.identity(),
      updatedAt: t.timestamp(),
    }
  ),
  // RC-690: what lets a ref or citation follow its code without its text. Side tables, not columns:
  // visible_code_ref and visible_edge rows are frozen (scripts/check-wire-compat.mjs). A hash is the
  // first 32 lowercase hex chars of the line's SHA-256; writers compute it, the module stores it.
  // Each row goes with its ref or edge.
  codeRefHash: table(
    {},
    {
      refId: t.u64().primaryKey(),
      boardId: t.u64().index('btree'),
      lineHashes: t.string(), // one hash per line of the range, space-joined, in order
    }
  ),
  edgeEvidenceHash: table(
    {},
    {
      edgeId: t.u64().primaryKey(),
      boardId: t.u64().index('btree'),
      lineHash: t.string(),
    }
  ),
  // A session's repo remote, the last checkpoint's HEAD if it was pushed ('' if not), and the cited
  // paths that differed from HEAD then: the canvas links a ref to GitHub from these.
  sessionRemote: table(
    {},
    {
      boardId: t.u64().primaryKey(),
      remoteUrl: t.string(),
      pushedHead: t.string(),
      dirtyPaths: t.array(t.string()),
    }
  ),
};

const spacetimedb = schema(tables);

export default spacetimedb;

const EmbeddedChart = t.object('EmbeddedChartData', {
  token: t.string(), title: t.string(), subtitle: t.string(),
  type: t.string(), csv: t.string(), options: t.string(), source: t.string(),
});

// Deliberately does not return a Node or Chart row: those carry board IDs,
// docs and other metadata. Every read rechecks the current capability.
export const embeddedChart = spacetimedb.view({ name: 'embedded_chart', public: true }, t.array(EmbeddedChart), ctx => {
  if (isWorkspaceMachine(ctx) || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return [];
  const out = new Map<string, any>();
  for (const visit of ctx.db.chartEmbedVisit.viewer.filter(ctx.sender)) {
    const embed = ctx.db.chartEmbed.nodeId.find(visit.nodeId);
    if (!embed || embed.token !== visit.token) continue;
    const chart = ctx.db.chart.nodeId.find(embed.nodeId);
    const node = ctx.db.node.id.find(embed.nodeId);
    if (!chart || !node || node.kind !== 'chart' || chart.boardId !== embed.boardId || node.boardId !== embed.boardId) continue;
    out.set(embed.token, { token: embed.token, title: node.label, subtitle: node.sublabel,
      type: chart.type, csv: chart.csv, options: chart.options, source: chart.source });
  }
  return [...out.values()];
});

const ChartEmbedLink = t.object('ChartEmbedLink', { nodeId: t.u64(), token: t.string() });
export const myChartEmbeds = spacetimedb.view({ name: 'my_chart_embeds', public: true }, t.array(ChartEmbedLink), ctx => {
  return [...humanBoardIds(ctx)].filter(boardId => ownsBoard(ctx, boardId))
    .flatMap(boardId => [...ctx.db.chartEmbed.boardId.filter(boardId)].map(e => ({ nodeId: e.nodeId, token: e.token })));
});

// Board publication is also a projection, never a grant to the editor's views.
const BoardEmbedData = t.object('BoardEmbedData', { token: t.string(), title: t.string(), scene: t.string() });
const BoardEmbedLink = t.object('BoardEmbedLink', {
  boardId: t.u64(), token: t.string(), threats: t.bool(), comparisonBoardId: t.u64(),
});
function embedOwner(ctx: any, boardId: bigint, owner: any): boolean {
  return ownsBoardAs(ctx, boardId, owner);
}
export const myBoardEmbeds = spacetimedb.view({ name: 'my_board_embeds', public: true }, t.array(BoardEmbedLink), ctx => {
  return [...humanBoardIds(ctx)].filter(boardId => ownsBoard(ctx, boardId)).flatMap(boardId => {
    const e = ctx.db.boardEmbed.boardId.find(boardId);
    return e ? [{ boardId: e.boardId, token: e.token, threats: e.threats, comparisonBoardId: e.comparisonBoardId }] : [];
  });
});
export const embeddedBoard = spacetimedb.view({ name: 'embedded_board', public: true }, t.array(BoardEmbedData), ctx => {
  if (isWorkspaceMachine(ctx) || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return [];
  const out = new Map<string, any>();
  for (const visit of ctx.db.boardEmbedVisit.viewer.filter(ctx.sender)) {
    const e = ctx.db.boardEmbed.boardId.find(visit.boardId);
    const board = ctx.db.board.id.find(visit.boardId);
    if (!e || !board || e.token !== visit.token || !embedOwner(ctx, e.boardId, e.createdBy)) continue;
    // Opaque keys let the diff match snapshots without publishing source paths.
    const keys = new Map<string, string>();
    const graph = (boardId: bigint): EmbedGraph => {
      const nodes = [...ctx.db.node.boardId.filter(boardId)].filter(n => !n.hidden);
      const ids = new Set(nodes.map(n => n.id));
      return {
        nodes: nodes.map(n => {
          const source = n.sourceKey || `legacy:${n.id}`;
          if (!keys.has(source)) keys.set(source, String(keys.size));
          return { id: String(n.id), key: keys.get(source)!, label: n.label, sublabel: n.sublabel,
            x: n.x, y: n.y, w: n.w, h: n.h, token: n.token, focal: n.focal,
            kind: n.kind, shape: n.shape, color: n.color, strokeStyle: n.strokeStyle, size: n.size,
            icon: ctx.db.nodeIcon.nodeId.find(n.id)?.icon ?? '' };
        }),
        edges: [...ctx.db.edge.boardId.filter(boardId)].filter(x => !x.hidden && ids.has(x.fromNode) && ids.has(x.toNode)).map(x => ({
          id: String(x.id), fromNode: String(x.fromNode), toNode: String(x.toNode), label: x.label,
          color: x.color, strokeStyle: x.strokeStyle, relation: x.relation, latencyMs: x.latencyMs,
          weight: ctx.db.edgeWeight.edgeId.find(x.id)?.weight ?? 'regular',
        })),
        charts: [...ctx.db.chart.boardId.filter(boardId)].filter(x => ids.has(x.nodeId)).map(x => ({
          nodeId: String(x.nodeId), type: x.type, csv: x.csv, options: x.options, source: x.source, updatedAt: String(x.updatedAt.microsSinceUnixEpoch),
        })),
      };
    };
    const current = graph(e.boardId);
    const ids = new Set(current.nodes.map(n => n.id));
    const before = e.comparisonBoardId !== 0n && ctx.db.board.id.find(e.comparisonBoardId) && embedOwner(ctx, e.comparisonBoardId, e.createdBy)
      ? graph(e.comparisonBoardId) : null;
    const scene: EmbedScene = { ...current, before,
      route: (ctx.db.sessionRoute.boardId.find(e.boardId)?.nodeIds ?? []).map(String).filter(id => ids.has(id)),
      threats: e.threats ? [...ctx.db.threat.boardId.filter(e.boardId)].filter(x => ids.has(String(x.anchorId)) && x.containedBy === '').map(x => ({
        id: String(x.id), anchorId: String(x.anchorId), title: x.title, stage: x.stage, severity: x.severity,
      })) : [],
    };
    out.set(e.token, { token: e.token, title: board.name, scene: JSON.stringify(scene) });
  }
  return [...out.values()];
});

// Native RLS on server 2.8.1 cannot subscribe through nested/private ACLs.
// Views keep raw graph, companion and permission rows private.
// Each view reads its rows through the board index, so a connect costs the
// caller's boards, not every board. board and architectureVersion list every
// readable board (the switcher, ⌘K, the history rail); the rest return the
// boards the caller has open (viewBoardIds, RC-605).
export const visibleRows = spacetimedb.exportGroup({
  ...Object.fromEntries(['board', 'architectureVersion', 'node', 'edge', 'edgeWeight', 'hideSet', 'sessionRoute', 'routeEvent', 'chart', 'tracePlayback', 'changeNote', 'nodeIcon'].map(key => [
    `visible${key[0].toUpperCase()}${key.slice(1)}`,
    spacetimedb.view({ name: `visible_${key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}`, public: true }, t.array((tables as any)[key].rowType) as any, ctx => {
      const ids = key === 'board' || key === 'architectureVersion' ? readableBoardIds(ctx) : viewBoardIds(ctx);
      const index = (ctx.db as any)[key][key === 'board' ? 'id' : 'boardId'];
      // A btree index has filter; a primary key or unique column has find.
      const rows = [...ids].flatMap(id => (index.filter ? [...index.filter(id)] : index.find(id) ?? []));
      // A branch's sha is the fork-time base signature, server-side only.
      if (key === 'architectureVersion') return rows.map((row: any) => (row.historyId === 0n && row.sha !== '' ? { ...row, sha: '' } : row));
      if (key !== 'edge') return rows;
      // A source citation's captured line is code: a link that leaves code out gets the edge without it.
      const code = codeViewBoardIds(ctx);
      return rows.map((row: any) => (code.has(row.boardId) || row.evidenceSnippet === '' ? row : { ...row, evidenceSnippet: '' }));
    }),
  ])),
  // Not in the shared list above: that one follows readableBoardIds (link visits, public boards). Code refs and
  // threats reach link visitors only when the owner included them (linkShare.include*); repo files, session
  // paths and sign-in issuers are members only.
  visibleCodeRef: spacetimedb.view({ name: 'visible_code_ref', public: true }, t.array(tables.codeRef.rowType), ctx => {
    return [...codeViewBoardIds(ctx)].flatMap(id => [...ctx.db.codeRef.boardId.filter(id)]);
  }),
  // RC-690: under the code refs' rule. Edit links read them too: undo writes them back.
  visibleCodeRefHash: spacetimedb.view({ name: 'visible_code_ref_hash', public: true }, t.array(tables.codeRefHash.rowType), ctx => {
    return [...codeViewBoardIds(ctx)].flatMap(id => [...ctx.db.codeRefHash.boardId.filter(id)]);
  }),
  visibleEdgeEvidenceHash: spacetimedb.view({ name: 'visible_edge_evidence_hash', public: true }, t.array(tables.edgeEvidenceHash.rowType), ctx => {
    return [...codeViewBoardIds(ctx)].flatMap(id => [...ctx.db.edgeEvidenceHash.boardId.filter(id)]);
  }),
  visibleSessionRemote: spacetimedb.view({ name: 'visible_session_remote', public: true }, t.array(tables.sessionRemote.rowType), ctx => {
    return [...codeViewBoardIds(ctx)].flatMap(id => ctx.db.sessionRemote.boardId.find(id) ?? []);
  }),
  // Never on public boards: a published board must not announce "auth-svc is vulnerable to CVE X".
  visibleThreat: spacetimedb.view({ name: 'visible_threat', public: true }, t.array(tables.threat.rowType), ctx => {
    const open = openBoardIds(ctx);
    return [...linkLayerBoardIds(ctx, 'threats')].filter(id => open?.has(id) ?? true).flatMap(id => [...ctx.db.threat.boardId.filter(id)]);
  }),
  // Marks and their waiters: members and edit-link visitors (markBoardIds); read cursors: the sender's own.
  visibleMark: spacetimedb.view({ name: 'visible_mark', public: true }, t.array(tables.mark.rowType), ctx => {
    return [...markBoardIds(ctx)].flatMap(id => [...ctx.db.mark.boardId.filter(id)]);
  }),
  visibleMarkWaiter: spacetimedb.view({ name: 'visible_mark_waiter', public: true }, t.array(tables.markWaiter.rowType), ctx => {
    return [...markBoardIds(ctx)].flatMap(id => [...ctx.db.markWaiter.boardId.filter(id)]);
  }),
  visibleMarkRead: spacetimedb.view({ name: 'visible_mark_read', public: true }, t.array(tables.markRead.rowType), ctx => {
    return [...ctx.db.markRead.identity.filter(ctx.sender)];
  }),
  // Who has a board open that the sender may mark on (markBoardIds, never readers): the marks watcher stops when nobody does.
  visibleBoardPeople: spacetimedb.view({ name: 'visible_board_people', public: true }, t.array(tables.openBoard.rowType), ctx => {
    const boards = markBoardIds(ctx);
    if (boards.size === 0) return [];
    // shortcut: boardIds is an array (no index), so this scans one row per open canvas; index per board if canvases reach the thousands.
    // Return the intersection: a row's other open boards may be private to the reader.
    return [...ctx.db.openBoard.iter()]
      .map(row => ({ ...row, boardIds: row.boardIds.filter((id: bigint) => boards.has(id)) }))
      .filter(row => row.boardIds.length > 0);
  }),
  // A session's file list is every path the owner's repo tracks; its readers (the agent, the MCP server) are members.
  visibleRepoFile: spacetimedb.view({ name: 'visible_repo_file', public: true }, t.array(tables.repoFile.rowType), ctx => {
    const open = openBoardIds(ctx);
    return [...memberBoardIds(ctx)].filter(id => open?.has(id) ?? true).flatMap(id => [...ctx.db.repoFile.boardId.filter(id)]);
  }),
  // repoRoot is the owner's checkout path (/Users/<name>/src/<private repo>): '' unless the reader is a member.
  visibleSession: spacetimedb.view({ name: 'visible_session', public: true }, t.array(tables.session.rowType), ctx => {
    const members = memberBoardIds(ctx);
    return [...viewBoardIds(ctx)].flatMap(id => ctx.db.session.boardId.find(id) ?? []).map(s => (members.has(s.boardId) ? s : { ...s, repoRoot: '' }));
  }),
  visibleHideSetMember: spacetimedb.view({ name: 'visible_hide_set_member', public: true }, t.array(tables.hideSetMember.rowType), ctx => {
    const ids = viewBoardIds(ctx);
    return [...ids].flatMap(id => [...ctx.db.hideSet.boardId.filter(id)]).flatMap(set => [...ctx.db.hideSetMember.setId.filter(set.id)]);
  }),
  visibleCursor: spacetimedb.view({ name: 'visible_cursor', public: true }, t.array(tables.cursor.rowType), ctx => presenceRows(ctx, [ctx.db.cursor])),
  // Also each linked agent's selection on a board the caller can read: the
  // Connect dialog names the board the agent is drawing on.
  visibleSelection: spacetimedb.view({ name: 'visible_selection', public: true }, t.array(tables.selection.rowType), ctx => {
    const rows = presenceRows(ctx, [ctx.db.selection]);
    const here = new Set(rows.map(row => row.identity.toHexString()));
    for (const linked of ctx.db.agentLink.owner.filter(ctx.sender)) {
      const row = ctx.db.selection.identity.find(linked.agent);
      if (row && !here.has(row.identity.toHexString()) && canReadBoard(ctx, row.boardId)) rows.push(row);
    }
    return rows;
  }),
  visibleParticipant: spacetimedb.view({ name: 'visible_participant', public: true }, t.array(tables.participant.rowType), ctx => {
    if (isService(ctx)) return [...ctx.db.participant.iter()];
    // Look each actor up by its key: participant rows are never deleted, so a scan of the table would
    // grow with every visitor and run on every connect (a call cost 149 ms at 30,000 participants).
    const actors = new Map<string, any>([[ctx.sender.toHexString(), ctx.sender]]);
    for (const linked of ctx.db.agentLink.owner.filter(ctx.sender)) actors.set(linked.agent.toHexString(), linked.agent);
    for (const row of presenceRows(ctx, [ctx.db.cursor, ctx.db.selection])) actors.set(row.identity.toHexString(), row.identity);
    // authIssuer names the sign-in provider's host (vendor or corporate SSO): the caller's own only.
    return [...actors.values()].flatMap(identity => ctx.db.participant.identity.find(identity) ?? [])
      .map(p => (p.identity.isEqual(ctx.sender) ? p : { ...p, authIssuer: '' }));
  }),
  visibleArchitectureHistory: spacetimedb.view({ name: 'visible_architecture_history', public: true }, t.array(architectureHistory.rowType), ctx => {
    if (isService(ctx)) return [...ctx.db.architectureHistory.iter()];
    const out = new Map<bigint, any>();
    for (const member of ctx.db.workspaceMember.member.filter(ctx.sender)) {
      if (!['owner', 'admin'].includes(member.role)) continue;
      for (const scope of ctx.db.historyWorkspace.workspaceId.filter(member.workspaceId)) {
        const history = ctx.db.architectureHistory.id.find(scope.historyId);
        if (history) out.set(history.id, history);
      }
    }
    for (const row of ctx.db.architectureHistory.owner.filter(ctx.sender)) out.set(row.id, row);
    for (const linked of ctx.db.agentLink.owner.filter(ctx.sender)) {
      for (const row of ctx.db.architectureHistory.owner.filter(linked.agent)) out.set(row.id, row);
    }
    for (const boardId of readableBoardIds(ctx)) {
      const version = ctx.db.architectureVersion.boardId.find(boardId);
      const row = version && ctx.db.architectureHistory.id.find(version.historyId);
      if (row) out.set(row.id, row);
    }
    return [...out.values()].filter(h => canReadArchitectureHistory(ctx, h));
  }),
});

const ALLOWED_TOKENS = ['ink', 'muted', 'accent'];
// 'chart' nodes are made only by createChart (they need a chart row); see
// the guards in createNode and updateNode.
const ALLOWED_KINDS = ['service', 'datastore', 'external', 'boundary', 'note', 'text', 'chart'];
// 'diamond' is deliberately absent: the renderer has no diamond case, and an
// allowlist must not offer a value that silently renders as a rectangle.
const ALLOWED_SHAPES = ['rect', 'ellipse', 'pill'];
// '' is legal and means "derive from kind/token" — the pre-C behaviour.
const ALLOWED_COLORS = ['', 'ink', 'blue', 'red', 'green', 'purple', 'gray'];
const ALLOWED_STROKES = ['solid', 'dashed'];
// RC-688: an edge can also be dotted; a node border cannot (no renderer).
const ALLOWED_EDGE_STROKES = ['solid', 'dashed', 'dotted'];
const ALLOWED_EDGE_WEIGHTS = ['regular', 'medium', 'bold'];
const ALLOWED_SIZES = ['s', 'm', 'l'];
const FOCAL_LIMIT = 2;
const GRID = 4;

function assertOnGrid(field: string, value: number): void {
  if (value % GRID !== 0) {
    throw new SenderError(
      `grid rule: ${field} = ${value} is not divisible by ${GRID}; all coordinates and dimensions must sit on the ${GRID}px grid`
    );
  }
}

function assertToken(token: string): void {
  if (!ALLOWED_TOKENS.includes(token)) {
    throw new SenderError(
      `token '${token}' is not allowed; must be one of: ${ALLOWED_TOKENS.join(', ')}`
    );
  }
}

function assertKind(kind: string): void {
  if (!ALLOWED_KINDS.includes(kind)) {
    throw new SenderError(
      `kind '${kind}' is not allowed; must be one of: ${ALLOWED_KINDS.join(', ')}`
    );
  }
}

function assertOneOf(field: string, value: string, allowed: string[]): void {
  if (!allowed.includes(value)) {
    throw new SenderError(
      `${field} '${value}' is not allowed; must be one of: ${allowed
        .map(a => (a === '' ? "'' (derive from kind)" : a))
        .join(', ')}`
    );
  }
}

function assertStyle(style: {
  shape: string;
  color: string;
  strokeStyle: string;
  size: string;
}): void {
  assertOneOf('shape', style.shape, ALLOWED_SHAPES);
  assertOneOf('color', style.color, ALLOWED_COLORS);
  assertOneOf('strokeStyle', style.strokeStyle, ALLOWED_STROKES);
  assertOneOf('size', style.size, ALLOWED_SIZES);
}

function assertBoardExists(ctx: any, boardId: bigint): void {
  if (!ctx.db.board.id.find(boardId)) {
    throw new SenderError(`board ${boardId} does not exist`);
  }
}

function findNodeOrThrow(ctx: any, nodeId: bigint): any {
  const node = ctx.db.node.id.find(nodeId);
  if (!node) {
    throw new SenderError(`node ${nodeId} does not exist`);
  }
  assertBoardWrite(ctx, node.boardId);
  return node;
}

function assertFocalCapacity(ctx: any, boardId: bigint, excludeNodeId?: bigint): void {
  let count = 0;
  for (const n of ctx.db.node.boardId.filter(boardId)) {
    if (n.focal && n.id !== excludeNodeId) {
      count++;
    }
  }
  if (count >= FOCAL_LIMIT) {
    throw new SenderError(
      `focal limit: board ${boardId} already has ${FOCAL_LIMIT} focal nodes; demote one before promoting another`
    );
  }
}

// Hosted MCP (spec §2, §8 Items 1 and 2). Our Worker mints ES256 tokens for the
// database with iss ISSUERS.ours, aud 'redcrayon-db' and a sub of agent:<browser
// user id>, machine:<key id>, guest:<uuid> or service:mcp. The database checks the signature but
// never `aud`, so the audience check here is the only one.
function fromUs(ctx: any): boolean {
  const jwt = ctx.senderAuth.jwt;
  return ISSUERS.ours !== '' && jwt?.issuer === ISSUERS.ours && jwt.audience.includes('redcrayon-db');
}

function hostedAgent(ctx: any): boolean {
  return fromUs(ctx) && /^(agent:|machine:[0-9a-f]{32}$)/.test(ctx.senderAuth.jwt.subject);
}

// Our tokens, browser session tokens issued to one of our apps (`azp`, or
// `aud` without one: isBrowserSession), and tokens the database host signs
// itself (ISSUERS.dbIssuers): canvas guests are anonymous identities it mints,
// and the owner's SQL connects with its CLI login. When ISSUERS.sessionClaim is
// set, a session token must also carry that claim: an identity provider whose
// OAuth tokens share the issuer and keys tells its session tokens apart by one,
// so those OAuth tokens never reach the database.
// shortcut: every anonymous identity the host mints is accepted, so anyone can
// still connect as a guest; refuse them once we mint guest tokens ourselves and
// existing guest-owned boards have moved to those identities (RC-571 run (e)).
function issuerAccepted(ctx: any): boolean {
  const jwt = ctx.senderAuth.jwt;
  if (!jwt) return false;
  if (fromUs(ctx)) return /^(agent|guest|service):/.test(jwt.subject) || /^machine:[0-9a-f]{32}$/.test(jwt.subject);
  if (ISSUERS.dbIssuers.includes(jwt.issuer)) return true;
  return isBrowserSession(jwt, ISSUERS);
}

function callerIsAgent(ctx: any): boolean {
  return hostedAgent(ctx) || isWorkspaceMachine(ctx) || ctx.db.participant.identity.find(ctx.sender)?.kind === 'agent';
}

function setCallerSelection(ctx: any, boardId: bigint, nodeIds: bigint[]): void {
  const existing = ctx.db.selection.identity.find(ctx.sender);
  if (existing) {
    ctx.db.selection.identity.update({ ...existing, boardId, nodeIds });
  } else {
    ctx.db.selection.insert({ identity: ctx.sender, boardId, nodeIds });
  }
}

function focusAgentNode(ctx: any, boardId: bigint, nodeId: bigint): void {
  if (callerIsAgent(ctx) && ctx.db.session.boardId.find(boardId)) {
    setCallerSelection(ctx, boardId, [nodeId]);
  }
}

const CITE_RULE = "only board members can cite this board's code or register its files";

/**
 * Path membership for citations: <path> must be registered in repoFile for
 * the board. Shared by edge evidence (`rule` = 'evidence rule') and code refs
 * (`rule` = 'code ref rule'); the message text after the prefix is unchanged
 * from the original assertEvidence so existing callers see identical errors.
 */
function assertRepoPath(ctx: any, boardId: bigint, path: string, rule: string): void {
  // The owner's helper uploads every cited path at the next checkpoint, and the
  // checkpoint writes the real code into planted refs: members choose them.
  if (!isBoardMember(ctx, boardId)) throw new SenderError(CITE_RULE);
  for (const f of ctx.db.repoFile.boardId.filter(boardId)) {
    if (f.path === path) {
      return;
    }
  }
  throw new SenderError(
    `${rule}: source path '${path}' does not exist in the repo imported for board ${boardId}`
  );
}

/**
 * Evidence grammar for edges:
 *   import                — a real import in non-test code
 *   test-import           — a real import in test files only
 *   source:<path>:<line>  — a source citation; <path> must exist in the
 *                           board's imported repo (repoFile table)
 *   human:<identity>      — a human drew it in the UI (agents may not send it)
 *   agent:<basis>         — an agent drew it without a citation; <basis> says
 *                           what it rests on (shown as unverified)
 */
function assertEvidence(ctx: any, boardId: bigint, evidence: string): void {
  if (evidence.length === 0) {
    if (ctx.db.architectureVersion.boardId.find(boardId)?.assertionMode === 'intent') return;
    throw new SenderError(
      'evidence rule: evidence is empty; every edge must cite import, test-import, source:<path>:<line>, human:<identity>, or agent:<basis>'
    );
  }
  if (evidence === 'import' || evidence === 'test-import') {
    return;
  }
  // shortcut: a DB-minted identity picks its own kind in joinBoard, so one that joins as human passes
  // (as for chart sources); upgrade when the issuer rule refuses DB-minted identities (issuerAccepted).
  noteRule(() => checkEvidencePrefix(evidence, callerIsAgent(ctx)));
  if (evidence.startsWith('agent:')) {
    return;
  }
  if (evidence.startsWith('human:')) {
    if (evidence.length <= 'human:'.length) {
      throw new SenderError("evidence rule: 'human:' must be followed by an identity");
    }
    return;
  }
  if (evidence.startsWith('source:')) {
    const rest = evidence.slice('source:'.length);
    const lastColon = rest.lastIndexOf(':');
    if (lastColon <= 0) {
      throw new SenderError(
        `evidence rule: '${evidence}' is not of the form source:<path>:<line>`
      );
    }
    const path = rest.slice(0, lastColon);
    const line = rest.slice(lastColon + 1);
    if (!/^[0-9]+$/.test(line)) {
      throw new SenderError(
        `evidence rule: source citation line '${line}' is not a number`
      );
    }
    assertRepoPath(ctx, boardId, path, 'evidence rule');
    return;
  }
  throw new SenderError(
    `evidence rule: '${evidence}' is not one of import, test-import, source:<path>:<line>, human:<identity>, agent:<basis>`
  );
}

// ---------------------------------------------------------------------------
// RC-530 dashboard: board health, owner grants and the activity outbox
// ---------------------------------------------------------------------------

const MINUTE_MICROS = 60_000_000n;
const BOARD_NAME_MAX = 100;

// coverage JSON is agent-written: clamp so a fraction, a negative or a huge
// number cannot wrap the u32 column.
function u32(n: number): number {
  return Math.min(0xffffffff, Math.max(0, Math.floor(n)));
}

// Health counters of one board (spec §1.3), scanned through the boardId
// indexes. ponytail: O(board rows) per content write, fine to ~thousands of
// rows; incremental counters if imports grow past that.
function computeStats(ctx: any, boardId: bigint) {
  const shown = new Set<bigint>();
  let nodes = 0;
  for (const n of ctx.db.node.boardId.filter(boardId)) {
    nodes++;
    if (!n.hidden) {
      shown.add(n.id);
    }
  }
  const ev = { import: 0, source: 0, stale: 0, test: 0, human: 0, agent: 0, none: 0 };
  let edges = 0;
  let shownEdges = 0;
  for (const e of ctx.db.edge.boardId.filter(boardId)) {
    edges++;
    if (!e.hidden && shown.has(e.fromNode) && shown.has(e.toNode)) {
      shownEdges++;
      ev[evidenceClass(e.evidence, e.evidenceStatus)]++;
    }
  }
  let refsOk = 0;
  let refsStale = 0;
  let refsAmbiguous = 0;
  for (const r of ctx.db.codeRef.boardId.filter(boardId)) {
    if (r.status === 'stale') {
      refsStale++;
    } else if (r.status === 'ambiguous') {
      refsAmbiguous++;
    } else {
      refsOk++;
    }
  }
  const session = ctx.db.session.boardId.find(boardId);
  const cov = parseCoverage(session ? session.coverage : '{}');
  const covExcluded = cov.excluded.reduce((sum, g) => sum + g.paths.length, 0);
  return {
    nodes,
    shownNodes: shown.size,
    edges,
    shownEdges,
    evImport: ev.import,
    evSource: ev.source,
    evStale: ev.stale,
    evTest: ev.test,
    evHuman: ev.human,
    // shortcut: agent claims count as unproven; add an evAgent column (appended last) when the dashboard shows them apart.
    evNone: ev.none + ev.agent,
    refsOk,
    refsStale,
    refsAmbiguous,
    repoFiles: [...ctx.db.repoFile.boardId.filter(boardId)].length,
    isSession: Boolean(session),
    sessionCheckpoint: session ? session.checkpoint : 0,
    sessionUpdatedAt: session ? session.updatedAt : Timestamp.UNIX_EPOCH,
    covChanged: u32(cov.changed),
    covOnBoard: u32(cov.changed - covExcluded - cov.uncovered.length),
    covExcluded,
    covUncovered: cov.uncovered.length,
    covDeleted: cov.deleted.length,
  };
}

// Upserts the board's boardStats row and returns the fresh counters.
// createdBy/createdAt/snapshotAt/lastEventId survive every refresh. A board
// without a row gets one: `init` (initBoard) records the caller and now; a
// legacy board records the database identity and the epoch ("unknown").
// snapshotAt is kept for the row contract; no board.stats metric history is
// written any more (it only fed the activity copy step, which never ran).
function refreshStats(
  ctx: any,
  boardId: bigint,
  opts: { init?: boolean } = {}
): ReturnType<typeof computeStats> {
  const now = ctx.timestamp;
  const prev = ctx.db.boardStats.boardId.find(boardId);
  const counters = computeStats(ctx, boardId);
  const row = {
    boardId,
    createdBy: prev ? prev.createdBy : opts.init ? ctx.sender : ctx.databaseIdentity,
    createdAt: prev ? prev.createdAt : opts.init ? now : Timestamp.UNIX_EPOCH,
    updatedAt: now,
    ...counters,
    snapshotAt: prev ? prev.snapshotAt : now,
    lastEventId: prev ? prev.lastEventId : 0n,
  };
  if (prev) {
    ctx.db.boardStats.boardId.update(row);
  } else {
    ctx.db.boardStats.insert(row);
  }
  return counters;
}

// Cosmetic writes (move, resize, style, doc) only freshen updatedAt, at most
// once a minute, so a group drag does not re-run every dashboard's view.
function touch(ctx: any, boardId: bigint): void {
  const s = ctx.db.boardStats.boardId.find(boardId);
  if (s && ctx.timestamp.microsSinceUnixEpoch - s.updatedAt.microsSinceUnixEpoch > MINUTE_MICROS) {
    ctx.db.boardStats.boardId.update({ ...s, updatedAt: ctx.timestamp });
  }
}

// Appends an activity event. A burst (same board, type and actor within a
// minute of the previous event) merges into the board's last outbox row:
// count+1, lastAt and payload move forward. A new row drops the board's bursts
// past its newest KEEP_PER_BOARD, so the outbox stays bounded without a drain.
function emit(ctx: any, boardId: bigint, type: string, payload: Record<string, unknown>): void {
  const now = ctx.timestamp;
  const json = JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const stats = ctx.db.boardStats.boardId.find(boardId);
  const last = stats && stats.lastEventId !== 0n ? ctx.db.activityOutbox.id.find(stats.lastEventId) : null;
  if (
    last &&
    last.type === type &&
    last.actor.isEqual(ctx.sender) &&
    now.microsSinceUnixEpoch - last.lastAt.microsSinceUnixEpoch <= MINUTE_MICROS
  ) {
    ctx.db.activityOutbox.id.update({ ...last, count: last.count + 1, lastAt: now, payload: json });
    return;
  }
  const p = ctx.db.participant.identity.find(ctx.sender);
  const row = ctx.db.activityOutbox.insert({
    id: 0n,
    boardId,
    type,
    actor: ctx.sender,
    actorName: p ? p.displayName : '',
    actorKind: p ? p.kind : 'human',
    at: now,
    lastAt: now,
    count: 1,
    payload: json,
  });
  if (stats) {
    ctx.db.boardStats.boardId.update({ ...stats, lastEventId: row.id });
  }
  // board.created stays: redeemAgentLink's legacy recovery falls back to it for the creator
  const bursts = [...ctx.db.activityOutbox.boardId.filter(boardId)].filter(e => e.type !== 'board.created');
  for (const old of beyondKeep(bursts, KEEP_PER_BOARD)) {
    ctx.db.activityOutbox.id.delete(old.id);
  }
}

// Every board-creating reducer ends here: the caller owns the new board.
function initBoard(ctx: any, boardId: bigint, name: string, via: string, owner = ctx.sender): void {
  assertBoardAllowance(ctx, owner);
  ctx.db.boardGrant.insert({ id: 0n, boardId, grantee: owner, role: 'owner' });
  refreshStats(ctx, boardId, { init: true });
  if (!owner.isEqual(ctx.sender)) {
    const stats = ctx.db.boardStats.boardId.find(boardId);
    ctx.db.boardStats.boardId.update({ ...stats, createdBy: owner });
  }
  emit(ctx, boardId, 'board.created', { name, via });
}

// A linked agent works for the person it is linked to: that person owns what
// the agent makes, and the agent edits it through a grant. Unlinking removes
// the agent's grants, never the person's ownership.
const LEGACY_DEV_OWNER = 'c200e1b9656eb65c355214f4803e213c5ceb4447ca636c22eb3f86b0cd41f1dc'; // identityFromClaims('', 'user_dev')

function initCallerBoard(ctx: any, boardId: bigint, name: string, via: string): void {
  const link = ctx.db.agentLink.agent.find(ctx.sender);
  initBoard(ctx, boardId, name, via, link ? link.owner : ctx.sender);
  if (link) ctx.db.agentGrant.insert({ id: 0n, boardId, agent: ctx.sender, grantedBy: link.owner });
  // Preserve creation provenance until an old local agent can be linked to a browser.
  if (ISSUERS.variant === 'local' && link?.owner.toHexString() === LEGACY_DEV_OWNER) {
    ctx.db.boardCreation.insert({ requestKey: `creator:${boardId}`, owner: ctx.sender, boardId });
  }
}

// Boards an agent made while unlinked (or before boards followed the link) move
// to the person it is linked to, as initCallerBoard would have made them.
// Architecture boards stay put: their history names its own owner.
function adoptAgentBoards(ctx: any, agent: any, owner: any): void {
  if (isWorkspaceMachine(ctx, agent) || isWorkspaceMachine(ctx, owner) || ctx.db.workspaceAccount.identity.find(agent) || ctx.db.workspaceAccount.identity.find(owner)?.disabled) throw new SenderError('link rule: use an agent identity and an active owner account');
  for (const grant of [...ctx.db.boardGrant.grantee.filter(agent)]) {
    if (grant.role !== 'owner' || ctx.db.boardWorkspace.boardId.find(grant.boardId) || ctx.db.architectureVersion.boardId.find(grant.boardId)) continue;
    ctx.db.boardGrant.id.update({ ...grant, grantee: owner });
    if (!findAgentGrant(ctx, grant.boardId, agent)) ctx.db.agentGrant.insert({ id: 0n, boardId: grant.boardId, agent, grantedBy: owner });
    const stats = ctx.db.boardStats.boardId.find(grant.boardId);
    if (stats) ctx.db.boardStats.boardId.update({ ...stats, createdBy: owner });
    enforceCodeConsent(ctx, grant.boardId);
  }
}

// The boards an agent keeps (architecture snapshots) follow its person's consent: call when that person changes.
function enforceAgentBoards(ctx: any, agent: any): void {
  for (const grant of [...ctx.db.boardGrant.grantee.filter(agent)]) if (grant.role === 'owner') enforceCodeConsent(ctx, grant.boardId);
}

function isService(ctx: any): boolean {
  return Boolean(ctx.db.serviceAccount.identity.find(ctx.sender));
}

function assertService(ctx: any): void {
  if (!isService(ctx)) {
    throw new SenderError('not authorized: service account only');
  }
}

// The storage limits in limits.ts: switched per publish (REDCRAYON_LIMITS), never for service accounts.
function limitsApply(ctx: any): boolean {
  return ISSUERS.limits && !isService(ctx);
}

function assertDocSize(ctx: any, doc: string): void {
  if (doc.length > LIMITS.docChars && limitsApply(ctx)) throw new SenderError(`limit rule: a node doc holds at most ${LIMITS.docChars} characters`);
}

// Personal boards an owner already has; a signed-in person (an account row) gets the larger allowance.
function assertBoardAllowance(ctx: any, owner: any): void {
  if (!limitsApply(ctx)) return;
  const cap = ctx.db.workspaceAccount.identity.find(owner) ? LIMITS.boardsPerAccount : LIMITS.boardsPerGuest;
  let owned = 0;
  for (const g of ctx.db.boardGrant.grantee.filter(owner)) if (g.role === 'owner' && ++owned >= cap) {
    throw new SenderError(`limit rule: an owner keeps at most ${cap} boards (branches included); delete one first`);
  }
}

// RC-571: every reducer a canvas, an agent or a guest writes through spends one
// write from the sender's token bucket (writeBudget): up to a minute's worth at
// once, refilled continuously. People and hosted agents get 300 a minute, other
// senders (anonymous identities, guest: tokens) 60, service accounts no limit;
// the local variant has none. Presence, geometry (a drag or layout_board moves
// every node it touches, one call each) and service-only reducers call
// spacetimedb.reducer and spend nothing; module/src/write-budget.test.mjs lists them.
// shortcut: a reducer that throws rolls back its spend, so refused calls are
// free, and anonymous identities cost nothing to mint, so this caps one
// identity, not one client (RC-648); upgrade to a per-client limit in front of
// the database when a minted-identity flood matters.
const WRITES_PER_MINUTE = 300;
const GUEST_WRITES_PER_MINUTE = 60;

function spendWrite(ctx: any): void {
  if (ISSUERS.variant === 'local' || isService(ctx)) return;
  const perMinute = isBrowserSession(ctx.senderAuth.jwt, ISSUERS) || hostedAgent(ctx) ? WRITES_PER_MINUTE : GUEST_WRITES_PER_MINUTE;
  const row = ctx.db.writeBudget.identity.find(ctx.sender);
  const elapsed = row ? Math.max(0, Number(ctx.timestamp.microsSinceUnixEpoch - row.refilledAt.microsSinceUnixEpoch)) : 60e6;
  const tokens = Math.min(perMinute, (row?.tokens ?? 0) + (elapsed * perMinute) / 60e6);
  if (tokens < 1) throw new SenderError('write rule: too many writes from this identity; wait a minute');
  const next = { identity: ctx.sender, tokens: tokens - 1, refilledAt: ctx.timestamp };
  if (row) ctx.db.writeBudget.identity.update(next);
  else ctx.db.writeBudget.insert(next);
}

/** spacetimedb.reducer, spending one write first (spendWrite). */
const reducer = ((...args: any[]) => {
  const fn = args.pop();
  return (spacetimedb.reducer as any)(...args, (ctx: any, params: any) => {
    spendWrite(ctx);
    return fn(ctx, params);
  });
}) as typeof spacetimedb.reducer;

// A display name is the user's sign-in name, which the user does not control. The module shortens it
// (joinBoard) and never rejects it. Other text has no limit here: undo re-creates a node, edge or doc
// through the same reducers with the text it was saved with (imports save paths of up to 4000
// characters, notes hold prose, and the canvas limits nothing), so a limit would refuse to restore an
// existing row. The call endpoint already bounds one call at 2 MiB.
const NAME_MAX = 100;

function assertBoardName(name: string): void {
  if (name.trim().length === 0 || name.length > BOARD_NAME_MAX || CONTROL_CHAR_RE.test(name)) {
    throw new SenderError('board name must be one short line (1–100 characters)');
  }
}

function ownsBoard(ctx: any, boardId: bigint): boolean {
  return ownsBoardAs(ctx, boardId, ctx.sender);
}

function ownsBoardAs(ctx: any, boardId: bigint, identity: any): boolean {
  if (isWorkspaceMachine(ctx, identity)) return false;
  if (ctx.db.workspaceAccount.identity.find(identity)?.disabled) return false;
  if (ctx.db.boardWorkspace.boardId.find(boardId)) return humanBoardRole(ctx, boardId, identity) === 'manager';
  for (const g of ctx.db.boardGrant.boardId.filter(boardId)) {
    if (g.role === 'owner' && g.grantee.isEqual(identity)) {
      return true;
    }
  }
  return false;
}

function findAgentGrant(ctx: any, boardId: bigint, agent: any): any {
  for (const grant of ctx.db.agentGrant.agent.filter(agent)) if (grant.boardId === boardId) return grant;
  return undefined;
}

// A grant counts only while the agent is linked, the link's owner made the grant,
// and that owner still owns the board. Cleanup deletes dead rows; this keeps a
// missed path (an operator's SQL, a future ownership change) from leaving one working.
function agentMayEdit(ctx: any, boardId: bigint, agent: any): boolean {
  if (isWorkspaceMachine(ctx, agent)) return false;
  const link = ctx.db.agentLink.agent.find(agent);
  if (!link) return false;
  const grant = findAgentGrant(ctx, boardId, agent);
  const allowed = ctx.db.boardWorkspace.boardId.find(boardId)
    ? roleRank(humanBoardRole(ctx, boardId, link.owner)) >= 2
    : ownsBoardAs(ctx, boardId, link.owner);
  return grant !== undefined && grant.grantedBy.isEqual(link.owner) && allowed;
}

function dropAgentGrants(ctx: any, agent: any): void {
  for (const grant of [...ctx.db.agentGrant.agent.filter(agent)]) ctx.db.agentGrant.id.delete(grant.id);
}

function hasLinkVisit(ctx: any, boardId: bigint, viewer: any): boolean {
  for (const visit of ctx.db.linkVisit.viewer.filter(viewer)) if (visit.boardId === boardId) return true;
  return false;
}

// Board grants, team grants and agent links: readableBoardIds without link visits and public boards.
function memberBoardIds(ctx: any): Set<bigint> {
  if (isWorkspaceMachine(ctx)) return workspaceMachineBoardIds(ctx);
  if (isService(ctx)) return new Set([...ctx.db.board.iter()].map((board: any) => board.id));
  if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return new Set();
  const boards = humanBoardIds(ctx);
  // An agent reads its own boards (below) and the boards its owner shared with it.
  const agentLink = ctx.db.agentLink.agent.find(ctx.sender);
  if (agentLink) {
    for (const grant of ctx.db.agentGrant.agent.filter(ctx.sender)) {
      if (agentMayEdit(ctx, grant.boardId, ctx.sender)) boards.add(grant.boardId);
    }
  }
  for (const linked of ctx.db.agentLink.owner.filter(ctx.sender)) {
    for (const grant of ctx.db.boardGrant.grantee.filter(linked.agent)) boards.add(grant.boardId);
  }
  return boards;
}

// Members' boards plus the opened links that include `layer`: the sensitive layers a link leaves out by default.
function linkLayerBoardIds(ctx: any, layer: 'threats' | 'code'): Set<bigint> {
  if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return new Set();
  const boards = memberBoardIds(ctx);
  if (isService(ctx) || isWorkspaceMachine(ctx)) return boards;
  for (const visit of ctx.db.linkVisit.viewer.filter(ctx.sender)) {
    const share = ctx.db.linkShare.boardId.find(visit.boardId);
    if (share && linkIncludes(share, layer)) boards.add(visit.boardId);
  }
  return boards;
}

// An edit link always carries code: deleting a cited edge or a node with code refs is undone by
// writing them back, and an editor who cannot see them could not (source evidence stays strict).
function linkIncludes(share: any, layer: 'threats' | 'code'): boolean {
  return layer === 'threats' ? share.includeThreats : share.includeCode || share.mode === 'edit';
}

// Code follows linkIncludes; a public board publishes its code as before.
function codeBoardIds(ctx: any): Set<bigint> {
  const boards = linkLayerBoardIds(ctx, 'code');
  if (isWorkspaceMachine(ctx) || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return boards;
  for (const row of ctx.db.publicBoard.iter()) boards.add(row.boardId);
  return boards;
}

// codeBoardIds on the boards the sender has open, through index lookups (no publicBoard scan, RC-605).
function codeViewBoardIds(ctx: any): Set<bigint> {
  const open = openBoardIds(ctx);
  if (!open) return codeBoardIds(ctx);
  const layer = linkLayerBoardIds(ctx, 'code');
  return new Set([...open].filter(id => layer.has(id) || (!isWorkspaceMachine(ctx) && ctx.db.publicBoard.boardId.find(id))));
}

// Everything above plus link visits and public boards.
function readableBoardIds(ctx: any): Set<bigint> {
  if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return new Set();
  const boards = memberBoardIds(ctx);
  if (isService(ctx) || isWorkspaceMachine(ctx)) return boards;
  // A link counts while it is shared; stopping it deletes these rows too.
  for (const visit of ctx.db.linkVisit.viewer.filter(ctx.sender)) {
    if (ctx.db.linkShare.boardId.find(visit.boardId)) boards.add(visit.boardId);
  }
  for (const row of ctx.db.publicBoard.iter()) boards.add(row.boardId);
  return boards;
}

// readableBoardIds(ctx).has(boardId) for one board, through index lookups only:
// updateCursor runs this 20 times a second per person, so it must not read all
// of publicBoard. Keep the two in step.
function canReadBoard(ctx: any, boardId: bigint): boolean {
  if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled || !ctx.db.board.id.find(boardId)) return false;
  if (isWorkspaceMachine(ctx)) return Boolean(workspaceMachineBoardRole(ctx, boardId));
  if (ctx.db.publicBoard.boardId.find(boardId) || isService(ctx)) return true;
  if (humanBoardRole(ctx, boardId) || agentMayEdit(ctx, boardId, ctx.sender)) return true;
  for (const linked of ctx.db.agentLink.owner.filter(ctx.sender)) if (ownsBoardAs(ctx, boardId, linked.agent)) return true;
  return Boolean(ctx.db.linkShare.boardId.find(boardId)) && hasLinkVisit(ctx, boardId, ctx.sender);
}

function assertBoardRead(ctx: any, boardId: bigint): void {
  if (!canReadBoard(ctx, boardId)) throw new SenderError('not authorized: board is unavailable');
}

// The boards the sender's canvases have open and can still read (none once they
// closed), or undefined for a sender that never opened one (agents, the MCP
// server, an older canvas): it reads every board it can, as before. Open boards
// keep each view to their index keys, so a write on a board elsewhere re-runs no
// view of this sender and nothing reads all of publicBoard.
function openBoardIds(ctx: any): Set<bigint> | undefined {
  const rows = [...ctx.db.openBoard.identity.filter(ctx.sender)];
  if (rows.length === 0) return undefined;
  return new Set(rows.flatMap((row: any) => row.boardIds as bigint[]).filter(id => canReadBoard(ctx, id)));
}

// The boards whose marks the sender reads: members' boards and edit links it opened (D14), on its open boards.
function markBoardIds(ctx: any): Set<bigint> {
  if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return new Set();
  const boards = memberBoardIds(ctx);
  for (const visit of isWorkspaceMachine(ctx) ? [] : ctx.db.linkVisit.viewer.filter(ctx.sender)) {
    if (ctx.db.linkShare.boardId.find(visit.boardId)?.mode === 'edit') boards.add(visit.boardId);
  }
  const open = openBoardIds(ctx);
  return open ? new Set([...boards].filter(id => open.has(id))) : boards;
}

function viewBoardIds(ctx: any): Set<bigint> {
  return openBoardIds(ctx) ?? readableBoardIds(ctx);
}

// Cursor and selection rows on the sender's boards: through the boardId index on
// open boards. A sender reading every board scans, as before RC-605: these tables
// hold a row per person present, fewer than the boards it reads once many are public.
function presenceRows(ctx: any, tables: any[]): any[] {
  const open = openBoardIds(ctx);
  if (open) return tables.flatMap(table => [...open].flatMap(id => [...table.boardId.filter(id)]));
  const ids = readableBoardIds(ctx);
  return tables.flatMap(table => [...table.iter()].filter((row: any) => ids.has(row.boardId)));
}

// memberBoardIds(ctx).has(boardId) for one board, through index lookups only:
// every writer but an edit-link visitor.
function isBoardMember(ctx: any, boardId: bigint): boolean {
  if (isWorkspaceMachine(ctx)) return workspaceMachineBoardRole(ctx, boardId) === 'editor';
  if (isService(ctx)) return true;
  if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return false;
  if (ownsBoard(ctx, boardId)) return true;
  if (agentMayEdit(ctx, boardId, ctx.sender)) return true;
  for (const linked of ctx.db.agentLink.owner.filter(ctx.sender)) if (ownsBoardAs(ctx, boardId, linked.agent)) return true;
  if (roleRank(humanBoardRole(ctx, boardId)) >= 2) return true;
  return false;
}

function assertBoardWrite(ctx: any, boardId: bigint): void {
  assertBoardRead(ctx, boardId);
  if (isBoardMember(ctx, boardId)) return;
  if (linkEditRole(ctx, boardId)) return;
  throw new SenderError('not authorized: board is read only');
}

function linkEditRole(ctx: any, boardId: bigint): string {
  if (isWorkspaceMachine(ctx) || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled || ctx.db.agentLink.agent.find(ctx.sender)) return '';
  const account = ctx.senderAuth
    ? isAccountSender(ctx.senderAuth.jwt, ISSUERS)
    : ISSUERS.browser === '' ? ISSUERS.variant === 'local' : ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled === false;
  return account && ctx.db.linkShare.boardId.find(boardId)?.mode === 'edit' && hasLinkVisit(ctx, boardId, ctx.sender) ? 'editor' : '';
}

function effectiveBoardRole(ctx: any, boardId: bigint): string {
  if (isWorkspaceMachine(ctx)) return workspaceMachineBoardRole(ctx, boardId);
  if (isService(ctx)) return 'manager';
  let role = strongestRole(humanBoardRole(ctx, boardId), agentMayEdit(ctx, boardId, ctx.sender) ? 'editor' : '', linkEditRole(ctx, boardId));
  for (const link of ctx.db.agentLink.owner.filter(ctx.sender)) if (ownsBoardAs(ctx, boardId, link.agent)) role = strongestRole(role, 'editor');
  return strongestRole(role, canReadBoard(ctx, boardId) ? 'viewer' : '');
}

function workspaceHuman(ctx: any): boolean {
  return !isWorkspaceMachine(ctx) && !ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled && isBrowserSession(ctx.senderAuth.jwt, ISSUERS) && !hostedAgent(ctx) && !ctx.db.agentLink.agent.find(ctx.sender) && !isService(ctx);
}

function assertArchitectureEditor(ctx: any, boardId: bigint): any {
  assertBoardExists(ctx, boardId);
  if (isWorkspaceMachine(ctx) && workspaceMachineBoardRole(ctx, boardId) === 'editor') return ctx.sender;
  if (ownsBoard(ctx, boardId)) return ctx.sender;
  if (ctx.db.boardWorkspace.boardId.find(boardId) && roleRank(humanBoardRole(ctx, boardId)) >= 2) return ctx.sender;
  const link = ctx.db.agentLink.agent.find(ctx.sender);
  if (link && agentMayEdit(ctx, boardId, ctx.sender)) return link.owner;
  throw new SenderError('architecture rule: only an owner or an agent they shared this board with can edit or submit a proposal');
}

// Protect ordinary edits and factual imports, and require
// ownership for proposal semantics. The reducer transaction rolls review reset
// back if a later validation fails.
function architectureEdit(ctx: any, boardId: bigint): void {
  assertBoardWrite(ctx, boardId);
  const version = ctx.db.architectureVersion.boardId.find(boardId);
  if (!version) return;
  if (version.assertionMode === 'fact') throw new SenderError('architecture rule: factual snapshots reject graph edits');
  if (version.status === 'implemented' && version.historyId === 0n) throw new SenderError('architecture rule: a merged branch is read-only');
  assertArchitectureEditor(ctx, boardId);
  if (version.status !== 'draft' || version.reviewedSignature || version.implementedBoardId !== 0n) {
    ctx.db.architectureVersion.boardId.update({ ...version, status: 'draft', reviewedSignature: '', implementedBoardId: 0n });
  }
}

// On a branch of a hand-drawn board the labels and docs are the content: an
// edit after acceptance returns it to draft like a graph edit would.
function contentEdit(ctx: any, node: any, changed: boolean): void {
  if (!changed) return;
  const version = ctx.db.architectureVersion.boardId.find(node.boardId);
  if (version?.assertionMode === 'intent' && version.historyId === 0n) architectureEdit(ctx, node.boardId);
}

// Every board gets its canvas link id (#b=<slug>, slug.ts) here.
function insertBoard(ctx: any, name: string) {
  if (isWorkspaceMachine(ctx)) throw new SenderError('service account rule: service accounts can only use existing workspace boards');
  return ctx.db.board.insert({ id: 0n, name, slug: newSlug(ctx.db.board, ctx.random) });
}

// Signature unchanged (Decision 6); the dashboard's team boards use
// createTeamBoard.
export const createBoard = reducer(
  { name: t.string() },
  (ctx, { name }) => {
    assertBoardName(name);
    const board = insertBoard(ctx, name);
    initCallerBoard(ctx, board.id, name, 'manual');
  }
);

export const createRequestedBoard = reducer(
  { name: t.string(), orgId: t.string(), requestKey: t.string() },
  (ctx, { name, orgId, requestKey }) => {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(requestKey)) throw new SenderError('board creation request key must contain 32–128 URL-safe characters');
    const previous = ctx.db.boardCreation.requestKey.find(requestKey);
    if (previous) {
      if (!previous.owner.isEqual(ctx.sender)) throw new SenderError('not authorized: board creation key belongs to another owner');
      return;
    }
    assertBoardName(name);
    if (orgId) assertMember(ctx, orgId);
    const board = insertBoard(ctx, name);
    if (orgId) ctx.db.teamGrant.insert({ id: 0n, boardId: board.id, orgId, grantedBy: ctx.sender });
    initCallerBoard(ctx, board.id, name, orgId ? 'team' : 'manual');
    ctx.db.boardCreation.insert({ requestKey, owner: ctx.sender, boardId: board.id });
  }
);

export const myBoardCreations = spacetimedb.view(
  { name: 'my_board_creations', public: true }, t.array(boardCreation.rowType),
  ctx => [...ctx.db.boardCreation.owner.filter(ctx.sender)]
);

// A linked agent's guest board is its owner's (initCallerBoard), so the agent holds it through its grant.
function holdsGuestBoard(ctx: any, boardId: bigint): boolean {
  return ownsBoard(ctx, boardId) || agentMayEdit(ctx, boardId, ctx.sender);
}

export const ensureGuestBoard = reducer(
  { fresh: t.option(t.bool()) },
  (ctx, { fresh }) => {
    const previous = ctx.db.guestBoard.identity.find(ctx.sender);
    if (!fresh && previous && ctx.db.board.id.find(previous.boardId) && holdsGuestBoard(ctx, previous.boardId)) return;
    if (previous) ctx.db.guestBoard.identity.delete(ctx.sender);
    const board = insertBoard(ctx, 'Untitled board');
    initCallerBoard(ctx, board.id, board.name, 'guest');
    ctx.db.guestBoard.insert({ identity: ctx.sender, boardId: board.id });
  }
);

const GuestBoardRow = t.row('GuestBoardRow', { boardId: t.u64().primaryKey() });
export const myGuestBoard = spacetimedb.view(
  { name: 'my_guest_board', public: true }, t.array(GuestBoardRow), ctx => {
    const guest = ctx.db.guestBoard.identity.find(ctx.sender);
    return guest && holdsGuestBoard(ctx, guest.boardId) && ctx.db.board.id.find(guest.boardId) ? [{ boardId: guest.boardId }] : [];
  }
);

function isClaimableBoard(ctx: any, boardId: bigint): boolean {
  return Boolean(ctx.db.board.id.find(boardId)) && !ctx.db.boardWorkspace.boardId.find(boardId) && !ctx.db.architectureVersion.boardId.find(boardId) && !ctx.db.session.boardId.find(boardId) && !ctx.db.publicBoard.boardId.find(boardId);
}

export const offerGuestClaim = reducer(
  { boardId: t.u64(), code: t.string() }, (ctx, { boardId, code }) => {
    if (!ownsBoard(ctx, boardId)) throw new SenderError('guest claim requires the board owner');
    if (!isClaimableBoard(ctx, boardId)) throw new SenderError('guest claim requires an ordinary manual board');
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(code)) throw new SenderError('guest claim code must contain 32–128 URL-safe characters');
    const previous = ctx.db.guestClaimOffer.boardId.find(boardId);
    if (previous) ctx.db.guestClaimOffer.code.delete(previous.code);
    ctx.db.guestClaimOffer.insert({ code, boardId, guest: ctx.sender, expiresAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + 30n * MINUTE_MICROS) });
  }
);

export const claimGuestBoard = reducer(
  { boardId: t.u64(), code: t.string() }, (ctx, { boardId, code }) => {
    if (isWorkspaceMachine(ctx)) throw new SenderError('service account rule: service accounts cannot claim personal boards');
    // A completed transfer can be retried after a lost response.
    if (ownsBoard(ctx, boardId) && ctx.db.guestBoard.identity.find(ctx.sender)?.boardId !== boardId) return;
    const offer = ctx.db.guestClaimOffer.code.find(code);
    const guest = offer && ctx.db.guestBoard.identity.find(offer.guest);
    if (!offer || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled || offer.boardId !== boardId || offer.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch || !isClaimableBoard(ctx, boardId) || !ownsBoardAs(ctx, boardId, offer.guest)) {
      throw new SenderError('guest claim code is invalid or expired');
    }
    if (offer.guest.isEqual(ctx.sender)) throw new SenderError('guest claim requires a different account identity');
    for (const grant of [...ctx.db.boardGrant.boardId.filter(boardId)]) {
      if (grant.grantee.isEqual(offer.guest)) ctx.db.boardGrant.id.delete(grant.id);
    }
    ctx.db.boardGrant.insert({ id: 0n, boardId, grantee: ctx.sender, role: 'owner' });
    // The previous owner's agents lose the board with the previous owner.
    for (const grant of [...ctx.db.agentGrant.boardId.filter(boardId)]) ctx.db.agentGrant.id.delete(grant.id);
    if (guest?.boardId === boardId) ctx.db.guestBoard.identity.delete(offer.guest);
    ctx.db.guestClaimOffer.code.delete(code);
    const stats = ctx.db.boardStats.boardId.find(boardId);
    if (stats) ctx.db.boardStats.boardId.update({ ...stats, createdBy: ctx.sender });
    enforceCodeConsent(ctx, boardId);
    emit(ctx, boardId, 'board.claimed', {});
  }
);

export const renameBoard = reducer(
  { boardId: t.u64(), name: t.string() }, (ctx, { boardId, name }) => {
    assertOwner(ctx, boardId, 'rename');
    assertBoardName(name);
    const board = ctx.db.board.id.find(boardId)!;
    ctx.db.board.id.update({ ...board, name });
    touch(ctx, boardId);
    emit(ctx, boardId, 'board.renamed', { name });
  }
);

// The drawing and everything on it, for deleteBoard and resetDemo. The board, its stats, grants, links,
// session and activity stay: deleteBoard removes those itself.
function clearBoardContent(ctx: any, boardId: bigint): void {
  for (const set of [...ctx.db.hideSet.boardId.filter(boardId)]) {
    for (const member of [...ctx.db.hideSetMember.setId.filter(set.id)]) ctx.db.hideSetMember.id.delete(member.id);
    ctx.db.hideSet.id.delete(set.id);
  }
  for (const key of ['node', 'edge', 'repoFile', 'routeEvent', 'codeRef', 'changeNote', 'threat', 'mark', 'markRead'] as const) {
    for (const row of [...ctx.db[key].boardId.filter(boardId)]) ctx.db[key].id.delete(row.id);
  }
  for (const row of [...ctx.db.chart.boardId.filter(boardId)]) ctx.db.chart.nodeId.delete(row.nodeId);
  for (const row of [...ctx.db.chartEmbed.boardId.filter(boardId)]) revokeChartEmbed(ctx, row.nodeId);
  for (const row of [...ctx.db.edgeWeight.boardId.filter(boardId)]) ctx.db.edgeWeight.edgeId.delete(row.edgeId);
  for (const row of [...ctx.db.nodeIcon.boardId.filter(boardId)]) ctx.db.nodeIcon.nodeId.delete(row.nodeId);
  for (const row of [...ctx.db.nodeTouch.boardId.filter(boardId)]) ctx.db.nodeTouch.nodeId.delete(row.nodeId);
  for (const row of [...ctx.db.codeRefHash.boardId.filter(boardId)]) ctx.db.codeRefHash.refId.delete(row.refId);
  for (const row of [...ctx.db.edgeEvidenceHash.boardId.filter(boardId)]) ctx.db.edgeEvidenceHash.edgeId.delete(row.edgeId);
  ctx.db.sessionRoute.boardId.delete(boardId);
  ctx.db.tracePlayback.boardId.delete(boardId);
}

export const deleteBoard = reducer(
  { boardId: t.u64() }, (ctx, { boardId }) => {
    assertOwner(ctx, boardId, 'delete');
    // A proposal is the owner's draft and goes with its board; a fact snapshot belongs to its history.
    if (ctx.db.architectureVersion.boardId.find(boardId)?.assertionMode === 'fact') throw new SenderError('architecture boards must be managed through their history');
    for (const v of ctx.db.architectureVersion.baseBoardId.filter(boardId)) {
      if (v.assertionMode === 'intent' && v.status !== 'implemented') throw new SenderError('delete rule: this board has open branches; merge or delete them first');
    }
    removeBoard(ctx, boardId);
  }
);

// Every row about the board (RC-690; scripts/verify-deletion-local.mjs finds a table this misses).
// Library items saved from it are their owner's copies and stay.
function removeBoard(ctx: any, boardId: bigint): void {
  revokeBoardEmbed(ctx, boardId);
  for (const embed of [...ctx.db.boardEmbed.comparisonBoardId.filter(boardId)]) {
    ctx.db.boardEmbed.boardId.update({ ...embed, comparisonBoardId: 0n });
  }
  ctx.db.architectureVersion.boardId.delete(boardId);
  clearBoardContent(ctx, boardId);
  for (const key of ['boardGrant', 'teamGrant', 'agentGrant', 'linkVisit', 'activityOutbox', 'workspaceBoardGrant', 'workspaceTeamGrant'] as const) {
    for (const row of [...ctx.db[key].boardId.filter(boardId)]) ctx.db[key].id.delete(row.id);
  }
  for (const invite of [...ctx.db.workspaceInvite.boardId.filter(boardId)]) ctx.db.workspaceInvite.token.delete(invite.token);
  ctx.db.boardWorkspace.boardId.delete(boardId);
  for (const row of [...ctx.db.markWaiter.boardId.filter(boardId)]) ctx.db.markWaiter.owner.delete(row.owner);
  const session = ctx.db.session.boardId.find(boardId);
  if (session) ctx.db.session.id.delete(session.id);
  ctx.db.sessionRemote.boardId.delete(boardId);
  ctx.db.boardStats.boardId.delete(boardId);
  ctx.db.demoReset.boardId.delete(boardId);
  ctx.db.publicBoard.boardId.delete(boardId);
  ctx.db.linkShare.boardId.delete(boardId);
  for (const creation of [...ctx.db.boardCreation.boardId.filter(boardId)]) ctx.db.boardCreation.requestKey.delete(creation.requestKey);
  const guest = ctx.db.guestBoard.boardId.find(boardId);
  if (guest) ctx.db.guestBoard.identity.delete(guest.identity);
  const offer = ctx.db.guestClaimOffer.boardId.find(boardId);
  if (offer) ctx.db.guestClaimOffer.code.delete(offer.code);
  for (const row of [...ctx.db.cursor.iter()]) if (row.boardId === boardId) ctx.db.cursor.identity.delete(row.identity);
  for (const row of [...ctx.db.selection.iter()]) if (row.boardId === boardId) ctx.db.selection.identity.delete(row.identity);
  // A canvas showing the board keeps the rest of its boards; one left with none reads none, as closeBoards leaves it.
  for (const row of [...ctx.db.openBoard.iter()]) {
    if (row.boardIds.includes(boardId)) ctx.db.openBoard.connectionId.update({ ...row, boardIds: row.boardIds.filter((id: bigint) => id !== boardId) });
  }
  ctx.db.board.id.delete(boardId);
}

// joinBoard fills in profile fields (displayName, kind); the connection
// count itself is maintained by the lifecycle reducers below, so joining
// never touches `connections`.
export const joinBoard = spacetimedb.reducer(
  { displayName: t.string(), kind: t.string() },
  (ctx, { displayName, kind }) => {
    // A display name is the user's sign-in name: shorten a long one rather than reject it, or the
    // canvas would fail to start for that user (and older canvases would keep failing after a publish).
    const shortName = Array.from(displayName).slice(0, NAME_MAX).join('');
    if (kind !== 'human' && kind !== 'agent') {
      throw new SenderError(`kind '${kind}' is not allowed; must be 'human' or 'agent'`);
    }
    // Our tokens name the kind in their subject, and a browser session is a
    // person. Other identities (DB-minted: the stdio agents, anonymous guests) keep
    // the kind they ask for.
    if (fromUs(ctx)) kind = hostedAgent(ctx) ? 'agent' : 'human';
    else if (ISSUERS.browser !== '' && ctx.senderAuth.jwt?.issuer === ISSUERS.browser) kind = 'human';
    const existing = ctx.db.participant.identity.find(ctx.sender);
    // The Worker joins once per isolate: an unchanged join writes nothing, so an
    // agent costs at most one participant write a minute (onConnect's refresh).
    if (existing && hostedAgent(ctx) && existing.displayName === shortName && existing.kind === kind) return;
    if (existing) {
      ctx.db.participant.identity.update({
        ...existing,
        displayName: shortName,
        kind,
        lastSeenAt: ctx.timestamp,
      });
    } else {
      // Normally clientConnected has already inserted the row; this branch
      // covers callers invoking joinBoard through a pre-existing connection
      // (e.g. reducers called from `spacetime call`).
      ctx.db.participant.insert({
        identity: ctx.sender,
        displayName: shortName,
        kind,
        connectedAt: ctx.timestamp,
        connections: 1,
        lastSeenAt: ctx.timestamp,
        authIssuer: ctx.senderAuth.jwt?.issuer ?? '',
      });
    }
  }
);

// create_node's arguments, built fresh for each reducer that takes them.
function nodeArgs() {
  return {
    boardId: t.u64(),
    label: t.string(),
    sublabel: t.string(),
    x: t.i32(),
    y: t.i32(),
    w: t.i32(),
    h: t.i32(),
    token: t.string(),
    focal: t.bool(),
    kind: t.option(t.string()),
    doc: t.option(t.string()),
    imported: t.option(t.bool()),
    shape: t.option(t.string()),
    color: t.option(t.string()),
    strokeStyle: t.option(t.string()),
    size: t.option(t.string()),
  };
}

interface NodeArgs {
  boardId: bigint;
  label: string;
  sublabel: string;
  x: number;
  y: number;
  w: number;
  h: number;
  token: string;
  focal: boolean;
  kind?: string;
  doc?: string;
  imported?: boolean;
  shape?: string;
  color?: string;
  strokeStyle?: string;
  size?: string;
}

// The checks and the insert createNode and createIconNode share; the caller
// refreshes stats, emits and focuses once its own rows are written.
function insertNode(ctx: any, { boardId, label, sublabel, x, y, w, h, token, focal, kind, doc, imported, shape, color, strokeStyle, size }: NodeArgs): any {
  assertBoardExists(ctx, boardId);
  architectureEdit(ctx, boardId);
  assertOnGrid('x', x);
  assertOnGrid('y', y);
  assertOnGrid('w', w);
  assertOnGrid('h', h);
  assertToken(token);
  assertDocSize(ctx, doc ?? '');
  const k = kind ?? 'service';
  if (k === 'chart') throw new SenderError(CHART_KIND_RULE);
  assertKind(k);
  const style = {
    shape: shape ?? 'rect',
    color: color ?? '',
    strokeStyle: strokeStyle ?? 'solid',
    size: size ?? 'm',
  };
  assertStyle(style);
  if (focal) {
    assertFocalCapacity(ctx, boardId);
  }
  const node = ctx.db.node.insert({
    id: 0n,
    boardId,
    label,
    sublabel,
    x,
    y,
    w,
    h,
    token,
    focal,
    kind: k,
    doc: doc ?? '',
    hidden: false,
    imported: imported ?? false,
    sourceKey: '',
    ...style,
  });
  touchNode(ctx, node.id, boardId);
  if (ctx.db.architectureVersion.boardId.find(boardId)?.assertionMode === 'intent') {
    return ctx.db.node.id.update({ ...node, sourceKey: `proposal:${node.id}` });
  }
  return node;
}

// An agent that creates or edits a node gets first dibs on its marks (D9). A person's edit leaves it.
function touchNode(ctx: any, nodeId: bigint, boardId: bigint): void {
  if (!callerIsAgent(ctx)) return;
  const row = { nodeId, boardId, agent: ctx.sender.toHexString() };
  const prev = ctx.db.nodeTouch.nodeId.find(nodeId);
  if (!prev) ctx.db.nodeTouch.insert(row);
  else if (prev.agent !== row.agent) ctx.db.nodeTouch.nodeId.update(row);
}

export const createNode = reducer(nodeArgs(), (ctx, args) => {
  const node = insertNode(ctx, args);
  refreshStats(ctx, node.boardId);
  emit(ctx, node.boardId, 'node.created', { label: node.label, kind: node.kind });
  focusAgentNode(ctx, node.boardId, node.id);
});

function assertIconFor(ctx: any, boardId: bigint, kind: string, icon: string): void {
  // Before any architectureEdit: fact boards would answer with their own rule.
  if (ctx.db.architectureVersion.boardId.find(boardId)?.assertionMode === 'fact') throw new SenderError(ARCHITECTURE_ICON_RULE);
  if (!isIconId(icon)) throw new SenderError(`icon '${icon}' is not allowed; must be one of: ${ICON_IDS.join(', ')}`);
  // An unknown kind is left to assertKind, whose sentence lists the kinds.
  if (ALLOWED_KINDS.includes(kind) && !ICON_NODE_KINDS.includes(kind)) throw new SenderError(ICON_KIND_RULE);
}

// One transaction: a throw anywhere leaves neither the node nor its icon, so no
// collaborator sees a plain box first.
export const createIconNode = reducer({ ...nodeArgs(), icon: t.string() }, (ctx, { icon, ...args }) => {
  assertBoardWrite(ctx, args.boardId);
  assertIconFor(ctx, args.boardId, args.kind ?? 'service', icon);
  const node = insertNode(ctx, args);
  ctx.db.nodeIcon.insert({ nodeId: node.id, boardId: node.boardId, icon });
  refreshStats(ctx, node.boardId);
  emit(ctx, node.boardId, 'node.created', { label: node.label, kind: node.kind });
  focusAgentNode(ctx, node.boardId, node.id);
});

// '' removes the icon; any other value sets or replaces it.
export const setNodeIcon = reducer({ nodeId: t.u64(), icon: t.string() }, (ctx, { nodeId, icon }) => {
  const node = findNodeOrThrow(ctx, nodeId);
  const current = ctx.db.nodeIcon.nodeId.find(nodeId);
  if (icon === '') {
    if (current) ctx.db.nodeIcon.nodeId.delete(nodeId);
  } else {
    assertIconFor(ctx, node.boardId, node.kind, icon);
    if (!current) ctx.db.nodeIcon.insert({ nodeId, boardId: node.boardId, icon });
    else if (current.icon !== icon) ctx.db.nodeIcon.nodeId.update({ ...current, icon });
  }
  touch(ctx, node.boardId);
  focusAgentNode(ctx, node.boardId, nodeId);
});

export const moveNode = spacetimedb.reducer(
  { nodeId: t.u64(), x: t.i32(), y: t.i32() },
  (ctx, { nodeId, x, y }) => {
    const node = findNodeOrThrow(ctx, nodeId);
    assertOnGrid('x', x);
    assertOnGrid('y', y);
    ctx.db.node.id.update({ ...node, x, y });
    touchNode(ctx, nodeId, node.boardId);
    touch(ctx, node.boardId);
  }
);

export const updateNode = reducer(
  {
    nodeId: t.u64(),
    label: t.option(t.string()),
    sublabel: t.option(t.string()),
    token: t.option(t.string()),
    focal: t.option(t.bool()),
    kind: t.option(t.string()),
    shape: t.option(t.string()),
    color: t.option(t.string()),
    strokeStyle: t.option(t.string()),
    size: t.option(t.string()),
  },
  (ctx, { nodeId, label, sublabel, token, focal, kind, shape, color, strokeStyle, size }) => {
    contentEdit(ctx, findNodeOrThrow(ctx, nodeId), (label !== undefined && label !== findNodeOrThrow(ctx, nodeId).label) || (sublabel !== undefined && sublabel !== findNodeOrThrow(ctx, nodeId).sublabel));
    const node = findNodeOrThrow(ctx, nodeId);
    const next = {
      ...node,
      label: label ?? node.label,
      sublabel: sublabel ?? node.sublabel,
      token: token ?? node.token,
      focal: focal ?? node.focal,
      kind: kind ?? node.kind,
      shape: shape ?? node.shape,
      color: color ?? node.color,
      strokeStyle: strokeStyle ?? node.strokeStyle,
      size: size ?? node.size,
    };
    if (next.kind !== node.kind) {
      if (node.kind === 'chart') {
        throw new SenderError('a chart cannot change kind; delete it and create a node instead');
      }
      if (next.kind === 'chart') throw new SenderError(CHART_KIND_RULE);
      architectureEdit(ctx, node.boardId);
    }
    assertToken(next.token);
    assertKind(next.kind);
    // Free text may be smaller than a node; turning it into one must not keep that box.
    if (next.kind !== 'text' && (node.w < 64 || node.h < 48)) {
      throw new SenderError(`size rule: nodes must be at least 64x48; got ${node.w}x${node.h}`);
    }
    assertStyle(next);
    if (next.focal) {
      assertFocalCapacity(ctx, node.boardId, nodeId);
    }
    ctx.db.node.id.update(next);
    // A node that becomes a kind no icon shows on (a note) loses its icon, so
    // every icon row stays on a kind create_icon_node accepts (RC-687).
    if (!ICON_NODE_KINDS.includes(next.kind)) ctx.db.nodeIcon.nodeId.delete(nodeId);
    touchNode(ctx, nodeId, node.boardId);
    touch(ctx, node.boardId);
    focusAgentNode(ctx, node.boardId, nodeId);
  }
);

export const resizeNode = spacetimedb.reducer(
  { nodeId: t.u64(), x: t.i32(), y: t.i32(), w: t.i32(), h: t.i32() },
  (ctx, { nodeId, x, y, w, h }) => {
    const node = findNodeOrThrow(ctx, nodeId);
    assertOnGrid('x', x);
    assertOnGrid('y', y);
    assertOnGrid('w', w);
    assertOnGrid('h', h);
    // Free text fits its box to its words, so a short heading is smaller than a node.
    const [minW, minH] = node.kind === 'text' ? [16, 16] : [64, 48];
    if (w < minW || h < minH) {
      throw new SenderError(
        `size rule: ${node.kind === 'text' ? 'text' : 'nodes'} must be at least ${minW}x${minH}; got ${w}x${h}`
      );
    }
    if (node.kind === 'chart') assertChartSize(w, h);
    ctx.db.node.id.update({ ...node, x, y, w, h });
    touchNode(ctx, nodeId, node.boardId);
    touch(ctx, node.boardId);
  }
);

function resolveHideSet(ctx: any, boardId: bigint, setName: string | undefined): bigint {
  const name = (setName ?? '').trim() || 'unsorted';
  for (const hs of ctx.db.hideSet.boardId.filter(boardId)) {
    if (hs.name === name) {
      return hs.id;
    }
  }
  const created = ctx.db.hideSet.insert({
    id: 0n,
    boardId,
    name,
    createdBy: ctx.sender.toHexString ? ctx.sender.toHexString() : String(ctx.sender),
  });
  return created.id;
}

function attachedEdges(ctx: any, nodeId: bigint): any[] {
  const found = new Map<bigint, any>();
  for (const e of ctx.db.edge.fromNode.filter(nodeId)) found.set(e.id, e);
  for (const e of ctx.db.edge.toNode.filter(nodeId)) found.set(e.id, e);
  return [...found.values()];
}

function removeEdgeRows(ctx: any, edgeId: bigint): void {
  clearMemberships(ctx, 'edge', edgeId);
  clearCodeRefs(ctx, 'edge', edgeId);
  ctx.db.edge.id.delete(edgeId);
  ctx.db.edgeWeight.edgeId.delete(edgeId); // false (no throw) for a regular edge
  dropEdgeHash(ctx, edgeId);
}

/** Deletes a node and everything hanging off it; returns the boards that lost rows. */
function removeNodeRows(ctx: any, node: any): Set<bigint> {
  const boards = new Set<bigint>([node.boardId]);
  for (const e of attachedEdges(ctx, node.id)) {
    boards.add(e.boardId);
    removeEdgeRows(ctx, e.id);
  }
  clearMemberships(ctx, 'node', node.id);
  clearCodeRefs(ctx, 'node', node.id);
  for (const n of [...ctx.db.changeNote.anchorId.filter(node.id)]) ctx.db.changeNote.id.delete(n.id);
  for (const th of [...ctx.db.threat.anchorId.filter(node.id)]) ctx.db.threat.id.delete(th.id);
  ctx.db.node.id.delete(node.id);
  ctx.db.chart.nodeId.delete(node.id); // false (no throw) for non-chart nodes
  revokeChartEmbed(ctx, node.id);
  ctx.db.nodeIcon.nodeId.delete(node.id); // false (no throw) for nodes without an icon
  ctx.db.nodeTouch.nodeId.delete(node.id); // its marks stay: they carry the node's label
  return boards;
}

function clearMemberships(ctx: any, targetKind: string, targetId: bigint): void {
  const stale: bigint[] = [];
  for (const m of ctx.db.hideSetMember.targetId.filter(targetId)) {
    if (m.targetKind === targetKind) {
      stale.push(m.id);
    }
  }
  for (const id of stale) {
    ctx.db.hideSetMember.id.delete(id);
  }
}

// Same shape as clearMemberships: collect ids first, delete after, so the
// index iterator is never mutated underneath.
function clearCodeRefs(ctx: any, targetKind: string, targetId: bigint): void {
  const stale: any[] = [];
  for (const r of ctx.db.codeRef.targetId.filter(targetId)) {
    if (r.targetKind === targetKind) {
      stale.push(r);
    }
  }
  for (const r of stale) {
    detachRefFromNotes(ctx, r.boardId, r.id, 'cascade');
    ctx.db.codeRef.id.delete(r.id);
    dropRefHash(ctx, r.id);
  }
}

// A code ref leaving the board (D9a). As a note's main ref: removeCodeRef refuses
// it, a node or edge delete takes the note with it. As a reader: the row stays,
// unknown and marked removed, so a missed reader never just disappears.
function detachRefFromNotes(ctx: any, boardId: bigint, refId: bigint, mode: 'refuse' | 'cascade'): void {
  for (const n of [...ctx.db.changeNote.refId.filter(refId)]) {
    if (mode === 'refuse') {
      throw new SenderError(`code ref ${refId} is the main ref of change note ${n.id}; add_code_ref the migration again under another symbol, update_change_note with its refId, then remove_code_ref this one`);
    }
    ctx.db.changeNote.id.delete(n.id);
  }
  const key = refId.toString();
  for (const n of [...ctx.db.changeNote.boardId.filter(boardId)]) {
    const readers = parseReaders(n.readers);
    if (!readers.some(r => r.refId === key && !r.removed)) continue;
    const next = readers.map(r => (r.refId === key ? { ...r, status: 'unknown' as const, removed: true as const } : r));
    ctx.db.changeNote.id.update({ ...n, readers: JSON.stringify(next) });
  }
}

function addMembership(ctx: any, setId: bigint, targetKind: string, targetId: bigint): void {
  for (const m of ctx.db.hideSetMember.targetId.filter(targetId)) {
    if (m.targetKind === targetKind && m.setId === setId) {
      return;
    }
  }
  ctx.db.hideSetMember.insert({ id: 0n, setId, targetKind, targetId });
}

export const setNodeHidden = reducer(
  { nodeId: t.u64(), hidden: t.bool(), setName: t.option(t.string()) },
  (ctx, { nodeId, hidden, setName }) => {
    const node = findNodeOrThrow(ctx, nodeId);
    if (hidden) {
      addMembership(ctx, resolveHideSet(ctx, node.boardId, setName), 'node', nodeId);
    } else {
      clearMemberships(ctx, 'node', nodeId);
    }
    ctx.db.node.id.update({ ...node, hidden });
    refreshStats(ctx, node.boardId);
    emit(ctx, node.boardId, hidden ? 'node.hidden' : 'node.unhidden', { label: node.label });
  }
);

export const setEdgeHidden = reducer(
  { edgeId: t.u64(), hidden: t.bool(), setName: t.option(t.string()) },
  (ctx, { edgeId, hidden, setName }) => {
    const edge = ctx.db.edge.id.find(edgeId);
    if (!edge) {
      throw new SenderError(`edge ${edgeId} does not exist`);
    }
    assertBoardWrite(ctx, edge.boardId);
    if (hidden) {
      addMembership(ctx, resolveHideSet(ctx, edge.boardId, setName), 'edge', edgeId);
    } else {
      clearMemberships(ctx, 'edge', edgeId);
    }
    ctx.db.edge.id.update({ ...edge, hidden });
    refreshStats(ctx, edge.boardId);
    emit(ctx, edge.boardId, hidden ? 'edge.hidden' : 'edge.unhidden', { label: edge.label });
  }
);

export const updateEdgeStyle = reducer(
  {
    edgeId: t.u64(),
    color: t.option(t.string()),
    strokeStyle: t.option(t.string()),
  },
  (ctx, { edgeId, color, strokeStyle }) => {
    const edge = ctx.db.edge.id.find(edgeId);
    if (!edge) {
      throw new SenderError(`edge ${edgeId} does not exist`);
    }
    assertBoardWrite(ctx, edge.boardId);
    const next = {
      ...edge,
      color: color ?? edge.color,
      strokeStyle: strokeStyle ?? edge.strokeStyle,
    };
    assertOneOf('color', next.color, ALLOWED_COLORS);
    assertOneOf('strokeStyle', next.strokeStyle, ALLOWED_EDGE_STROKES);
    ctx.db.edge.id.update(next);
    touch(ctx, edge.boardId);
  }
);

// RC-688: its own reducer, so update_edge_style keeps the arguments that
// clients built before it send.
export const setEdgeWeight = reducer(
  { edgeId: t.u64(), weight: t.string() },
  (ctx, { edgeId, weight }) => {
    const edge = ctx.db.edge.id.find(edgeId);
    if (!edge) {
      throw new SenderError(`edge ${edgeId} does not exist`);
    }
    assertBoardWrite(ctx, edge.boardId);
    assertOneOf('weight', weight, ALLOWED_EDGE_WEIGHTS);
    writeEdgeWeight(ctx, edge, weight);
    touch(ctx, edge.boardId);
  }
);

/** Store an edge's weight: regular is no row. */
function writeEdgeWeight(ctx: any, edge: { id: bigint; boardId: bigint }, weight: string): void {
  const row = ctx.db.edgeWeight.edgeId.find(edge.id);
  if (weight === 'regular') {
    if (row) ctx.db.edgeWeight.edgeId.delete(edge.id);
  } else if (!row) {
    ctx.db.edgeWeight.insert({ edgeId: edge.id, boardId: edge.boardId, weight });
  } else if (row.weight !== weight) {
    ctx.db.edgeWeight.edgeId.update({ ...row, weight });
  }
}

export const deleteNode = reducer(
  { nodeId: t.u64() },
  (ctx, { nodeId }) => {
    const node = findNodeOrThrow(ctx, nodeId);
    architectureEdit(ctx, node.boardId);
    if (node.imported === true && callerIsAgent(ctx) && ctx.db.architectureVersion.boardId.find(node.boardId)?.assertionMode !== 'intent') {
      throw new SenderError(
        `provenance rule: node ${nodeId} ("${node.label}") was imported; agents may hide imported rows (set_node_hidden), not delete them`
      );
    }
    // Edges on another board can still exist (createEdge checked endpoints only from RC-530 on), so the
    // cascade finds a node's edges by endpoint, not by board, and checks the caller may edit each board.
    // The endpoint indexes keep that proportional to the node's own edges, not every board's.
    for (const e of attachedEdges(ctx, nodeId)) if (e.boardId !== node.boardId) architectureEdit(ctx, e.boardId);
    // every board that loses an edge is refreshed
    for (const b of removeNodeRows(ctx, node)) {
      refreshStats(ctx, b);
    }
    emit(ctx, node.boardId, 'node.deleted', { label: node.label });
  }
);

export const createEdge = reducer(
  {
    boardId: t.u64(),
    fromNode: t.u64(),
    toNode: t.u64(),
    label: t.string(),
    evidence: t.string(),
    imported: t.option(t.bool()),
    evidenceSnippet: t.option(t.string()),
    evidenceStatus: t.option(t.string()),
  },
  (ctx, { boardId, fromNode, toNode, label, evidence, imported, evidenceSnippet, evidenceStatus }) => {
    assertBoardExists(ctx, boardId);
    architectureEdit(ctx, boardId);
    const from = findNodeOrThrow(ctx, fromNode);
    const to = findNodeOrThrow(ctx, toNode);
    // RC-530: an edge whose endpoint sits on another board is never shown, and
    // it let deleteNode reach across boards.
    for (const n of [from, to]) {
      if (n.boardId !== boardId) {
        throw new SenderError(`edge rule: node ${n.id} belongs to board ${n.boardId}, not board ${boardId}`);
      }
    }
    assertEvidence(ctx, boardId, evidence);
    const relation = ctx.db.architectureVersion.boardId.find(boardId)?.assertionMode === 'intent' ? 'imports' : '';
    // On intent boards (from, to, relation) is the edge's identity, so the same
    // uniqueness set_architecture_edge_relation enforces has to hold here too:
    // a second A->B edge would otherwise sit on the board until
    // submit_architecture_proposal failed on "duplicate graph edge".
    if (relation && [...ctx.db.edge.boardId.filter(boardId)].some(e => e.fromNode === fromNode && e.toNode === toNode && e.relation === relation)) {
      throw new SenderError('architecture edge relation already exists for these endpoints');
    }
    const snippet = evidenceSnippet ?? '';
    assertEvidenceLine(snippet);
    // Undo may supply migration defaults explicitly rather than omit them.
    const status = evidence.startsWith('source:') ? (evidenceStatus || (snippet ? 'ok' : 'stale')) : (evidenceStatus ?? '');
    if (evidence.startsWith('source:')) {
      // Undo restores ok citations with no text on consent boards (wiped, or never filled); the hash follows via setEdgeEvidenceCode.
      assertSourceStatus(status, snippet, evidence, false);
    } else if (snippet !== '' || status !== '') {
      throw new SenderError('evidence rule: only source citations carry captured evidence');
    }
    if (snippet !== '' && !storesCode(ctx, boardId)) throw new SenderError(CODE_CONSENT_RULE);
    ctx.db.edge.insert({
      id: 0n,
      boardId,
      fromNode,
      toNode,
      label,
      evidence,
      evidenceSnippet: snippet,
      evidenceStatus: status,
      // Sub-project C: new edges start unstyled, so the evidence overlay keeps
      // full control of how they read until someone styles them by hand.
      color: '',
      strokeStyle: 'solid',
      hidden: false,
      imported: imported ?? false,
      relation,
      latencyMs: -1,
      latencySource: '',
    });
    refreshStats(ctx, boardId);
    emit(ctx, boardId, 'edge.created', { from: from.label, to: to.label, evidence: evidenceClass(evidence, status) });
  }
);

function assertEvidenceLine(snippet: string): void {
  if (snippet.length > 0 && (snippet.trim().length === 0 || /[\r\n]/.test(snippet) || snippet.length > 4000)) {
    throw new SenderError('evidence rule: captured source line must be one nonblank line of at most 4000 characters');
  }
}

// lineRequired: the board stores code and the citation has no line hash. Without consent an ok citation
// keeps no line (RC-690); its hash comes through setEdgeEvidenceCode.
function assertSourceStatus(status: string, snippet: string, evidence: string, lineRequired: boolean): void {
  if (status !== 'ok' && status !== 'stale') {
    throw new SenderError('evidence rule: source status must be ok or stale');
  }
  if (status === 'ok' && snippet.length === 0 && lineRequired) {
    throw new SenderError('evidence rule: ok source evidence requires a captured line');
  }
  // Uncaptured legacy citations, including line 0, can only be stale. A new
  // anchor (captured, or ok without its line) must name a real, positive line.
  const line = evidence.slice(evidence.lastIndexOf(':') + 1);
  if ((snippet || status === 'ok') && (!Number.isSafeInteger(Number(line)) || Number(line) < 1)) {
    throw new SenderError(`evidence rule: source citation line '${line}' must be a positive integer`);
  }
}

// Checkpoints can move or flag an existing citation, never replace its anchor.
const LATENCY_SOURCES = ['prod', 'local', 'estimate'];
const MAX_LATENCY_MS = 600_000;

/** Set (or, with latencyMs < 0, clear) an edge's hop latency and where the number came from. */
export const setEdgeLatency = reducer(
  { edgeId: t.u64(), latencyMs: t.f32(), source: t.string() },
  (ctx, { edgeId, latencyMs, source }) => {
    const edge = ctx.db.edge.id.find(edgeId);
    if (!edge) throw new SenderError(`edge ${edgeId} does not exist`);
    assertBoardWrite(ctx, edge.boardId);
    if (!Number.isFinite(latencyMs)) throw new SenderError('latency rule: latencyMs must be a number');
    if (latencyMs < 0) {
      ctx.db.edge.id.update({ ...edge, latencyMs: -1, latencySource: '' });
    } else {
      if (latencyMs > MAX_LATENCY_MS) throw new SenderError(`latency rule: latencyMs must be at most ${MAX_LATENCY_MS}`);
      assertOneOf('source', source, LATENCY_SOURCES);
      ctx.db.edge.id.update({ ...edge, latencyMs, latencySource: source });
    }
    touch(ctx, edge.boardId);
  }
);

/** Store a trace on the board; every viewer replays it as dots between its nodes. */
export const playTrace = reducer(
  { boardId: t.u64(), spans: t.string(), source: t.string(), title: t.string() },
  (ctx, { boardId, spans, source, title }) => {
    assertBoardWrite(ctx, boardId);
    assertOneOf('source', source, LATENCY_SOURCES);
    if (title.length > 120) throw new SenderError('trace rule: title is at most 120 characters');
    const parsed = parseTraceSpans(spans, id => ctx.db.node.id.find(id)?.boardId === boardId);
    if (!parsed.ok) throw new SenderError(`trace rule: ${parsed.error}`);
    const normal = parsed.json;
    const prev = ctx.db.tracePlayback.boardId.find(boardId);
    const row = { boardId, spans: normal, source, title, seq: (prev?.seq ?? 0) + 1, playedAt: ctx.timestamp };
    if (prev) ctx.db.tracePlayback.boardId.update(row);
    else ctx.db.tracePlayback.insert(row);
    touch(ctx, boardId);
  }
);

export const updateEdgeEvidence = reducer(
  { edgeId: t.u64(), evidence: t.string(), status: t.string() },
  (ctx, { edgeId, evidence, status }) => {
    const edge = ctx.db.edge.id.find(edgeId);
    if (!edge) throw new SenderError(`edge ${edgeId} does not exist`);
    assertBoardWrite(ctx, edge.boardId);
    architectureEdit(ctx, edge.boardId);
    if (!edge.evidence.startsWith('source:') || !evidence.startsWith('source:')) {
      throw new SenderError('evidence rule: only source citations carry captured evidence');
    }
    assertEvidence(ctx, edge.boardId, evidence);
    const path = (citation: string) => citation.slice('source:'.length, citation.lastIndexOf(':'));
    if (path(evidence) !== path(edge.evidence)) {
      throw new SenderError('evidence rule: re-anchoring must keep the source path');
    }
    assertSourceStatus(status, edge.evidenceSnippet, evidence, storesCode(ctx, edge.boardId) && !ctx.db.edgeEvidenceHash.edgeId.find(edgeId));
    ctx.db.edge.id.update({ ...edge, evidence, evidenceStatus: status });
    // ok <-> stale moves the edge between evSource and evStale
    refreshStats(ctx, edge.boardId);
  }
);

export const deleteEdge = reducer(
  { edgeId: t.u64() },
  (ctx, { edgeId }) => {
    const edge = ctx.db.edge.id.find(edgeId);
    if (!edge) {
      throw new SenderError(`edge ${edgeId} does not exist`);
    }
    assertBoardWrite(ctx, edge.boardId);
    architectureEdit(ctx, edge.boardId);
    if (edge.imported === true && callerIsAgent(ctx) && ctx.db.architectureVersion.boardId.find(edge.boardId)?.assertionMode !== 'intent') {
      throw new SenderError(
        `provenance rule: edge ${edgeId} was imported; agents may hide imported rows (set_edge_hidden), not delete them`
      );
    }
    clearMemberships(ctx, 'edge', edgeId);
    clearCodeRefs(ctx, 'edge', edgeId);
    ctx.db.edge.id.delete(edgeId);
    ctx.db.edgeWeight.edgeId.delete(edgeId);
    dropEdgeHash(ctx, edgeId);
    refreshStats(ctx, edge.boardId);
    emit(ctx, edge.boardId, 'edge.deleted', { evidence: evidenceClass(edge.evidence, edge.evidenceStatus) });
  }
);

// Skips paths already present for the board (and repeats inside `paths`), so
// a retry after an MCP reconnect does not multiply rows.
export const addRepoFiles = reducer(
  { boardId: t.u64(), paths: t.array(t.string()) },
  (ctx, { boardId, paths }) => {
    assertBoardWrite(ctx, boardId);
    if (!isBoardMember(ctx, boardId)) throw new SenderError(CITE_RULE);
    const limited = limitsApply(ctx);
    if (limited && paths.length > LIMITS.repoFilesPerCall) throw new SenderError(`limit rule: add at most ${LIMITS.repoFilesPerCall} repo files per call`);
    if (limited && paths.some(path => path.length > LIMITS.repoPathChars)) throw new SenderError(`limit rule: a repo file path holds at most ${LIMITS.repoPathChars} characters`);
    const existing = new Set<string>();
    for (const f of ctx.db.repoFile.boardId.filter(boardId)) {
      existing.add(f.path);
    }
    let added = 0;
    for (const path of paths) {
      if (existing.has(path)) {
        continue;
      }
      existing.add(path);
      if (limited && existing.size > LIMITS.repoFilesPerBoard) throw new SenderError(`limit rule: a board keeps at most ${LIMITS.repoFilesPerBoard} repo files`);
      ctx.db.repoFile.insert({ id: 0n, boardId, path });
      added++;
    }
    if (added > 0) {
      refreshStats(ctx, boardId);
      emit(ctx, boardId, 'repo.files_added', { added });
    }
  }
);

// ---------------------------------------------------------------------------
// Build companion: session lifecycle
// ---------------------------------------------------------------------------

// git object ids: sha-1 (40 hex) or sha-256 (64 hex), lowercase.
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function assertSha(field: string, value: string): void {
  if (!SHA_RE.test(value)) {
    throw new SenderError(
      `${field} '${value}' is not a 40- or 64-character lowercase hex sha`
    );
  }
}

// A session name lands in the URL (?board=<name>), the rail and get_board, and
// boards are never deleted, so it must be one short line. repoRoot is read by
// the MCP server for every snippet and git call, so it must be absolute.
const SESSION_NAME_MAX = 100;
// the suggested other name for a hand-made board's name, kept within SESSION_NAME_MAX
const SESSION_SUFFIX = '-session';
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function assertSessionName(name: string): void {
  if (name.length === 0 || name.length > SESSION_NAME_MAX || CONTROL_CHAR_RE.test(name)) {
    throw new SenderError('session name must be one short line, e.g. the git branch');
  }
}

function assertRepoRoot(repoRoot: string): void {
  if (!repoRoot.startsWith('/') || CONTROL_CHAR_RE.test(repoRoot)) {
    throw new SenderError('repoRoot must be an absolute path on one line, e.g. /Users/me/src/repo');
  }
}

// Idempotent by name among the CALLER's boards (RC-530: those it holds a
// grant on, so another tenant's 'main' is neither re-adopted nor a clash; a
// linked agent's boards are its owner's, so for it also those it edits):
// the board named `name` that has a session row is re-adopted (no-op) when it
// was started from the same repoRoot, and refused when it belongs to another
// checkout (its stored repoRoot and baseSha would otherwise win silently).
// When only same-named boards WITHOUT a session row exist, the call is
// refused so a session can never silently take over a hand-made board.
// Otherwise insert board then session in this one transaction. Reducers
// return nothing, so the MCP server finds the session board by name among
// its own and granted my_boards rows afterwards; the checks below keep at
// most one session board per name and checkout per caller. Legacy boards (no grants) are out of
// scope, so a restart against one starts a fresh session board.
export const startSession = reducer(
  { name: t.string(), repoRoot: t.string(), baseSha: t.string() },
  (ctx, { name, repoRoot, baseSha }) => {
    assertSessionName(name);
    assertRepoRoot(repoRoot);
    assertSha('baseSha', baseSha);
    const link = ctx.db.agentLink.agent.find(ctx.sender);
    if (link) adoptAgentBoards(ctx, ctx.sender, link.owner);
    // the caller's own boards, and for a linked agent the boards it edits for its owner
    const reachable: bigint[] = [...ctx.db.boardGrant.grantee.filter(ctx.sender)].map((g: any) => g.boardId);
    for (const g of ctx.db.agentGrant.agent.filter(ctx.sender)) if (agentMayEdit(ctx, g.boardId, ctx.sender)) reachable.push(g.boardId);
    let plainTwin = false;
    let otherRoot = '';
    for (const boardId of reachable) {
      const b = ctx.db.board.id.find(boardId);
      if (!b || b.name !== name) {
        continue;
      }
      const s = ctx.db.session.boardId.find(b.id);
      if (!s) {
        plainTwin = true;
        continue;
      }
      if (s.repoRoot === repoRoot) return;
      otherRoot = s.repoRoot;
    }
    if (otherRoot) {
      throw new SenderError(
        `session board '${name}' belongs to ${otherRoot}; start_session from that checkout or choose another name`
      );
    }
    if (plainTwin) {
      throw new SenderError(
        `board '${name}' already exists without a session (someone made it by hand); call start_session with another name, e.g. '${name.slice(0, SESSION_NAME_MAX - SESSION_SUFFIX.length)}${SESSION_SUFFIX}'`
      );
    }
    const board = insertBoard(ctx, name);
    ctx.db.session.insert({
      id: 0n,
      boardId: board.id,
      repoRoot,
      baseSha,
      headSha: '',
      checkpoint: 0,
      coverage: '{}',
      startedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    initCallerBoard(ctx, board.id, name, 'session');
    // repoRoot is a local absolute path; only its last segment leaves the board
    emit(ctx, board.id, 'session.started', { repo: repoRoot.replace(/\/+$/, '').split('/').pop() ?? '' });
  }
);

function findSessionOrThrow(ctx: any, boardId: bigint): any {
  assertBoardWrite(ctx, boardId);
  const session = ctx.db.session.boardId.find(boardId);
  if (!session) {
    throw new SenderError(`board ${boardId} has no session; call start_session first`);
  }
  return session;
}

// coverage is opaque JSON written by the MCP server (shape: Coverage in the
// client/agent); the module stores it verbatim.
function commitCheckpoint(ctx: any, session: any, headSha: string, coverage: string): number {
  assertSha('headSha', headSha);
  const checkpoint = session.checkpoint + 1;
  ctx.db.session.id.update({ ...session, headSha, coverage, checkpoint, updatedAt: ctx.timestamp });
  const s = refreshStats(ctx, session.boardId);
  emit(ctx, session.boardId, 'session.checkpoint', {
    checkpoint: s.sessionCheckpoint,
    changed: s.covChanged,
    onBoard: s.covOnBoard,
    uncovered: s.covUncovered,
  });
  return checkpoint;
}

export const markCheckpoint = reducer(
  { boardId: t.u64(), headSha: t.string(), coverage: t.string() },
  (ctx, { boardId, headSha, coverage }) => {
    commitCheckpoint(ctx, findSessionOrThrow(ctx, boardId), headSha, coverage);
  }
);

function assertUniqueWaypoints(nodeIds: bigint[]): void {
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new SenderError('route rule: duplicate waypoint');
  }
}

function assertRouteNode(ctx: any, boardId: bigint, nodeId: bigint): any {
  const node = findNodeOrThrow(ctx, nodeId);
  if (node.boardId !== boardId) {
    throw new SenderError(`route rule: node ${nodeId} belongs to board ${node.boardId}, not board ${boardId}`);
  }
  return node;
}

function sameWaypoints(a: bigint[], b: bigint[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function findRouteOrThrow(ctx: any, boardId: bigint): any {
  const route = ctx.db.sessionRoute.boardId.find(boardId);
  if (!route) throw new SenderError(`board ${boardId} has no route; call plan_route first`);
  return route;
}

function recordRouteEvent(ctx: any, route: any, kind: string, checkpoint: number, reason = '', nodeId?: bigint): void {
  ctx.db.routeEvent.insert({
    id: 0n, boardId: route.boardId, kind, revision: route.revision,
    nodeId, nodeIds: route.nodeIds, reason, checkpoint, at: ctx.timestamp,
  });
}

export const planRoute = reducer(
  { boardId: t.u64(), nodeIds: t.array(t.u64()) },
  (ctx, { boardId, nodeIds }) => {
    assertBoardWrite(ctx, boardId);
    const session = findSessionOrThrow(ctx, boardId);
    if (nodeIds.length === 0) throw new SenderError('route rule: route must contain at least one waypoint');
    assertUniqueWaypoints(nodeIds);
    const existing = ctx.db.sessionRoute.boardId.find(boardId);
    if (existing) {
      if (sameWaypoints(existing.nodeIds, nodeIds)) return;
      throw new SenderError('route rule: route already planned; use reroute to change pending waypoints');
    }
    for (const id of nodeIds) assertRouteNode(ctx, boardId, id);
    const route = ctx.db.sessionRoute.insert({
      boardId, nodeIds, currentIndex: -1, revision: 1, currentCheckpoint: 0, updatedAt: ctx.timestamp,
    });
    recordRouteEvent(ctx, route, 'plan', session.checkpoint);
    touch(ctx, boardId);
  }
);

export const reroute = reducer(
  {
    boardId: t.u64(), addNodeIds: t.array(t.u64()), addIndices: t.array(t.u32()),
    removeNodeIds: t.array(t.u64()), reason: t.string(),
  },
  (ctx, { boardId, addNodeIds, addIndices, removeNodeIds, reason }) => {
    assertBoardWrite(ctx, boardId);
    const session = findSessionOrThrow(ctx, boardId);
    const route = findRouteOrThrow(ctx, boardId);
    if (reason.trim().length === 0) throw new SenderError('route rule: reason is empty');
    if (addNodeIds.length !== addIndices.length) throw new SenderError('route rule: addNodeIds and addIndices must have the same length');
    assertUniqueWaypoints(addNodeIds);
    assertUniqueWaypoints(removeNodeIds);
    const visited: bigint[] = route.nodeIds.slice(0, route.currentIndex + 1);
    const changedIds = new Set([...addNodeIds, ...removeNodeIds]);
    for (const id of visited) {
      if (changedIds.has(id)) throw new SenderError(`route rule: cannot change visited waypoint ${id}`);
    }
    for (const id of addNodeIds) assertRouteNode(ctx, boardId, id);
    const pending: bigint[] = route.nodeIds.slice(route.currentIndex + 1).filter((id: bigint) => !changedIds.has(id));
    for (let i = 0; i < addNodeIds.length; i++) {
      if (addIndices[i] > pending.length) throw new SenderError(`route rule: pending index ${addIndices[i]} exceeds ${pending.length}`);
      pending.splice(addIndices[i], 0, addNodeIds[i]);
    }
    const nodeIds = [...visited, ...pending];
    if (nodeIds.length === 0) throw new SenderError('route rule: route must contain at least one waypoint');
    if (sameWaypoints(route.nodeIds, nodeIds)) return;
    const next = { ...route, nodeIds, revision: route.revision + 1, updatedAt: ctx.timestamp };
    ctx.db.sessionRoute.boardId.update(next);
    recordRouteEvent(ctx, next, 'reroute', session.checkpoint, reason.trim());
    touch(ctx, boardId);
  }
);

export const arriveAtCheckpoint = reducer(
  {
    boardId: t.u64(), nodeId: t.u64(), expectedRevision: t.u32(), expectedCheckpoint: t.u32(),
    headSha: t.string(), coverage: t.string(),
  },
  (ctx, { boardId, nodeId, expectedRevision, expectedCheckpoint, headSha, coverage }) => {
    assertBoardWrite(ctx, boardId);
    const session = findSessionOrThrow(ctx, boardId);
    const route = findRouteOrThrow(ctx, boardId);
    // A lost acknowledgement may be retried after a reroute or checkpoint.
    // Preserve both its original checkpoint and an explicit focus override.
    if (route.currentIndex >= 0 && route.nodeIds[route.currentIndex] === nodeId) return;
    if (route.currentIndex > 0 && route.nodeIds.slice(0, route.currentIndex).includes(nodeId)) {
      throw new SenderError(`route rule: waypoint ${nodeId} is already done`);
    }
    if (route.revision !== expectedRevision) throw new SenderError('route rule: route revision changed; prepare arrival again');
    if (session.checkpoint !== expectedCheckpoint) throw new SenderError('route rule: checkpoint changed; prepare arrival again');
    const currentIndex = route.currentIndex + 1;
    if (route.nodeIds[currentIndex] !== nodeId) throw new SenderError(`route rule: node ${nodeId} is not the next pending waypoint`);
    const node = assertRouteNode(ctx, boardId, nodeId);
    if (node.hidden) throw new SenderError(`route rule: waypoint ${nodeId} is hidden`);
    const currentCheckpoint = commitCheckpoint(ctx, session, headSha, coverage);
    const next = { ...route, currentIndex, currentCheckpoint, updatedAt: ctx.timestamp };
    ctx.db.sessionRoute.boardId.update(next);
    recordRouteEvent(ctx, next, 'arrive', currentCheckpoint, '', nodeId);
    setCallerSelection(ctx, boardId, [nodeId]);
  }
);

// Replaces node.doc. A separate reducer rather than a new updateNode argument:
// changing a reducer's signature breaks deployed clients between module
// publish and client redeploy; adding a reducer is always safe (Decision 6).
export const setNodeDoc = reducer(
  { nodeId: t.u64(), doc: t.string() },
  (ctx, { nodeId, doc }) => {
    const node = findNodeOrThrow(ctx, nodeId);
    assertDocSize(ctx, doc);
    contentEdit(ctx, node, doc !== node.doc);
    ctx.db.node.id.update({ ...node, doc });
    touchNode(ctx, nodeId, node.boardId);
    touch(ctx, node.boardId);
  }
);

// ---------------------------------------------------------------------------
// Charts: a node with kind 'chart' plus its chart row. parseChart is the one
// gate; the client inspector and the MCP tools call the same function, so all
// three accept and reject the same input with the same sentence.
// ---------------------------------------------------------------------------

function assertChartSize(w: number, h: number): void {
  if (w < CHART_MIN_W || h < CHART_MIN_H) {
    throw new SenderError(`chart size rule: charts must be at least ${CHART_MIN_W}x${CHART_MIN_H}; got ${w}x${h}`);
  }
}

function parseChartOrThrow(type: string, csv: string, options: string): void {
  const result = parseChart(type, csv, options);
  if (!result.ok) throw new SenderError(result.error);
}

// '' and whitespace mean "no options"; stored as '{}' so readers never see ''.
const chartOptions = (options: string | undefined): string => (options ?? '').trim() || '{}';

function humanPrefix(ctx: any): string {
  const p = ctx.db.participant.identity.find(ctx.sender);
  return `human:${(p && p.displayName) || ctx.sender.toHexString().slice(0, 12)}`;
}

// A caller that never ran joinBoard (a bare HTTP call) has an empty name, and
// 'human:' alone says nothing, so it falls back to the identity's first 12 hex.
// A long name is cut so the default fits the cap (and undo can replay it).
function defaultHumanSource(ctx: any): string {
  return humanPrefix(ctx).slice(0, MAX_SOURCE_CHARS).replace(/[\uD800-\uDBFF]$/, '');
}

// A stored source still names the caller when it is their default source with
// anything after it that does not run on into a longer name (`human:alice2`
// is not alice's; `human:alice — grafana export` is).
function namesCaller(ctx: any, stored: string): boolean {
  const prefix = humanPrefix(ctx);
  return stored.startsWith(prefix) && !/^[\p{L}\p{N}_]/u.test(stored.slice(prefix.length));
}

// The source rule. `given` is the caller's source (undefined when omitted).
// On a data edit, `stored` is the chart's current source and `dataChanged`
// says the numbers changed (type or csv; options alone never do); on create
// both are absent. New numbers keep a stored source only when it still tells
// the truth: a human's keep it only when it names that human (anyone else's, or
// a free-form one, becomes theirs), and an agent's edits keep its own.
function resolveChartSource(ctx: any, given: string | undefined, stored?: string, dataChanged = false): string {
  const agent = callerIsAgent(ctx);
  if (given === undefined && stored !== undefined) {
    if (!dataChanged) return stored;
    if (!agent) return namesCaller(ctx, stored) ? stored : defaultHumanSource(ctx);
    if (stored === SAMPLE_SOURCE) throw new SenderError(SAMPLE_NEEDS_SOURCE);
    if (isHumanSource(stored)) throw new SenderError(HUMAN_DATA_NEEDS_SOURCE);
    return stored;
  }
  const source = (given ?? '').trim();
  if (source === '') {
    if (agent) throw new SenderError(AGENT_SOURCE_RULE);
    return defaultHumanSource(ctx);
  }
  // Humans may send 'sample': library placement and undo replay it.
  if (agent && source === SAMPLE_SOURCE) throw new SenderError(SAMPLE_RESERVED);
  if (agent && isHumanSource(source)) throw new SenderError(HUMAN_SOURCE_RESERVED);
  if (source.length > MAX_SOURCE_CHARS) {
    throw new SenderError(`source is ${source.length} characters; the limit is ${MAX_SOURCE_CHARS}`);
  }
  return source;
}

// One transaction: a throw anywhere leaves neither the node nor the chart row.
export const createChart = reducer(
  {
    boardId: t.u64(),
    label: t.string(),
    sublabel: t.string(),
    x: t.i32(),
    y: t.i32(),
    w: t.i32(),
    h: t.i32(),
    type: t.string(),
    csv: t.string(),
    options: t.option(t.string()),
    source: t.option(t.string()),
  },
  (ctx, { boardId, label, sublabel, x, y, w, h, type, csv, options, source }) => {
    // No assertBoardExists: a missing board must answer like an unreadable one.
    assertBoardWrite(ctx, boardId);
    // Before any architectureEdit: fact boards would answer with their own rule.
    if (ctx.db.architectureVersion.boardId.find(boardId)?.assertionMode === 'fact') throw new SenderError(ARCHITECTURE_CHART_RULE);
    assertOnGrid('x', x);
    assertOnGrid('y', y);
    assertOnGrid('w', w);
    assertOnGrid('h', h);
    assertChartSize(w, h);
    const opts = chartOptions(options);
    parseChartOrThrow(type, csv, opts);
    const src = resolveChartSource(ctx, source);
    const node = ctx.db.node.insert({
      id: 0n,
      boardId,
      label,
      sublabel,
      x,
      y,
      w,
      h,
      token: 'ink',
      focal: false,
      kind: 'chart',
      doc: '',
      hidden: false,
      imported: false,
      sourceKey: '',
      shape: 'rect',
      color: '',
      strokeStyle: 'solid',
      size: 'm',
    });
    ctx.db.chart.insert({ nodeId: node.id, boardId, type, csv, options: opts, source: src, updatedAt: ctx.timestamp });
    refreshStats(ctx, boardId);
    emit(ctx, boardId, 'node.created', { label, kind: 'chart' });
    focusAgentNode(ctx, boardId, node.id);
  }
);

// Omitted fields keep their stored value; the merged result is parsed whole.
export const setChartData = reducer(
  {
    nodeId: t.u64(),
    type: t.option(t.string()),
    csv: t.option(t.string()),
    options: t.option(t.string()),
    source: t.option(t.string()),
  },
  (ctx, { nodeId, type, csv, options, source }) => {
    const node = findNodeOrThrow(ctx, nodeId);
    const row = node.kind === 'chart' ? ctx.db.chart.nodeId.find(nodeId) : null;
    if (!row) throw new SenderError(`node ${nodeId} is not a chart`);
    const next = {
      type: type ?? row.type,
      csv: csv ?? row.csv,
      options: options === undefined ? row.options : chartOptions(options),
    };
    parseChartOrThrow(next.type, next.csv, next.options);
    const dataChanged = next.type !== row.type || next.csv !== row.csv;
    const src = resolveChartSource(ctx, source, row.source, dataChanged);
    ctx.db.chart.nodeId.update({ ...row, ...next, source: src, updatedAt: ctx.timestamp });
    touch(ctx, node.boardId);
    focusAgentNode(ctx, node.boardId, nodeId);
  }
);

// ---------------------------------------------------------------------------
// Chart library: personal saved selections. The client builds and checks the
// payload shape; the server checks ownership, the name, the size, that the
// JSON is an object with version 1, and the per-owner cap.
// ---------------------------------------------------------------------------

const LIBRARY_NAME_MAX = 80;
const LIBRARY_ITEMS_MAX = 200;

function libraryName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > LIBRARY_NAME_MAX) {
    throw new SenderError(`library item name must be 1–80 characters; got ${trimmed.length}`);
  }
  return trimmed;
}

function assertLibraryPayload(payload: string): void {
  const bytes = utf8Bytes(payload);
  if (bytes > MAX_LIBRARY_PAYLOAD_BYTES) {
    throw new SenderError(`library item is ${bytes} bytes; the limit is 262144 bytes (256 KB)`);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { version?: unknown }).version !== 1) {
    throw new SenderError('library item payload must be a JSON object with version 1');
  }
}

// Another owner's row answers exactly like a missing one: ids are not secrets,
// but nothing should confirm that someone else's item exists.
function ownLibraryItem(ctx: any, id: bigint): any {
  if (isWorkspaceMachine(ctx)) throw new SenderError('service account rule: service accounts cannot manage personal libraries');
  const row = ctx.db.libraryItem.id.find(id);
  if (!row || !row.owner.isEqual(ctx.sender)) throw new SenderError(`library item ${id} does not exist`);
  return row;
}

export const saveLibraryItem = reducer(
  { name: t.string(), payload: t.string() },
  (ctx, { name, payload }) => {
    if (isWorkspaceMachine(ctx)) throw new SenderError('service account rule: service accounts cannot manage personal libraries');
    const n = libraryName(name);
    assertLibraryPayload(payload);
    // ponytail: counts by walking the owner index (at most 200 rows); keep a
    // per-owner counter row if the cap ever grows.
    let held = 0;
    for (const _row of ctx.db.libraryItem.owner.filter(ctx.sender)) held += 1;
    if (held >= LIBRARY_ITEMS_MAX) {
      throw new SenderError('your library holds 200 items; delete one before saving another');
    }
    ctx.db.libraryItem.insert({ id: 0n, owner: ctx.sender, orgId: '', name: n, payload, createdAt: ctx.timestamp });
  }
);

export const renameLibraryItem = reducer(
  { id: t.u64(), name: t.string() },
  (ctx, { id, name }) => {
    const row = ownLibraryItem(ctx, id);
    ctx.db.libraryItem.id.update({ ...row, name: libraryName(name) });
  }
);

export const deleteLibraryItem = reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    ownLibraryItem(ctx, id);
    ctx.db.libraryItem.id.delete(id);
  }
);

// --- code consent (RC-690) ---------------------------------------------------
// A board keeps code text (codeRef.snippet, edge.evidenceSnippet) only while its
// owner's `user` row says storeCode. Paths, lines and shas are always kept.

const CODE_CONSENT_RULE = 'code rule: this board does not store code; send the code ref without its snippet';
const CODE_CONSENT_SELF_RULE = 'not authorized: an agent cannot change whether boards store code; the person chooses it in the dashboard';

function boardOwner(ctx: any, boardId: bigint): any {
  for (const g of ctx.db.boardGrant.boardId.filter(boardId)) if (g.role === 'owner') return g.grantee;
  return undefined;
}

// A linked agent's boards follow the person it is linked to, as its new boards do (initCallerBoard).
function consentSubject(ctx: any, owner: any): any {
  return ctx.db.agentLink.agent.find(owner)?.owner ?? owner;
}

const consentKey = (subject: any): string => `user:${subject.toHexString()}`;

function storesCode(ctx: any, boardId: bigint): boolean {
  const owner = boardOwner(ctx, boardId);
  return owner !== undefined && ctx.db.codeConsent.key.find(consentKey(consentSubject(ctx, owner)))?.storeCode === true;
}

function purgeStoredCode(ctx: any, boardId: bigint): number {
  let changed = 0;
  for (const ref of [...ctx.db.codeRef.boardId.filter(boardId)]) {
    if (ref.snippet !== '') { ctx.db.codeRef.id.update({ ...ref, snippet: '' }); changed++; }
  }
  for (const edge of [...ctx.db.edge.boardId.filter(boardId)]) {
    if (edge.evidenceSnippet !== '') { ctx.db.edge.id.update({ ...edge, evidenceSnippet: '' }); changed++; }
  }
  return changed;
}

// A hash row goes with its ref or edge (false, no throw, when there is none).
function dropRefHash(ctx: any, refId: bigint): void {
  ctx.db.codeRefHash.refId.delete(refId);
}

function dropEdgeHash(ctx: any, edgeId: bigint): void {
  ctx.db.edgeEvidenceHash.edgeId.delete(edgeId);
}

/** A merged edge carries its branch edge's line hash (or none, when the branch edge had none). */
function copyEdgeHash(ctx: any, fromEdgeId: bigint, toEdgeId: bigint, boardId: bigint): void {
  const hash = ctx.db.edgeEvidenceHash.edgeId.find(fromEdgeId);
  dropEdgeHash(ctx, toEdgeId);
  if (hash) ctx.db.edgeEvidenceHash.insert({ ...hash, edgeId: toEdgeId, boardId });
}

// Every reducer that changes whose consent a board follows ends here.
function enforceCodeConsent(ctx: any, boardId: bigint): void {
  if (!storesCode(ctx, boardId)) purgeStoredCode(ctx, boardId);
}

// The boards whose consent `subject`'s row sets: its own and its linked agents' (consentSubject).
function consentBoardIds(ctx: any, subject: any): bigint[] {
  const owners = [...ctx.db.agentLink.owner.filter(subject)].map((l: any) => l.agent);
  if (!ctx.db.agentLink.agent.find(subject)) owners.push(subject);
  return owners.flatMap(o => [...ctx.db.boardGrant.grantee.filter(o)].filter((g: any) => g.role === 'owner').map((g: any) => g.boardId));
}

function holdsCode(ctx: any, boardId: bigint): boolean {
  for (const ref of ctx.db.codeRef.boardId.filter(boardId)) if (ref.snippet !== '') return true;
  for (const edge of ctx.db.edge.boardId.filter(boardId)) if (edge.evidenceSnippet !== '') return true;
  return false;
}

function writeCodeConsent(ctx: any, subject: any, storeCode: boolean): void {
  const row = { key: consentKey(subject), scope: 'user', subject: subject.toHexString(), storeCode, updatedBy: ctx.sender, updatedAt: ctx.timestamp };
  if (ctx.db.codeConsent.key.find(row.key)) ctx.db.codeConsent.key.update(row);
  else ctx.db.codeConsent.insert(row);
}

// A member sets only their own row. Turning it off deletes the stored text at once; turning it on stores
// nothing until the next ref, citation or checkpoint brings the code.
export const setCodeConsent = reducer({ storeCode: t.bool() }, (ctx, { storeCode }) => {
  if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) throw new SenderError('not authorized: account is unavailable');
  if (hostedAgent(ctx)) throw new SenderError(CODE_CONSENT_SELF_RULE);
  writeCodeConsent(ctx, ctx.sender, storeCode);
  if (!storeCode) for (const boardId of consentBoardIds(ctx, ctx.sender)) purgeStoredCode(ctx, boardId);
});

// The one-time rollout step (scripts/wipe-stored-code.mjs): every board has no consent when code consent ships, so
// code text stored before it goes. The script writes the line hashes first; this blanks the text.
export const wipeStoredCode = spacetimedb.reducer(ctx => {
  assertService(ctx);
  for (const board of [...ctx.db.board.iter()]) if (!storesCode(ctx, board.id)) purgeStoredCode(ctx, board.id);
});

// The dashboard's setting, and how many boards turning it off would blank.
const MyCodeConsentRow = t.row('MyCodeConsentRow', { storeCode: t.bool(), boardsWithCode: t.u32() });
// The count only matters for turning it off, so it is not scanned while off.
export const myCodeConsent = spacetimedb.view({ name: 'my_code_consent', public: true }, t.array(MyCodeConsentRow), ctx => {
  if (isWorkspaceMachine(ctx) || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return [];
  const storeCode = ctx.db.codeConsent.key.find(consentKey(ctx.sender))?.storeCode === true;
  return [{ storeCode, boardsWithCode: storeCode ? u32(consentBoardIds(ctx, ctx.sender).filter(boardId => holdsCode(ctx, boardId)).length) : 0 }];
});

// Whether each board the caller reads stores code: the MCP server sends text only where it does.
const BoardCodeConsent = t.row('BoardCodeConsent', { boardId: t.u64().primaryKey(), storeCode: t.bool() });
export const visibleBoardCodeConsent = spacetimedb.view({ name: 'visible_board_code_consent', public: true }, t.array(BoardCodeConsent), ctx =>
  [...viewBoardIds(ctx)].map(boardId => ({ boardId, storeCode: storesCode(ctx, boardId) }))
);

// ---------------------------------------------------------------------------
// Build companion: code refs
// ---------------------------------------------------------------------------

const SNIPPET_MAX_LINES = 60;
const SNIPPET_MAX_CHARS = 4000;
const SYMBOL_MAX = 200;
const REF_STATUSES = ['ok', 'stale', 'ambiguous'];

// A resolver-named member ref ('Limiter.allow') points at the member's own
// lines, which never spell the class name, so the needle is the last dotted
// segment. Undotted symbols are matched whole. PR2's resolver and the eval
// use the same rule.
function symbolNeedle(symbol: string): string {
  const dot = symbol.lastIndexOf('.');
  const tail = dot >= 0 ? symbol.slice(dot + 1) : symbol;
  return tail.length > 0 ? tail : symbol;
}

function assertRefRange(startLine: number, endLine: number): void {
  if (startLine < 1 || endLine < startLine) {
    throw new SenderError(
      `code ref rule: range ${startLine}-${endLine} is invalid; need 1 <= startLine <= endLine`
    );
  }
  if (endLine - startLine >= SNIPPET_MAX_LINES) {
    throw new SenderError(
      `code ref rule: range ${startLine}-${endLine} spans ${endLine - startLine + 1} lines; the limit is ${SNIPPET_MAX_LINES}`
    );
  }
}

function assertRefSnippet(symbol: string, snippet: string): void {
  if (symbol.length === 0) {
    throw new SenderError('code ref rule: symbol is empty');
  }
  if (snippet.length > SNIPPET_MAX_CHARS) {
    throw new SenderError(
      `code ref rule: snippet is ${snippet.length} chars; the limit is ${SNIPPET_MAX_CHARS}`
    );
  }
  if (snippet === '') return; // a board without code consent keeps no text to find the symbol in
  const needle = symbolNeedle(symbol);
  if (!snippet.includes(needle)) {
    throw new SenderError(
      `code ref rule: symbol '${symbol}' does not occur in the snippet (looked for '${needle}')`
    );
  }
}

function assertRefTarget(ctx: any, boardId: bigint, targetKind: string, targetId: bigint): void {
  if (targetKind !== 'node' && targetKind !== 'edge') {
    throw new SenderError(
      `code ref rule: targetKind '${targetKind}' is not allowed; must be 'node' or 'edge'`
    );
  }
  const target =
    targetKind === 'node' ? ctx.db.node.id.find(targetId) : ctx.db.edge.id.find(targetId);
  if (!target) {
    throw new SenderError(`code ref rule: ${targetKind} ${targetId} does not exist`);
  }
  if (target.boardId !== boardId) {
    throw new SenderError(
      `code ref rule: ${targetKind} ${targetId} belongs to board ${target.boardId}, not board ${boardId}`
    );
  }
}

export const addCodeRef = reducer(
  {
    boardId: t.u64(),
    targetKind: t.string(),
    targetId: t.u64(),
    path: t.string(),
    symbol: t.string(),
    startLine: t.u32(),
    endLine: t.u32(),
    blobSha: t.string(),
    snippet: t.string(),
    author: t.string(),
  },
  (ctx, { boardId, targetKind, targetId, path, symbol, startLine, endLine, blobSha, snippet, author }) => {
    assertBoardWrite(ctx, boardId);
    assertRefTarget(ctx, boardId, targetKind, targetId);
    // The symbol is the ref's identity (spec Decision 11): a retry after a
    // timed-out call, or a re-add at the next checkpoint, names the existing
    // row instead of adding a second badge for one symbol. Scans only this
    // target's refs (btree index on targetId).
    for (const r of ctx.db.codeRef.targetId.filter(targetId)) {
      if (r.boardId === boardId && r.targetKind === targetKind && r.path === path && r.symbol === symbol) {
        throw new SenderError(`already attached id=${r.id} ${r.path}:${r.startLine}-${r.endLine}`);
      }
    }
    // A symbol is a code name, never prose. Paths have no limit here: imports
    // register every path git lists (up to 4000 characters, see NAME_MAX), and a
    // ref's path must be one of them.
    const symbolLength = Array.from(symbol).length;
    if (symbolLength > SYMBOL_MAX) {
      throw new SenderError(`size rule: symbol is ${symbolLength} characters; the limit is ${SYMBOL_MAX}`);
    }
    if (symbol.endsWith('.')) {
      throw new SenderError(
        `code ref rule: symbol '${symbol}' ends with a dot; name the member, e.g. Limiter.allow`
      );
    }
    assertRefRange(startLine, endLine);
    assertRefSnippet(symbol, snippet);
    assertSha('blobSha', blobSha);
    assertRepoPath(ctx, boardId, path, 'code ref rule');
    if (snippet !== '' && !storesCode(ctx, boardId)) throw new SenderError(CODE_CONSENT_RULE);
    // The ref belongs to the UPCOMING checkpoint; after markCheckpoint the
    // inspector reads it as "checkpoint N". Boards without a session count
    // from 1 so hand-inserted refs (PR3 testing) still render.
    const session = ctx.db.session.boardId.find(boardId);
    ctx.db.codeRef.insert({
      id: 0n,
      boardId,
      targetKind,
      targetId,
      path,
      symbol,
      startLine,
      endLine,
      blobSha,
      snippet,
      author,
      checkpoint: (session ? session.checkpoint : 0) + 1,
      status: 'ok',
    });
    refreshStats(ctx, boardId);
    emit(ctx, boardId, 'coderef.added', { symbol, path });
    if (targetKind === 'node') focusAgentNode(ctx, boardId, targetId);
  }
);

const updateCodeRefArgs = {
  id: t.u64(),
  startLine: t.u32(),
  endLine: t.u32(),
  blobSha: t.string(),
  snippet: t.string(),
  status: t.string(),
};

/** The checkpoint new code on the board belongs to: the session's next one (1 without a session). */
function nextCheckpoint(ctx: any, boardId: bigint): number {
  const session = ctx.db.session.boardId.find(boardId);
  return (session ? session.checkpoint : 0) + 1;
}

function updateRef(ctx: any, { id, startLine, endLine, blobSha, snippet, status }: {
  id: bigint; startLine: number; endLine: number; blobSha: string; snippet: string; status: string;
}): any {
  const ref = ctx.db.codeRef.id.find(id);
  if (!ref) {
    throw new SenderError(`code ref ${id} does not exist`);
  }
  assertBoardWrite(ctx, ref.boardId);
  if (!REF_STATUSES.includes(status)) {
    throw new SenderError(
      `code ref rule: status '${status}' is not allowed; must be one of: ${REF_STATUSES.join(', ')}`
    );
  }
  if (status !== 'ok') {
    // stale / ambiguous keep the last known lines, snippet and sha.
    ctx.db.codeRef.id.update({ ...ref, status });
  } else {
    assertRefRange(startLine, endLine);
    assertRefSnippet(ref.symbol, snippet);
    assertSha('blobSha', blobSha);
    if (snippet !== '' && !storesCode(ctx, ref.boardId)) throw new SenderError(CODE_CONSENT_RULE);
    // A shifted ref retains its checkpoint; new text belongs to the next one.
    // Text appearing or going (consent, RC-690) is not new code: the line
    // hashes say whether the code changed (setCodeRefHashes).
    const changed = snippet !== ref.snippet && snippet !== '' && ref.snippet !== '';
    const checkpoint = changed ? nextCheckpoint(ctx, ref.boardId) : ref.checkpoint;
    ctx.db.codeRef.id.update({ ...ref, startLine, endLine, blobSha, snippet, status, checkpoint });
  }
  refreshStats(ctx, ref.boardId);
  if (status !== ref.status) {
    emit(ctx, ref.boardId, 'coderef.status', { symbol: ref.symbol, status });
  }
  return ref;
}

// Internal checkpoint re-anchors preserve selection.
export const updateCodeRef = reducer(
  updateCodeRefArgs,
  (ctx, args) => { updateRef(ctx, args); }
);

// Explicit MCP edits follow the target; checkpoint re-anchors retain focus.
export const updateCodeRefAndFocus = reducer(
  updateCodeRefArgs,
  (ctx, args) => {
    const ref = updateRef(ctx, args);
    if (ref.targetKind === 'node') focusAgentNode(ctx, ref.boardId, ref.targetId);
  }
);

// Authorized editors. Refs are never `imported`, so the hide-not-delete provenance
// rule for agents does not apply here.
export const removeCodeRef = reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    const ref = ctx.db.codeRef.id.find(id);
    if (!ref) {
      throw new SenderError(`code ref ${id} does not exist`);
    }
    assertBoardWrite(ctx, ref.boardId);
    detachRefFromNotes(ctx, ref.boardId, id, 'refuse');
    ctx.db.codeRef.id.delete(id);
    dropRefHash(ctx, id);
    refreshStats(ctx, ref.boardId);
    emit(ctx, ref.boardId, 'coderef.removed', { symbol: ref.symbol, path: ref.path });
  }
);

// --- line hashes and the repo remote (RC-690) --------------------------------
// New reducers, so add_code_ref, create_edge and the rest keep the arguments deployed canvases send.
// Members only, like citing (assertRepoPath): they describe the owner's code.

const LINE_HASH_RE = /^[0-9a-f]{32}$/;
const LINE_HASHES_RE = /^[0-9a-f]{32}( [0-9a-f]{32}){0,59}$/; // at most SNIPPET_MAX_LINES
const REMOTE_MAX = 2048;

function assertCodeWriter(ctx: any, boardId: bigint): void {
  assertBoardWrite(ctx, boardId);
  if (!isBoardMember(ctx, boardId)) throw new SenderError(CITE_RULE);
}

export const setCodeRefHashes = reducer(
  { refId: t.u64(), lineHashes: t.string() },
  (ctx, { refId, lineHashes }) => {
    const ref = ctx.db.codeRef.id.find(refId);
    if (!ref) throw new SenderError(`code ref ${refId} does not exist`);
    assertCodeWriter(ctx, ref.boardId);
    if (!LINE_HASHES_RE.test(lineHashes)) {
      throw new SenderError(`code ref rule: lineHashes must be 1 to ${SNIPPET_MAX_LINES} hashes of 32 lowercase hex characters, separated by single spaces`);
    }
    const row = { refId, boardId: ref.boardId, lineHashes };
    const old = ctx.db.codeRefHash.refId.find(refId);
    if (!old) {
      ctx.db.codeRefHash.insert(row); // a first row fills in what the ref lacked: no new code
      return;
    }
    ctx.db.codeRefHash.refId.update(row);
    // Other lines are new code, as new text is in updateRef: they belong to the next checkpoint.
    if (old.lineHashes !== lineHashes) ctx.db.codeRef.id.update({ ...ref, checkpoint: nextCheckpoint(ctx, ref.boardId) });
  }
);

// The citation's line hash, and its line where the board stores code.
export const setEdgeEvidenceCode = reducer(
  { edgeId: t.u64(), lineHash: t.string(), snippet: t.option(t.string()) },
  (ctx, { edgeId, lineHash, snippet }) => {
    const edge = ctx.db.edge.id.find(edgeId);
    if (!edge) throw new SenderError(`edge ${edgeId} does not exist`);
    assertCodeWriter(ctx, edge.boardId);
    if (!edge.evidence.startsWith('source:')) throw new SenderError('evidence rule: only source citations carry captured evidence');
    if (!LINE_HASH_RE.test(lineHash)) throw new SenderError('evidence rule: lineHash must be 32 lowercase hex characters');
    if (snippet !== undefined) {
      assertEvidenceLine(snippet);
      if (storesCode(ctx, edge.boardId)) ctx.db.edge.id.update({ ...edge, evidenceSnippet: snippet });
      else if (snippet !== '') throw new SenderError(CODE_CONSENT_RULE);
    }
    const row = { edgeId, boardId: edge.boardId, lineHash };
    if (ctx.db.edgeEvidenceHash.edgeId.find(edgeId)) ctx.db.edgeEvidenceHash.edgeId.update(row);
    else ctx.db.edgeEvidenceHash.insert(row);
  }
);

// remoteUrl is shown to everyone who reads the board's code, so a token in an https remote is refused.
export const setSessionRemote = reducer(
  { boardId: t.u64(), remoteUrl: t.string(), pushedHead: t.string(), dirtyPaths: t.array(t.string()) },
  (ctx, { boardId, remoteUrl, pushedHead, dirtyPaths }) => {
    assertCodeWriter(ctx, boardId);
    if (remoteUrl.length > REMOTE_MAX || CONTROL_CHAR_RE.test(remoteUrl) || /^https?:\/\/[^/]*@/i.test(remoteUrl)) {
      throw new SenderError(`remote rule: remoteUrl must be one line of at most ${REMOTE_MAX} characters, without a user name or token`);
    }
    if (pushedHead !== '') assertSha('pushedHead', pushedHead);
    const row = { boardId, remoteUrl, pushedHead, dirtyPaths };
    if (ctx.db.sessionRemote.boardId.find(boardId)) ctx.db.sessionRemote.boardId.update(row);
    else ctx.db.sessionRemote.insert(row);
  }
);

// --- change notes (spec 2026-10-16) -----------------------------------------

const UNREVIEWED = { reviewedBy: '', reviewedAt: Timestamp.UNIX_EPOCH, reviewedSha: '' };
const REVIEW_RULE = 'only a signed-in person with edit access can review a change note';
const NOTE_SHA_RE = /^$|^[0-9a-f]{40}([0-9a-f]{24})?$/;

// change-notes.ts throws plain Errors with its rule sentences; callers see them as refusals.
function noteRule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new SenderError((e as Error).message);
  }
}

function findNoteOrThrow(ctx: any, id: bigint): any {
  const note = ctx.db.changeNote.id.find(id);
  if (!note) {
    throw new SenderError(`change note ${id} does not exist`);
  }
  assertBoardWrite(ctx, note.boardId);
  return note;
}

function noteRef(ctx: any, boardId: bigint, refId: bigint): any {
  const ref = ctx.db.codeRef.id.find(refId);
  if (!ref || ref.boardId !== boardId) {
    throw new SenderError('change note ref must be a code ref on this board');
  }
  return ref;
}

// steps: the agent's absolute lines, or the stored relative form (keptSteps) when the call leaves them out.
// keptSubjects: subjects are the stored ones, so the alias cap (newer than some rows) does not apply.
interface NoteFields { kind: string; severity: string; title: string; summary: string; refId: bigint; steps: string; schema: string; subjects: string; keptSteps?: string; keptSubjects?: boolean }

/** Every field checked, and the JSON ones in the stored (canonical) form; steps relative to the ref (storeSteps). */
function checkNote(ctx: any, boardId: bigint, f: NoteFields): { ref: any; schema: Schema | null; subjects: Subject[]; stored: { steps: string; schema: string; subjects: string } } {
  const ref = noteRef(ctx, boardId, f.refId);
  return noteRule(() => {
    checkKind(f.kind);
    checkSeverity(f.severity);
    checkText(f.title, f.summary);
    const steps = f.keptSteps ?? storeSteps(parseSteps(f.steps, ref), ref.startLine);
    const schema = parseSchema(f.schema);
    const subjects = parseSubjects(f.subjects);
    if (!f.keptSubjects) checkAliases(subjects);
    return { ref, schema, subjects, stored: { steps, schema: schema ? JSON.stringify(schema) : '', subjects: JSON.stringify(subjects) } };
  });
}

/** Reader inputs as stored readers: one already listed keeps its status; a new one must read its subject now (D4a) and starts stale. */
function noteReaders(ctx: any, boardId: bigint, json: string, subjects: Subject[], prev: Reader[], checkpoint: number): Reader[] {
  return noteRule(() => parseReaderInputs(json, subjects.length)).map(r => {
    const kept = prev.find(p => p.refId === r.refId && p.subject === r.subject && !p.removed);
    if (kept) return kept;
    const ref = noteRef(ctx, boardId, BigInt(r.refId));
    // A board without code consent keeps no text to check: the next checkpoint reports the reader (RC-690).
    if (ref.snippet !== '' && !hasTerm(ref.snippet, termsOf(subjects[r.subject]))) throw new SenderError(READER_TERM_RULE);
    return { refId: r.refId, subject: r.subject, status: 'stale', checkpoint };
  });
}

// D9c: the schema card is drawn inside the stored rect, so the anchor grows to fit the card
// every note on it makes together (D9b merges them); it never shrinks.
function growAnchor(ctx: any, anchorId: bigint): void {
  const anchor = ctx.db.node.id.find(anchorId);
  const schemas = [...ctx.db.changeNote.anchorId.filter(anchorId)].flatMap((n: any) => {
    const schema = n.schema === '' ? null : noteRule(() => parseSchema(n.schema));
    return schema ? [schema] : [];
  });
  const merged = mergeSchemas(schemas);
  if (!merged || !anchor) return;
  const h = Math.max(anchor.h, schemaCardHeight(merged));
  if (h !== anchor.h) ctx.db.node.id.update({ ...anchor, h });
}

function keptStepsFor(ctx: any, n: any, refId: bigint | undefined): string {
  if (refId === undefined || refId === n.refId) return n.steps;
  const from = ctx.db.codeRef.id.find(n.refId), to = ctx.db.codeRef.id.find(refId);
  return from && to ? rebaseSteps(n.steps, from.startLine, to.startLine) : n.steps;
}

const sessionCheckpoint = (ctx: any, boardId: bigint): number => ctx.db.session.boardId.find(boardId)?.checkpoint ?? 0;

export const addChangeNote = reducer(
  {
    boardId: t.u64(),
    anchorId: t.u64(),
    kind: t.string(),
    severity: t.string(),
    title: t.string(),
    summary: t.string(),
    refId: t.u64(),
    steps: t.string(),
    schema: t.string(),
    subjects: t.string(),
    readers: t.string(),
    author: t.string(),
  },
  (ctx, a) => {
    assertBoardWrite(ctx, a.boardId);
    const anchor = ctx.db.node.id.find(a.anchorId);
    if (!anchor || anchor.boardId !== a.boardId) {
      throw new SenderError('change note anchor must be a node on this board');
    }
    const { ref, subjects, stored } = checkNote(ctx, a.boardId, a);
    const checkpoint = sessionCheckpoint(ctx, a.boardId);
    const readers = noteReaders(ctx, a.boardId, a.readers, subjects, [], checkpoint);
    ctx.db.changeNote.insert({
      id: 0n,
      boardId: a.boardId,
      anchorId: a.anchorId,
      refId: a.refId,
      kind: a.kind,
      severity: a.severity,
      title: a.title,
      summary: a.summary,
      ...stored,
      readers: JSON.stringify(readers),
      refFileSha: ref.blobSha,
      author: a.author,
      checkpoint,
      ...UNREVIEWED,
    });
    growAnchor(ctx, a.anchorId);
    touch(ctx, a.boardId);
    emit(ctx, a.boardId, 'changenote.added', { title: a.title, kind: a.kind });
  }
);

// Fields left out keep their value. readers, when given, replaces the list.
export const updateChangeNote = reducer(
  {
    id: t.u64(),
    kind: t.option(t.string()),
    severity: t.option(t.string()),
    title: t.option(t.string()),
    summary: t.option(t.string()),
    refId: t.option(t.u64()),
    steps: t.option(t.string()),
    schema: t.option(t.string()),
    subjects: t.option(t.string()),
    readers: t.option(t.string()),
  },
  (ctx, p) => {
    const n = findNoteOrThrow(ctx, p.id);
    const next: NoteFields = {
      kind: p.kind ?? n.kind,
      severity: p.severity ?? n.severity,
      title: p.title ?? n.title,
      summary: p.summary ?? n.summary,
      refId: p.refId ?? n.refId,
      steps: p.steps ?? '',
      // left out: the stored steps stand, on the same lines; a new main ref re-anchors them to its first line
      keptSteps: p.steps === undefined ? keptStepsFor(ctx, n, p.refId) : undefined,
      schema: p.schema ?? n.schema,
      subjects: p.subjects ?? n.subjects,
      keptSubjects: p.subjects === undefined,
    };
    const { ref, subjects, stored } = checkNote(ctx, n.boardId, next);
    const prev = noteRule(() => parseReaders(n.readers));
    const checkpoint = sessionCheckpoint(ctx, n.boardId);
    let readers = p.readers === undefined ? prev : noteReaders(ctx, n.boardId, p.readers, subjects, prev, checkpoint);
    if (readers.some(r => r.subject >= subjects.length)) throw new SenderError(READER_SUBJECT_RULE);
    if (stored.subjects !== n.subjects) {
      // D4a again: under new terms every reader needs a new baseline, or "updated" could mean "never read it".
      readers = readers.map(r => {
        if (r.removed) return r;
        const readerRef = noteRef(ctx, n.boardId, BigInt(r.refId));
        if (readerRef.snippet !== '' && !hasTerm(readerRef.snippet, termsOf(subjects[r.subject]))) throw new SenderError(READER_TERM_RULE);
        return { refId: r.refId, subject: r.subject, status: 'stale', checkpoint };
      });
    }
    const refChanged = next.refId !== n.refId;
    // D9: what a reviewer approved changed, so the review no longer holds.
    const reviewed = !(refChanged || next.severity !== n.severity || stored.steps !== n.steps || stored.schema !== n.schema || stored.subjects !== n.subjects);
    const { keptSteps: _kept, keptSubjects: _keptSubjects, ...fields } = next;
    ctx.db.changeNote.id.update({
      ...n,
      ...fields,
      ...stored,
      readers: JSON.stringify(readers),
      refFileSha: refChanged ? ref.blobSha : n.refFileSha,
      ...(reviewed ? {} : UNREVIEWED),
    });
    growAnchor(ctx, n.anchorId);
    touch(ctx, n.boardId);
  }
);

export const removeChangeNote = reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    const n = findNoteOrThrow(ctx, id);
    ctx.db.changeNote.id.delete(id);
    touch(ctx, n.boardId);
    emit(ctx, n.boardId, 'changenote.removed', { title: n.title });
  }
);

// The checkpoint's reader check (D4): new statuses for the same readers, and the
// main ref's file sha. A different sha than the reviewed one ends the review (D9).
export const setChangeNoteReaders = reducer(
  { id: t.u64(), readers: t.string(), refFileSha: t.string() },
  (ctx, { id, readers, refFileSha }) => {
    const n = findNoteOrThrow(ctx, id);
    const prev = noteRule(() => parseReaders(n.readers));
    const next = noteRule(() => parseReaders(readers));
    if (!NOTE_SHA_RE.test(refFileSha) || next.length !== prev.length || next.some((r, i) => r.refId !== prev[i].refId || r.subject !== prev[i].subject)) {
      throw new SenderError(NOTE_JSON_RULE);
    }
    const stored = next.map((r, i) => (prev[i].removed ? prev[i] : r)); // a removed reader stays unknown
    const edited = n.reviewedBy !== '' && refFileSha !== n.reviewedSha;
    ctx.db.changeNote.id.update({ ...n, readers: JSON.stringify(stored), refFileSha, ...(edited ? UNREVIEWED : {}) });
  }
);

// D12: only a signed-in person who may edit the board reviews; never an agent.
export const markChangeNoteReviewed = reducer(
  { id: t.u64(), reviewed: t.bool() },
  (ctx, { id, reviewed }) => {
    const n = findNoteOrThrow(ctx, id);
    if (callerIsAgent(ctx) || isService(ctx) || ctx.db.agentLink.agent.find(ctx.sender) || !isAccountSender(ctx.senderAuth.jwt, ISSUERS)) {
      throw new SenderError(REVIEW_RULE);
    }
    if (!reviewed) {
      ctx.db.changeNote.id.update({ ...n, ...UNREVIEWED });
      return;
    }
    const p = ctx.db.participant.identity.find(ctx.sender);
    // The caller picks its display name (joinBoard), so the identity prefix (as humanPrefix's) tells two Adas apart.
    const reviewedBy = `${p?.displayName || 'someone'} (${ctx.sender.toHexString().slice(0, 12)})`;
    ctx.db.changeNote.id.update({ ...n, reviewedBy, reviewedAt: ctx.timestamp, reviewedSha: n.refFileSha });
    emit(ctx, n.boardId, 'changenote.reviewed', { title: n.title });
  }
);

// --- threats (spec 2026-10-16) ------------------------------------------------

const CONTAIN_RULE = 'only a signed-in person with edit access can contain a threat';
const MEMBERS_RULE = 'only board members can see or change threats';

/** Edit access first, then membership: an edit-link visitor can edit the board and still never touches threats. */
function assertThreatBoard(ctx: any, boardId: bigint): void {
  assertBoardWrite(ctx, boardId);
  if (!memberBoardIds(ctx).has(boardId)) throw new SenderError(MEMBERS_RULE);
}

function findThreatOrThrow(ctx: any, id: bigint): any {
  const threat = ctx.db.threat.id.find(id);
  if (!threat) throw new SenderError(`threat ${id} does not exist`);
  assertThreatBoard(ctx, threat.boardId);
  return threat;
}

// threats.ts throws plain Errors with its rule sentences; callers see them as refusals.
// author is set once by addThreat; an update checks '' so an old row never blocks its own edit
interface ThreatFields { stage: string; severity: string; title: string; summary: string; cvss: string; package: string; fixedIn: string; flags: string; source: string; author?: string }

function checkThreat(f: ThreatFields): void {
  noteRule(() => {
    checkStage(f.stage);
    checkThreatSeverity(f.severity);
    checkThreatText(f.title, f.summary);
    checkThreatFields(f.cvss, f.package, f.fixedIn, f.author ?? '');
    parseFlags(f.flags);
    parseSource(f.source);
  });
}

export const addThreat = reducer(
  {
    boardId: t.u64(),
    anchorId: t.u64(),
    stage: t.string(),
    severity: t.string(),
    title: t.string(),
    summary: t.string(),
    cvss: t.string(),
    package: t.string(),
    fixedIn: t.string(),
    flags: t.string(),
    source: t.string(),
    author: t.string(),
  },
  (ctx, a) => {
    assertThreatBoard(ctx, a.boardId);
    const anchor = ctx.db.node.id.find(a.anchorId);
    if (!anchor || anchor.boardId !== a.boardId || !isThreatKind(anchor.kind)) {
      throw new SenderError('threat anchor must be a service, datastore or external node on this board');
    }
    checkThreat(a);
    ctx.db.threat.insert({
      id: 0n,
      boardId: a.boardId,
      anchorId: a.anchorId,
      stage: a.stage,
      severity: a.severity,
      title: a.title,
      summary: a.summary,
      cvss: a.cvss,
      package: a.package,
      fixedIn: a.fixedIn,
      flags: a.flags,
      source: a.source,
      author: a.author,
      createdAt: ctx.timestamp,
      containedBy: '',
      containedAt: Timestamp.UNIX_EPOCH,
    });
    touch(ctx, a.boardId);
    // no title: the feed reaches link visitors and threats are members-only (T15)
    emit(ctx, a.boardId, 'threat.added', { stage: a.stage });
  }
);

// Fields left out keep their value. Containment is never touched here.
export const updateThreat = reducer(
  {
    id: t.u64(),
    stage: t.option(t.string()),
    severity: t.option(t.string()),
    title: t.option(t.string()),
    summary: t.option(t.string()),
    cvss: t.option(t.string()),
    package: t.option(t.string()),
    fixedIn: t.option(t.string()),
    flags: t.option(t.string()),
    source: t.option(t.string()),
  },
  (ctx, p) => {
    const th = findThreatOrThrow(ctx, p.id);
    const next: ThreatFields = {
      stage: p.stage ?? th.stage,
      severity: p.severity ?? th.severity,
      title: p.title ?? th.title,
      summary: p.summary ?? th.summary,
      cvss: p.cvss ?? th.cvss,
      package: p.package ?? th.package,
      fixedIn: p.fixedIn ?? th.fixedIn,
      flags: p.flags ?? th.flags,
      source: p.source ?? th.source,
    };
    checkThreat(next);
    if (!canRaiseStage(th.stage, next.stage as any)) throw new SenderError(THREAT_STAGE_LOWER_RULE);
    ctx.db.threat.id.update({ ...th, ...next });
    touch(ctx, th.boardId);
  }
);

export const removeThreat = reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    const th = findThreatOrThrow(ctx, id);
    ctx.db.threat.id.delete(id);
    touch(ctx, th.boardId);
    emit(ctx, th.boardId, 'threat.removed', {});
  }
);

// Like a change-note review: only a signed-in person who may edit the board; never an agent.
export const setThreatContained = reducer(
  { id: t.u64(), contained: t.bool() },
  (ctx, { id, contained }) => {
    const th = findThreatOrThrow(ctx, id);
    if (callerIsAgent(ctx) || isService(ctx) || ctx.db.agentLink.agent.find(ctx.sender) || !isAccountSender(ctx.senderAuth.jwt, ISSUERS)) {
      throw new SenderError(CONTAIN_RULE);
    }
    if (!contained) {
      ctx.db.threat.id.update({ ...th, containedBy: '', containedAt: Timestamp.UNIX_EPOCH });
      return;
    }
    const p = ctx.db.participant.identity.find(ctx.sender);
    ctx.db.threat.id.update({ ...th, containedBy: p?.displayName || 'someone', containedAt: ctx.timestamp });
    emit(ctx, th.boardId, 'threat.contained', {});
  }
);

// ---------------------------------------------------------------------------
// Red crayon review marks (spec 2026-10-19). marks.ts holds the lease rule and the input limits.
// ---------------------------------------------------------------------------

// A person sends a round: every node on this board, one mark each.
export const sendMarks = reducer(
  { boardId: t.u64(), nodeIds: t.array(t.u64()), notes: t.array(t.string()) },
  (ctx, { boardId, nodeIds, notes }) => {
    assertBoardWrite(ctx, boardId);
    if (callerIsAgent(ctx) || isService(ctx) || ctx.db.agentLink.agent.find(ctx.sender) || !isAccountSender(ctx.senderAuth.jwt, ISSUERS)) {
      throw new SenderError(MARK_HUMANS_RULE);
    }
    noteRule(() => validateSend(nodeIds, notes));
    const nodes = nodeIds.map(id => ctx.db.node.id.find(id));
    if (nodes.some(node => node?.boardId !== boardId)) throw new SenderError(MARK_SEND_RULE);
    let round = 0;
    for (const m of ctx.db.mark.boardId.filter(boardId)) if (m.round > round) round = m.round;
    nodes.forEach((node, i) => ctx.db.mark.insert({
      id: 0n,
      boardId,
      nodeId: node!.id,
      nodeLabel: node!.label || node!.sublabel,
      note: notes[i],
      author: ctx.sender,
      round: round + 1,
      preferredAgent: ctx.db.nodeTouch.nodeId.find(node!.id)?.agent ?? '',
      claimedBy: '',
      leaseUntil: Timestamp.UNIX_EPOCH,
      claimGen: 0,
      status: 'sent',
      reply: '',
      files: '[]',
      sentAt: ctx.timestamp,
      answeredAt: Timestamp.UNIX_EPOCH,
    }));
  }
);

// An agent's seat waits for marks: renew its leases, then take every mark it may claim (D9, D10).
// The MCP layer reads the claimed rows back from visible_mark by claimedBy.
export const claimMarks = spacetimedb.reducer(
  { boardId: t.u64(), seat: t.string() },
  (ctx, { boardId, seat }) => {
    if (!callerIsAgent(ctx)) throw new SenderError(MARK_AGENTS_RULE);
    assertBoardWrite(ctx, boardId);
    if (!SEAT_RE.test(seat)) throw new SenderError(MARK_SEAT_RULE);
    const hex = ctx.sender.toHexString();
    const owner = `${hex}/${seat}`;
    const now = ctx.timestamp.microsSinceUnixEpoch;
    // Polls come every few seconds: write the waiter row (and sweep stale ones) only when it is due.
    const mine = ctx.db.markWaiter.owner.find(owner);
    if (waiterDue(mine?.lastWaitAt.microsSinceUnixEpoch, now)) {
      const waiter = { owner, boardId, lastWaitAt: ctx.timestamp };
      if (mine) ctx.db.markWaiter.owner.update(waiter);
      else {
        // Seats are the caller's choice, so a new one replaces this identity's oldest past the cap (limits.ts).
        if (limitsApply(ctx)) {
          const seats = [...ctx.db.markWaiter.boardId.filter(boardId)].filter(w => w.owner.startsWith(`${hex}/`));
          seats.sort((a, b) => (a.lastWaitAt.microsSinceUnixEpoch < b.lastWaitAt.microsSinceUnixEpoch ? -1 : 1));
          for (const old of seats.slice(0, Math.max(0, seats.length - LIMITS.waitersPerIdentity + 1))) ctx.db.markWaiter.owner.delete(old.owner);
        }
        ctx.db.markWaiter.insert(waiter);
      }
      // Seats that stopped waiting leave rows behind; drop them so the banner and the table stay honest.
      for (const w of [...ctx.db.markWaiter.boardId.filter(boardId)]) {
        if (w.owner !== owner && staleWaiter(w.lastWaitAt.microsSinceUnixEpoch, now)) ctx.db.markWaiter.owner.delete(w.owner);
      }
    }
    const leaseUntil = new Timestamp(now + LEASE_MICROS);
    renewLeases(ctx, boardId, owner);
    // shortcut: scans every mark on the board per call; index by status if answered history grows large.
    for (const m of [...ctx.db.mark.boardId.filter(boardId)]) {
      if (claimable({ ...m, leaseUntil: m.leaseUntil.microsSinceUnixEpoch, sentAt: m.sentAt.microsSinceUnixEpoch }, now, hex)) {
        ctx.db.mark.id.update({ ...m, status: 'claimed', claimedBy: owner, leaseUntil, claimGen: m.claimGen + 1 });
      }
    }
  }
);

// Every mark tool renews the seat's claimed marks on the board, so a long round keeps its marks.
function renewLeases(ctx: any, boardId: bigint, owner: string): void {
  const leaseUntil = new Timestamp(ctx.timestamp.microsSinceUnixEpoch + LEASE_MICROS);
  for (const m of [...ctx.db.mark.boardId.filter(boardId)]) {
    if (m.status === 'claimed' && m.claimedBy === owner) ctx.db.mark.id.update({ ...m, leaseUntil });
  }
}

// Only the seat that holds the mark, with the claimGen it was given, answers it.
export const replyMark = reducer(
  { markId: t.u64(), seat: t.string(), claimGen: t.u32(), status: t.string(), reply: t.string(), files: t.array(t.string()) },
  (ctx, { markId, seat, claimGen, status, reply, files }) => {
    if (!callerIsAgent(ctx)) throw new SenderError(MARK_AGENTS_RULE);
    const m = ctx.db.mark.id.find(markId);
    if (!m) throw new SenderError(`mark ${markId} does not exist`);
    assertBoardWrite(ctx, m.boardId);
    const hex = ctx.sender.toHexString();
    const owner = `${hex}/${seat}`;
    const refusal = replyRefusal(m, owner, hex, claimGen);
    if (refusal) throw new SenderError(refusal === 'seat' ? MARK_SEAT_MISMATCH_RULE : MARK_RECLAIMED_RULE);
    noteRule(() => validateReply(status, reply, files));
    ctx.db.mark.id.update({ ...m, status, reply, files: JSON.stringify(files), answeredAt: ctx.timestamp });
    renewLeases(ctx, m.boardId, owner);
  }
);

// The sender has seen the replies on this board up to now.
export const markRepliesRead = spacetimedb.reducer(
  { boardId: t.u64() },
  (ctx, { boardId }) => {
    assertBoardWrite(ctx, boardId);
    const row = [...ctx.db.markRead.identity.filter(ctx.sender)].find(r => r.boardId === boardId);
    if (row) ctx.db.markRead.id.update({ ...row, lastReadAt: ctx.timestamp });
    else ctx.db.markRead.insert({ id: 0n, identity: ctx.sender, boardId, lastReadAt: ctx.timestamp });
  }
);

export const updateCursor = spacetimedb.reducer(
  { boardId: t.u64(), x: t.f32(), y: t.f32() },
  (ctx, { boardId, x, y }) => {
    assertBoardRead(ctx, boardId);
    const existing = ctx.db.cursor.identity.find(ctx.sender);
    if (existing) {
      ctx.db.cursor.identity.update({ ...existing, boardId, x, y });
    } else {
      ctx.db.cursor.insert({ identity: ctx.sender, boardId, x, y });
    }
  }
);

// RC-605: a canvas names the boards it shows (the board, and the one its diff
// compares against) before it subscribes and on every switch. The board views
// then return this sender only those boards; onDisconnect closes them.
export const openBoards = spacetimedb.reducer(
  { boardIds: t.array(t.u64()) },
  (ctx, { boardIds }) => {
    if (!ctx.connectionId) throw new SenderError('open boards needs a live connection');
    if (boardIds.length === 0 || boardIds.length > 2) throw new SenderError('open one board, and at most the board it is compared with');
    for (const boardId of boardIds) assertBoardRead(ctx, boardId);
    const row = { connectionId: ctx.connectionId, identity: ctx.sender, boardIds };
    if (ctx.db.openBoard.connectionId.find(ctx.connectionId)) ctx.db.openBoard.connectionId.update(row);
    else ctx.db.openBoard.insert(row);
  }
);

// The database keeps running a sender's views after its last connection closes,
// so the identity's last row is emptied, not deleted: its views then read no
// board, where no row at all would mean every board it can read.
function closeBoards(ctx: any): void {
  const own = ctx.connectionId && ctx.db.openBoard.connectionId.find(ctx.connectionId);
  if (!own) return;
  if ([...ctx.db.openBoard.identity.filter(ctx.sender)].length > 1) ctx.db.openBoard.connectionId.delete(ctx.connectionId);
  else ctx.db.openBoard.connectionId.update({ ...own, boardIds: [] });
}

export const setSelection = spacetimedb.reducer(
  { boardId: t.u64(), nodeIds: t.array(t.u64()) },
  (ctx, { boardId, nodeIds }) => {
    assertBoardRead(ctx, boardId);
    // Any reader may call this and every viewer receives the row: a select-all is the longest list.
    // Counts the board's nodes only up to nodeIds.length.
    let room = nodeIds.length;
    for (const _ of ctx.db.node.boardId.filter(boardId)) if (--room <= 0) break;
    if (room > 0) throw new SenderError('a selection holds at most as many nodes as its board');
    setCallerSelection(ctx, boardId, nodeIds);
  }
);

// RC-528: participant rows are durable. Connections are refcounted so the
// same identity in several tabs stays "online" until the last one closes.
// The row itself is never deleted. Service accounts (the dashboard Worker,
// one connect/disconnect pair per HTTP call) are skipped entirely, or every
// Worker request would rewrite a participant row on every canvas.
//
// Hosted agents (our issuer, sub agent:…) connect once per HTTP call. They get
// one stub row that never counts a connection and whose lastSeenAt moves at most
// once a minute; the canvas shows them by kind and lastSeenAt (spec D17).
export const onConnect = spacetimedb.clientConnected(ctx => {
  if (isService(ctx)) {
    return;
  }
  // Issuer allowlist (M1.2, RC-571): staging, production and none refuse every
  // other sender; local only logs it. The log names the issuer, never the
  // token; the caller's text names neither (it can be a vendor host).
  if (!issuerAccepted(ctx)) {
    console.log(`issuer rule: ${ISSUERS.enforce ? 'refused' : 'would refuse'} ${ctx.senderAuth.jwt?.issuer ?? ''}`);
    if (ISSUERS.enforce) throw new SenderError('issuer rule: tokens from this issuer are not accepted');
  }
  if (fromUs(ctx) && /^machine:[0-9a-f]{32}$/.test(ctx.senderAuth.jwt!.subject)) registerWorkspaceMachine(ctx, ctx.senderAuth.jwt!.subject.slice('machine:'.length));
  const existing = ctx.db.participant.identity.find(ctx.sender);
  const authIssuer = ctx.senderAuth.jwt?.issuer ?? '';
  if (isBrowserSession(ctx.senderAuth.jwt, ISSUERS) && !ctx.db.workspaceAccount.identity.find(ctx.sender)) ctx.db.workspaceAccount.insert({ identity: ctx.sender, disabled: false });
  if (hostedAgent(ctx)) {
    if (!existing) {
      ctx.db.participant.insert({
        identity: ctx.sender,
        displayName: '',
        kind: 'agent',
        connectedAt: ctx.timestamp,
        connections: 0,
        lastSeenAt: ctx.timestamp,
        authIssuer,
      });
    } else if (existing.kind !== 'agent' || ctx.timestamp.microsSinceUnixEpoch - existing.lastSeenAt.microsSinceUnixEpoch > MINUTE_MICROS) {
      ctx.db.participant.identity.update({ ...existing, kind: 'agent', lastSeenAt: ctx.timestamp });
    }
    return;
  }
  if (existing) {
    ctx.db.participant.identity.update({
      ...existing,
      connections: existing.connections + 1,
      lastSeenAt: ctx.timestamp,
      authIssuer,
    });
  } else {
    // Stub row so a second connection arriving before joinBoard still
    // counts; joinBoard fills in displayName/kind.
    ctx.db.participant.insert({
      identity: ctx.sender,
      displayName: '',
      kind: 'human',
      connectedAt: ctx.timestamp,
      connections: 1,
      lastSeenAt: ctx.timestamp,
      authIssuer,
    });
  }
});

// D6 (RC-530): cursor and selection (identity-keyed, last writer wins across
// tabs) are cleared on EVERY disconnect, not only at zero connections: an open
// dashboard tab or an HTTP call kept a closed canvas tab's cursor alive as a
// ghost. A still-open canvas tab re-publishes its own on the next move.
// A hosted agent's call ends here too: it keeps its selection (no churn).
export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  closeBoards(ctx);
  if (ctx.connectionId) {
    ctx.db.chartEmbedVisit.connectionId.delete(ctx.connectionId);
    ctx.db.boardEmbedVisit.connectionId.delete(ctx.connectionId);
  }
  if (isService(ctx) || hostedAgent(ctx)) {
    return;
  }
  const existing = ctx.db.participant.identity.find(ctx.sender);
  if (existing) {
    ctx.db.participant.identity.update({
      ...existing,
      connections: existing.connections > 0 ? existing.connections - 1 : 0,
      lastSeenAt: ctx.timestamp,
    });
  }
  if (ctx.db.cursor.identity.find(ctx.sender)) {
    ctx.db.cursor.identity.delete(ctx.sender);
  }
  if (ctx.db.selection.identity.find(ctx.sender)) {
    ctx.db.selection.identity.delete(ctx.sender);
  }
});

// Service only: the caller owns Demo, a public board every dashboard lists, and the check scans every board.
export const seedDemoBoard = spacetimedb.reducer(ctx => {
  assertService(ctx);
  // Demo shows sample code, so its owner stores code (RC-690); a re-seed grants it to a Demo made before.
  // Only the public one is Demo: a member's own board may carry the name, and its owner did not opt in.
  for (const b of ctx.db.board.iter()) {
    if (b.name === 'Demo' && ctx.db.publicBoard.boardId.find(b.id)) {
      const owner = boardOwner(ctx, b.id);
      if (owner) writeCodeConsent(ctx, owner, true);
      return;
    }
  }
  writeCodeConsent(ctx, ctx.sender, true);
  const board = insertBoard(ctx, 'Demo');
  seedDemoContent(ctx, board.id);
  // last, so the stats see every seeded row: 9/8 nodes, 6/5 edges, one edge
  // per evidence class, 6 repo files (the spec §1.3 acceptance fixture)
  initBoard(ctx, board.id, 'Demo', 'seed');
  ctx.db.publicBoard.insert({ boardId: board.id });
});

// Demo's drawing, for seedDemoBoard and resetDemo.
function seedDemoContent(ctx: any, boardId: bigint): void {
  // Mirrors the canvas design mock: a boundary around the core services, an
  // external client and vendor, a datastore pair (one hidden into "runtime
  // plumbing"), and a note. Coordinates come straight off the design artboard
  // (all on the 4px grid).
  // Sub-project C defaults, spread into every seeded row so the seed stays a
  // single source of truth as the style columns grow.
  const style = { shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '' };
  const edgeStyle = { color: '', strokeStyle: 'solid', evidenceSnippet: '', evidenceStatus: '', relation: '', latencyMs: -1, latencySource: '' };
  const base = { doc: '', hidden: false, imported: false, ...style };
  const web = ctx.db.node.insert({
    id: 0n, boardId, label: 'Web Client', sublabel: 'browser',
    x: 32, y: 112, w: 160, h: 76, token: 'ink', focal: false, kind: 'external', ...base,
  });
  ctx.db.node.insert({
    id: 0n, boardId, label: 'core services', sublabel: '',
    x: 272, y: 48, w: 320, h: 328, token: 'muted', focal: false, kind: 'boundary', ...base,
  });
  const gateway = ctx.db.node.insert({
    id: 0n, boardId, label: 'API Gateway', sublabel: 'svc-gw',
    x: 296, y: 112, w: 272, h: 76, token: 'ink', focal: true, kind: 'service', ...base,
  });
  const auth = ctx.db.node.insert({
    id: 0n, boardId, label: 'Auth', sublabel: 'svc-auth',
    x: 296, y: 252, w: 128, h: 76, token: 'ink', focal: false, kind: 'service', ...base,
  });
  const billing = ctx.db.node.insert({
    id: 0n, boardId, label: 'Billing', sublabel: 'svc-billing',
    x: 440, y: 252, w: 128, h: 76, token: 'ink', focal: false, kind: 'service', ...base,
  });
  const stripe = ctx.db.node.insert({
    id: 0n, boardId, label: 'Stripe', sublabel: 'external',
    x: 712, y: 112, w: 200, h: 76, token: 'ink', focal: false, kind: 'external', ...base,
  });
  const postgres = ctx.db.node.insert({
    id: 0n, boardId, label: 'Postgres', sublabel: 'db-primary',
    x: 712, y: 252, w: 200, h: 76, token: 'ink', focal: false, kind: 'datastore', ...base,
  });
  const redis = ctx.db.node.insert({
    id: 0n, boardId, label: 'Redis', sublabel: 'cache',
    x: 712, y: 384, w: 200, h: 76, token: 'muted', focal: false,
    kind: 'datastore', doc: '', hidden: true, imported: false, ...style,
  });
  ctx.db.node.insert({
    id: 0n, boardId,
    label: 'Ledger writes are synchronous. Billing blocks on Postgres.', sublabel: '',
    x: 32, y: 384, w: 216, h: 88, token: 'ink', focal: false, kind: 'note', ...base,
  });

  // The validation set for source:<path>:<line> citations, and the rows the
  // source index lists.
  for (const path of [
    'cmd/gateway/main.go',
    'internal/auth/',
    'internal/billing/ledger.go',
    'internal/store/store.go',
    'internal/cache/redis.go',
    'internal/queue/worker.go',
  ]) {
    ctx.db.repoFile.insert({ id: 0n, boardId, path });
  }

  // One edge per evidence class: human, none (legacy ''), import, source
  // citation, test-import — plus a hidden edge in the same set as Redis.
  const e = { hidden: false, imported: false, ...edgeStyle };
  ctx.db.edge.insert({ id: 0n, boardId, fromNode: web.id, toNode: gateway.id, label: 'https', evidence: 'human:seed', ...e });
  ctx.db.edge.insert({ id: 0n, boardId, fromNode: gateway.id, toNode: auth.id, label: 'grpc', evidence: '', ...e });
  ctx.db.edge.insert({ id: 0n, boardId, fromNode: gateway.id, toNode: billing.id, label: 'grpc', evidence: 'import', imported: true, hidden: false, ...edgeStyle });
  ctx.db.edge.insert({ id: 0n, boardId, fromNode: billing.id, toNode: postgres.id, label: 'sql', evidence: 'source:internal/store/store.go:42', imported: true, hidden: false, ...edgeStyle, evidenceSnippet: '\treturn s.db.QueryContext(ctx, q, args...)', evidenceStatus: 'ok' });
  ctx.db.edge.insert({ id: 0n, boardId, fromNode: gateway.id, toNode: stripe.id, label: 'webhook', evidence: 'test-import', imported: true, hidden: false, ...edgeStyle });
  const cacheEdge = ctx.db.edge.insert({
    id: 0n, boardId, fromNode: billing.id, toNode: redis.id, label: 'cache',
    evidence: 'import', imported: true, hidden: true, ...edgeStyle,
  });

  const plumbing = ctx.db.hideSet.insert({
    id: 0n, boardId, name: 'runtime plumbing', createdBy: 'seed',
  });
  ctx.db.hideSetMember.insert({ id: 0n, setId: plumbing.id, targetKind: 'node', targetId: redis.id });
  ctx.db.hideSetMember.insert({ id: 0n, setId: plumbing.id, targetKind: 'edge', targetId: cacheEdge.id });
}

// The seeded Demo: the public board named Demo (seedDemoBoard's, or an older one made public by hand).
function demoBoard(ctx: any): any {
  for (const row of ctx.db.publicBoard.iter()) {
    const board = ctx.db.board.id.find(row.boardId);
    if (board?.name === 'Demo') return board;
  }
  return undefined;
}

const DEMO_IDLE_MICROS = 10n * MINUTE_MICROS;

// Service only (the mcp Worker's 5-minute cron, RC-568): puts Demo back to the seed once nobody wrote to
// it for 10 minutes. The check runs in this transaction, so a fresh edit is never wiped. A Demo unchanged
// since the last reset is left alone: every reset re-sends the whole drawing to every Demo viewer.
export const resetDemo = spacetimedb.reducer(ctx => {
  assertService(ctx);
  const demo = demoBoard(ctx);
  if (!demo) return;
  const stats = ctx.db.boardStats.boardId.find(demo.id);
  const updatedAt = stats ? stats.updatedAt : Timestamp.UNIX_EPOCH;
  const last = ctx.db.demoReset.boardId.find(demo.id);
  if (ctx.timestamp.microsSinceUnixEpoch - updatedAt.microsSinceUnixEpoch <= DEMO_IDLE_MICROS) return;
  if (last && updatedAt.microsSinceUnixEpoch <= last.resetAt.microsSinceUnixEpoch) return;
  clearBoardContent(ctx, demo.id);
  seedDemoContent(ctx, demo.id);
  refreshStats(ctx, demo.id);
  // A reset is not an edit: keep the last write's time, so touch (at most once a minute) records the next one.
  ctx.db.boardStats.boardId.update({ ...ctx.db.boardStats.boardId.find(demo.id)!, updatedAt });
  if (last) ctx.db.demoReset.boardId.update({ ...last, resetAt: ctx.timestamp });
  else ctx.db.demoReset.insert({ boardId: demo.id, resetAt: ctx.timestamp });
});

// The cron's read (mcp/src/canary.ts): a changed resetAt is a reset. Nothing for anyone but a service account.
export const serviceDemoReset = spacetimedb.view(
  { name: 'service_demo_reset', public: true },
  t.array(tables.demoReset.rowType),
  ctx => (isService(ctx) ? [...ctx.db.demoReset.iter()] : [])
);

// Service only: gives every board made before RC-530 its boardStats row
// (createdAt = epoch, "unknown"). Listing such a board still needs a grant,
// which the operator adds with owner SQL (runbook).
export const backfillBoardStats = spacetimedb.reducer(ctx => {
  assertService(ctx);
  for (const b of ctx.db.board.iter()) {
    if (!ctx.db.boardStats.boardId.find(b.id)) {
      refreshStats(ctx, b.id);
    }
  }
});

// Service only, run after every publish: boards made before slugs (2026-10-14)
// get one, so every board link can be #b=<slug>. Idempotent.
export const backfillBoardSlugs = spacetimedb.reducer(ctx => {
  assertService(ctx);
  backfillSlugs(ctx.db.board, ctx.random);
});

// ---------------------------------------------------------------------------
// RC-530 dashboard: teams, agent links, the activity drain and the views
// ---------------------------------------------------------------------------

function assertMember(ctx: any, orgId: string): void {
  const imported = ctx.db.legacyWorkspace.orgId.find(orgId);
  if (imported) {
    const member = membership(ctx, imported.workspaceId);
    if (member && member.role !== 'guest') return;
    throw new SenderError(`team rule: you are not a member of org ${orgId}; sync your teams and retry`);
  }
  for (const m of ctx.db.orgMember.member.filter(ctx.sender)) {
    if (m.orgId === orgId) {
      return;
    }
  }
  throw new SenderError(`team rule: you are not a member of org ${orgId}; sync your teams and retry`);
}

function assertOwner(ctx: any, boardId: bigint, verb: string): void {
  assertBoardExists(ctx, boardId);
  if (!ownsBoard(ctx, boardId)) {
    throw new SenderError(`share rule: only an owner of board ${boardId} can ${verb} it`);
  }
}

// ---------------------------------------------------------------------------
// RC-525/526: complete source snapshots and independently reviewed intent
// ---------------------------------------------------------------------------

function architectureHistoryOrThrow(ctx: any, historyId: bigint): any {
  const h = ctx.db.architectureHistory.id.find(historyId);
  if (!h) throw new SenderError(`architecture history ${historyId} does not exist`);
  return h;
}

function canReadArchitectureHistory(ctx: any, history: any): boolean {
  if (isService(ctx)) return true;
  if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return false;
  const scope = ctx.db.historyWorkspace.historyId.find(history.id);
  if (!scope) return true; // Legacy callers are filtered by their existing owner/board path.
  if (['owner', 'admin'].includes(membership(ctx, scope.workspaceId)?.role)) return true;
  const versions = [...ctx.db.architectureVersion.historyId.filter(history.id)];
  // Before publication there is no board ACL; after publication creator metadata grants nothing.
  if (versions.length === 0 && history.owner.isEqual(ctx.sender) && membership(ctx, scope.workspaceId)?.role === 'member') return true;
  return versions.some((v: any) => canReadBoard(ctx, v.boardId));
}

// This view authorizes import retries in the dashboard; read access alone never permits a service import.
function canManageArchitectureHistory(ctx: any, history: any): boolean {
  if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return false;
  const scope = ctx.db.historyWorkspace.historyId.find(history.id);
  if (!scope) return history.owner.isEqual(ctx.sender);
  const member = membership(ctx, scope.workspaceId);
  if (['owner', 'admin'].includes(member?.role)) return true;
  if (member?.role !== 'member') return false;
  const facts = [...ctx.db.architectureVersion.historyId.filter(history.id)].filter((v: any) => v.assertionMode === 'fact');
  return facts.length === 0 ? history.owner.isEqual(ctx.sender) : facts.every((v: any) => humanBoardRole(ctx, v.boardId) === 'manager');
}

function inheritWorkspaceBoard(ctx: any, source: bigint, target: bigint, creator: any): void {
  const scope = ctx.db.boardWorkspace.boardId.find(source);
  if (!scope) return;
  assignBoardWorkspace(ctx, target, scope.workspaceId, creator, scope.defaultRole);
  for (const grant of ctx.db.workspaceBoardGrant.boardId.filter(source)) {
    if (membership(ctx, scope.workspaceId, grant.member) && ![...ctx.db.workspaceBoardGrant.boardId.filter(target)].some((g: any) => g.member.isEqual(grant.member))) ctx.db.workspaceBoardGrant.insert({ ...grant, id: 0n, boardId: target });
  }
  for (const grant of ctx.db.workspaceTeamGrant.boardId.filter(source)) ctx.db.workspaceTeamGrant.insert({ ...grant, id: 0n, boardId: target });
  // Migrated personal boards can still have organization editors outside their owner's workspace.
  for (const grant of ctx.db.teamGrant.boardId.filter(source)) ctx.db.teamGrant.insert({ ...grant, id: 0n, boardId: target });
}

function architectureVersionOrThrow(ctx: any, boardId: bigint, mode?: string): any {
  const v = ctx.db.architectureVersion.boardId.find(boardId);
  if (!v || (mode && v.assertionMode !== mode)) throw new SenderError(`architecture board ${boardId} must be ${mode ?? 'a version'}`);
  return v;
}

// Charts are presentation: they never enter the diff, the signature or validation.
function architectureGraph(ctx: any, boardId: bigint): Graph {
  const nodes = [...ctx.db.node.boardId.filter(boardId)].filter((n: any) => n.kind !== 'chart');
  const keys = new Map<bigint, string>(nodes.map((n: any) => [n.id, n.sourceKey]));
  return {
    nodes: nodes.map((n: any) => ({ key: n.sourceKey, label: n.label, sublabel: n.sublabel, kind: n.kind })),
    edges: [...ctx.db.edge.boardId.filter(boardId)].filter((e: any) => keys.has(e.fromNode) && keys.has(e.toNode)).map((e: any) => ({ from: keys.get(e.fromNode)!, to: keys.get(e.toNode)!, label: e.label, relation: e.relation, evidence: e.evidence })),
    files: [...ctx.db.repoFile.boardId.filter(boardId)].map((f: any) => f.path),
  };
}

function pinnedRefs(refsJson: string): { ref: string; sha: string }[] {
  let refs;
  try { refs = JSON.parse(refsJson); } catch { throw new SenderError('architecture refs must be JSON'); }
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 10) throw new SenderError('architecture history requires 1–10 pinned refs');
  const seen = new Set<string>();
  for (const r of refs) {
    if (!r || typeof r.ref !== 'string' || !r.ref.trim() || r.ref.length > 300 || CONTROL_CHAR_RE.test(r.ref) || seen.has(r.ref)) throw new SenderError('architecture refs must have unique nonempty ref names');
    assertSha('pinned sha', r.sha);
    seen.add(r.ref);
  }
  return refs.map(r => ({ ref: r.ref, sha: r.sha }));
}

function assertRequestKey(key: string): void {
  if (!key.trim() || key.length > 200 || CONTROL_CHAR_RE.test(key)) throw new SenderError('architecture requestKey must be a short nonempty string');
}

function insertArchitectureHistory(ctx: any, { name, repository, refsJson, requestKey }: { name: string; repository: string; refsJson: string; requestKey: string }, workspaceId = 0n): void {
    if (isWorkspaceMachine(ctx)) throw new SenderError('service account rule: service accounts cannot create architecture histories');
    assertBoardName(name); assertRequestKey(requestKey);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(repository)) throw new SenderError('architecture repository must be a public GitHub repository URL');
    const canonicalRefs = JSON.stringify(pinnedRefs(refsJson));
    for (const h of ctx.db.architectureHistory.owner.filter(ctx.sender)) {
      if (h.requestKey === requestKey) {
        if (h.name !== name || h.repository !== repository || h.refsJson !== canonicalRefs) throw new SenderError('architecture requestKey already belongs to a different import');
        if ((ctx.db.historyWorkspace.historyId.find(h.id)?.workspaceId ?? 0n) !== workspaceId) throw new SenderError('workspace rule: import request key belongs to another workspace');
        return;
      }
    }
    const history = ctx.db.architectureHistory.insert({ id: 0n, owner: ctx.sender, name, repository, refsJson: canonicalRefs, requestKey, status: 'queued', error: '', curationJson: '', createdAt: ctx.timestamp, updatedAt: ctx.timestamp });
    if (workspaceId) ctx.db.historyWorkspace.insert({ historyId: history.id, workspaceId });
}

export const createArchitectureHistory = reducer(
  { name: t.string(), repository: t.string(), refsJson: t.string(), requestKey: t.string() },
  (ctx, args) => insertArchitectureHistory(ctx, args)
);

export const createWorkspaceArchitectureHistory = reducer(
  { workspaceId: t.u64(), name: t.string(), repository: t.string(), refsJson: t.string(), requestKey: t.string() },
  (ctx, args) => {
    if (!workspaceHuman(ctx)) throw new SenderError('workspace rule: sign in with a human account');
    const member = membership(ctx, args.workspaceId);
    if (!member || member.role === 'guest') throw new SenderError('workspace rule: a full workspace member is required to import');
    insertArchitectureHistory(ctx, args, args.workspaceId);
  }
);

export const setArchitectureImportStatus = spacetimedb.reducer(
  { historyId: t.u64(), status: t.string(), error: t.string() },
  (ctx, { historyId, status, error }) => {
    assertService(ctx);
    const h = architectureHistoryOrThrow(ctx, historyId);
    if (!['queued', 'running', 'ready', 'partial', 'failed'].includes(status)) throw new SenderError('architecture import status is invalid');
    if (error.length > 4000) throw new SenderError('architecture import error is too long');
    const facts = [...ctx.db.architectureVersion.historyId.filter(historyId)].filter(v => v.assertionMode === 'fact');
    const complete = pinnedRefs(h.refsJson).every((_ref, index) => facts.some(v => v.index === index));
    ctx.db.architectureHistory.id.update({ ...h, status: complete ? 'ready' : status, error: complete ? '' : error, updatedAt: ctx.timestamp });
  }
);

const CURATED_NODE_FIELDS = ['label', 'sublabel', 'x', 'y', 'w', 'h', 'token', 'focal', 'shape', 'color', 'strokeStyle', 'size', 'hidden'] as const;
const CURATED_EDGE_FIELDS = ['label', 'color', 'strokeStyle', 'hidden'] as const;
type ArchitectureCuration = { nodes: Record<string, any>; edges: Record<string, any>; sets: Record<string, { nodes: string[]; edges: string[] }> };
function readCuration(json: string): ArchitectureCuration {
  const parsed = json ? JSON.parse(json) : {};
  return { nodes: Object.assign(Object.create(null), parsed.nodes), edges: Object.assign(Object.create(null), parsed.edges), sets: Object.assign(Object.create(null), parsed.sets) };
}
function pickFields(row: any, fields: readonly string[]): any {
  return Object.fromEntries(fields.map(k => [k, row[k]]));
}

function applyArchitectureCuration(ctx: any, boardId: bigint, curation: ArchitectureCuration): void {
  const nodes = [...ctx.db.node.boardId.filter(boardId)];
  const keys = new Map<bigint, string>(nodes.map((n: any) => [n.id, n.sourceKey]));
  const nodeIds = new Map<string, bigint>(nodes.map((n: any) => [n.sourceKey, n.id]));
  const edgeIds = new Map<string, bigint>();
  for (const n of nodes) {
    if (curation.nodes[n.sourceKey]) ctx.db.node.id.update({ ...n, ...pickFields(curation.nodes[n.sourceKey], CURATED_NODE_FIELDS) });
  }
  // Retained choices for absent keys can reappear alongside newer focal
  // choices. Preserve the board's two-focal invariant in exact key order.
  let focalCount = 0;
  const curatedNodes = [...ctx.db.node.boardId.filter(boardId)].sort((a, b) => a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0);
  for (const n of curatedNodes) if (n.focal && focalCount++ >= FOCAL_LIMIT) ctx.db.node.id.update({ ...n, focal: false });
  for (const e of ctx.db.edge.boardId.filter(boardId)) {
    const key = edgeKey(keys.get(e.fromNode)!, keys.get(e.toNode)!, e.relation);
    edgeIds.set(key, e.id);
    if (curation.edges[key]) {
      ctx.db.edge.id.update({ ...e, ...pickFields(curation.edges[key], CURATED_EDGE_FIELDS) });
      // Saved before RC-688: no weight, and the snapshot's own stays.
      const weight = curation.edges[key].weight;
      if (ALLOWED_EDGE_WEIGHTS.includes(weight)) writeEdgeWeight(ctx, e, weight);
    }
  }
  // Named hide sets are part of the shared view, and rows must point at this
  // snapshot's IDs rather than IDs from the snapshot that supplied the view.
  for (const set of [...ctx.db.hideSet.boardId.filter(boardId)]) {
    for (const m of [...ctx.db.hideSetMember.setId.filter(set.id)]) ctx.db.hideSetMember.id.delete(m.id);
    ctx.db.hideSet.id.delete(set.id);
  }
  for (const [name, members] of Object.entries(curation.sets)) {
    const set = ctx.db.hideSet.insert({ id: 0n, boardId, name, createdBy: 'architecture-curation' });
    for (const key of members.nodes) if (nodeIds.has(key)) addMembership(ctx, set.id, 'node', nodeIds.get(key)!);
    for (const key of members.edges) if (edgeIds.has(key)) addMembership(ctx, set.id, 'edge', edgeIds.get(key)!);
  }
}

export const publishArchitectureSnapshot = spacetimedb.reducer(
  { historyId: t.u64(), index: t.u32(), ref: t.string(), sha: t.string(), graphJson: t.string() },
  (ctx, { historyId, index, ref, sha, graphJson }) => {
    assertService(ctx);
    const h = architectureHistoryOrThrow(ctx, historyId), pinned = pinnedRefs(h.refsJson)[index];
    if (!pinned || pinned.ref !== ref || pinned.sha !== sha) throw new SenderError('architecture snapshot does not match the pinned ref and sha');
    for (const v of ctx.db.architectureVersion.historyId.filter(historyId)) {
      if (v.assertionMode === 'fact' && v.index === index) return;
    }
    let graph: Graph;
    try { graph = validateGraph(JSON.parse(graphJson)); } catch (error) { throw new SenderError(error instanceof Error ? error.message : 'invalid architecture graph'); }
    if (graph.nodes.some(n => n.key.startsWith('proposal:')) || graph.edges.some(e => e.evidence !== 'import' && e.evidence !== 'test-import')) throw new SenderError('architecture factual snapshots require source keys and real import evidence');
    const board = insertBoard(ctx, `${h.name.slice(0, 60)} · ${ref.slice(0, 30)}`);
    const ids = new Map<string, bigint>();
    const positions = new Map<string, { x: number; y: number }>();
    // Keep positions by source identity. Newly discovered keys append after
    // the union of known keys, including packages absent from this ref.
    const facts = [...ctx.db.architectureVersion.historyId.filter(historyId)].filter(v => v.assertionMode === 'fact').sort((a, b) => a.index - b.index);
    for (const fact of facts) for (const n of ctx.db.node.boardId.filter(fact.boardId)) positions.set(n.sourceKey, { x: n.x, y: n.y });
    let nextSlot = positions.size;
    for (const n of graph.nodes) {
      const position = positions.get(n.key) ?? { x: (nextSlot % 8) * 224, y: Math.floor(nextSlot++ / 8) * 128 };
      const row = ctx.db.node.insert({ id: 0n, boardId: board.id, label: n.label, sublabel: n.sublabel, kind: n.kind, sourceKey: n.key, ...position, w: 176, h: 80, token: 'ink', focal: false, doc: '', hidden: false, imported: true, shape: 'rect', color: '', strokeStyle: 'solid', size: 'm' });
      ids.set(n.key, row.id);
    }
    for (const e of graph.edges) ctx.db.edge.insert({ id: 0n, boardId: board.id, fromNode: ids.get(e.from)!, toNode: ids.get(e.to)!, label: e.label, relation: e.relation, evidence: e.evidence, imported: true, hidden: false, color: '', strokeStyle: 'solid', evidenceSnippet: '', evidenceStatus: '', latencyMs: -1, latencySource: '' });
    for (const path of graph.files) ctx.db.repoFile.insert({ id: 0n, boardId: board.id, path });
    ctx.db.architectureVersion.insert({ boardId: board.id, historyId, index, assertionMode: 'fact', baseBoardId: 0n, ref, sha, status: 'ready', requestKey: `${h.requestKey}:${index}`, reviewedSignature: '', implementedBoardId: 0n });
    if (h.curationJson) applyArchitectureCuration(ctx, board.id, readCuration(h.curationJson));
    ctx.db.boardGrant.insert({ id: 0n, boardId: board.id, grantee: h.owner, role: 'owner' });
    const historyScope = ctx.db.historyWorkspace.historyId.find(historyId);
    if (historyScope) {
      const previous = facts.find(v => ctx.db.boardWorkspace.boardId.find(v.boardId));
      if (previous) inheritWorkspaceBoard(ctx, previous.boardId, board.id, h.owner);
      else assignBoardWorkspace(ctx, board.id, historyScope.workspaceId, h.owner);
    }
    refreshStats(ctx, board.id, { init: true });
    const stats = ctx.db.boardStats.boardId.find(board.id)!;
    ctx.db.boardStats.boardId.update({ ...stats, createdBy: h.owner });
    emit(ctx, board.id, 'architecture.snapshot', { historyId, ref, sha });
    const count = [...ctx.db.architectureVersion.historyId.filter(historyId)].filter(v => v.assertionMode === 'fact').length;
    ctx.db.architectureHistory.id.update({ ...h, status: count === pinnedRefs(h.refsJson).length ? 'ready' : 'running', error: '', updatedAt: ctx.timestamp });
  }
);

export const createArchitectureProposal = reducer(
  { baseBoardId: t.u64(), name: t.string(), requestKey: t.string() },
  (ctx, { baseBoardId, name, requestKey }) => {
    const owner = assertArchitectureEditor(ctx, baseBoardId);
    assertBoardName(name); assertRequestKey(requestKey);
    const existing = ctx.db.architectureVersion.boardId.find(baseBoardId);
    if (existing?.assertionMode === 'intent') throw new SenderError('architecture rule: a branch forks a board or a snapshot, not another branch');
    // A plain board: identity is backfilled once, on the base, so the copy and
    // every later fork share keys (importer keys are never touched).
    if (!existing) {
      for (const n of [...ctx.db.node.boardId.filter(baseBoardId)]) {
        if (n.sourceKey === '' && n.kind !== 'chart') ctx.db.node.id.update({ ...n, sourceKey: `node:${n.id}` });
      }
      for (const e of [...ctx.db.edge.boardId.filter(baseBoardId)]) {
        if (e.relation === '') ctx.db.edge.id.update({ ...e, relation: `edge:${e.id}` });
      }
    }
    // shortcut: for a plain base, sha holds the fork-time base signature (merge's three-way origin); upgrade to its own column when the schema next changes
    const base = existing ?? { historyId: 0n, index: 0, ref: '', sha: graphSignature(architectureGraph(ctx, baseBoardId)) };
    const branches = [...ctx.db.architectureVersion.baseBoardId.filter(baseBoardId)];
    for (const v of branches) {
      if (v.assertionMode === 'intent' && v.requestKey === requestKey && ctx.db.boardStats.boardId.find(v.boardId)?.createdBy.isEqual(owner) && (ownsBoardAs(ctx, v.boardId, owner) || roleRank(humanBoardRole(ctx, v.boardId, owner)) >= 2)) {
        if (ctx.db.board.id.find(v.boardId)?.name !== name) throw new SenderError('architecture requestKey already belongs to a different proposal');
        return;
      }
    }
    // One write copies the whole base, so the base size and the branch count are capped (limits.ts).
    if (limitsApply(ctx)) {
      if (branches.filter(v => v.assertionMode === 'intent').length >= LIMITS.forksPerBase) throw new SenderError(`limit rule: a board has at most ${LIMITS.forksPerBase} branches; delete one first`);
      let count = 0;
      for (const _n of ctx.db.node.boardId.filter(baseBoardId)) if (++count > LIMITS.forkMaxNodes) throw new SenderError(`limit rule: only a board with at most ${LIMITS.forkMaxNodes} nodes can be branched`);
    }
    const board = insertBoard(ctx, name), nodes = new Map<bigint, bigint>(), edges = new Map<bigint, bigint>();
    for (const n of ctx.db.node.boardId.filter(baseBoardId)) {
      const row = ctx.db.node.insert({ ...n, id: 0n, boardId: board.id }); nodes.set(n.id, row.id);
      const icon = ctx.db.nodeIcon.nodeId.find(n.id);
      if (icon) ctx.db.nodeIcon.insert({ nodeId: row.id, boardId: board.id, icon: icon.icon });
      const chart = ctx.db.chart.nodeId.find(n.id);
      if (chart) ctx.db.chart.insert({ ...chart, nodeId: row.id, boardId: board.id });
    }
    for (const e of ctx.db.edge.boardId.filter(baseBoardId)) {
      const row = ctx.db.edge.insert({ ...e, id: 0n, boardId: board.id, fromNode: nodes.get(e.fromNode)!, toNode: nodes.get(e.toNode)! }); edges.set(e.id, row.id);
      const weight = ctx.db.edgeWeight.edgeId.find(e.id);
      if (weight) ctx.db.edgeWeight.insert({ edgeId: row.id, boardId: board.id, weight: weight.weight });
      const hash = ctx.db.edgeEvidenceHash.edgeId.find(e.id);
      if (hash) ctx.db.edgeEvidenceHash.insert({ ...hash, edgeId: row.id, boardId: board.id });
    }
    for (const f of ctx.db.repoFile.boardId.filter(baseBoardId)) ctx.db.repoFile.insert({ ...f, id: 0n, boardId: board.id });
    for (const set of ctx.db.hideSet.boardId.filter(baseBoardId)) {
      const row = ctx.db.hideSet.insert({ ...set, id: 0n, boardId: board.id });
      for (const m of ctx.db.hideSetMember.setId.filter(set.id)) {
        const targetId = (m.targetKind === 'node' ? nodes : edges).get(m.targetId);
        if (targetId !== undefined) ctx.db.hideSetMember.insert({ ...m, id: 0n, setId: row.id, targetId });
      }
    }
    const refIds = new Map<bigint, bigint>();
    for (const r of ctx.db.codeRef.boardId.filter(baseBoardId)) {
      const targetId = (r.targetKind === 'node' ? nodes : edges).get(r.targetId);
      if (targetId === undefined) continue;
      const row = ctx.db.codeRef.insert({ ...r, id: 0n, boardId: board.id, targetId });
      refIds.set(r.id, row.id);
      const hash = ctx.db.codeRefHash.refId.find(r.id);
      if (hash) ctx.db.codeRefHash.insert({ ...hash, refId: row.id, boardId: board.id });
    }
    for (const n of ctx.db.changeNote.boardId.filter(baseBoardId)) {
      const anchorId = nodes.get(n.anchorId), refId = refIds.get(n.refId);
      if (anchorId === undefined || refId === undefined) continue;
      const readers = parseReaders(n.readers).flatMap(r => {
        const copied = refIds.get(BigInt(r.refId));
        return copied === undefined ? [] : [{ ...r, refId: copied.toString() }];
      });
      ctx.db.changeNote.insert({ ...n, id: 0n, boardId: board.id, anchorId, refId, readers: JSON.stringify(readers), ...UNREVIEWED });
    }
    ctx.db.architectureVersion.insert({ boardId: board.id, historyId: base.historyId, index: base.index, assertionMode: 'intent', baseBoardId, ref: base.ref, sha: base.sha, status: 'draft', requestKey, reviewedSignature: '', implementedBoardId: 0n });
    initBoard(ctx, board.id, name, 'architecture-proposal', owner);
    inheritWorkspaceBoard(ctx, baseBoardId, board.id, owner);
    // An agent drafts for its owner: it keeps editing and submitting its own proposal.
    if (!owner.isEqual(ctx.sender)) ctx.db.agentGrant.insert({ id: 0n, boardId: board.id, agent: ctx.sender, grantedBy: owner });
  }
);

export const setArchitectureNodeKey = reducer(
  { nodeId: t.u64(), sourceKey: t.string() },
  (ctx, { nodeId, sourceKey }) => {
    const node = findNodeOrThrow(ctx, nodeId);
    architectureVersionOrThrow(ctx, node.boardId, 'intent');
    assertArchitectureEditor(ctx, node.boardId);
    if (!sourceKey.trim() || sourceKey.length > 4000 || CONTROL_CHAR_RE.test(sourceKey)) throw new SenderError('architecture source key must be nonempty and contain no control characters');
    if ([...ctx.db.node.boardId.filter(node.boardId)].some(n => n.id !== nodeId && n.sourceKey === sourceKey)) throw new SenderError('architecture source key already exists');
    if (sourceKey !== node.sourceKey) { architectureEdit(ctx, node.boardId); ctx.db.node.id.update({ ...node, sourceKey }); }
  }
);

export const setArchitectureEdgeRelation = reducer(
  { edgeId: t.u64(), relation: t.string() },
  (ctx, { edgeId, relation }) => {
    const edge = ctx.db.edge.id.find(edgeId);
    if (!edge) throw new SenderError(`edge ${edgeId} does not exist`);
    assertBoardWrite(ctx, edge.boardId);
    architectureVersionOrThrow(ctx, edge.boardId, 'intent');
    assertArchitectureEditor(ctx, edge.boardId);
    if (relation.length > 4000 || CONTROL_CHAR_RE.test(relation)) throw new SenderError('architecture relation must contain no control characters');
    if ([...ctx.db.edge.boardId.filter(edge.boardId)].some(e => e.id !== edgeId && e.fromNode === edge.fromNode && e.toNode === edge.toNode && e.relation === relation)) throw new SenderError('architecture edge relation already exists for these endpoints');
    if (relation !== edge.relation) { architectureEdit(ctx, edge.boardId); ctx.db.edge.id.update({ ...edge, relation }); }
  }
);

export const submitArchitectureProposal = reducer(
  { boardId: t.u64() },
  (ctx, { boardId }) => {
    assertArchitectureEditor(ctx, boardId);
    const v = architectureVersionOrThrow(ctx, boardId, 'intent');
    if (v.status === 'submitted') return;
    if (!['draft', 'rejected'].includes(v.status)) throw new SenderError('architecture proposal must be draft or rejected before submission');
    try { validateGraph(architectureGraph(ctx, boardId)); } catch (e) { throw new SenderError(e instanceof Error ? e.message : 'invalid proposal graph'); }
    ctx.db.architectureVersion.boardId.update({ ...v, status: 'submitted', reviewedSignature: '', implementedBoardId: 0n });
  }
);

export const reviewArchitectureProposal = reducer(
  { boardId: t.u64(), decision: t.string() },
  (ctx, { boardId, decision }) => {
    assertOwner(ctx, boardId, 'review');
    const v = architectureVersionOrThrow(ctx, boardId, 'intent');
    if (ctx.db.boardWorkspace.boardId.find(boardId) && v.baseBoardId) assertOwner(ctx, v.baseBoardId, 'review');
    if (callerIsAgent(ctx) || isService(ctx) || ctx.db.agentLink.agent.find(ctx.sender)) throw new SenderError('architecture proposal review requires a human owner');
    if (decision !== 'accept' && decision !== 'reject') throw new SenderError('architecture decision must be accept or reject');
    const signature = graphSignature(architectureGraph(ctx, boardId)), status = decision === 'accept' ? 'accepted' : 'rejected';
    if (v.status === status && v.reviewedSignature === signature) return;
    if (v.status !== 'submitted') throw new SenderError('architecture proposal must be submitted before review');
    ctx.db.architectureVersion.boardId.update({ ...v, status, reviewedSignature: signature, implementedBoardId: 0n });
  }
);

export const reconcileArchitectureProposal = reducer(
  { boardId: t.u64(), snapshotBoardId: t.u64() },
  (ctx, { boardId, snapshotBoardId }) => {
    assertOwner(ctx, boardId, 'reconcile');
    assertBoardRead(ctx, snapshotBoardId);
    const p = architectureVersionOrThrow(ctx, boardId, 'intent'), snapshot = architectureVersionOrThrow(ctx, snapshotBoardId, 'fact');
    const base = architectureVersionOrThrow(ctx, p.baseBoardId, 'fact');
    const baseHistory = architectureHistoryOrThrow(ctx, base.historyId), targetHistory = architectureHistoryOrThrow(ctx, snapshot.historyId);
    const canonicalRepository = (url: string) => url.toLowerCase().replace(/\/$/, '').replace(/\.git$/, '');
    // Recency comes from the history, not from boardStats.createdAt: board_stats
    // is private, so the canvas can only rank candidates by history timestamp
    // (client/src/architecture.ts reconciliationSnapshot). Ordering on the
    // snapshot boards instead made the rail offer a snapshot this reducer then
    // refused, whenever a retried import published after a later history did.
    if (
      canonicalRepository(baseHistory.repository) !== canonicalRepository(targetHistory.repository) ||
      (snapshot.historyId === p.historyId && snapshot.index <= base.index) || snapshot.sha === base.sha ||
      targetHistory.createdAt.microsSinceUnixEpoch < baseHistory.createdAt.microsSinceUnixEpoch
    ) throw new SenderError('architecture reconciliation requires a newer commit imported from the same repository');
    const intent = architectureGraph(ctx, boardId);
    if (!['accepted', 'implemented'].includes(p.status) || p.reviewedSignature !== graphSignature(intent)) throw new SenderError('architecture reconciliation requires current accepted intent');
    if (!proposalSatisfied(architectureGraph(ctx, p.baseBoardId), intent, architectureGraph(ctx, snapshotBoardId))) throw new SenderError('architecture proposal is not satisfied by this snapshot');
    ctx.db.architectureVersion.boardId.update({ ...p, status: 'implemented', implementedBoardId: snapshotBoardId });
  }
);

/** A source citation names a file the board must list; merge carries it over so the next fork still validates. */
function citeFile(ctx: any, boardId: bigint, evidence: string): void {
  const match = /^source:(.+):[1-9][0-9]*$/.exec(evidence);
  if (!match) return;
  for (const f of ctx.db.repoFile.boardId.filter(boardId)) if (f.path === match[1]) return;
  ctx.db.repoFile.insert({ id: 0n, boardId, path: match[1] });
}

// Three-way at the key level: F = the base as it was at the fork (stored in
// sha), B = the base now, H = the branch now. Keys in B but not in F were
// added on the base while the branch was open and are never touched.
export const mergeArchitectureProposal = reducer(
  { boardId: t.u64() },
  (ctx, { boardId }) => {
    if (callerIsAgent(ctx) || isService(ctx) || ctx.db.agentLink.agent.find(ctx.sender)) throw new SenderError('architecture proposal merge requires a human owner');
    assertOwner(ctx, boardId, 'merge');
    const v = architectureVersionOrThrow(ctx, boardId, 'intent');
    if (ctx.db.architectureVersion.boardId.find(v.baseBoardId)) throw new SenderError('architecture rule: a branch of a snapshot is checked against a newer import, not merged');
    // The base may have changed hands since the fork (a claimed guest board): its owner now decides.
    assertOwner(ctx, v.baseBoardId, 'merge into');
    const base = v.baseBoardId, head = architectureGraph(ctx, boardId);
    const baseStoresCode = storesCode(ctx, base);
    if (v.status !== 'accepted' || v.reviewedSignature !== graphSignature(head)) throw new SenderError('architecture rule: merge needs an accepted branch whose graph has not changed since review');
    let fork: { nodes: [string, string][]; edges: [string, string][] };
    try { fork = JSON.parse(v.sha); } catch { throw new SenderError('architecture rule: this branch has no fork record to merge from'); }
    const forkNodes = new Set(fork.nodes.map(([k]) => k)), forkEdges = new Set(fork.edges.map(([k]) => k));
    const graphNodes = (bid: bigint) => new Map<string, any>([...ctx.db.node.boardId.filter(bid)].filter((n: any) => n.kind !== 'chart').map((n: any) => [n.sourceKey, n]));
    const graphEdges = (bid: bigint, nodes: Map<string, any>) => {
      const key = new Map<bigint, string>([...nodes.values()].map((n: any) => [n.id, n.sourceKey]));
      return new Map<string, any>([...ctx.db.edge.boardId.filter(bid)].filter((e: any) => key.has(e.fromNode) && key.has(e.toNode)).map((e: any) => [edgeKey(key.get(e.fromNode)!, key.get(e.toNode)!, e.relation), e]));
    };
    const baseNodes = graphNodes(base), headNodes = graphNodes(boardId);
    const baseEdges = graphEdges(base, baseNodes), headEdges = graphEdges(boardId, headNodes);
    const human = `human:${ctx.sender.toHexString()}`;
    const evidenceOf = (e: any) => (e.evidence === '' ? human : e.evidence);
    let removedNodes = 0, removedEdges = 0, addedNodes = 0, addedEdges = 0;
    // From the table, not the key map: base nodes added since the fork share the empty key.
    // The base keeps the focal limit: the owner demotes one of its focal nodes before merging a third.
    const focalArriving = [...headNodes].filter(([k, n]) => n.focal && !forkNodes.has(k) && !baseNodes.has(k)).length;
    if (focalArriving > 0 && [...ctx.db.node.boardId.filter(base)].filter((n: any) => n.focal).length + focalArriving > FOCAL_LIMIT) {
      throw new SenderError(`focal limit: board ${base} already has ${FOCAL_LIMIT} focal nodes; demote one before merging another`);
    }
    // removed in the branch
    for (const k of forkEdges) if (!headEdges.has(k) && baseEdges.has(k)) { removeEdgeRows(ctx, baseEdges.get(k).id); baseEdges.delete(k); removedEdges++; }
    for (const k of forkNodes) if (!headNodes.has(k) && baseNodes.has(k)) { removeNodeRows(ctx, baseNodes.get(k)); baseNodes.delete(k); removedNodes++; }
    for (const [k, e] of [...baseEdges]) if (!ctx.db.edge.id.find(e.id)) baseEdges.delete(k);
    // added in the branch
    for (const [k, n] of headNodes) {
      if (forkNodes.has(k) || baseNodes.has(k)) continue;
      const row = ctx.db.node.insert({ ...n, id: 0n, boardId: base, hidden: false });
      const keyed = k.startsWith('proposal:') ? ctx.db.node.id.update({ ...row, sourceKey: `node:${row.id}` }) : row;
      const icon = ctx.db.nodeIcon.nodeId.find(n.id);
      if (icon) ctx.db.nodeIcon.insert({ nodeId: row.id, boardId: base, icon: icon.icon });
      baseNodes.set(keyed.sourceKey, keyed); headNodes.set(k, { ...n, mergedKey: keyed.sourceKey });
      addedNodes++;
    }
    const headKey = new Map<bigint, string>([...headNodes.values()].map((n: any) => [n.id, n.mergedKey ?? n.sourceKey]));
    for (const [k, e] of headEdges) {
      if (forkEdges.has(k) || baseEdges.has(k)) continue;
      const from = baseNodes.get(headKey.get(e.fromNode)!), to = baseNodes.get(headKey.get(e.toNode)!);
      if (!from || !to) continue;
      // The cited line enters the base only if the base's owner stores code (RC-690); its hash always does.
      const inserted = ctx.db.edge.insert({ ...e, id: 0n, boardId: base, fromNode: from.id, toNode: to.id, hidden: false, evidence: evidenceOf(e), evidenceSnippet: baseStoresCode ? e.evidenceSnippet : '' });
      // The branch's 'imports' relation would block a second A→B on the next branch: give it the base's own identity.
      const row = e.relation === 'imports' ? ctx.db.edge.id.update({ ...inserted, relation: `edge:${inserted.id}` }) : inserted;
      citeFile(ctx, base, row.evidence);
      copyEdgeHash(ctx, e.id, row.id, base);
      const weight = ctx.db.edgeWeight.edgeId.find(e.id);
      if (weight) ctx.db.edgeWeight.insert({ edgeId: row.id, boardId: base, weight: weight.weight });
      baseEdges.set(k, row); addedEdges++;
    }
    // kept on both sides: the branch's content wins per field, the base keeps its layout
    for (const [k, n] of headNodes) {
      const b = baseNodes.get(k);
      if (!b || !forkNodes.has(k)) continue;
      if (b.label !== n.label || b.sublabel !== n.sublabel || b.kind !== n.kind || b.doc !== n.doc) {
        ctx.db.node.id.update({ ...b, label: n.label, sublabel: n.sublabel, kind: n.kind, doc: n.doc });
        // As updateNode: a kind no icon shows on loses its icon (RC-687).
        if (!ICON_NODE_KINDS.includes(n.kind)) ctx.db.nodeIcon.nodeId.delete(b.id);
      }
    }
    for (const [k, e] of headEdges) {
      const b = baseEdges.get(k);
      if (!b || !forkEdges.has(k)) continue;
      const evidence = evidenceOf(e);
      const snippet = baseStoresCode ? e.evidenceSnippet : '';
      if (b.label !== e.label || b.evidence !== evidence || b.evidenceStatus !== e.evidenceStatus || b.evidenceSnippet !== snippet) {
        // Evidence travels with its captured line (only where the base stores code), its hash and status,
        // or the base would show a stale citation as current.
        ctx.db.edge.id.update({ ...b, label: e.label, evidence, evidenceSnippet: snippet, evidenceStatus: e.evidenceStatus });
        copyEdgeHash(ctx, e.id, b.id, base);
        citeFile(ctx, base, evidence);
      }
    }
    ctx.db.architectureVersion.boardId.update({ ...v, status: 'implemented', implementedBoardId: base });
    refreshStats(ctx, base); refreshStats(ctx, boardId);
    emit(ctx, base, 'architecture.merged', { branch: ctx.db.board.id.find(boardId)?.name ?? '', nodes: addedNodes, removedNodes, edges: addedEdges, removedEdges });
  }
);

export const propagateArchitectureCuration = reducer(
  { boardId: t.u64() },
  (ctx, { boardId }) => {
    assertOwner(ctx, boardId, 'propagate curation from');
    const v = architectureVersionOrThrow(ctx, boardId, 'fact'), h = architectureHistoryOrThrow(ctx, v.historyId), curation = readCuration(h.curationJson);
    const historyScope = ctx.db.historyWorkspace.historyId.find(h.id);
    if (historyScope) {
      for (const snapshot of ctx.db.architectureVersion.historyId.filter(h.id)) if (snapshot.assertionMode === 'fact') assertOwner(ctx, snapshot.boardId, 'curate');
    } else if (!h.owner.isEqual(ctx.sender)) throw new SenderError('architecture curation requires the history owner');
    const nodes = [...ctx.db.node.boardId.filter(boardId)], keys = new Map<bigint, string>(nodes.map(n => [n.id, n.sourceKey])), edgeKeys = new Map<bigint, string>();
    const presentNodes = new Set<string>(keys.values()), presentEdges = new Set<string>();
    for (const n of nodes) curation.nodes[n.sourceKey] = pickFields(n, CURATED_NODE_FIELDS);
    for (const e of ctx.db.edge.boardId.filter(boardId)) {
      const key = edgeKey(keys.get(e.fromNode)!, keys.get(e.toNode)!, e.relation);
      curation.edges[key] = { ...pickFields(e, CURATED_EDGE_FIELDS), weight: ctx.db.edgeWeight.edgeId.find(e.id)?.weight ?? 'regular' };
      edgeKeys.set(e.id, key); presentEdges.add(key);
    }
    // Retain hide membership for keys absent from this ref; visible keys use
    // only this ref's current editorial decision, including deliberate unhide.
    for (const s of Object.values(curation.sets)) { s.nodes = s.nodes.filter(k => !presentNodes.has(k)); s.edges = s.edges.filter(k => !presentEdges.has(k)); }
    for (const set of ctx.db.hideSet.boardId.filter(boardId)) {
      const members = curation.sets[set.name] ?? { nodes: [], edges: [] };
      for (const m of ctx.db.hideSetMember.setId.filter(set.id)) {
        const key = (m.targetKind === 'node' ? keys : edgeKeys).get(m.targetId);
        if (key) (m.targetKind === 'node' ? members.nodes : members.edges).push(key);
      }
      curation.sets[set.name] = { nodes: [...new Set(members.nodes)], edges: [...new Set(members.edges)] };
    }
    ctx.db.architectureHistory.id.update({ ...h, curationJson: JSON.stringify(curation), updatedAt: ctx.timestamp });
    for (const snapshot of ctx.db.architectureVersion.historyId.filter(v.historyId)) {
      if (snapshot.assertionMode === 'fact') { applyArchitectureCuration(ctx, snapshot.boardId, curation); refreshStats(ctx, snapshot.boardId); }
    }
  }
);

// Native histories follow current workspace management; legacy agent histories retain their person's ownership.
export const deleteArchitectureHistory = reducer(
  { historyId: t.u64() },
  (ctx, { historyId }) => {
    const h = architectureHistoryOrThrow(ctx, historyId);
    const scoped = ctx.db.historyWorkspace.historyId.find(historyId);
    const allowed = scoped ? canManageArchitectureHistory(ctx, h) : h.owner.isEqual(ctx.sender) || ctx.db.agentLink.agent.find(h.owner)?.owner.isEqual(ctx.sender);
    if (isWorkspaceMachine(ctx) || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled || !allowed) {
      throw new SenderError('architecture rule: only the owner of a history can delete it');
    }
    for (const v of [...ctx.db.architectureVersion.historyId.filter(historyId)]) removeBoard(ctx, v.boardId);
    ctx.db.historyWorkspace.historyId.delete(historyId);
    ctx.db.architectureHistory.id.delete(historyId);
  }
);

export const myArchitectureHistories = spacetimedb.view(
  { name: 'my_architecture_histories', public: true },
  t.array(architectureHistory.rowType),
  ctx => {
    const out = new Map<bigint, any>();
    for (const member of ctx.db.workspaceMember.member.filter(ctx.sender)) {
      if (!['owner', 'admin'].includes(member.role)) continue;
      for (const scope of ctx.db.historyWorkspace.workspaceId.filter(member.workspaceId)) {
        const history = ctx.db.architectureHistory.id.find(scope.historyId);
        if (history) out.set(history.id, history);
      }
    }
    for (const h of ctx.db.architectureHistory.owner.filter(ctx.sender)) if (canManageArchitectureHistory(ctx, h)) out.set(h.id, h);
    for (const boardId of humanBoardIds(ctx)) {
      const version = ctx.db.architectureVersion.boardId.find(boardId);
      const h = version && ctx.db.architectureHistory.id.find(version.historyId);
      if (h && ctx.db.historyWorkspace.historyId.find(h.id) && canManageArchitectureHistory(ctx, h)) out.set(h.id, h);
    }
    return [...out.values()].filter(h => canManageArchitectureHistory(ctx, h));
  }
);

// The caller's chart library. Same shape as my_architecture_histories.
export const myLibrary = spacetimedb.view(
  { name: 'my_library', public: true },
  t.array(libraryItem.rowType),
  ctx => isWorkspaceMachine(ctx) ? [] : [...ctx.db.libraryItem.owner.filter(ctx.sender)]
);

export const createTeamBoard = reducer(
  { name: t.string(), orgId: t.string() },
  (ctx, { name, orgId }) => {
    assertBoardName(name);
    assertMember(ctx, orgId);
    const board = insertBoard(ctx, name);
    ctx.db.teamGrant.insert({ id: 0n, boardId: board.id, orgId, grantedBy: ctx.sender });
    initCallerBoard(ctx, board.id, name, 'team');
  }
);

export const shareBoardWithTeam = reducer(
  { boardId: t.u64(), orgId: t.string() },
  (ctx, { boardId, orgId }) => {
    assertOwner(ctx, boardId, 'share');
    assertMember(ctx, orgId);
    for (const g of ctx.db.teamGrant.boardId.filter(boardId)) {
      if (g.orgId === orgId) {
        return; // already shared: idempotent
      }
    }
    ctx.db.teamGrant.insert({ id: 0n, boardId, orgId, grantedBy: ctx.sender });
    emit(ctx, boardId, 'board.shared', { orgId });
  }
);

// No membership check: an owner who left the org can still take a board back.
export const unshareBoardFromTeam = reducer(
  { boardId: t.u64(), orgId: t.string() },
  (ctx, { boardId, orgId }) => {
    assertOwner(ctx, boardId, 'unshare');
    const gone = [...ctx.db.teamGrant.boardId.filter(boardId)].filter(g => g.orgId === orgId);
    for (const g of gone) {
      ctx.db.teamGrant.id.delete(g.id);
    }
    if (gone.length > 0) {
      emit(ctx, boardId, 'board.unshared', { orgId });
    }
  }
);

function revokeChartEmbed(ctx: any, nodeId: bigint): void {
  ctx.db.chartEmbed.nodeId.delete(nodeId);
  for (const visit of [...ctx.db.chartEmbedVisit.nodeId.filter(nodeId)]) ctx.db.chartEmbedVisit.connectionId.delete(visit.connectionId);
}

export const enableChartEmbed = reducer(
  { nodeId: t.u64(), token: t.string() }, (ctx, { nodeId, token }) => {
    const node = ctx.db.node.id.find(nodeId);
    if (!node) throw new SenderError('embed rule: chart is unavailable');
    assertOwner(ctx, node.boardId, 'embed');
    if (node.kind !== 'chart' || !ctx.db.chart.nodeId.find(nodeId)) throw new SenderError('embed rule: select a chart');
    if (ctx.db.chartEmbed.nodeId.find(nodeId)) return;
    if (!isShareToken(token)) throw new SenderError('embed rule: token must be 32 lowercase hex characters');
    if (ctx.db.chartEmbed.token.find(token) || ctx.db.boardEmbed.token.find(token)) throw new SenderError('embed rule: token is already in use');
    ctx.db.chartEmbed.insert({ nodeId, boardId: node.boardId, token });
    emit(ctx, node.boardId, 'chart.embedded', {});
  }
);

export const disableChartEmbed = reducer(
  { nodeId: t.u64() }, (ctx, { nodeId }) => {
    const node = ctx.db.node.id.find(nodeId);
    if (!node) throw new SenderError('embed rule: chart is unavailable');
    assertOwner(ctx, node.boardId, 'revoke embed access');
    revokeChartEmbed(ctx, nodeId);
    emit(ctx, node.boardId, 'chart.embed_revoked', {});
  }
);

export const openChartEmbed = reducer(
  { token: t.string() }, (ctx, { token }) => {
    if (isWorkspaceMachine(ctx) || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) throw new SenderError('not authorized: embed is unavailable');
    const embed = isShareToken(token) ? ctx.db.chartEmbed.token.find(token) : undefined;
    if (!embed || !ctx.connectionId || !ctx.db.chart.nodeId.find(embed.nodeId)) throw new SenderError('This chart is no longer embedded.');
    const row = { connectionId: ctx.connectionId, viewer: ctx.sender, nodeId: embed.nodeId, token };
    if (ctx.db.chartEmbedVisit.connectionId.find(ctx.connectionId)) ctx.db.chartEmbedVisit.connectionId.update(row);
    else ctx.db.chartEmbedVisit.insert(row);
  }
);

function revokeBoardEmbed(ctx: any, boardId: bigint): void {
  ctx.db.boardEmbed.boardId.delete(boardId);
  for (const visit of [...ctx.db.boardEmbedVisit.boardId.filter(boardId)]) ctx.db.boardEmbedVisit.connectionId.delete(visit.connectionId);
}
export const enableBoardEmbed = reducer(
  { boardId: t.u64(), token: t.string(), threats: t.bool(), comparisonBoardId: t.u64() },
  (ctx, { boardId, token, threats, comparisonBoardId }) => {
    assertOwner(ctx, boardId, 'embed');
    if (comparisonBoardId !== 0n) {
      assertOwner(ctx, comparisonBoardId, 'embed comparison');
      // Publish only the architecture version's actual predecessor/base.
      const version = ctx.db.architectureVersion.boardId.find(boardId);
      const versions = version ? [...ctx.db.architectureVersion.historyId.filter(version.historyId)] : [];
      const previous = version?.assertionMode === 'intent' ? version.baseBoardId : versions
        .filter(v => v.assertionMode === 'fact' && v.index < version!.index).sort((a, b) => b.index - a.index)[0]?.boardId;
      if (previous !== comparisonBoardId) throw new SenderError('embed rule: comparison must be the previous architecture snapshot');
    }
    const existing = ctx.db.boardEmbed.boardId.find(boardId);
    if (existing) ctx.db.boardEmbed.boardId.update({ ...existing, createdBy: ctx.sender, threats, comparisonBoardId });
    else {
      if (!isShareToken(token)) throw new SenderError('embed rule: token must be 32 lowercase hex characters');
      if (ctx.db.boardEmbed.token.find(token) || ctx.db.chartEmbed.token.find(token)) throw new SenderError('embed rule: token is already in use');
      ctx.db.boardEmbed.insert({ boardId, token, createdBy: ctx.sender, threats, comparisonBoardId });
    }
    emit(ctx, boardId, 'board.embedded', { threats, comparison: comparisonBoardId !== 0n });
  }
);
export const disableBoardEmbed = reducer({ boardId: t.u64() }, (ctx, { boardId }) => {
  assertOwner(ctx, boardId, 'revoke embed access');
  revokeBoardEmbed(ctx, boardId);
  emit(ctx, boardId, 'board.embed_revoked', {});
});
export const openBoardEmbed = reducer({ token: t.string() }, (ctx, { token }) => {
  if (isWorkspaceMachine(ctx) || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) throw new SenderError('not authorized: embed is unavailable');
  const embed = isShareToken(token) ? ctx.db.boardEmbed.token.find(token) : undefined;
  if (!embed || !ctx.connectionId || !ctx.db.board.id.find(embed.boardId) || !embedOwner(ctx, embed.boardId, embed.createdBy)) throw new SenderError('This board is no longer embedded.');
  const row = { connectionId: ctx.connectionId, viewer: ctx.sender, boardId: embed.boardId, token };
  if (ctx.db.boardEmbedVisit.connectionId.find(ctx.connectionId)) ctx.db.boardEmbedVisit.connectionId.update(row);
  else ctx.db.boardEmbedVisit.insert(row);
});

// Anyone-with-the-link sharing.
// A new link takes the caller's token; an existing link keeps its token and
// changes only its mode.
export const setLinkShare = reducer(
  { boardId: t.u64(), mode: t.string(), token: t.string() },
  (ctx, { boardId, mode, token }) => {
    assertOwner(ctx, boardId, 'share');
    if (ctx.db.architectureVersion.boardId.find(boardId)?.assertionMode === 'fact') throw new SenderError('architecture boards must be managed through their history');
    if (!isLinkMode(mode)) throw new SenderError("share rule: link mode must be 'view' or 'edit'");
    const existing = ctx.db.linkShare.boardId.find(boardId);
    if (existing) {
      if (existing.mode === mode) return;
      ctx.db.linkShare.boardId.update({ ...existing, mode });
    } else {
      if (!isShareToken(token)) throw new SenderError('share rule: link token must be 32 lowercase hex characters');
      if (ctx.db.linkShare.token.find(token)) throw new SenderError('share rule: link token is already in use');
      // A new link includes no sensitive layer: the owner turns each on (setLinkShareIncludes).
      ctx.db.linkShare.insert({ boardId, token, mode, createdBy: ctx.sender, createdAt: ctx.timestamp, includeThreats: false, includeCode: false });
    }
    emit(ctx, boardId, 'board.link_shared', { mode });
  }
);

// Which sensitive layers the link carries. Turning one off removes it from every open visitor at once.
export const setLinkShareIncludes = reducer(
  { boardId: t.u64(), threats: t.bool(), code: t.bool() },
  (ctx, { boardId, threats, code }) => {
    assertOwner(ctx, boardId, 'share');
    const share = ctx.db.linkShare.boardId.find(boardId);
    if (!share) throw new SenderError('share rule: turn on the link before choosing what it includes');
    if (share.includeThreats === threats && share.includeCode === code) return;
    ctx.db.linkShare.boardId.update({ ...share, includeThreats: threats, includeCode: code });
    emit(ctx, boardId, 'board.link_includes', { threats, code });
  }
);

// Ends access for everyone who opened the link. Sharing again makes a new token.
export const stopLinkShare = reducer(
  { boardId: t.u64() },
  (ctx, { boardId }) => {
    assertOwner(ctx, boardId, 'unshare');
    for (const visit of [...ctx.db.linkVisit.boardId.filter(boardId)]) ctx.db.linkVisit.id.delete(visit.id);
    if (!ctx.db.linkShare.boardId.find(boardId)) return;
    ctx.db.linkShare.boardId.delete(boardId);
    emit(ctx, boardId, 'board.link_unshared', {});
  }
);

// Anyone may open a link: guests and signed-out visitors too. Callers who
// already reach the board still get a visit row; the canvas finds the board by
// the token in my_boards.
export const openSharedLink = reducer(
  { token: t.string() },
  (ctx, { token }) => {
    const share = isShareToken(token) ? ctx.db.linkShare.token.find(token) : undefined;
    if (!share) throw new SenderError('This link is no longer shared.');
    if (isWorkspaceMachine(ctx) && !workspaceMachineBoardRole(ctx, share.boardId)) throw new SenderError('not authorized: board is unavailable');
    if (!hasLinkVisit(ctx, share.boardId, ctx.sender)) {
      ctx.db.linkVisit.insert({ id: 0n, boardId: share.boardId, viewer: ctx.sender, openedAt: ctx.timestamp });
    }
  }
);

// Service: replaces every orgMember row of `member` (one person). Two syncs
// can race; the service that syncs teams checks each write against its source
// and rewrites a stale one, so the last write is current.
export const setOrgMemberships = spacetimedb.reducer(
  { member: t.identity(), orgIds: t.array(t.string()), roles: t.array(t.string()) },
  (ctx, { member, orgIds, roles }) => {
    assertService(ctx);
    if (orgIds.length !== roles.length) {
      throw new SenderError(
        `orgIds and roles must have the same length (got ${orgIds.length} and ${roles.length})`
      );
    }
    for (const m of [...ctx.db.orgMember.member.filter(member)]) {
      ctx.db.orgMember.id.delete(m.id);
    }
    orgIds.forEach((orgId, i) => {
      ctx.db.orgMember.insert({ id: 0n, member, orgId, role: roles[i] });
    });
  }
);

// Service: an organization was deleted at its source.
export const dropOrg = spacetimedb.reducer(
  { orgId: t.string() },
  (ctx, { orgId }) => {
    assertService(ctx);
    // Native membership and the imported sharing relationship survive obsolete provider events.
    if (ctx.db.legacyWorkspace.orgId.find(orgId)) return;
    for (const m of [...ctx.db.orgMember.orgId.filter(orgId)]) {
      ctx.db.orgMember.id.delete(m.id);
    }
    for (const g of [...ctx.db.teamGrant.orgId.filter(orgId)]) {
      ctx.db.teamGrant.id.delete(g.id);
    }
  }
);

// Service: the Worker stored these outbox rows in Postgres. A row whose count
// moved on since the read (a burst merged into it) stays for the next drain.
export const ackActivity = spacetimedb.reducer(
  { ids: t.array(t.u64()), counts: t.array(t.u32()) },
  (ctx, { ids, counts }) => {
    assertService(ctx);
    if (ids.length !== counts.length) {
      throw new SenderError(
        `ids and counts must have the same length (got ${ids.length} and ${counts.length})`
      );
    }
    ids.forEach((id, i) => {
      const row = ctx.db.activityOutbox.id.find(id);
      if (row && row.count === counts[i]) {
        ctx.db.activityOutbox.id.delete(id);
      }
    });
  }
);

// Agent pairing (RC-532). Reducers return nothing, so the agent picks the code
// (random, unguessable) and prints a /link?code= URL for its human.
const LINK_CODE_RE = /^[A-Za-z0-9_-]{32,128}$/;
const LINK_TTL_MICROS = 30n * MINUTE_MICROS;

export const offerAgentLink = reducer(
  { code: t.string() },
  (ctx, { code }) => {
    if (isWorkspaceMachine(ctx) || ctx.db.workspaceAccount.identity.find(ctx.sender)) throw new SenderError('link rule: use an agent identity to offer an agent link');
    if (!LINK_CODE_RE.test(code)) {
      throw new SenderError('link code must be 32–128 characters of A-Z, a-z, 0-9, _ or -');
    }
    const prev = ctx.db.agentLinkOffer.agent.find(ctx.sender);
    if (prev) {
      ctx.db.agentLinkOffer.code.delete(prev.code);
    }
    ctx.db.agentLinkOffer.insert({
      code,
      agent: ctx.sender,
      expiresAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + LINK_TTL_MICROS),
    });
  }
);

export const redeemAgentLink = reducer(
  { code: t.string() },
  (ctx, { code }) => {
    if (isWorkspaceMachine(ctx) || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) throw new SenderError('not authorized: account is unavailable');
    const offer = ctx.db.agentLinkOffer.code.find(code);
    if (!offer || isWorkspaceMachine(ctx, offer.agent) || ctx.db.workspaceAccount.identity.find(offer.agent) || offer.expiresAt.microsSinceUnixEpoch < ctx.timestamp.microsSinceUnixEpoch) {
      throw new SenderError('link code is invalid or expired');
    }
    if (offer.agent.isEqual(ctx.sender)) {
      throw new SenderError(
        'you cannot link an identity to itself; open the link while signed in to your dashboard'
      );
    }
    const link = { agent: offer.agent, owner: ctx.sender, linkedAt: ctx.timestamp };
    const previous = ctx.db.agentLink.agent.find(offer.agent);
    // Old localhost MCP linked to an unreachable owner. Recover only boards this agent created.
    if (ISSUERS.variant === 'local' && previous?.owner.toHexString() === LEGACY_DEV_OWNER) {
      for (const grant of ctx.db.agentGrant.agent.filter(offer.agent)) {
        if (!grant.grantedBy.isEqual(previous.owner) || !ownsBoardAs(ctx, grant.boardId, previous.owner) || ctx.db.architectureVersion.boardId.find(grant.boardId)) continue;
        const creation = [...ctx.db.boardCreation.boardId.filter(grant.boardId)][0];
        const creator = creation?.owner ?? [...ctx.db.activityOutbox.boardId.filter(grant.boardId)].find(e => e.type === 'board.created')?.actor;
        if (!creator) throw new SenderError(`link rule: cannot verify who created legacy dev board ${grant.boardId}; existing access was kept; ask the database owner to recover its ownership before linking`);
        if (!creator.isEqual(offer.agent)) continue;
        for (const owner of ctx.db.boardGrant.boardId.filter(grant.boardId)) {
          if (owner.role === 'owner' && owner.grantee.isEqual(previous.owner)) {
            ctx.db.boardGrant.id.update({ ...owner, grantee: offer.agent });
          }
        }
      }
    }
    // Grants belong to the owner who made them: keep them only for a re-link to the same owner.
    const relinked = !previous?.owner.isEqual(ctx.sender);
    if (relinked) dropAgentGrants(ctx, offer.agent);
    if (previous) {
      ctx.db.agentLink.agent.update(link);
    } else {
      ctx.db.agentLink.insert(link);
    }
    adoptAgentBoards(ctx, offer.agent, ctx.sender);
    if (relinked) enforceAgentBoards(ctx, offer.agent);
    ctx.db.agentLinkOffer.code.delete(code);
  }
);

// Hosted MCP (spec §8 Item 5): on an agent's first call the Worker, as a service
// account, links the agent identity blake3(<mcp origin>/agent-id | agent:user_…)
// to the same person's browser identity blake3(<browser iss> | user_…). Grants
// follow redeemAgentLink's rule: they belong to the owner who made them.
export const linkHostedAgent = spacetimedb.reducer(
  { agent: t.identity(), owner: t.identity() },
  (ctx, { agent, owner }) => {
    assertService(ctx);
    if (isWorkspaceMachine(ctx, agent) || isWorkspaceMachine(ctx, owner) || ctx.db.workspaceAccount.identity.find(owner)?.disabled || ctx.db.workspaceAccount.identity.find(agent)) throw new SenderError('link rule: use an agent identity and an active owner account');
    const previous = ctx.db.agentLink.agent.find(agent);
    const relinked = !previous?.owner.isEqual(owner);
    if (relinked) {
      dropAgentGrants(ctx, agent);
      const link = { agent, owner, linkedAt: ctx.timestamp };
      if (previous) {
        ctx.db.agentLink.agent.update(link);
      } else {
        ctx.db.agentLink.insert(link);
      }
    }
    // also when already linked: it picks up boards made before boards followed
    // the link, and writes nothing once there are none
    adoptAgentBoards(ctx, agent, owner);
    if (relinked) enforceAgentBoards(ctx, agent);
  }
);

// Hosted MCP: the person's own agent, signed in as them, opens one of their
// boards by its link. The Worker grants it as that person would from the
// dashboard (grantAgentBoard). A board they do not own stays unreachable.
// board: the link's board id (at most 16 digits, as the Worker reads ids) or slug (20 characters, digits possible).
export const grantHostedAgentBoard = spacetimedb.reducer(
  { agent: t.identity(), owner: t.identity(), board: t.string() },
  (ctx, { agent, owner, board }) => {
    assertService(ctx);
    const boardId = /^\d{1,16}$/.test(board) ? BigInt(board) : [...ctx.db.board.slug.filter(board)][0]?.id;
    const link = ctx.db.agentLink.agent.find(agent);
    if (isWorkspaceMachine(ctx, agent) || isWorkspaceMachine(ctx, owner) || boardId === undefined || !link || !link.owner.isEqual(owner) || !(ownsBoardAs(ctx, boardId, owner) || roleRank(nativeBoardRole(ctx, boardId, owner)) >= 2)) {
      throw new SenderError('not authorized: board is unavailable');
    }
    if (!findAgentGrant(ctx, boardId, agent)) ctx.db.agentGrant.insert({ id: 0n, boardId, agent, grantedBy: owner });
  }
);

export const unlinkAgent = reducer(
  { agent: t.identity() },
  (ctx, { agent }) => {
    const link = ctx.db.agentLink.agent.find(agent);
    if (!link || !link.owner.isEqual(ctx.sender)) {
      throw new SenderError(`agent ${agent.toHexString()} is not linked to you`);
    }
    ctx.db.agentLink.agent.delete(agent);
    dropAgentGrants(ctx, agent);
    enforceAgentBoards(ctx, agent);
  }
);

// Owner shares one of their boards with one of their linked agents.
export const grantAgentBoard = reducer(
  { boardId: t.u64(), agent: t.identity() },
  (ctx, { boardId, agent }) => {
    if (roleRank(nativeBoardRole(ctx, boardId)) >= 2) {
      if (!workspaceHuman(ctx)) throw new SenderError('workspace rule: sign in with a human account');
    } else assertOwner(ctx, boardId, 'share');
    const link = ctx.db.agentLink.agent.find(agent);
    if (!link || !link.owner.isEqual(ctx.sender)) {
      throw new SenderError(`share rule: agent ${agent.toHexString()} is not linked to you`);
    }
    if (findAgentGrant(ctx, boardId, agent)) {
      return; // already shared: idempotent
    }
    ctx.db.agentGrant.insert({ id: 0n, boardId, agent, grantedBy: ctx.sender });
    emit(ctx, boardId, 'board.agent_shared', {});
  }
);

// No link check: an owner can always take a grant back.
export const revokeAgentBoard = reducer(
  { boardId: t.u64(), agent: t.identity() },
  (ctx, { boardId, agent }) => {
    const grant = findAgentGrant(ctx, boardId, agent);
    if (!(grant?.grantedBy.isEqual(ctx.sender) && roleRank(nativeBoardRole(ctx, boardId)) >= 2 && workspaceHuman(ctx))) assertOwner(ctx, boardId, 'unshare');
    if (!grant) {
      return;
    }
    ctx.db.agentGrant.id.delete(grant.id);
    emit(ctx, boardId, 'board.agent_unshared', {});
  }
);

// Views. They must never throw and must never emit a primary key twice: a
// failing view fails whichever reducer triggered its refresh. They read no
// node/edge/code_ref rows, so moves and edits only re-run a view through the
// boardStats row they changed.

const MyBoard = t.row('MyBoard', {
  boardId: t.u64().primaryKey(),
  name: t.string(),
  access: t.string(), // 'owner' | 'grant' (an agent's boards, edited for its owner) | 'team' | 'agent' | 'link' | 'public'
  orgId: t.string(), // team rows only, else ''
  sharedWith: t.array(t.string()), // owner rows: orgs with a team grant
  statsReady: t.bool(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
  nodes: t.u32(),
  shownNodes: t.u32(),
  edges: t.u32(),
  shownEdges: t.u32(),
  evImport: t.u32(),
  evSource: t.u32(),
  evStale: t.u32(),
  evTest: t.u32(),
  evHuman: t.u32(),
  evNone: t.u32(),
  refsOk: t.u32(),
  refsStale: t.u32(),
  refsAmbiguous: t.u32(),
  repoFiles: t.u32(),
  isSession: t.bool(),
  sessionCheckpoint: t.u32(),
  sessionUpdatedAt: t.timestamp(),
  covChanged: t.u32(),
  covOnBoard: t.u32(),
  covExcluded: t.u32(),
  covUncovered: t.u32(),
  covDeleted: t.u32(),
  // Appended last (see node.kind): link sharing.
  linkMode: t.string(), // '' | 'view' | 'edit': owner rows and link rows
  linkToken: t.string(), // the owner, or a caller who opened the link; else ''
});

// What each of the caller's own links also carries (linkShare.include*): the share menu's boxes.
// Its own view: my_boards' public row shape is frozen (scripts/check-wire-compat.mjs).
const MyLinkInclude = t.row('MyLinkInclude', { boardId: t.u64().primaryKey(), threats: t.bool(), code: t.bool() });
export const myLinkIncludes = spacetimedb.view({ name: 'my_link_includes', public: true }, t.array(MyLinkInclude), ctx => {
  const out: { boardId: bigint; threats: boolean; code: boolean }[] = [];
  for (const boardId of humanBoardIds(ctx)) {
    const share = humanBoardRole(ctx, boardId) === 'manager' ? ctx.db.linkShare.boardId.find(boardId) : undefined;
    // The stored choices: the menu shows code as included on an edit link, without saving it as chosen.
    if (share) out.push({ boardId, threats: share.includeThreats, code: share.includeCode });
  }
  return out;
});

// What a board without a boardStats row shows (a legacy board before
// backfill_board_stats): zeros and epoch timestamps.
const NO_STATS = {
  createdAt: Timestamp.UNIX_EPOCH,
  updatedAt: Timestamp.UNIX_EPOCH,
  nodes: 0,
  shownNodes: 0,
  edges: 0,
  shownEdges: 0,
  evImport: 0,
  evSource: 0,
  evStale: 0,
  evTest: 0,
  evHuman: 0,
  evNone: 0,
  refsOk: 0,
  refsStale: 0,
  refsAmbiguous: 0,
  repoFiles: 0,
  isSession: false,
  sessionCheckpoint: 0,
  sessionUpdatedAt: Timestamp.UNIX_EPOCH,
  covChanged: 0,
  covOnBoard: 0,
  covExcluded: 0,
  covUncovered: 0,
  covDeleted: 0,
};

function linkFields(ctx: any, boardId: bigint, access: string): { linkMode: string; linkToken: string } {
  if (isWorkspaceMachine(ctx)) return { linkMode: workspaceMachineBoardRole(ctx, boardId) === 'viewer' ? 'view' : '', linkToken: '' };
  // Preserve the existing wire shape and old-client read-only classification.
  if (ctx.db.boardWorkspace.boardId.find(boardId) && effectiveBoardRole(ctx, boardId) === 'viewer') return { linkMode: 'view', linkToken: '' };
  const share = ctx.db.linkShare.boardId.find(boardId);
  if (!share) return { linkMode: '', linkToken: '' };
  const holder = access === 'owner' || hasLinkVisit(ctx, boardId, ctx.sender);
  return {
    linkMode: access === 'owner' || access === 'link' ? share.mode : '',
    linkToken: holder ? share.token : '',
  };
}

// Every board the caller can reach, once, with the strongest access first:
// own grant, then (for an agent) its owner's grants to it, then a team grant
// of any of their orgs, then a linked agent's board, then an opened link, then
// public (the first add() for a board wins). Graph views enforce the same access boundaries.
function eachMyBoard(ctx: any, add: (boardId: bigint, access: string, orgId: string) => void): void {
  if (ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) return;
  if (isWorkspaceMachine(ctx)) {
    for (const boardId of workspaceMachineBoardIds(ctx)) add(boardId, workspaceMachineBoardRole(ctx, boardId) === 'editor' ? 'grant' : 'link', '');
    return;
  }
  for (const boardId of humanBoardIds(ctx)) {
    const scope = ctx.db.boardWorkspace.boardId.find(boardId);
    if (!scope) continue;
    const role = humanBoardRole(ctx, boardId);
    add(boardId, role === 'manager' ? 'owner' : role === 'editor' ? 'team' : 'link', '');
  }
  for (const g of ctx.db.boardGrant.grantee.filter(ctx.sender)) {
    if (humanBoardRole(ctx, g.boardId) === 'manager') add(g.boardId, 'owner', '');
  }
  for (const g of ctx.db.agentGrant.agent.filter(ctx.sender)) {
    if (agentMayEdit(ctx, g.boardId, ctx.sender)) add(g.boardId, 'grant', '');
  }
  for (const m of ctx.db.orgMember.member.filter(ctx.sender)) {
    for (const g of ctx.db.teamGrant.orgId.filter(m.orgId)) {
      if (humanBoardRole(ctx, g.boardId)) add(g.boardId, 'team', m.orgId);
    }
  }
  // Native membership is authoritative after legacy import, including newly invited members.
  for (const m of ctx.db.workspaceMember.member.filter(ctx.sender)) {
    const legacy = ctx.db.legacyWorkspace.workspaceId.find(m.workspaceId);
    if (legacy) for (const g of ctx.db.teamGrant.orgId.filter(legacy.orgId)) if (humanBoardRole(ctx, g.boardId)) add(g.boardId, 'team', legacy.orgId);
  }
  for (const l of ctx.db.agentLink.owner.filter(ctx.sender)) {
    for (const g of ctx.db.boardGrant.grantee.filter(l.agent)) {
      add(g.boardId, 'agent', '');
    }
  }
  for (const v of ctx.db.linkVisit.viewer.filter(ctx.sender)) {
    if (ctx.db.linkShare.boardId.find(v.boardId)) add(v.boardId, 'link', '');
  }
  // a whole-table read, fine for a tiny table that almost never changes
  for (const p of ctx.db.publicBoard.iter()) {
    add(p.boardId, 'public', '');
  }
}

export const myBoards = spacetimedb.view(
  { name: 'my_boards', public: true },
  t.array(MyBoard),
  ctx => {
    const out = new Map<bigint, any>();
    eachMyBoard(ctx, (boardId, access, orgId) => {
      if (out.has(boardId)) {
        return;
      }
      const board = ctx.db.board.id.find(boardId);
      if (!board) {
        return;
      }
      const s = ctx.db.boardStats.boardId.find(boardId);
      out.set(boardId, {
        // createdBy/snapshotAt/lastEventId are not MyBoard columns; the
        // serializer writes only the row type's fields
        ...(s ?? NO_STATS),
        boardId,
        name: board.name,
        access,
        orgId,
        sharedWith:
          access === 'owner' ? [...ctx.db.teamGrant.boardId.filter(boardId)].map(g => g.orgId) : [],
        statsReady: Boolean(s),
        ...linkFields(ctx, boardId, access),
      });
    });
    return [...out.values()];
  }
);

const BoardSlugRow = t.row('BoardSlugRow', {
  boardId: t.u64().primaryKey(),
  slug: t.string(),
});

// The #b=<slug> of every my_boards board, so the dashboard links them by slug.
// A view of its own: public row contracts stay exact (scripts/check-wire-compat.mjs).
export const myBoardSlugs = spacetimedb.view(
  { name: 'my_board_slugs', public: true },
  t.array(BoardSlugRow),
  ctx => {
    const out = new Map<bigint, { boardId: bigint; slug: string }>();
    eachMyBoard(ctx, boardId => {
      const board = out.has(boardId) ? undefined : ctx.db.board.id.find(boardId);
      if (board) out.set(boardId, { boardId, slug: board.slug });
    });
    return [...out.values()];
  }
);

const AgentLinkRow = t.row('AgentLinkRow', {
  agent: t.identity().primaryKey(),
  owner: t.identity(),
  linkedAt: t.timestamp(),
});

// The caller's own link (an agent learns it is linked) plus the agents the
// caller linked (a human lists and unlinks them).
export const myAgentLinks = spacetimedb.view(
  { name: 'my_agent_links', public: true },
  t.array(AgentLinkRow),
  ctx => {
    if (isWorkspaceMachine(ctx)) return [];
    const out = new Map<string, any>();
    const own = ctx.db.agentLink.agent.find(ctx.sender);
    if (own) {
      out.set(own.agent.toHexString(), own);
    }
    for (const l of ctx.db.agentLink.owner.filter(ctx.sender)) {
      out.set(l.agent.toHexString(), l);
    }
    return [...out.values()];
  }
);

const AgentGrantRow = t.row('AgentGrantRow', {
  id: t.u64().primaryKey(),
  boardId: t.u64(),
  agent: t.identity(),
});

// The caller's own grants (an agent learns what it may edit) plus the grants
// of every agent the caller linked (an owner lists and revokes them).
export const myAgentGrants = spacetimedb.view(
  { name: 'my_agent_grants', public: true },
  t.array(AgentGrantRow),
  ctx => {
    if (isWorkspaceMachine(ctx)) return [];
    const out = new Map<bigint, any>();
    const add = (g: any) => out.set(g.id, { id: g.id, boardId: g.boardId, agent: g.agent });
    for (const g of ctx.db.agentGrant.agent.filter(ctx.sender)) add(g);
    for (const l of ctx.db.agentLink.owner.filter(ctx.sender)) {
      for (const g of ctx.db.agentGrant.agent.filter(l.agent)) add(g);
    }
    return [...out.values()];
  }
);

const OUTBOX_BATCH = 500;

// The drain's read: oldest outbox rows for a service account, nothing for
// anyone else.
export const serviceOutbox = spacetimedb.view(
  { name: 'service_outbox', public: true },
  t.array(activityOutbox.rowType),
  ctx => {
    if (!ctx.db.serviceAccount.identity.find(ctx.sender)) {
      return [];
    }
    // ponytail: whole-outbox scan + sort per drain; drains ack what they read,
    // so the outbox stays small. Index on id ranges if it ever is not.
    return [...ctx.db.activityOutbox.iter()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, OUTBOX_BATCH);
  }
);

// The dashboard's activity feed: the newest bursts on the boards the caller
// works on, newest first, board.stats history left out. It reads the outbox by
// board, so a write re-runs only the views of people who can open that board.
// Public boards stay out: everyone can open them, so their writes would re-run
// every dashboard (a public board you also work on stays in). Code and threat
// events follow the same layer rules as visible_code_ref and visible_threat: a
// link visitor sees them only when the owner's link includes that layer.
export const myActivity = spacetimedb.view(
  { name: 'my_activity', public: true },
  t.array(activityOutbox.rowType),
  ctx => {
    const boards = new Set<bigint>();
    eachMyBoard(ctx, (boardId, access) => {
      if (access !== 'public') boards.add(boardId);
    });
    const layers = { code: linkLayerBoardIds(ctx, 'code'), threats: linkLayerBoardIds(ctx, 'threats') };
    const rows: any[] = [];
    for (const boardId of boards) {
      for (const row of ctx.db.activityOutbox.boardId.filter(boardId)) {
        const layer = activityLayer(row.type);
        if (row.type !== 'board.stats' && (!layer || layers[layer].has(boardId))) rows.push(row);
      }
    }
    return rows.sort(newestFirst).slice(0, FEED_SIZE);
  }
);

export const workspaceServiceAccounts = spacetimedb.exportGroup(workspaceServiceAccountFeatures(spacetimedb, {
  reducer,
  isHuman: workspaceHuman,
  assertService,
}));

export const nativeWorkspaces = spacetimedb.exportGroup(workspaceFeatures(spacetimedb, {
  reducer,
  isHuman: workspaceHuman,
  assertService,
  readableBoardIds,
  effectiveRole: effectiveBoardRole,
  createBoard(ctx: any, args: any, workspace: any) {
    assertBoardName(args.name); assertRequestKey(args.requestKey);
    const receipt = ctx.db.boardCreation.requestKey.find(args.requestKey);
    if (receipt) {
      if (!receipt.owner.isEqual(ctx.sender) || ctx.db.boardWorkspace.boardId.find(receipt.boardId)?.workspaceId !== workspace.id || ctx.db.board.id.find(receipt.boardId)?.name !== args.name) throw new SenderError('workspace rule: request key belongs to another board');
      return;
    }
    const board = insertBoard(ctx, args.name);
    initCallerBoard(ctx, board.id, args.name, 'workspace');
    assignBoardWorkspace(ctx, board.id, workspace.id, ctx.sender);
    ctx.db.boardCreation.insert({ requestKey: args.requestKey, owner: ctx.sender, boardId: board.id });
  },
  moveBoard(ctx: any, boardId: bigint, workspace: any) {
    assertOwner(ctx, boardId, 'move');
    let root = boardId;
    const initial = ctx.db.architectureVersion.boardId.find(root);
    const historyId = initial?.historyId ?? 0n;
    // A plain board and all its branches share one ownership boundary.
    if (historyId === 0n && initial?.baseBoardId) root = initial.baseBoardId;
    const boards = new Set<bigint>([root]);
    if (historyId !== 0n) for (const v of ctx.db.architectureVersion.historyId.filter(historyId)) boards.add(v.boardId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...boards]) for (const v of ctx.db.architectureVersion.baseBoardId.filter(id)) if (!boards.has(v.boardId)) { boards.add(v.boardId); changed = true; }
    }
    if ([...boards].every(id => ctx.db.boardWorkspace.boardId.find(id)?.workspaceId === workspace.id)) return;
    for (const id of boards) {
      assertOwner(ctx, id, 'move');
      const scope = ctx.db.boardWorkspace.boardId.find(id);
      if (scope && !['owner', 'admin'].includes(membership(ctx, scope.workspaceId)?.role)) throw new SenderError('workspace rule: only a workspace administrator can transfer workspace content');
    }
    for (const id of boards) assignBoardWorkspace(ctx, id, workspace.id, ctx.sender);
    // The move changes whose consent each board follows (a shared workspace has none): re-apply it (RC-690).
    for (const id of boards) enforceCodeConsent(ctx, id);
    if (historyId !== 0n) {
      const mapping = { historyId, workspaceId: workspace.id };
      if (ctx.db.historyWorkspace.historyId.find(historyId)) ctx.db.historyWorkspace.historyId.update(mapping);
      else ctx.db.historyWorkspace.insert(mapping);
    }
    emit(ctx, root, 'board.workspace_moved', { workspaceId: workspace.id.toString() });
  },
}));
