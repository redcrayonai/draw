// The activity feed: my_activity rows as events, and their wording (spec §3.3).
// Bursts are merged in the module (count + latest payload); this file only
// words them.
import type { ActivityOutbox } from '../module_bindings/types';
import type { ActivityEvent } from './api-types';
import { plural } from './boards';

/** The feed, or the sentence that says why there is none; null while it loads. */
export type ActivityResult = { events: ActivityEvent[] } | { error: string };

/** The part of a feed `keep` accepts, at most `limit` events; errors and loading pass through. */
export function filterFeed(feed: ActivityResult | null, keep: (e: ActivityEvent) => boolean, limit = Infinity): ActivityResult | null {
  return feed && 'events' in feed ? { events: feed.events.filter(keep).slice(0, limit) } : feed;
}

/** A my_activity row as the feed shows it; a payload that is not a JSON object reads as {}. */
export function toEvent(row: ActivityOutbox): ActivityEvent {
  let payload: Record<string, unknown> = {};
  try {
    const value = JSON.parse(row.payload);
    if (value && typeof value === 'object' && !Array.isArray(value)) payload = value;
  } catch {
    // keep {}: one malformed row must not empty the feed
  }
  return {
    id: row.id.toString(),
    boardId: row.boardId.toString(),
    type: row.type,
    actor: row.actor.toHexString(),
    actorName: row.actorName,
    actorKind: row.actorKind === 'agent' ? 'agent' : 'human',
    at: row.at.toDate().toISOString(),
    lastAt: row.lastAt.toDate().toISOString(),
    count: row.count,
    payload,
  };
}

export type Marker = 'square' | 'dashed' | 'round';

/** Canvas glyph convention: agent = dashed, human = square, anything else = round. */
export const marker = (e: { actorKind: string }): Marker =>
  e.actorKind === 'agent' ? 'dashed' : e.actorKind === 'human' ? 'square' : 'round';

/** 'you' for the caller, else the participant name, else kind plus the
 * identity's last 6 hex (human-1a2b3c): every identity starts with 'c200'. */
export function actorLabel(e: ActivityEvent, me: string): string {
  if (me && e.actor === me) return 'you';
  return e.actorName || `${e.actorKind === 'agent' ? 'agent' : 'human'}-${e.actor.slice(-6)}`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const quoted = (v: unknown): string => `“${str(v)}”`;
const edges = (n: number): string => (n === 1 ? 'an edge' : `${n} edges`);
/** An edge's evidence class (module health-rules) as feed words. */
const evidenceWords = (cls: unknown): string =>
  cls === 'none' ? 'no evidence' : cls === 'stale' ? 'stale source' : str(cls);

/** Verb phrase for one (possibly merged) event, naming the board. */
export function phrase(e: ActivityEvent, board: string): string {
  const p = e.payload;
  const n = e.count;
  switch (e.type) {
    case 'board.created':
      return `created ${board}`;
    case 'board.shared':
      return `shared ${board} with a team`;
    case 'board.unshared':
      return `stopped sharing ${board} with a team`;
    case 'board.agent_shared':
      return `shared ${board} with an agent`;
    case 'board.agent_unshared':
      return `stopped sharing ${board} with an agent`;
    case 'board.link_shared':
      return `shared ${board} by link (${p.mode === 'edit' ? 'can edit' : 'view only'})`;
    case 'board.link_unshared':
      return `stopped sharing ${board} by link`;
    case 'board.link_includes': {
      const parts = [p.threats === true ? 'threats' : '', p.code === true ? 'code' : ''].filter(x => x !== '');
      return parts.length === 0 ? `stopped including threats and code in the link to ${board}` : `included ${parts.join(' and ')} in the link to ${board}`;
    }
    case 'session.started':
      return p.repo ? `started a session for ${str(p.repo)} on ${board}` : `started a session on ${board}`;
    case 'session.checkpoint':
      return `checkpoint ${str(p.checkpoint)} on ${board}: ${str(p.onBoard)} of ${str(p.changed)} changed files on the board`;
    case 'node.created':
      return n === 1 ? `added ${quoted(p.label)} to ${board}` : `added ${n} nodes to ${board}`;
    case 'node.deleted':
      return n === 1 ? `deleted ${quoted(p.label)} from ${board}` : `deleted ${n} nodes from ${board}`;
    case 'node.hidden':
      return n === 1 ? `hid ${quoted(p.label)} on ${board}` : `hid ${n} nodes on ${board}`;
    case 'node.unhidden':
      return n === 1 ? `unhid ${quoted(p.label)} on ${board}` : `unhid ${n} nodes on ${board}`;
    case 'edge.created':
      return n === 1
        ? `connected ${quoted(p.from)} → ${quoted(p.to)}${p.evidence ? ` (${evidenceWords(p.evidence)})` : ''} on ${board}`
        : `drew ${n} edges on ${board}`;
    case 'edge.deleted':
      return `deleted ${edges(n)} on ${board}`;
    case 'edge.hidden':
      return `hid ${edges(n)} on ${board}`;
    case 'edge.unhidden':
      return `unhid ${edges(n)} on ${board}`;
    case 'repo.files_added':
      // a merged burst keeps only the latest batch size, so name batches instead of a false total
      return n === 1
        ? `added ${plural(Number(p.added) || 0, 'repo file')} to ${board}`
        : `added repo files to ${board} in ${n} batches`;
    case 'coderef.added':
      return n === 1 ? `linked ${str(p.symbol)} on ${board}` : `linked ${n} code refs on ${board}`;
    case 'coderef.removed':
      return n === 1 ? `removed the code ref to ${str(p.symbol)} from ${board}` : `removed ${n} code refs from ${board}`;
    case 'coderef.status':
      return n === 1 ? `marked ${str(p.symbol)} ${str(p.status)} on ${board}` : `updated ${n} code ref statuses on ${board}`;
    case 'changenote.added':
      return n === 1 ? `flagged ${str(p.title)} on ${board}` : `flagged ${n} changes on ${board}`;
    case 'changenote.removed':
      return n === 1 ? `removed the change note ${str(p.title)} from ${board}` : `removed ${n} change notes from ${board}`;
    case 'changenote.reviewed':
      return n === 1 ? `reviewed ${str(p.title)} on ${board}` : `reviewed ${n} changes on ${board}`;
    // threats are members-only: the feed also reaches link visitors, so it never names one
    case 'threat.added':
      // a burst keeps only the last payload, so a count never claims a stage
      if (n > 1) return `flagged ${n} threats on ${board}`;
      return p.stage === 'compromised' ? `flagged a compromised node on ${board}` : `flagged a threat on ${board}`;
    case 'threat.removed':
      return n === 1 ? `removed a threat from ${board}` : `removed ${n} threats from ${board}`;
    case 'threat.contained':
      return n === 1 ? `contained a threat on ${board}` : `contained ${n} threats on ${board}`;
    default:
      return `${e.type} on ${board}${n > 1 ? ` ×${n}` : ''}`;
  }
}

// A private-use character no board name or payload carries: phrase() words the
// event once and the split falls where the board name went.
const SLOT = '\uE000';

/** phrase() split around the board name, so only the name is a link. */
export function phraseParts(e: ActivityEvent): { before: string; after: string } {
  const s = phrase(e, SLOT);
  const i = s.indexOf(SLOT);
  return { before: s.slice(0, i), after: s.slice(i + SLOT.length) };
}
