/**
 * Tables the build companion added (session boards). A module published
 * before them still serves every other table, so they get their own
 * subscription: on an older module it fails alone and the board runs without
 * session chrome, instead of the whole connection failing ("no such table:
 * code_ref") while a new client is deployed ahead of the module.
 */
export const COMPANION_TABLES = ['visible_session', 'visible_code_ref'];
/** Optional independently: older session modules still show companion chrome. */
export const ROUTE_TABLES = ['visible_session_route', 'visible_route_event'];
export const ARCHITECTURE_TABLES = ['visible_architecture_history', 'visible_architecture_version'];
/**
 * Chart data, one row per chart node. Optional: a client deployed ahead of the
 * module still opens every board, and chart nodes draw their "no data" state.
 */
export const CHART_TABLES = ['visible_chart'];
/** Library icons by node (spec 2026-10-18). Optional, like charts: on an older module nodes draw without them. */
export const ICON_TABLES = ['visible_node_icon'];
/** The latest played trace per board (play_trace). Optional, like charts. */
export const TRACE_TABLES = ['visible_trace_playback'];
/** Change notes (spec 2026-10-16): optional like charts, so a module without them keeps the board open. */
export const CHANGE_NOTE_TABLES = ['visible_change_note'];
/** Threats (members-only view): optional like change notes, so a module without them keeps the board open. */
export const THREAT_TABLES = ['visible_threat'];
/** Red crayon review marks, waiting agents and read cursors: optional, so a module without them keeps the board open. */
export const MARK_TABLES = ['visible_mark', 'visible_mark_waiter', 'visible_mark_read'];
/** Hand-set edge weights (RC-688): optional, so a module without them draws every edge at regular weight. */
export const EDGE_WEIGHT_TABLES = ['visible_edge_weight'];
/** The repo remote and the line hashes (RC-690): optional, so a module without them shows no GitHub links and undo replays no hashes. */
export const CODE_LINK_TABLES = ['visible_session_remote', 'visible_code_ref_hash', 'visible_edge_evidence_hash'];
/** Incident triage: chart pins, the shared time window, lifetime flags and incident state. Optional, like charts. */
export const INCIDENT_TABLES = ['visible_chart_anchor', 'visible_board_window', 'visible_board_lifetime', 'visible_incident'];
/** The caller's saved library (one owner-filtered view). Optional, like charts. */
export const LIBRARY_VIEWS = ['my_library'];
/**
 * The viewer's linked agents, for the Connect dialog's live line (hosted MCP
 * §6). Signed-in tabs only: a sender-aware view re-runs once per subscriber,
 * and a guest links no agent.
 */
export const AGENT_LINK_VIEWS = ['my_agent_links'];
/** The owner's link includes: the share menu's Threats and Code boxes. */
export const SHARE_VIEWS = ['my_link_includes'];
/** Effective permissions are optional for servers predating native workspaces. */
export const PERMISSION_VIEWS = ['my_board_permissions'];
export const EMBED_VIEWS = ['my_chart_embeds', 'my_board_embeds'];
/**
 * The board list: every board the caller can read, for the switcher, ⌘K and
 * picking the board to open. The board tables return only the boards this
 * connection opened (open_boards, RC-605), so the list comes first.
 */
export const LIST_TABLES = ['visible_board', 'my_boards'];
/** Every other table in module_bindings; the test keeps the lists in step with it. */
export const CORE_TABLES = ['visible_cursor', 'visible_edge', 'visible_hide_set', 'visible_hide_set_member', 'visible_node', 'visible_participant', 'visible_selection'];
/**
 * In module_bindings, but the canvas never subscribes: the dashboard views
 * (spec §1.6), as a sender-aware view re-runs once per subscriber, and
 * visible_repo_file, which only agents read, service_demo_reset, the mcp cron's, and the stored-code setting (RC-690), which the dashboard and agents read.
 */
export const NOT_SUBSCRIBED = ['my_workspaces', 'my_workspace_members', 'my_workspace_teams', 'my_workspace_team_members', 'my_workspace_board_grants', 'my_workspace_team_grants', 'my_workspace_invites', 'my_workspace_service_accounts', 'my_workspace_api_keys', 'service_workspace_api_keys', 'my_guest_board', 'my_board_creations', 'my_board_slugs', 'my_activity', 'service_outbox', 'service_demo_reset', 'my_architecture_histories', 'my_agent_grants', 'visible_repo_file', 'visible_board_people', 'my_code_consent', 'visible_board_code_consent', 'embedded_chart', 'embedded_board', 'my_incidents'];

