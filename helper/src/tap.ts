/**
 * redcrayon tap: OTLP/HTTP traces in on 127.0.0.1, per-edge summaries out to
 * the board's live channel, only while someone on the board has Live on.
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Aggregator, type TapMapping } from './tap-agg';
import { decodeJson, decodeProtobuf } from './tap-otlp';
import { HelperError } from './capture';

export const TAP_USAGE =
  'redcrayon: usage: redcrayon tap --token <token from start_tap> [--service <service.name>=<node id>]… [--port 4318] [--map .redcrayon/tap.json] (REDCRAYON_TAP_TOKEN may stand in for --token)';
const MAX_BODY = 8 * 1024 * 1024;

export interface TapArgs {
  token: string;
  port: number;
  map: string;
  /** --service flags (service.name -> node id), applied over the mapping file. */
  services: Record<string, string>;
}

/** The token may come from REDCRAYON_TAP_TOKEN, so it stays out of argv (other users of a host can read argv). */
export function parseTap(argv: string[], env: Record<string, string | undefined> = process.env): TapArgs {
  const out: TapArgs = { token: env.REDCRAYON_TAP_TOKEN ?? '', port: 4318, map: join('.redcrayon', 'tap.json'), services: {} };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--token' && v) (out.token = v), i++;
    else if (argv[i] === '--port' && v && /^\d{1,5}$/.test(v)) (out.port = Number(v)), i++;
    else if (argv[i] === '--map' && v) (out.map = v), i++;
    else if (argv[i] === '--service' && v && /^.+=\d{1,20}$/.test(v)) {
      // The node id is digits, so the last = splits even a service name that holds one.
      const at = v.lastIndexOf('=');
      out.services[v.slice(0, at)] = v.slice(at + 1);
      i++;
    } else throw new HelperError(TAP_USAGE);
  }
  if (!out.token) throw new HelperError(TAP_USAGE);
  return out;
}

/** The board a start_tap token is for (read, not verified: the channel verifies it). */
export function boardOfToken(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { board?: unknown };
    if (typeof payload.board === 'string' && /^\d{1,20}$/.test(payload.board)) return payload.board;
  } catch {
    // fall through
  }
  throw new HelperError('redcrayon: that is not a tap token. Ask your agent to call start_tap again.');
}

/**
 * A mapping file read on change: services -> node ids; a broken edit keeps the last good mapping.
 * `flags` (--service) win over the file, and with flags no file is needed.
 */
export function mappingFile(path: string, board: string, log: (line: string) => void, flags: Record<string, string> = {}): () => TapMapping {
  let mtime = -1;
  let current: TapMapping = { board, services: { ...flags } };
  let warned = Object.keys(flags).length > 0;
  return () => {
    let m: number;
    try {
      m = statSync(path).mtimeMs;
    } catch {
      if (!warned) log(`redcrayon tap: no ${path} yet; every service counts as unmapped until your agent writes it.`);
      warned = true;
      return current;
    }
    if (m === mtime) return current;
    mtime = m;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { board?: unknown; services?: unknown };
      const services: Record<string, string> = {};
      if (raw.services && typeof raw.services === 'object') {
        for (const [k, v] of Object.entries(raw.services as Record<string, unknown>)) if (typeof v === 'string' && /^\d{1,20}$/.test(v)) services[k] = v;
      }
      if (raw.board !== undefined && String(raw.board) !== board) log(`redcrayon tap: ${path} names board ${String(raw.board)}, but the token is for board ${board}; using ${board}.`);
      current = { board, services: { ...services, ...flags } };
      log(`redcrayon tap: mapping ${Object.keys(current.services).length} service(s) from ${path}${Object.keys(flags).length > 0 ? ' and --service' : ''}.`);
    } catch {
      log(`redcrayon tap: ${path} is not valid JSON; keeping the previous mapping.`);
    }
    return current;
  };
}

/** The subset of WebSocket the tap uses, so tests can drive it. */
export interface TapSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'message' | 'error', fn: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
}

export interface TapDeps {
  connect(url: string): TapSocket;
  log(line: string): void;
  now(): number;
}

const OPEN = 1;

