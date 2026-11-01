/**
 * redcrayon, the local facts helper (spec §5), run from the project directory:
 *
 *   redcrayon capture start
 *   redcrayon capture ref <path> [--board <id>]
 *   redcrayon capture cite <path> [--board <id>]
 *   redcrayon capture checkpoint --board <id> --base <sha> [--also <path>…]
 *   redcrayon hook      Claude Code PreToolUse/PostToolUse JSON on stdin (Decision 20)
 *   redcrayon doctor    one line per check: node, git, repo, network
 *   redcrayon tap --token <t>   live traffic: OTLP/HTTP on 127.0.0.1:4318 to the board's Live view
 *   redcrayon marks --token <t> wait for red crayon marks; prints them and exits once they are claimed
 *
 * A capture prints exactly one line on stdout, `cap_<22 base62>`; everything
 * else goes to stderr. A refusal is one stderr line and exit 1.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { gitCommonDir } from '../../agent/src/git';
import { CAPTURE_ID_RE, type CaptureBody, type CaptureKind } from '../../shared/capture';
import {
  BOARD_RE,
  HOOK_MATCHER,
  HelperError,
  PRIVACY,
  buildCapture,
  checkout,
  firstRun,
  origin,
  readBase,
  say,
  writeBase,
  writeCited,
  type CaptureOpts,
} from './capture';
import { runMarks } from './marks';
import { runTap } from './tap';


const USAGE =
  'redcrayon: usage: redcrayon capture start | capture ref <path> [--board <id>] | capture cite <path> [--board <id>] | capture checkpoint --board <id> --base <sha> [--also <path>…] | hook | doctor | tap --token <t> | marks --token <t>';

const firstLine = (s: string) => s.split('\n')[0].replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
const BATCH_CAPTURE_TIMEOUT = 'redcrayon: source captures took too long for one batch. Split apply_board into smaller batches or create_edge calls.';

async function upload(body: CaptureBody, parent?: AbortSignal): Promise<string> {
  const url = `${origin()}/facts`;
  const host = new URL(url).host;
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(30_000);
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: parent ? AbortSignal.any([parent, timeout]) : timeout });
  } catch {
    throw new HelperError(say.offline(host));
  }
  const text = await res.text().catch(() => '');
  let id: unknown;
  try {
    id = (JSON.parse(text) as { capture?: unknown }).capture;
  } catch {
    id = undefined;
  }
  if (!res.ok || typeof id !== 'string' || !CAPTURE_ID_RE.test(id)) {
    throw new HelperError(`redcrayon: ${host} did not take the capture (HTTP ${res.status}${text ? `: ${firstLine(text)}` : ''}).`);
  }
  return id;
}

/** Upload one capture; the privacy line goes out once, after the first upload that worked. */
async function capture(kind: CaptureKind, opts: CaptureOpts, notice: (line: string) => void, signal?: AbortSignal, deadline?: number): Promise<string> {
  signal?.throwIfAborted();
  if (deadline !== undefined && Date.now() >= deadline) throw new HelperError(BATCH_CAPTURE_TIMEOUT);
  const body = buildCapture(kind, opts, deadline);
  if (deadline !== undefined && Date.now() >= deadline) throw new HelperError(BATCH_CAPTURE_TIMEOUT);
  const id = await upload(body, signal);
  if (firstRun(join(gitCommonDir(body.toplevel, deadline === undefined ? undefined : Math.max(1, deadline - Date.now())), 'redcrayon'))) notice(PRIVACY);
  return id;
}

function parseCapture(args: string[]): { kind: CaptureKind; opts: Omit<CaptureOpts, 'cwd'> } {
  const [kind, ...rest] = args;
  const positional: string[] = [];
  const opts: Omit<CaptureOpts, 'cwd'> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--board' || a === '--base') {
      if (i + 1 >= rest.length) throw new HelperError(USAGE);
      opts[a === '--board' ? 'board' : 'base'] = rest[++i];
    } else if (a === '--also') {
      opts.also ??= [];
      while (i + 1 < rest.length && !rest[i + 1].startsWith('--')) opts.also.push(rest[++i]);
    } else if (a.startsWith('--')) {
      throw new HelperError(USAGE);
    } else {
      positional.push(a);
    }
  }
  if (kind === 'start' && positional.length === 0) return { kind, opts };
  if ((kind === 'ref' || kind === 'cite') && positional.length === 1) return { kind, opts: { ...opts, path: positional[0] } };
  if (kind === 'checkpoint' && positional.length === 0 && opts.board !== undefined && opts.base !== undefined) return { kind, opts };
  throw new HelperError(USAGE);
}

