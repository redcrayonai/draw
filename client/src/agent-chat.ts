import type { AgentEvent } from './agent-stream';

export type ChatItem =
  | { kind: 'me'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'status'; text: string }
  | { kind: 'error'; text: string };

export type ChatState = { items: ChatItem[]; sending: boolean };

export type ChatAction =
  | { type: 'send'; text: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'ended'; how: 'done' | 'error' | 'dropped' };

export const DROPPED = 'The connection dropped. Send again to continue.';

export const initialChat = (): ChatState => ({ items: [], sending: false });

/** True if any agent text came after my latest message, i.e. in the current reply. */
function hasReplyText(items: ChatItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'me') return false;
    if (items[i].kind === 'agent') return true;
  }
  return false;
}

/** Deltas extend the newest item only if it is agent text, so status lines stay in order. */
function appendAgent(items: ChatItem[], text: string): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.kind === 'agent') return [...items.slice(0, -1), { kind: 'agent', text: last.text + text }];
  return [...items, { kind: 'agent', text }];
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'send':
      return { items: [...state.items, { kind: 'me', text: action.text }], sending: true };
    case 'event': {
      const e = action.event;
      switch (e.type) {
        case 'delta':
          return e.text ? { ...state, items: appendAgent(state.items, e.text) } : state;
        case 'status':
          return { ...state, items: [...state.items, { kind: 'status', text: e.message }] };
        case 'error':
          return { ...state, items: [...state.items, { kind: 'error', text: e.message }] };
        case 'done':
          // The final text is a fallback for replies that streamed no deltas.
          return e.text && !hasReplyText(state.items)
            ? { ...state, items: [...state.items, { kind: 'agent', text: e.text }] }
            : state;
      }
      // a type this panel does not know changes nothing (and must not fall through to 'ended')
      return state;
    }
    case 'ended':
      return {
        items: action.how === 'dropped' ? [...state.items, { kind: 'error', text: DROPPED }] : state.items,
        sending: false,
      };
  }
}