/** The tap's moving parts, without timers or process handling (runTap adds those). */
export function createTap(args: TapArgs, channelOrigin: string, deps: TapDeps) {
  const board = boardOfToken(args.token);
  const mapping = mappingFile(args.map, board, deps.log, args.services);
  const agg = new Aggregator(mapping, deps.now);
  let socket: TapSocket | null = null;
  let watching = false;
  let fatal: string | null = null;
  let backoff = 1000;
  let retryAt = 0;
  let stopped = false;

  const url = `${channelOrigin.replace(/^http/, 'ws')}/live/${board}`;

  function connect(): void {
    if (stopped || fatal) return;
    const ws = deps.connect(url);
    socket = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ auth: args.token, role: 'tap' }));
    });
    ws.addEventListener('message', ev => {
      let msg: { ok?: boolean; watching?: boolean };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.ok) {
        backoff = 1000;
        deps.log(`redcrayon tap: connected to board ${board}. Waiting for someone to press Live.`);
      }
      if (typeof msg.watching === 'boolean' && msg.watching !== watching) {
        watching = msg.watching;
        deps.log(watching ? 'redcrayon tap: someone is watching; sending live summaries.' : 'redcrayon tap: nobody is watching; paused.');
      }
    });
    ws.addEventListener('close', ev => {
      if (socket === ws) socket = null;
      watching = false;
      // 4001 auth, 4009 another tap, 4008 abuse: retrying would only fail again.
      if (ev.code === 4001 || ev.code === 4009 || ev.code === 4008) {
        fatal = `redcrayon tap: ${ev.reason || 'the board refused this tap'}`;
        deps.log(fatal);
        return;
      }
      if (stopped) return;
      retryAt = deps.now() + backoff;
      deps.log(`redcrayon tap: lost the board's live channel; retrying in ${Math.round(backoff / 1000)} s.`);
      backoff = Math.min(backoff * 2, 30_000);
    });
    ws.addEventListener('error', () => {
      // a close event follows
    });
  }

  async function receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/traces') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(c as Buffer);
    }
    let body = Buffer.concat(chunks);
    const type = String(req.headers['content-type'] ?? '');
    try {
      if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
      agg.add(type.includes('json') ? decodeJson(JSON.parse(body.toString('utf8'))) : decodeProtobuf(new Uint8Array(body)));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (type.includes('json')) res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    else res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
  }

  const server: Server = createServer((req, res) => {
    receive(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  let lastHint = deps.now();

  return {
    board,
    server,
    /** One second's work: reconnect if due, then send the window if anyone is watching. */
    tick(): void {
      if (fatal || stopped) return;
      if (!socket && deps.now() >= retryAt) connect();
      const w = agg.flush();
      if (w && watching && socket?.readyState === OPEN) socket.send(JSON.stringify(w));
      if (deps.now() - lastHint >= 60_000) {
        lastHint = deps.now();
        if (agg.unmappedServices.size > 0) {
          deps.log(`redcrayon tap: unmapped services: ${[...agg.unmappedServices].sort().join(', ')}. Add them to ${args.map} or pass --service <name>=<node id>.`);
          agg.unmappedServices.clear();
        }
      }
    },
    fatal: () => fatal,
    watching: () => watching,
    stop(): void {
      stopped = true;
      socket?.close();
      server.close();
    },
  };
}

/** Run until Ctrl-C (exit 0) or until the board refuses the tap (exit 1). */
export async function runTap(argv: string[], origin: string, log: (line: string) => void): Promise<number> {
  const args = parseTap(argv);
  const WS = (globalThis as { WebSocket?: new (url: string) => TapSocket }).WebSocket;
  if (!WS) throw new HelperError(`redcrayon: tap needs Node 22 or later (this is ${process.version}).`);
  const tap = createTap(args, origin, { connect: url => new WS(url), log, now: Date.now });
  await new Promise<void>((resolve, reject) => {
    tap.server.once('error', (e: NodeJS.ErrnoException) =>
      reject(new HelperError(e.code === 'EADDRINUSE' ? `redcrayon: port ${args.port} is in use; pass --port <n> and point your exporter there.` : `redcrayon: ${e.message}`))
    );
    tap.server.listen(args.port, '127.0.0.1', () => resolve());
  });
  log(`redcrayon tap: listening for OTLP/HTTP traces on http://127.0.0.1:${args.port} (export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${args.port} OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf).`);
  log('redcrayon tap: span attributes are dropped here; only per-edge counts, latencies and errors leave this machine, and only while someone watches.');
  tap.tick();
  return new Promise<number>(resolve => {
    const timer = setInterval(() => {
      tap.tick();
      if (tap.fatal()) {
        clearInterval(timer);
        tap.stop();
        resolve(1);
      }
    }, 1000);
    const quit = () => {
      clearInterval(timer);
      tap.stop();
      resolve(0);
    };
    process.once('SIGINT', quit);
    process.once('SIGTERM', quit);
  });
}
