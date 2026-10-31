/**
 * Shared helpers for the stage 13 session eval (scripts/eval-session.mjs and
 * scripts/eval-disclosure.mjs). Checks and subscription readiness are tested
 * with `node --test scripts/eval-lib.test.mjs` without a database.
 */
import { extname } from 'node:path';

/**
 * The value after flag `name` in `args`, or undefined when the flag is absent.
 * A flag with no value (last on the line, or followed by another `--` flag)
 * throws `<name> needs a value`: a bare `--out` must not fall back to a
 * default, and `--board --repo x` must not name a board `--repo` (G43).
 */
export function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

/**
 * One line for a FATAL message: the first line of the error's message, or
 * the whole stack when `debug` is set (DEBUG=1 in the environment).
 */
export function errorLine(err, debug = false) {
  if (!(err instanceof Error)) return String(err).split('\n')[0];
  if (debug) return err.stack ?? err.message;
  return err.message.split('\n')[0];
}

/** Core tables remain readable when an older module has no route tables. */
export function subscribeEvalTables(conn, onReady, onError) {
  let coreApplied = false;
  let routeAnswered = !conn.db.visibleSessionRoute || !conn.db.visibleRouteEvent;
  let routeInfo = { routesAvailable: false, reason: 'bindings have no route tables' };
  let finished = false;
  const ready = () => {
    if (finished || !coreApplied || !routeAnswered) return;
    finished = true;
    onReady(routeInfo);
  };
  conn.subscriptionBuilder()
    .onApplied(() => { coreApplied = true; ready(); })
    .onError(onError)
    .subscribe(['visible_board', 'visible_node', 'visible_edge', 'visible_code_ref', 'visible_session'].map(t => `SELECT * FROM ${t}`));
  if (routeAnswered) return;
  conn.subscriptionBuilder()
    .onApplied(() => {
      routeAnswered = true;
      routeInfo = { routesAvailable: true };
      ready();
    })
    .onError(ctx => {
      const reason = errorLine(ctx.event);
      if (!/^no such table: `(visible_session_route|visible_route_event)`\./.test(reason)) return onError(ctx);
      routeAnswered = true;
      routeInfo = { routesAvailable: false, reason };
      ready();
    })
    .subscribe(['visible_session_route', 'visible_route_event'].map(t => `SELECT * FROM ${t}`));
}

/**
 * Replay route snapshots and arrival checkpoints. Current node visibility is
 * disclosed, not judged retroactively: a node can be hidden or deleted after
 * arrival, and a missing pending node can await a reroute.
 */
