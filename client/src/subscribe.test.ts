import { describe, it, expect, vi } from 'vitest';
import bindings from './module_bindings/index.ts?raw';
import {
  AGENT_LINK_VIEWS,
  SHARE_VIEWS,
  PERMISSION_VIEWS,
  EMBED_VIEWS,
  ARCHITECTURE_TABLES,
  CHANGE_NOTE_TABLES,
  CHART_TABLES,
  ICON_TABLES,
  COMPANION_TABLES,
  CORE_TABLES,
  LIBRARY_VIEWS,
  TRACE_TABLES,
  THREAT_TABLES,
  MARK_TABLES,
  EDGE_WEIGHT_TABLES,
  EDGE_MOTION_TABLES,
  CODE_LINK_TABLES,
  INCIDENT_TABLES,
  NOT_SUBSCRIBED,
  ROUTE_TABLES,
  LIST_TABLES,
  openBoards,
  subscribeBoard,
  subscribeLists,
} from './subscribe';

type Sub = { queries: string[]; onError?: (c: { event?: unknown }) => void; onApplied?: () => void };
function fakeConn() {
  const subs: Sub[] = [];
  return {
    subs,
    subscriptionBuilder() {
      const s: Sub = { queries: [] };
      subs.push(s);
      const b = {
        onApplied(cb: () => void) { s.onApplied = cb; return b; },
        onError(cb: (c: { event?: unknown }) => void) { s.onError = cb; return b; },
        subscribe(q: string[]) { s.queries = q; return {}; },
      };
      return b;
    },
  };
}

