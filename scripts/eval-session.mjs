/**
 * eval-session — stage 13 automated checks over a session board (spec §6).
 *
 * Run inside the nix shell from the repo root. tsx is required because the
 * generated bindings and the resolver are TypeScript, imported directly (not
 * copied) from agent/src:
 *
 *   SPACETIME_URI=ws://localhost:3000 SPACETIME_DB=redcrayon \
 *     agent/node_modules/.bin/tsx scripts/eval-session.mjs --board <name> --repo <path> [--out <dir>]
 *
 * Pass --token-file <path> with an identity authorized to read a private board.
 * Without it, only public boards are visible. No reducers are called. Dumps
 * the board, runs the checks against git at --repo (any path
 * inside the work tree; its top level is used), writes:
 *   <out>/stage13-checks.json        every check per ref + the coverage ledger
 *   <out>/stage13-board.json         nodes, edges, refs (no snippets), session, route + history -> truth judge
 *   <out>/stage13-board-public.json  same without session.coverage             -> disclosure judge
 * <out> defaults to .context/eval, which is gitignored. Keep board dumps and
 * evaluation output there, or choose another private directory with --out.
 * Exit 0 = all checks passed, 1 = a check failed or the run was VACUOUS,
 * 2 = could not run (bad arguments, a flag without a value, --repo not in a
 * git work tree, no such board, a board without a session row such as Demo,
 * DB unreachable). Every exit-2 path prints one FATAL line (DEBUG=1 adds the
 * stack of an unexpected error).
 *
 * VACUOUS (exit 1): the session is at checkpoint 0, the board has no code refs,
 * or files changed but no ref covers any of them. reconcile() is ok on an empty
 * board and the per-ref checks pass on zero refs, so without this guard a board
 * with nothing drawn would print PASS.
 *
 * The ledger reconciles the coverage the agent stored at its LAST checkpoint
 * against git at the final tree. That is why the skill makes the final
 * mark_checkpoint the session's last write: any edit after it fails here.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import {
  splitNul,
  parseHunks,
  rangeIntersectsHunks,
  parseCoverage,
  reconcile,
  vacuityReasons,
  needleInSnippet,
  isResolvablePath,
  coveredPaths,
  flagValue,
  errorLine,
  reresolveCheck,
  evaluateRoute,
  subscribeEvalTables,
} from './eval-lib.mjs';

function fatal(reason) {
  console.error(`FATAL: ${reason}`);
  process.exit(2);
}

const uri = process.env.SPACETIME_URI;
const db = process.env.SPACETIME_DB;
if (!uri) fatal('SPACETIME_URI is not set — e.g. SPACETIME_URI=ws://localhost:3000');
if (!db) fatal('SPACETIME_DB is not set — e.g. SPACETIME_DB=redcrayon');

const args = process.argv.slice(2);
function flag(name) {
  try {
    return flagValue(args, name);
  } catch (err) {
    return fatal(errorLine(err));
  }
}
const boardName = flag('--board') ?? fatal('missing --board <name>');
const repoArg = flag('--repo') ?? fatal('missing --repo <path>');
const outDir = resolve(process.cwd(), flag('--out') ?? '.context/eval');
const tokenFile = flag('--token-file');
let readerToken;
if (tokenFile) {
  try {
    readerToken = readFileSync(resolve(tokenFile), 'utf8').trim();
    if (!readerToken) fatal('--token-file is empty');
  } catch {
    fatal('cannot read --token-file');
  }
}
// --repo must be inside a git work tree; its top level is what the session's
// repoRoot names, so repo-relative ref paths resolve against it.
let repo;
try {
  const top = execFileSync('git', ['-C', resolve(process.cwd(), repoArg), 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  repo = realpathSync(top);
} catch (err) {
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim().split('\n')[0] : '';
  fatal(`--repo ${repoArg} is not inside a git work tree (${stderr || errorLine(err)})`);
}

// The bindings, resolver and session flows are TypeScript with extensionless
// imports, so they load only under tsx. Imported after the argument checks so
// a misconfigured run fails with one FATAL line, not a module-resolution trace.
// symbolNeedle comes from the resolver and reanchor from the session flows,
// never local copies, so the eval's needle rule (F18) and its re-resolve
// decision (G44) cannot drift from the server's.
let DbConnection, symbolNeedle, RESOLVABLE_EXTENSIONS, reanchor, lineHashes;
try {
  ({ DbConnection } = await import('../agent/src/module_bindings/index.ts'));
  ({ symbolNeedle, RESOLVABLE_EXTENSIONS } = await import('../agent/src/resolver.ts'));
  ({ reanchor } = await import('../agent/src/session.ts'));
  ({ lineHashes } = await import('../agent/src/code-hash.ts'));
} catch (err) {
  const first = (err instanceof Error ? err.message : String(err)).split('\n')[0];
  fatal(`cannot load agent/src — run under agent/node_modules/.bin/tsx (${first})`);
}

function git(gitArgs, input) {
  return execFileSync('git', ['-C', repo, ...gitArgs], {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** repo-relative -> absolute; refuses escapes, symlinks, non-files (same guard as the server's snippet reader). */