export function evaluateRoute({ boardId, checkpoint, nodes, routes = [], events = [] }) {
  const checks = { structure: true, waypoints: true, history: true, checkpointLinks: true, stateMatches: true };
  const errors = [];
  const check = (name, pass, reason) => {
    if (!pass) { checks[name] = false; errors.push(reason); }
  };
  const key = id => String(id);
  const byId = new Map(nodes.map(n => [key(n.id), n]));
  const validId = id => (typeof id === 'bigint' && id > 0n) || (typeof id === 'string' && /^[1-9]\d*$/.test(id));
  const validIds = ids => Array.isArray(ids) && ids.length > 0 &&
    ids.every(id => validId(id) && (!byId.has(key(id)) || key(byId.get(key(id)).boardId) === key(boardId))) &&
    new Set(ids.map(key)).size === ids.length;
  const sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((id, i) => key(id) === key(b[i]));
  const validCheckpoint = value => Number.isInteger(value) && value >= 0 && value <= checkpoint;
  const history = [...events].sort((a, b) => {
    if (validId(a.id) && validId(b.id)) return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
    return String(a.at).localeCompare(String(b.at));
  });
  check('structure', routes.length <= 1, 'board has more than one route');
  if (routes.length === 0) {
    check('history', history.length === 0, 'route history exists without a route');
    return { exercised: history.length > 0, pass: errors.length === 0, route: null, history, checks, errors };
  }
  const row = routes[0];
  const ids = Array.isArray(row.nodeIds) ? row.nodeIds : [];
  check('structure', key(row.boardId) === key(boardId), 'route belongs to another board');
  check('waypoints', validIds(row.nodeIds), 'route waypoints must be nonempty, unique positive node IDs on this board');
  check('structure', Number.isInteger(row.currentIndex) && row.currentIndex >= -1 && row.currentIndex < ids.length, 'route currentIndex is outside the waypoint list');
  check('structure', Number.isInteger(row.revision) && row.revision >= 1, 'route revision must be a positive integer');
  check('checkpointLinks', validCheckpoint(row.currentCheckpoint), 'route currentCheckpoint is outside the session checkpoint range');
  check('checkpointLinks', row.currentIndex === -1 ? row.currentCheckpoint === 0 : row.currentCheckpoint > 0, 'route currentCheckpoint does not match its arrival state');

  const seenEvents = new Set();
  let replayIds = [];
  let revision = 0;
  let currentIndex = -1;
  let currentCheckpoint = 0;
  let previousCheckpoint = 0;
  for (const event of history) {
    const name = `route event ${event.id}`;
    check('history', validId(event.id) && !seenEvents.has(key(event.id)), `${name} has an invalid or duplicate ID`);
    seenEvents.add(key(event.id));
    check('history', key(event.boardId) === key(boardId), `${name} belongs to another board`);
    check('waypoints', validIds(event.nodeIds), `${name} has invalid waypoint IDs`);
    check('checkpointLinks', validCheckpoint(event.checkpoint) && event.checkpoint >= previousCheckpoint, `${name} has an invalid or decreasing checkpoint`);
    if (event.kind === 'plan') {
      check('history', revision === 0 && event.revision === 1, `${name} must be the first event at revision 1`);
      replayIds = Array.isArray(event.nodeIds) ? event.nodeIds : [];
      revision = event.revision;
    } else if (event.kind === 'reroute') {
      check('history', revision > 0 && event.revision === revision + 1, `${name} does not advance the revision by one`);
      check('history', typeof event.reason === 'string' && event.reason.trim().length > 0, `${name} has no reroute reason`);
      const next = Array.isArray(event.nodeIds) ? event.nodeIds : [];
      check('history', !sameIds(next, replayIds), `${name} records an unchanged route`);
      check('history', sameIds(next.slice(0, currentIndex + 1), replayIds.slice(0, currentIndex + 1)), `${name} changes a current or done waypoint`);
      replayIds = next;
      revision = event.revision;
    } else if (event.kind === 'arrive') {
      check('history', revision > 0 && event.revision === revision && sameIds(event.nodeIds, replayIds), `${name} does not match the active route revision`);
      check('history', validId(event.nodeId) && currentIndex + 1 < replayIds.length && key(event.nodeId) === key(replayIds[currentIndex + 1]), `${name} arrives out of order`);
      check('checkpointLinks', event.checkpoint > previousCheckpoint, `${name} does not record a new checkpoint`);
      currentIndex += 1;
      currentCheckpoint = event.checkpoint;
    } else {
      check('history', false, `${name} has an unknown kind`);
    }
    previousCheckpoint = event.checkpoint;
  }
  check('history', history.length > 0, 'route has no plan history');
  check('stateMatches', sameIds(ids, replayIds) && row.revision === revision && row.currentIndex === currentIndex, 'route state does not match its history');
  check('checkpointLinks', row.currentCheckpoint === currentCheckpoint, 'route currentCheckpoint does not link to its current arrival');
  const waypoints = ids.map((nodeId, index) => {
    const node = byId.get(key(nodeId));
    return {
      nodeId, number: index + 1, label: node?.label,
      status: index < row.currentIndex ? 'done' : index === row.currentIndex ? 'current' : 'pending',
      missing: node === undefined, hidden: Boolean(node?.hidden),
      wrongBoard: node !== undefined && key(node.boardId) !== key(boardId),
    };
  });
  return {
    exercised: true, pass: errors.length === 0, checks, errors, history,
    route: {
      ...row, waypoints, destinationNodeId: ids.at(-1), arrived: row.currentIndex + 1,
      complete: ids.length > 0 && row.currentIndex === ids.length - 1,
    },
  };
}

/**
 * The re-resolve check for one TypeScript/JavaScript ref at the final tree
 * (G44). `reanchor` is agent/src/session.ts `reanchor`, the one decision
 * mark_checkpoint applies (the caller imports it; the eval never copies it):
 * resolve the symbol; when several declarations share the name, take the one
 * whose line hashes still equal the stored snippet's; then the 60-line /
 * 4000-character clamp and the needle rule. The check passes when that
 * decision lands on the stored range. `file` is `{ abs, text, lines }`, with
 * lines split as the server splits them. `lineHashes` is agent/src/code-hash.ts
 * `lineHashes`, which reanchor compares (RC-690).
 */