describe('board subscription', () => {
  it('list + core + companion + route tables + the unsubscribed dashboard views are exactly the tables in module_bindings', () => {
    const inBindings = [...bindings.matchAll(/^ {4}name: '(\w+)',$/gm)].map(m => m[1]).sort();
    expect(
      [...LIST_TABLES, ...CORE_TABLES, ...COMPANION_TABLES, ...ROUTE_TABLES, ...ARCHITECTURE_TABLES, ...CHART_TABLES, ...ICON_TABLES, ...LIBRARY_VIEWS, ...TRACE_TABLES, ...CHANGE_NOTE_TABLES, ...THREAT_TABLES, ...MARK_TABLES, ...EDGE_WEIGHT_TABLES, ...EDGE_MOTION_TABLES, ...CODE_LINK_TABLES, ...INCIDENT_TABLES, ...AGENT_LINK_VIEWS, ...SHARE_VIEWS, ...EMBED_VIEWS, ...PERMISSION_VIEWS, ...NOT_SUBSCRIBED].sort()
    ).toEqual(inBindings);
  });

  it('keeps chart and my_library out of the core group, whose error closes the board', () => {
    expect(CORE_TABLES).not.toContain('visible_chart');
    expect(CORE_TABLES).not.toContain('my_library');
    expect(NOT_SUBSCRIBED).not.toContain('my_library');
  });

  it('leaves visible_repo_file unsubscribed: the canvas never reads it (U2)', () => {
    expect(CORE_TABLES).not.toContain('visible_repo_file');
    expect(NOT_SUBSCRIBED).toContain('visible_repo_file');
  });

  it('keeps change notes out of the core group: a module without them leaves the board open', () => {
    expect(CHANGE_NOTE_TABLES).toEqual(['visible_change_note']);
    expect(CORE_TABLES).not.toContain('visible_change_note');
  });

  it('subscribes the mark views on their own and keeps them out of the core group (red crayon review)', () => {
    expect(MARK_TABLES).toEqual(['visible_mark', 'visible_mark_waiter', 'visible_mark_read']);
    for (const t of MARK_TABLES) {
      expect(CORE_TABLES).not.toContain(t);
      expect(NOT_SUBSCRIBED).not.toContain(t);
    }
  });

  it('keeps threats out of the core group: a module without them leaves the board open', () => {
    expect(THREAT_TABLES).toEqual(['visible_threat']);
    expect(CORE_TABLES).not.toContain('visible_threat');
  });

  it('lists every readable board apart from the open board\'s rows (RC-605)', () => {
    const conn = fakeConn();
    const failed = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribeLists(conn, () => {}, failed);
    expect(conn.subs.map(s => s.queries)).toEqual([
      ['SELECT * FROM visible_board', 'SELECT * FROM my_boards'],
      ['SELECT * FROM visible_architecture_history', 'SELECT * FROM visible_architecture_version'],
      ['SELECT * FROM my_library'],
      ['SELECT * FROM my_link_includes'],
      ['SELECT * FROM my_board_permissions'],
      ['SELECT * FROM my_chart_embeds', 'SELECT * FROM my_board_embeds'],
    ]);
    conn.subs[1].onError!({ event: new Error('no such table: `visible_architecture_version`') });
    conn.subs[2].onError!({ event: new Error('no such table: `my_library`') });
    conn.subs[3].onError!({ event: new Error('no such table: `my_link_includes`') });
    conn.subs[4].onError!({ event: new Error('no such table: `my_board_permissions`') });
    conn.subs[5].onError!({ event: new Error('no such table: `my_chart_embeds`') });
    expect(failed).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[1][0])).toContain('library unavailable');
    expect(String(warn.mock.calls[3][0])).toContain('chart embeds unavailable');
    conn.subs[0].onError!({ event: new Error('lost') });
    expect(failed).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a failing companion subscription does not reach the board error path', () => {
    const conn = fakeConn();
    const crash = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribeBoard(conn, () => {}, crash);
    expect(conn.subs[0].queries).toContain('SELECT * FROM visible_node');
    expect(conn.subs[0].queries).not.toContain('SELECT * FROM visible_board');
    expect(conn.subs[0].queries).not.toContain('SELECT * FROM visible_code_ref');
    expect(conn.subs[1].queries).toEqual(['SELECT * FROM visible_session', 'SELECT * FROM visible_code_ref']);
    expect(conn.subs[2].queries).toEqual(['SELECT * FROM visible_session_route', 'SELECT * FROM visible_route_event']);
    conn.subs[1].onError!({ event: new Error('no such table: `code_ref`') });
    expect(crash).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    conn.subs[2].onError!({ event: new Error('no such table: `session_route`') });
    expect(crash).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('subscribes to charts, icons, traces, change notes, threats, edge weights, marks and code links in their own groups, after the board groups', () => {
    const conn = fakeConn();
    const crash = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribeBoard(conn, () => {}, crash);
    expect(conn.subs).toHaveLength(13);
    expect(conn.subs[3].queries).toEqual(['SELECT * FROM visible_chart']);
    expect(conn.subs[4].queries).toEqual(['SELECT * FROM visible_node_icon']);
    expect(conn.subs[5].queries).toEqual(['SELECT * FROM visible_trace_playback']);
    expect(conn.subs[6].queries).toEqual(['SELECT * FROM visible_change_note']);
    expect(conn.subs[7].queries).toEqual(['SELECT * FROM visible_threat']);
    expect(conn.subs[8].queries).toEqual(['SELECT * FROM visible_edge_weight']);
    expect(conn.subs[9].queries).toEqual(['SELECT * FROM visible_edge_motion']);
    expect(conn.subs[10].queries).toEqual(['SELECT * FROM visible_mark', 'SELECT * FROM visible_mark_waiter', 'SELECT * FROM visible_mark_read']);
    expect(conn.subs[11].queries).toEqual(['SELECT * FROM visible_session_remote', 'SELECT * FROM visible_code_ref_hash', 'SELECT * FROM visible_edge_evidence_hash']);
    expect(conn.subs[12].queries).toEqual(['SELECT * FROM visible_chart_anchor', 'SELECT * FROM visible_board_window', 'SELECT * FROM visible_board_lifetime', 'SELECT * FROM visible_incident']);
    for (const [i, table] of [[3, 'visible_chart'], [4, 'visible_node_icon'], [5, 'visible_trace_playback'], [6, 'visible_change_note'], [7, 'visible_threat'], [8, 'visible_edge_weight'], [9, 'visible_edge_motion'], [10, 'visible_mark'], [11, 'visible_session_remote'], [12, 'visible_chart_anchor']] as const) {
      conn.subs[i].onError!({ event: new Error(`no such table: \`${table}\``) });
    }
    expect(crash).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(10);
    expect(String(warn.mock.calls[0][0])).toContain('chart table unavailable');
    expect(String(warn.mock.calls[1][0])).toContain('icon table unavailable');
    expect(String(warn.mock.calls[2][0])).toContain('trace table unavailable');
    expect(String(warn.mock.calls[3][0])).toContain('change notes unavailable');
    expect(String(warn.mock.calls[4][0])).toContain('threats unavailable');
    expect(String(warn.mock.calls[5][0])).toContain('edge weights unavailable');
    expect(String(warn.mock.calls[6][0])).toContain('edge motions unavailable');
    expect(String(warn.mock.calls[7][0])).toContain('marks unavailable');
    expect(String(warn.mock.calls[8][0])).toContain('code links unavailable');
    expect(String(warn.mock.calls[9][0])).toContain('incident tables unavailable');
    warn.mockRestore();
  });

  it('keeps node icons out of the core group: a module without them leaves the board open', () => {
    expect(ICON_TABLES).toEqual(['visible_node_icon']);
    expect(CORE_TABLES).not.toContain('visible_node_icon');
  });

  it('subscribes to the viewer\'s agent links only when asked (signed in), in a group of its own', () => {
    const queries = (agentLinks: boolean) => {
      const conn = fakeConn();
      subscribeLists(conn, () => {}, () => {}, agentLinks);
      return conn.subs.map(s => s.queries);
    };
    expect(queries(false).flat()).not.toContain('SELECT * FROM my_agent_links');
    expect(queries(true)).toHaveLength(7);
    expect(queries(true)[6]).toEqual(['SELECT * FROM my_agent_links']);
  });
});

describe('openBoards', () => {
  const conn = (failures: number) => {
    const calls: bigint[][] = [];
    return { calls, reducers: { openBoards: async ({ boardIds }: { boardIds: bigint[] }) => {
      calls.push(boardIds);
      if (calls.length <= failures) throw new Error('timeout');
    } } };
  };

  it('retries a failed open once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = conn(1);
    expect(await openBoards(c, [7n])).toBe(true);
    expect(c.calls).toEqual([[7n], [7n]]);
  });

  // An identity whose open_board row was emptied reads no board without it: the caller shows the board-unavailable screen.
  it('reports failure after the retry fails, instead of a silent blank board', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = conn(2);
    expect(await openBoards(c, [7n, 3n])).toBe(false);
    expect(c.calls).toHaveLength(2);
  });
});
