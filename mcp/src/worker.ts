/**
 * The mcp Worker's entry: app.ts with the open token verifiers (MCP_API_KEYS,
 * then a JWT from OIDC_ISSUER), and the Durable Objects: USER (one per
 * account: metering and the create window) and CAPTURE.
 */
import { DurableObject, tracing } from 'cloudflare:workers';
import { anyOf, apiKeys, oidc } from './auth';
import { createWorker } from './app';
import type { Env } from './env';
import { UserLedger } from './user';
import { CAPTURE_TTL_MS, CaptureVault } from './captures';
import { verifyTap } from './issuer';
import { AUTH_MS, LiveHub, type Attachment, type LiveSocket, type LiveStatus } from './live';
import { dbHttp } from '../../shared/db-http';

export class User extends DurableObject<Env> {
  private readonly ledger = new UserLedger(this.ctx.storage);

  charge(month: string, limit: number) {
    return this.ledger.charge(month, limit);
  }

  claim(key: string) {
    return this.ledger.claim(key);
  }

  settle(key: string, text: string | null) {
    return this.ledger.settle(key, text);
  }

  /** The canary's one flag: did the last cron run fail (so the next good one logs a recovery)? */
  async failing(value?: boolean): Promise<boolean> {
    if (value !== undefined) await this.ctx.storage.put('failing', value);
    return (await this.ctx.storage.get<boolean>('failing')) ?? false;
  }
}

/**
 * One capture (spec §5 Store): chunked SQL rows (P0.8: production stores at
 * most 2 MB per value), deleted by an alarm 10 minutes after upload, and taken
 * at most once. sql.exec is synchronous, so a claim cannot interleave with
 * another (P0.8: 20 parallel claims, exactly 1 success).
 */
export class Capture extends DurableObject<Env> {
  private readonly vault = new CaptureVault({
    write: (chunks, created) => {
      const sql = this.ctx.storage.sql;
      sql.exec('CREATE TABLE IF NOT EXISTS chunk (i INTEGER PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL)');
      sql.exec('DELETE FROM chunk');
      chunks.forEach((data, i) => sql.exec('INSERT INTO chunk (i, data, created) VALUES (?, ?, ?)', i, data, created));
    },
    take: () => {
      const sql = this.ctx.storage.sql;
      sql.exec('CREATE TABLE IF NOT EXISTS chunk (i INTEGER PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL)');
      const rows = sql.exec<{ data: string; created: number }>('SELECT data, created FROM chunk ORDER BY i').toArray();
      sql.exec('DELETE FROM chunk');
      return rows.length === 0 ? undefined : { chunks: rows.map(r => r.data), created: rows[0].created };
    },
  });

  async put(text: string): Promise<void> {
    this.vault.put(text);
    await this.ctx.storage.setAlarm(Date.now() + CAPTURE_TTL_MS);
  }

  async take(): Promise<string | undefined> {
    return this.vault.take();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/** Whether a canvas token can read the board: its own visible_board view, read as that token. */
async function canReadBoard(env: Env, token: string, board: bigint): Promise<boolean> {
  try {
    const rows = await dbHttp(env.DB_URL, env.DB_NAME).sqlAs(token, `SELECT id FROM visible_board WHERE id = ${board}`, AbortSignal.timeout(10_000));
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * One board's live tap channel: hibernatable WebSockets adapted to LiveHub
 * (live.ts). Nothing is stored; attachments carry each socket's role.
 */
export class Live extends DurableObject<Env> {
  private readonly wrappers = new WeakMap<WebSocket, LiveSocket>();
  private readonly hub = new LiveHub(
    {
      verifyTap: token => verifyTap(this.env, token),
      canRead: (token, board) => canReadBoard(this.env, token, board),
      now: () => Date.now(),
    },
    () => this.ctx.getWebSockets().map(ws => this.wrap(ws))
  );

  private wrap(ws: WebSocket): LiveSocket {
    let w = this.wrappers.get(ws);
    if (!w) {
      w = {
        send: data => {
          try {
            ws.send(data);
          } catch {
            // closing: the close handler tidies up
          }
        },
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            // already closed
          }
        },
        attachment: () => (ws.deserializeAttachment() as Attachment | null) ?? null,
        setAttachment: a => ws.serializeAttachment(a),
      };
      this.wrappers.set(ws, w);
    }
    return w;
  }

  async fetch(request: Request): Promise<Response> {
    const board = request.headers.get('x-live-board');
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !board) return new Response(null, { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: 'pending', board, at: Date.now() } satisfies Attachment);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + AUTH_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** tap_status, by RPC from the tools: reads the sockets, changes nothing. */
  async status(): Promise<LiveStatus> {
    return this.hub.status();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.hub.message(this.wrap(ws), typeof message === 'string' ? message : new TextDecoder().decode(message));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.hub.closed(this.wrap(ws));
    this.wrap(ws).close(code === 1005 ? 1000 : code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.hub.closed(this.wrap(ws));
  }

  async alarm(): Promise<void> {
    if (this.hub.sweep()) await this.ctx.storage.setAlarm(Date.now() + AUTH_MS);
  }
}

export default createWorker({ verifyBearer: env => anyOf(apiKeys(env), oidc(env)), tracing });