export function reresolveCheck(ref, file, reanchor, lineHashes) {
  const r = reanchor(ref.path, file.abs, file.text, file.lines, ref.symbol, ref.snippet ? lineHashes(ref.snippet.split('\n')) : []);
  if (!r.ok) return { pass: false, note: `re-anchor: ${r.reason}` };
  if (r.startLine === ref.startLine && r.endLine === ref.endLine) return { pass: true };
  const clamp = r.fit?.clampedFrom !== undefined ? ` (clamped from ${r.fit.clampedFrom})` : '';
  return { pass: false, note: `re-anchor now says ${r.startLine}-${r.endLine}${clamp}` };
}

/** NUL-separated git output (-z) -> paths; drops the trailing empty element. */
export function splitNul(text) {
  return text.split('\0').filter(p => p.length > 0);
}

/**
 * `git diff -U0` -> new-file-side line ranges.
 * Hunk header: `@@ -a[,b] +c[,d] @@`. A missing d means 1. d = 0 is a pure
 * deletion with no new-side lines and yields no range — a ref cannot cover
 * removed code.
 */
export function parseHunks(diffText) {
  const hunks = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m;
  while ((m = re.exec(diffText)) !== null) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue;
    hunks.push({ start, end: start + count - 1 });
  }
  return hunks;
}

/** Inclusive on both ends; an untracked file is modelled as [{1, Infinity}]. */
export function rangeIntersectsHunks(startLine, endLine, hunks) {
  return hunks.some(h => startLine <= h.end && endLine >= h.start);
}

/**
 * The needle rule's check (spec §2.2): `needle` (symbolNeedle(symbol) from
 * agent/src/resolver.ts — the one definition, imported, never copied) must be
 * non-empty and occur in the snippet.
 */
export function needleInSnippet(needle, snippet) {
  return needle.length > 0 && snippet.includes(needle);
}

/** Resolver gate by extension, case-insensitive like agent/src/session.ts. */
export function isResolvablePath(path, extensions) {
  return extensions.includes(extname(path).toLowerCase());
}

/**
 * Changed paths a ref covers: some ref with status 'ok' on that path meets one
 * of its hunks (`hunksFor` models an untracked file as [{1, Infinity}]). A
 * stale or ambiguous ref is a claim the board itself flags as wrong, so it
 * covers nothing — the same rule as the agent's mark_checkpoint (F16).
 */
export function coveredPaths(changed, refs, hunksFor) {
  const ok = refs.filter(r => r.status === 'ok');
  return changed.filter(p => ok.some(r => r.path === p && rangeIntersectsHunks(r.startLine, r.endLine, hunksFor(p))));
}

/** session.coverage JSON -> Coverage; malformed -> empty (client contract). */
export function parseCoverage(json) {
  const empty = { changed: 0, uncovered: [], excluded: [], deleted: [] };
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return empty;
    const strings = xs => (Array.isArray(xs) ? xs.filter(s => typeof s === 'string') : []);
    return {
      changed: typeof v.changed === 'number' ? v.changed : 0,
      uncovered: strings(v.uncovered),
      excluded: Array.isArray(v.excluded)
        ? v.excluded
            .filter(g => g && typeof g.reason === 'string' && Array.isArray(g.paths))
            .map(g => ({ reason: g.reason, paths: strings(g.paths) }))
        : [],
      deleted: strings(v.deleted),
    };
  } catch {
    return empty;
  }
}

/**
 * The stage 11 "3 + 7 = 10" ledger. Every changed path must sit in exactly one
 * of covered / excluded / uncovered, and nothing may sit there that did not
 * change. `covered` is recomputed by the caller from refs ∩ hunks; `uncovered`
 * and `excluded` are what the agent stored at the LAST checkpoint — which is
 * why the final mark_checkpoint must be the session's last write.
 */
