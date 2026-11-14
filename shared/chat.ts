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
  /** `reset`: the person can start the conversation over ("New chat"). `end`: they can end
   *  board chat from the board; the agent goes on in its own conversation ("End chat"). */
  capabilities: { stop: 'interrupt' | 'step' | 'none'; approvals: boolean; reset?: boolean; end?: boolean };
}

export type ChatEvent =
  | { type: 'state'; state: ChatState }
  | { type: 'text'; message: string; delta: string; final: boolean }
  | { type: 'user'; id: string; text: string; origin?: string }
  | { type: 'tool'; id: string; phase: 'start' | 'done'; summary?: string }
  | { type: 'notice'; text: string; tone?: 'attention' }
  | { type: 'approval'; id: string; summary: string; status: 'pending' | 'resolved' };

export type ApprovalDecision = 'accept' | 'decline';

/**
 * What the board draws in an agent's reply (client/src/agent-chat.ts RichText), in words for the agent.
 * Hosted chat only: the local board prints replies as plain text.
 */
export const CHAT_REPLY_GUIDE =
  'In a reply to a "Board chat:" message the board draws three things. ' +
  'A node\'s exact label in backticks becomes a link to that node. ' +
  'A fenced block that opens with ```chart <type> <title> and holds CSV becomes a chart the person can pin to the board: <type> and the CSV columns are the ones create_chart takes (bars, toplist, pie, timeseries, table and the rest). ' +
  'A fenced block that opens with ```choices and holds one short answer per line, six at most, becomes buttons that send that answer. ' +
  'Use them only where they help, and only in such replies: anywhere else they read as code.';
