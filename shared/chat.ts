/** The board speaks this protocol; execution adapters translate their own harness events. */
export type ChatState = 'idle' | 'working' | 'stopping' | 'stopped';
export const CHAT_PERSON_MAX_CHARS = 32000;
export const CHAT_PERSON_MAX_BYTES = 64 * 1024;
export const CHAT_VIEWER_TTL_MS = 90_000;

export interface ChatSession {
  /** Stable across reconnects, distinct from the board and checkout. */
  id: string;
  agent: string;
  name: string;
  capabilities: { stop: 'interrupt' | 'step' | 'none'; approvals: boolean };
}

export type ChatEvent =
  | { type: 'state'; state: ChatState }
  | { type: 'text'; message: string; delta: string; final: boolean }
  | { type: 'user'; id: string; text: string; origin?: string }
  | { type: 'tool'; id: string; phase: 'start' | 'done'; summary?: string }
  | { type: 'notice'; text: string; tone?: 'attention' }
  | { type: 'approval'; id: string; summary: string; status: 'pending' | 'resolved' };

export type ApprovalDecision = 'accept' | 'decline';