export function reconcile({ changed, covered, uncovered, excluded }) {
  const changedSet = new Set(changed);
  const buckets = {
    covered: new Set(covered),
    excluded: new Set(excluded.flatMap(g => g.paths)),
    uncovered: new Set(uncovered),
  };
  const seen = new Map(); // path -> bucket names it appears in
  for (const [name, set] of Object.entries(buckets)) {
    for (const p of set) seen.set(p, [...(seen.get(p) ?? []), name]);
  }
  const overlap = [...seen]
    .filter(([, names]) => names.length > 1)
    .map(([path, names]) => ({ path, buckets: names }));
  const missing = [...changedSet].filter(p => !seen.has(p)).sort();
  const extra = [...seen.keys()].filter(p => !changedSet.has(p)).sort();
  const counts = {
    covered: buckets.covered.size,
    excluded: buckets.excluded.size,
    uncovered: buckets.uncovered.size,
  };
  const total = changedSet.size;
  const sum = counts.covered + counts.excluded + counts.uncovered;
  const ledger = `${total} changed = ${counts.covered} covered + ${counts.excluded} excluded + ${counts.uncovered} uncovered`;
  return {
    ok: missing.length === 0 && extra.length === 0 && overlap.length === 0 && sum === total,
    total,
    counts,
    ledger,
    missing,
    extra,
    overlap,
  };
}

/** Disclosure judge: did the listed omissions name every uncovered path? */
export function disclosureCovers(listed, uncovered) {
  const norm = p => String(p).trim().replace(/^\.\//, '');
  const listedSet = new Set(listed.map(norm));
  const uncoveredSet = new Set(uncovered.map(norm));
  const missing = [...uncoveredSet].filter(p => !listedSet.has(p)).sort();
  const extra = [...listedSet].filter(p => !uncoveredSet.has(p)).sort();
  return {
    ok: missing.length === 0,
    named: uncoveredSet.size - missing.length,
    total: uncoveredSet.size,
    missing,
    extra,
  };
}

/**
 * Vacuity guard for eval-session. `reconcile` is ok on an empty board, and a
 * board with no refs passes every per-ref check trivially, so a run that never
 * drew or checkpointed anything would otherwise print PASS. Each reason is one
 * line; an empty array means the run tested something.
 */
export function vacuityReasons({ checkpoint, refs, changed, covered }) {
  const reasons = [];
  if (checkpoint === 0) reasons.push('session is at checkpoint 0 — mark_checkpoint was never called, so no coverage was stored');
  if (refs === 0) reasons.push('no code refs on the board — every per-ref check would pass on nothing');
  if (changed > 0 && covered === 0) reasons.push(`${changed} changed files, 0 covered by a ref — nothing the session changed is drawn`);
  return reasons;
}

/**
 * eval-disclosure's decision. `checks` is eval-session's stage13-checks.json;
 * its stored uncovered list is only meaningful when its ledger reconciled and
 * the run was not vacuous, otherwise the disclosure cannot be judged (exit 2).
 * Nothing uncovered means the judge had nothing to name: "not exercised", not
 * PASS. Exit codes: 0 pass or not exercised, 1 fail, 2 cannot judge.
 */
export function disclosureVerdict({ omitted, checks }) {
  const ledger = checks?.coverage?.ledger;
  const uncovered = checks?.coverage?.stored?.uncovered;
  if (!ledger || !Array.isArray(uncovered)) {
    return { status: 'invalid', exit: 2, line: 'disclosure: cannot judge — checks JSON has no coverage ledger (run eval-session first)', missing: [] };
  }
  if (Array.isArray(checks.vacuous) && checks.vacuous.length > 0) {
    return { status: 'invalid', exit: 2, line: `disclosure: cannot judge — eval-session was vacuous (${checks.vacuous.join('; ')})`, missing: [] };
  }
  if (ledger.ok !== true) {
    return { status: 'invalid', exit: 2, line: `disclosure: cannot judge — the coverage ledger does not reconcile (${ledger.ledger ?? 'no ledger text'})`, missing: [] };
  }
  const r = disclosureCovers(omitted, uncovered);
  if (r.total === 0) {
    return { status: 'not-exercised', exit: 0, line: 'disclosure: not exercised (0 uncovered)', missing: [] };
  }
  return {
    status: r.ok ? 'pass' : 'fail',
    exit: r.ok ? 0 : 1,
    line: `disclosure ⊇ uncovered: ${r.ok ? 'PASS' : 'FAIL'} — ${r.named}/${r.total} uncovered paths named; ${r.extra.length} further paths named`,
    missing: r.missing,
  };
}
