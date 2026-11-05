/** One thing a hosted agent says while replying. */
export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'status'; message: string }
  | { type: 'done'; text?: string }
  | { type: 'error'; code: string; message: string };

export type ChatBody = {
  message: string;
  conversationId: string;
  messageId: string;
  boardLink: string;
  focus?: { nodeId: string; label?: string };
};

const str = (v: unknown): v is string => typeof v === 'string';

/** The event for `type` and its JSON payload, or undefined if a field is missing or of the wrong type. */
function toEvent(type: string, p: Record<string, unknown>): AgentEvent | undefined {
  switch (type) {
    case 'delta': return str(p.text) ? { type, text: p.text } : undefined;
    case 'status': return str(p.message) ? { type, message: p.message } : undefined;
    case 'done':
      if (p.text === undefined) return { type };
      return str(p.text) ? { type, text: p.text } : undefined;
    case 'error': return str(p.code) && str(p.message) ? { type, code: p.code, message: p.message } : undefined;
    default: return undefined;
  }
}

/** Reads server-sent events: `event: <type>` and `data: <JSON>` lines, ended by a blank line.
 *  The JSON is the event without its `type`. Unknown types, bad JSON and events with
 *  missing or mistyped fields are skipped. */
export function createSseParser(onEvent: (e: AgentEvent) => void): { push(chunk: string): void } {
  let buffer = '';

  const dispatch = (block: string) => {
    let type = '';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch { return; /* a malformed event is not worth ending the reply for */ }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const event = toEvent(type, payload as Record<string, unknown>);
    if (event) onEvent(event);
  };

  return {
    push(chunk) {
      // A CRLF can straddle two chunks, so normalise only once the text is joined.
      buffer = (buffer + chunk).replace(/\r\n/g, '\n');
      if (buffer.endsWith('\r')) return; // wait for its \n
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        dispatch(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    },
  };
}

async function failure(res: Response): Promise<AgentEvent> {
  try {
    const { error } = await res.json();
    if (typeof error?.code === 'string' && typeof error?.message === 'string') {
      return { type: 'error', code: error.code, message: error.message };
    }
  } catch { /* no usable body */ }
  if (res.status === 401) return { type: 'error', code: 'unauthorized', message: 'Sign in to use the agent.' };
  return { type: 'error', code: 'http_error', message: `The agent could not be reached (${res.status}).` };
}

/** Sends one chat message to the agent endpoint and streams its reply to `onEvent`.
 *  Resolves 'done' or 'error' when the agent says so, or 'dropped' if the stream ends
 *  (or the connection fails or is aborted) before either. */
export async function streamChat(opts: {
  url: string;
  token: string | null;
  body: ChatBody;
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  fetchImpl?: typeof fetch;
}): Promise<'done' | 'error' | 'dropped'> {
  const { url, token, body, signal, onEvent, fetchImpl = fetch } = opts;
  let outcome: 'done' | 'error' | 'dropped' = 'dropped';
  const parser = createSseParser(e => {
    if (e.type === 'done') outcome = 'done';
    else if (e.type === 'error') outcome = 'error';
    onEvent(e);
  });

  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      onEvent(await failure(res));
      return 'error';
    }
    if (!res.body) return 'dropped';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
  } catch { /* a failed or aborted connection is a dropped reply */ }
  return outcome;
}