interface Builder {
  onApplied(cb: () => void): Builder;
  onError(cb: (ctx: { event?: unknown }) => void): Builder;
  subscribe(queries: string[]): unknown;
}

const all = (tables: string[]) => tables.map(t => `SELECT * FROM ${t}`);

/** What does not depend on the open board: the board list, the architecture history (the rail lists every version), the library, the owner's link includes and agent links. */
export function subscribeLists(
  conn: { subscriptionBuilder(): Builder },
  onApplied: () => void,
  onError: (ctx: { event?: unknown }) => void,
  agentLinks = false
): void {
  conn.subscriptionBuilder().onApplied(onApplied).onError(onError).subscribe(all(LIST_TABLES));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('architecture history unavailable:', ctx.event))
    .subscribe(all(ARCHITECTURE_TABLES));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('library unavailable (module predates the chart library):', ctx.event))
    .subscribe(all(LIBRARY_VIEWS));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('link includes unavailable (module predates them):', ctx.event))
    .subscribe(all(SHARE_VIEWS));
  conn.subscriptionBuilder()
    .onError(() => { /* Legacy access labels remain safe on older servers. */ })
    .subscribe(all(PERMISSION_VIEWS));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('chart embeds unavailable (module predates them):', ctx.event))
    .subscribe(all(EMBED_VIEWS));
  if (agentLinks) {
    conn.subscriptionBuilder()
      .onError(ctx => console.warn('agent links unavailable:', ctx.event))
      .subscribe(all(AGENT_LINK_VIEWS));
  }
}

/**
 * open_boards, tried twice; false when both fail. Once this identity has an
 * open_board row (an earlier tab's, emptied on disconnect), a connection that
 * opened nothing reads no board at all, so a failure must not pass silently.
 */
export async function openBoards(conn: { reducers: { openBoards(args: { boardIds: bigint[] }): Promise<void> } }, boardIds: bigint[]): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await conn.reducers.openBoards({ boardIds });
      return true;
    } catch (error) {
      console.warn('open boards failed:', error);
    }
  }
  return false;
}

/** The open boards' rows. Subscribe after open_boards, so the first rows are the open board's. */
export function subscribeBoard(
  conn: { subscriptionBuilder(): Builder },
  onApplied: () => void,
  onError: (ctx: { event?: unknown }) => void
): void {
  conn.subscriptionBuilder().onApplied(onApplied).onError(onError).subscribe(all(CORE_TABLES));
  conn
    .subscriptionBuilder()
    .onError(ctx => console.warn('session tables unavailable (module predates the build companion):', ctx.event))
    .subscribe(all(COMPANION_TABLES));
  conn
    .subscriptionBuilder()
    .onError(ctx => console.warn('route tables unavailable (module predates session routes):', ctx.event))
    .subscribe(all(ROUTE_TABLES));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('chart table unavailable (module predates charts):', ctx.event))
    .subscribe(all(CHART_TABLES));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('icon table unavailable (module predates node icons):', ctx.event))
    .subscribe(all(ICON_TABLES));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('trace table unavailable (module predates play_trace):', ctx.event))
    .subscribe(all(TRACE_TABLES));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('change notes unavailable (module predates change notes):', ctx.event))
    .subscribe(all(CHANGE_NOTE_TABLES));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('threats unavailable (module predates threats):', ctx.event))
    .subscribe(all(THREAT_TABLES));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('edge weights unavailable (module predates them):', ctx.event))
    .subscribe(all(EDGE_WEIGHT_TABLES));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('marks unavailable (module predates red crayon review):', ctx.event))
    .subscribe(all(MARK_TABLES));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('code links unavailable (module predates them):', ctx.event))
    .subscribe(all(CODE_LINK_TABLES));
  conn.subscriptionBuilder()
    .onError(ctx => console.warn('incident tables unavailable (module predates them):', ctx.event))
    .subscribe(all(INCIDENT_TABLES));
}