async function doctor(cwd: string): Promise<number> {
  let ok = true;
  const check = (name: string, good: boolean, detail: string) => {
    process.stderr.write(`${name}: ${good ? 'ok' : 'FAIL'} (${detail})\n`);
    ok &&= good;
  };
  const major = Number(process.versions.node.split('.')[0]);
  check('node', major >= 20, major >= 20 ? `v${process.versions.node}` : `v${process.versions.node}; redcrayon needs Node 20 or later`);
  try {
    check('git', true, execFileSync('git', ['--version'], { encoding: 'utf8' }).trim());
  } catch {
    check('git', false, 'git was not found on PATH');
  }
  try {
    check('repo', true, checkout(cwd).root);
  } catch (err) {
    check('repo', false, err instanceof HelperError ? err.message.replace(/^redcrayon: /, '') : firstLine(String(err)));
  }
  const host = new URL(origin()).host;
  try {
    const res = await fetch(`${origin()}/health`, { signal: AbortSignal.timeout(10_000) });
    check('network', true, `${host} answered ${res.status}`);
  } catch {
    check('network', false, `could not reach ${host}`);
  }
  return ok ? 0 : 1;
}

// ---------- hook mode (Decision 20) ----------

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Claude Code hands an MCP result over as its content blocks, the result, or its text.
function resultJson(response: unknown): Json | undefined {
  const blocks = Array.isArray(response) ? response : isObject(response) && Array.isArray(response.content) ? response.content : undefined;
  const text = typeof response === 'string' ? response : blocks?.find(b => isObject(b) && b.type === 'text')?.text;
  if (typeof text !== 'string') return blocks === undefined && isObject(response) ? response : undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** source:<path>:<line> → path (only the final colon separates the line), else undefined. */
function sourcePath(evidence: unknown): string | undefined {
  if (typeof evidence !== 'string' || !evidence.startsWith('source:')) return undefined;
  const rest = evidence.slice('source:'.length);
  const colon = rest.lastIndexOf(':');
  return colon > 0 && /^[0-9]+$/.test(rest.slice(colon + 1)) ? rest.slice(0, colon) : undefined;
}

/**
 * PreToolUse: fill an empty `capture` through updatedInput, which replaces
 * the whole input, so every argument is echoed. Exit 2 with the helper's
 * line only when the helper refuses on a tool that cannot succeed without a
 * capture; every other failure exits 0 with no output, and the server's
 * capture-missing text explains (a hook exiting 1 fails open anyway).
 */
async function preToolUse(tool: string, args: Json, cwd: string, out: string[], err: string[]): Promise<number> {
  if (typeof args.capture === 'string' && args.capture !== '') return 0;
  try {
    if (tool === 'apply_board') {
      if (!Array.isArray(args.edges) || args.edges.length > 16 || !args.edges.every(isObject)) return 0;
      const edges = [...args.edges];
      let changed = false;
      // Leave ten seconds for startup and cleanup inside the plugin hook's 45 s limit.
      const deadline = Date.now() + 35_000;
      const budget = AbortSignal.timeout(35_000);
      const stop = new AbortController();
      const signal = AbortSignal.any([budget, stop.signal]);
      try {
        for (let i = 0; i < edges.length; i += 3) {
          await Promise.all(edges.slice(i, i + 3).map(async (edge, j) => {
            const wanted = captureFor('create_edge', { ...edge, board: args.board }, cwd);
            if (!wanted || (typeof edge.capture === 'string' && edge.capture !== '')) return;
            const id = await capture(wanted.kind, wanted, line => err.push(line), signal, deadline);
            edges[i + j] = { ...edge, capture: id };
            changed = true;
          }));
        }
      } catch (e) {
        stop.abort();
        if (budget.aborted || Date.now() >= deadline) throw new HelperError(BATCH_CAPTURE_TIMEOUT);
        throw e;
      }
      if (changed) out.push(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...args, edges } } }));
      return 0;
    }
    const wanted = captureFor(tool, args, cwd);
    if (!wanted) return 0;
    const notices: string[] = [];
    const id = await capture(wanted.kind, wanted, line => notices.push(line));
    err.push(...notices);
    out.push(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...args, capture: id } } }));
    return 0;
  } catch (e) {
    // start_session outside a checkout opens a drawing-only board
    if (!(e instanceof HelperError) || tool === 'start_session') return 0;
    err.push(e.message);
    return 2;
  }
}

