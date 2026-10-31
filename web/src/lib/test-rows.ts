// Test-only row builders with the real MyBoard / AgentLinkRow / ActivityEvent
// shapes. Nothing in the app imports this file; no fixture number ever
// reaches the dashboard.
import { Identity, Timestamp } from 'spacetimedb';
import type { AgentGrantRow, AgentLinkRow, MyBoard } from '../module_bindings/types';
import type { ActivityEvent } from './api-types';

/** A timestamp `msAgo` milliseconds before now. */
export const at = (msAgo: number): Timestamp => new Timestamp(BigInt(Date.now() - msAgo) * 1000n);

export function myBoard(over: Partial<MyBoard> = {}): MyBoard {
  return {
    boardId: 1n,
    name: 'board',
    access: 'owner',
    orgId: '',
    sharedWith: [],
    statsReady: true,
    createdAt: at(86_400_000),
    updatedAt: at(4 * 60_000),
    nodes: 0,
    shownNodes: 0,
    edges: 0,
    shownEdges: 0,
    evImport: 0,
    evSource: 0,
    evStale: 0,
    evTest: 0,
    evHuman: 0,
    evNone: 0,
    refsOk: 0,
    refsStale: 0,
    refsAmbiguous: 0,
    repoFiles: 0,
    isSession: false,
    sessionCheckpoint: 0,
    sessionUpdatedAt: Timestamp.UNIX_EPOCH,
    covChanged: 0,
    covOnBoard: 0,
    covExcluded: 0,
    covUncovered: 0,
    covDeleted: 0,
    linkMode: '',
    linkToken: '',
    ...over,
  };
}

/** The seeded Demo board's acceptance stats (spec §1.3). */
export const DEMO = myBoard({
  boardId: 1n,
  name: 'Demo',
  access: 'public',
  updatedAt: at(3_600_000),
  nodes: 9,
  shownNodes: 8,
  edges: 6,
  shownEdges: 5,
  evImport: 1,
  evSource: 1,
  evTest: 1,
  evHuman: 1,
  evNone: 1,
  repoFiles: 6,
});

export const agentLink = (agentHex: string, ownerHex: string): AgentLinkRow => ({
  agent: new Identity(agentHex),
  owner: new Identity(ownerHex),
  linkedAt: at(3_600_000),
});

export const agentGrantRow = (id: bigint, boardId: bigint, agentHex: string): AgentGrantRow => ({
  id,
  boardId,
  agent: new Identity(agentHex),
});

export function activityEvent(over: Partial<ActivityEvent> = {}): ActivityEvent {
  const fourMinutesAgo = new Date(Date.now() - 4 * 60_000).toISOString();
  return {
    id: '1',
    boardId: '7',
    type: 'node.created',
    actor: 'ab'.repeat(32),
    actorName: 'maya',
    actorKind: 'human',
    at: fourMinutesAgo,
    lastAt: fourMinutesAgo,
    count: 1,
    payload: { label: 'API Gateway', kind: 'service' },
    ...over,
  };
}

/** A board's 20-hex link id (my_board_slugs) in the fixtures. */
export const slugOf = (id: bigint): string => id.toString(16).padStart(20, '0');
