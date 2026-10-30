// Pure view-model helpers over my_boards rows (spec §3.3). Every number the
// dashboard shows is derived here from real rows; there are no fixtures.
import type { Timestamp } from 'spacetimedb';
import type { AgentGrantRow, AgentLinkRow, MyBoard } from '../module_bindings/types';
import { boardHref } from '$shared/board-link';
import { identityFromClaims } from '$shared/identity';
import { shareHref } from '$shared/share-link';
import type { Team } from './api-types';
import { config } from './config';

export type { AgentGrantRow, AgentLinkRow, MyBoard };
export type CardState = 'session' | 'linked' | 'sketch';
export type Sort = 'recent' | 'name';
export type Facet = { key: string; label: string; count: number };
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** An identity as people tell them apart: every one starts with c200, so show the last 8 hex. */
export const idTail = (hex: string): string => `…${hex.slice(-8)}`;

export const cardState = (b: MyBoard): CardState =>
  b.isSession ? 'session' : b.repoFiles > 0 ? 'linked' : 'sketch';

/** The epoch stands for "unknown" (legacy boards, stats not computed). */
export const isEpoch = (t: Timestamp): boolean => t.microsSinceUnixEpoch === 0n;

export function ago(d: Date, now = Date.now()): string {
  const m = Math.floor(Math.max(0, now - d.getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** Canvas deep link: the board's #b=<slug> (my_board_slugs). `db` is forwarded unless it is this deployment's own. */
export const canvasHref = (slug: string, db = config.spacetimeDb, base = config.canvasUrl): string =>
  boardHref({ app: base, slug, db, home: import.meta.env.VITE_SPACETIME_DB });

/** Anyone-with-the-link URL on the canvas. `db` is forwarded unless it is this deployment's own, like canvasHref. */
export const shareLink = (token: string, db = config.spacetimeDb, base = config.canvasUrl): string =>
  shareHref(base, db, token, import.meta.env.VITE_SPACETIME_DB);

/** In-app link that keeps a ?db= override, so a reload stays on the same database. */
export const appHref = (path: string, db = config.spacetimeDb): string =>
  db === import.meta.env.VITE_SPACETIME_DB ? path : `${path}${path.includes('?') ? '&' : '?'}db=${encodeURIComponent(db)}`;

export const teamName = (orgId: string, teams: Team[]): string =>
  teams.find((t) => t.id === orgId)?.name ?? 'team';

/** Badge text: owner / the team's name / agent / public / can edit / view only. */
export const accessLabel = (b: MyBoard, teams: Team[]): string =>
  b.access === 'team' ? teamName(b.orgId, teams)
  : b.access === 'link' ? (b.linkMode === 'edit' ? 'can edit' : 'view only')
  : b.access;

/** Facet keys: 'all', 'owner', 'team:<orgId>', 'link', 'agent', 'public'. */
export function matchesFacet(b: MyBoard, key: string): boolean {
  if (key === 'all') return true;
  if (key.startsWith('team:')) return b.access === 'team' && b.orgId === key.slice(5);
  return b.access === key;
}

const FACET_LABELS: Record<string, string> = { all: 'All', owner: 'Mine', link: 'Shared with you', agent: 'Agents', public: 'Public' };

/** All, then each access kind (and each team) that has at least one board. */
export function accessFacets(boards: MyBoard[], teams: Team[]): Facet[] {
  const orgs = [...new Set(boards.filter((b) => b.access === 'team').map((b) => b.orgId))];
  return ['all', 'owner', ...orgs.map((o) => `team:${o}`), 'link', 'agent', 'public']
    .map((key) => ({
      key,
      label: FACET_LABELS[key] ?? teamName(key.slice(5), teams),
      count: boards.filter((b) => matchesFacet(b, key)).length,
    }))
    .filter((f) => f.key === 'all' || f.count > 0);
}

export function filterBoards(boards: MyBoard[], query: string, facet = 'all'): MyBoard[] {
  const q = query.trim().toLowerCase();
  return boards.filter((b) => matchesFacet(b, facet) && (q === '' || b.name.toLowerCase().includes(q)));
}

const desc = (a: bigint, b: bigint): number => (a < b ? 1 : a > b ? -1 : 0);

/** recent = updatedAt desc (ties: newest id first); name = A→Z. Never mutates. */
export function sortBoards(boards: MyBoard[], sort: Sort): MyBoard[] {
  return [...boards].sort(
    sort === 'name'
      ? (a, b) => a.name.localeCompare(b.name)
      : (a, b) =>
          desc(a.updatedAt.microsSinceUnixEpoch, b.updatedAt.microsSinceUnixEpoch) || desc(a.boardId, b.boardId)
  );
}

/** Links the caller owns. my_agent_links also returns the caller's own link
 * when the caller is an agent; that one is not "an agent I linked". */
export const linkedAgents = (links: AgentLinkRow[], meHex: string): AgentLinkRow[] =>
  links.filter((l) => l.owner.toHexString() === meHex);

/** Whether `agentHex` is the MCP server's agent for `userId` (mcp/src/tools.ts hostedPair): it links itself again on its next call. */
export const isHostedAgent = (agentHex: string, mcpUrl: string | undefined, userId: string | undefined): boolean =>
  !!mcpUrl && !!userId && agentHex === identityFromClaims(`${new URL(mcpUrl).origin}/agent-id`, `agent:${userId}`);

/** Hex ids of the agents that hold a grant on `boardId`. */
export const grantedAgents = (grants: AgentGrantRow[], boardId: bigint): string[] =>
  grants.filter((g) => g.boardId === boardId).map((g) => g.agent.toHexString());