function safeAbs(rel) {
  const abs = resolve(repo, rel);
  const r = relative(repo, abs);
  if (r.startsWith('..') || isAbsolute(r)) return null;
  try {
    if (!lstatSync(abs).isFile()) return null;
    if (realpathSync(abs) !== abs) return null;
  } catch {
    return null;
  }
  return abs;
}

const asJson = v => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

const CHECKS = ['targetExists', 'targetVisible', 'needleInSnippet', 'statusOk', 'inDiff', 'blobCurrent', 'reresolve'];

function run(conn, routeInfo) {
  const board = [...conn.db.visibleBoard.iter()].find(b => b.name === boardName);
  if (!board) {
    fatal(`board "${boardName}" is unavailable; use --token-file with an authorized identity for private boards`);
  }
  const session = [...conn.db.visibleSession.iter()].find(s => s.boardId === board.id);
  if (!session) fatal(`board "${boardName}" has no session row — this is not a session board`);

  const allNodes = [...conn.db.visibleNode.iter()];
  const nodes = allNodes.filter(n => n.boardId === board.id);
  const edges = [...conn.db.visibleEdge.iter()].filter(e => e.boardId === board.id);
  const refs = [...conn.db.visibleCodeRef.iter()].filter(r => r.boardId === board.id);
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  const edgesById = new Map(edges.map(e => [e.id, e]));
  const targetOf = r =>
    r.targetKind === 'node' ? nodesById.get(r.targetId) : r.targetKind === 'edge' ? edgesById.get(r.targetId) : undefined;
  const routeEvaluation = evaluateRoute({
    boardId: board.id, checkpoint: Number(session.checkpoint), nodes: allNodes,
    routes: routeInfo.routesAvailable ? [...conn.db.visibleSessionRoute.iter()].filter(r => r.boardId === board.id) : [],
    events: routeInfo.routesAvailable ? [...conn.db.visibleRouteEvent.iter()].filter(e => e.boardId === board.id) : [],
  });

  // ---- git truth at the final tree ---------------------------------------
  const head = git(['rev-parse', 'HEAD']).trim();
  // --no-ext-diff: a configured diff.external (difftastic) would replace the
  // unified hunks with its own format, the same reason agent/src/git.ts passes it.
  const changedTracked = splitNul(git(['diff', '--no-ext-diff', '-z', '--name-only', '--diff-filter=d', session.baseSha]));
  const untracked = new Set(splitNul(git(['ls-files', '-z', '--others', '--exclude-standard'])));
  const changed = [...new Set([...changedTracked, ...untracked])].sort();
  const changedSet = new Set(changed);
  const hunkCache = new Map();
  const hunksFor = path => {
    if (untracked.has(path)) return [{ start: 1, end: Infinity }];
    if (!hunkCache.has(path)) hunkCache.set(path, parseHunks(git(['diff', '--no-ext-diff', '--no-color', '--no-textconv', '-U0', session.baseSha, '--', `:(literal)${path}`])));
    return hunkCache.get(path);
  };

  // ---- per-ref checks ------------------------------------------------------
  const refResults = refs.map(ref => {
    const target = targetOf(ref);
    const checks = {
      targetExists: target !== undefined,
      targetVisible: target !== undefined && !target.hidden,
      needleInSnippet: needleInSnippet(symbolNeedle(ref.symbol), ref.snippet),
      statusOk: ref.status === 'ok',
      inDiff: changedSet.has(ref.path) && rangeIntersectsHunks(ref.startLine, ref.endLine, hunksFor(ref.path)),
      blobCurrent: false,
      reresolve: 'skipped',
    };
    const notes = [];
    if (!changedSet.has(ref.path)) notes.push('file unchanged in session');
    const abs = safeAbs(ref.path);
    if (!abs) {
      notes.push('path missing, escapes the repo, or is not a regular file');
    } else {
      const bytes = readFileSync(abs);
      checks.blobCurrent = git(['hash-object', `--path=${ref.path}`, '--stdin'], bytes).trim() === ref.blobSha;
      if (!checks.blobCurrent) notes.push('file changed after its ref was captured');
      // TS/JS refs only: the server's last decision on a ref was made on the
      // blob it stored, and reanchor repeats it exactly for these files. A
      // non-TS ref keeps its captured lines until its file changes, which
      // blobCurrent already checks; reanchor's exact-once rule for those
      // files would fail a ref the server rightly still holds as ok.
      if (isResolvablePath(ref.path, RESOLVABLE_EXTENSIONS)) {
        const text = bytes.toString('utf8');
        // split as agent/src/snippet.ts readSource splits
        const lines = text.split(/\r?\n/);
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        const r = reresolveCheck(ref, { abs, text, lines }, reanchor, lineHashes);
        checks.reresolve = r.pass;
        if (!r.pass) notes.push(r.note);
      }
    }
    const pass = CHECKS.every(k => checks[k] === true || checks[k] === 'skipped');
    return {
      id: ref.id,
      target: `${ref.targetKind}:${ref.targetId}`,
      targetLabel: target && 'label' in target ? target.label : undefined,
      symbol: ref.symbol,
      path: ref.path,
      range: `${ref.startLine}-${ref.endLine}`,
      status: ref.status,
      checkpoint: ref.checkpoint,
      author: ref.author,
      checks,
      notes,
      pass,
    };
  });

  // ---- coverage ledger (last checkpoint's stored coverage vs git now) -------
  const coverage = parseCoverage(session.coverage);
  const liveRefs = refs.filter(r => targetOf(r) !== undefined);
  const covered = coveredPaths(changed, liveRefs, hunksFor);
  const ledger = reconcile({ changed, covered, uncovered: coverage.uncovered, excluded: coverage.excluded });
  const headMatches = session.headSha === head;
  const vacuous = vacuityReasons({
    checkpoint: Number(session.checkpoint),
    refs: refs.length,
    changed: changed.length,
    covered: covered.length,
  });

  // ---- dumps for the judges ------------------------------------------------
  const summary = r => ({
    id: r.id, symbol: r.symbol, path: r.path, startLine: r.startLine, endLine: r.endLine,
    status: r.status, checkpoint: r.checkpoint, author: r.author,
  });
  const dump = {
    board: boardName,
    route: routeEvaluation.route,
    routeHistory: routeEvaluation.history,
    routeAvailability: routeInfo,
    session: {
      repoRoot: session.repoRoot, baseSha: session.baseSha, headSha: session.headSha,
      checkpoint: session.checkpoint, coverage,
    },
    nodes: nodes.map(n => ({
      id: n.id, label: n.label, sublabel: n.sublabel, kind: n.kind, token: n.token, focal: n.focal,
      hidden: n.hidden, doc: n.doc, x: n.x, y: n.y, w: n.w, h: n.h,
      refs: refs.filter(r => r.targetKind === 'node' && r.targetId === n.id).map(summary),
    })),
    edges: edges.map(e => ({
      id: e.id, from: e.fromNode, to: e.toNode, label: e.label, evidence: e.evidence, hidden: e.hidden,
      refs: refs.filter(r => r.targetKind === 'edge' && r.targetId === e.id).map(summary),
    })),
  };
  const publicDump = { ...dump, session: { ...dump.session, coverage: undefined } };

  const result = {
    board: boardName,
    repo,
    evaluatedAt: new Date().toISOString(),
    head,
    headMatches,
    counts: {
      nodes: nodes.length,
      shownNodes: nodes.filter(n => !n.hidden).length,
      edges: edges.length,
      refs: refs.length,
      changed: changed.length,
      waypoints: routeEvaluation.route?.waypoints.length ?? 0,
      routeEvents: routeEvaluation.history.length,
    },
    checkTotals: Object.fromEntries(
      CHECKS.map(k => [
        k,
        {
          pass: refResults.filter(r => r.checks[k] === true).length,
          skipped: refResults.filter(r => r.checks[k] === 'skipped').length,
          total: refResults.length,
        },
      ])
    ),
    refs: refResults,
    coverage: { changed, covered, stored: coverage, ledger },
    route: { ...routeInfo, ...routeEvaluation },
    vacuous,
    pass: vacuous.length === 0 && refResults.every(r => r.pass) && ledger.ok && routeEvaluation.pass,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'stage13-checks.json'), asJson(result) + '\n');
  writeFileSync(join(outDir, 'stage13-board.json'), asJson(dump) + '\n');
  writeFileSync(join(outDir, 'stage13-board-public.json'), asJson(publicDump) + '\n');

  console.log(
    `eval-session: board "${boardName}" · checkpoint ${session.checkpoint} · ${nodes.length} nodes · ${edges.length} edges · ${refs.length} refs · ${changed.length} changed files`
  );
  for (const [k, v] of Object.entries(result.checkTotals)) {
    console.log(`  ${k.padEnd(16)} ${v.pass}/${v.total - v.skipped}${v.skipped ? ` (skipped ${v.skipped})` : ''}`);
  }
  console.log(
    `  ledger           ${ledger.ledger}${
      ledger.ok ? ' ✓' : ` ✗ missing=${ledger.missing.length} extra=${ledger.extra.length} overlap=${ledger.overlap.length}`
    }`
  );
  console.log(
    `  headSha current  ${headMatches ? 'yes' : `no (session ${session.headSha.slice(0, 7) || '-'}, HEAD ${head.slice(0, 7)}) — something was committed after the last checkpoint`}`
  );
  console.log(`  route            ${!routeInfo.routesAvailable ? `unavailable (${routeInfo.reason})` : !routeEvaluation.exercised ? 'not exercised (no route)' : `${routeEvaluation.pass ? 'PASS' : 'FAIL'} · ${routeEvaluation.route?.arrived ?? 0}/${routeEvaluation.route?.waypoints.length ?? 0} arrived${routeEvaluation.route?.complete ? ' · destination reached' : ''}`}`);
  for (const reason of routeEvaluation.errors) console.log(`  FAIL route ${reason}`);
  for (const r of refResults.filter(r => !r.pass)) {
    const failed = CHECKS.filter(k => r.checks[k] === false).join(', ');
    console.log(`  FAIL ref ${r.id} ${r.symbol} ${r.path}:${r.range} — ${failed}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
  }
  console.log(`wrote ${join(outDir, 'stage13-checks.json')} + stage13-board.json + stage13-board-public.json`);
  for (const reason of vacuous) console.log(`  VACUOUS ${reason}`);
  console.log(result.pass ? 'PASS' : vacuous.length > 0 ? 'FAIL (VACUOUS)' : 'FAIL');
  conn.disconnect();
  setTimeout(() => process.exit(result.pass ? 0 : 1), 200);
}

const builder = DbConnection.builder()
  .withUri(uri)
  .withDatabaseName(db)
  .onConnect(conn => {
    subscribeEvalTables(conn,
      routeInfo => {
        try {
          run(conn, routeInfo);
        } catch (err) {
          fatal(errorLine(err, Boolean(process.env.DEBUG)));
        }
      },
      ctx => fatal(`subscription error: ${errorLine(ctx.event)}`),
    );
  })
  .onConnectError((_ctx, err) => fatal(`connection failed: ${errorLine(err)}`));
if (readerToken) builder.withToken(readerToken);
builder.build();
