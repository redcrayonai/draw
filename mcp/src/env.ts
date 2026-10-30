import { boardHref } from '../../shared/board-link';

/**
 * The Worker's bindings and settings (spec §9), and the origins every exact
 * string is built from. MCP_ORIGIN, APP_ORIGIN and OIDC_ISSUER carry the
 * domain, so moving domains is a config change.
 */
export interface Env {
  /** e.g. https://mcp.example.com; the OAuth resource is `${MCP_ORIGIN}/mcp` */
  MCP_ORIGIN: string;
  /** the canvas, e.g. https://app.example.com; board links and the icon live there */
  APP_ORIGIN: string;
  /**
   * The identity provider that signs users in, exactly as the `iss` of its
   * tokens. Owner identities are blake3(OIDC_ISSUER|sub), so it must match the
   * issuer the browser signs in with.
   */
  OIDC_ISSUER: string;
  /**
   * `<sha256 hex of key>:<user id>` pairs, comma-separated: static keys (the canary, e2e, self-hosters).
   * The user id is the person's `sub` at OIDC_ISSUER: the key's agent is linked to blake3(OIDC_ISSUER|user id).
   */
  MCP_API_KEYS?: string;
  DB_URL: string;
  DB_NAME: string;
  /** private ES256 JWK with its kid; _NEXT is published but never signs, _PREV is published until dropped */
  AGENT_JWK: string;
  AGENT_JWK_NEXT?: string;
  AGENT_JWK_PREV?: string;
  /** '1': every request on localhost is user_dev (local dev only) */
  DEV_AUTH?: string;
  /** 12-character git sha, set at deploy */
  VERSION?: string;
  USER: DurableObjectNamespace;
  /** 120 tool calls a minute per user */
  CALLS_RL?: RateLimit;
  /** 60 unauthenticated requests a minute per IP; 600 for Anthropic's egress range */
  IP_RL?: RateLimit;
  ANTHROPIC_RL?: RateLimit;
  /** 120 capture uploads a minute per IP: one per cited edge or code ref, and the skill sends a pass at once */
  FACTS_RL?: RateLimit;
  CAPTURE: DurableObjectNamespace;
  /** One per board: the live tap channel. Optional so tests without it get 503 on /live. */
  LIVE?: DurableObjectNamespace;
  CALLS?: AnalyticsEngineDataset;
}

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface AnalyticsEngineDataset {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

/** The strings every surface is built from, derived once per request. */
export function origins(env: Env) {
  const mcp = env.MCP_ORIGIN.replace(/\/$/, '');
  const app = env.APP_ORIGIN.replace(/\/$/, '');
  return {
    mcp,
    app,
    host: new URL(mcp).host,
    // mcp.<domain> or mcp-staging.<domain> -> support@<domain> (spec D21)
    support: `support@${new URL(mcp).hostname.replace(/^mcp(-staging)?\./, '')}`,
    resource: `${mcp}/mcp`,
    resourceMetadata: `${mcp}/.well-known/oauth-protected-resource/mcp`,
    issuer: `${mcp}/agent-id`,
    // byte-exact: the database hashes the token's iss as it is, so a trailing slash is part of every identity
    idp: env.OIDC_ISSUER,
    // The board's link as the canvas shows it: #b=<slug> (shared/board-link.ts).
    boardUrl: (slug: string) => boardHref({ app, slug, db: env.DB_NAME, home: env.DB_NAME }),
    icon: `${app}/icon.svg`,
  };
}

export type Origins = ReturnType<typeof origins>;

export const version = (env: Env) => (env.VERSION ?? 'dev').slice(0, 12);
