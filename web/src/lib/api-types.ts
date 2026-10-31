// web/src/lib/api-types.ts
export interface ActivityEvent {
  id: string;            // outbox row id
  boardId: string;       // decimal u64
  type: string;          // e.g. 'node.created'
  actor: string;         // identity hex (no 0x)
  actorName: string;
  actorKind: 'human' | 'agent';
  at: string;            // ISO, first event of the burst
  lastAt: string;        // ISO, last event of the burst
  count: number;         // burst size
  payload: Record<string, unknown>;
}
export interface ActivityResponse { events: ActivityEvent[] }
export interface ApiError { error: string }

/** Legacy organization labels used when displaying older board shares. */
export type Team = { id: string; name: string; role: string };