/** The capture a call needs, or undefined when there is none the hook can make (drawing, or a call the server refuses anyway). */
function captureFor(tool: string, args: Json, cwd: string): (CaptureOpts & { kind: CaptureKind }) | undefined {
  if (tool === 'start_session') return { kind: 'start', cwd };
  const board = typeof args.board === 'number' || typeof args.board === 'string' ? String(args.board) : '';
  if (!BOARD_RE.test(board)) return undefined;
  if (tool === 'add_code_ref') return typeof args.path === 'string' ? { kind: 'ref', cwd, path: args.path, board } : undefined;
  if (tool === 'create_edge') {
    const path = sourcePath(args.evidence);
    return path === undefined ? undefined : { kind: 'cite', cwd, path, board };
  }
  // mark_checkpoint, arrive: a base not recorded here is named by the server's capture-missing text
  const base = readBase(checkout(cwd).state, board);
  return base === undefined ? undefined : { kind: 'checkpoint', cwd, board, base };
}

/** PostToolUse: start_session records id → baseSha; a checkpoint's citedPaths replace cited/<board>. */
function postToolUse(tool: string, args: Json, response: unknown, cwd: string): void {
  const result = resultJson(response);
  if (!result) return;
  if (tool === 'start_session') {
    const id = typeof result.id === 'number' || typeof result.id === 'string' ? String(result.id) : '';
    if (result.session !== false && BOARD_RE.test(id) && typeof result.baseSha === 'string') writeBase(checkout(cwd).state, id, result.baseSha);
  } else if ((tool === 'mark_checkpoint' || tool === 'arrive') && Array.isArray(result.citedPaths)) {
    const board = String(args.board);
    if (BOARD_RE.test(board)) writeCited(checkout(cwd).state, board, result.citedPaths.filter((p): p is string => typeof p === 'string'));
  }
}

async function hook(out: string[], err: string[]): Promise<number> {
  // The hook never blocks drawing: anything unexpected exits 0 with no output.
  try {
    if (process.platform === 'win32') return 0;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isObject(input) || !isObject(input.tool_input)) return 0;
    const tool = new RegExp(HOOK_MATCHER).exec(String(input.tool_name))?.[3];
    if (!tool) return 0;
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    if (input.hook_event_name === 'PreToolUse') return await preToolUse(tool, input.tool_input, cwd, out, err);
    if (input.hook_event_name === 'PostToolUse') postToolUse(tool, input.tool_input, input.tool_response, cwd);
    return 0;
  } catch {
    out.length = 0;
    err.length = 0;
    return 0;
  }
}

// ---------- main ----------

async function main(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  if (argv[0] === 'hook') return { code: await hook(out, err), out, err };
  if (process.platform === 'win32') return { code: 1, out, err: [say.windows] };
  try {
    if (argv[0] === 'capture') {
      const { kind, opts } = parseCapture(argv.slice(1));
      out.push(await capture(kind, { ...opts, cwd: process.cwd() }, line => err.push(line)));
      return { code: 0, out, err };
    }
    if (argv[0] === 'doctor') return { code: await doctor(process.cwd()), out, err };
    // Long-running: logs go straight to stderr as they happen, not at exit.
    if (argv[0] === 'tap') return { code: await runTap(argv.slice(1), origin(), line => process.stderr.write(`${line}\n`)), out, err };
    if (argv[0] === 'marks') {
      const stop = new AbortController();
      process.once('SIGINT', () => stop.abort());
      process.once('SIGTERM', () => stop.abort());
      return { code: await runMarks(argv.slice(1), origin(), { out, err, signal: stop.signal }), out, err };
    }
    return { code: 1, out, err: [USAGE] };
  } catch (e) {
    return { code: 1, out: [], err: [e instanceof HelperError ? e.message : `redcrayon: ${firstLine(e instanceof Error ? e.message : String(e))}`] };
  }
}

const { code, out, err } = await main(process.argv.slice(2));
// Exit once both streams are flushed: an idle keep-alive socket must not hold the process.
const flush = (stream: NodeJS.WriteStream, lines: string[]) =>
  new Promise<void>(done => stream.write(lines.map(l => `${l}\n`).join(''), () => done()));
await Promise.all([flush(process.stdout, out), flush(process.stderr, err)]);
process.exit(code);
