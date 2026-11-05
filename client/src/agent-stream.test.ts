import { describe, it, expect } from 'vitest';
import { createSseParser, streamChat, type AgentEvent, type ChatBody } from './agent-stream';

const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

function collect() {
  const events: AgentEvent[] = [];
  return { events, parser: createSseParser(e => events.push(e)) };
}

const body: ChatBody = { message: 'hi', conversationId: 'c1', messageId: 'm1', boardLink: 'https://x/#b=abc' };

/** A fetch that answers with the given chunks as a streamed 200 response. */
function streamOf(chunks: string[], init: ResponseInit = { status: 200 }): typeof fetch {
  const enc = new TextEncoder();
  return (async () => new Response(new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  }), init)) as typeof fetch;
}

describe('createSseParser', () => {
  it('parses each event type', () => {
    const { events, parser } = collect();
    parser.push(frame('delta', { text: 'Hi' }) + frame('status', { message: 'Thinking' })
      + frame('done', { text: 'Hi there' }) + frame('done', {})
      + frame('error', { code: 'busy', message: 'Try later' }));
    expect(events).toEqual([
      { type: 'delta', text: 'Hi' },
      { type: 'status', message: 'Thinking' },
      { type: 'done', text: 'Hi there' },
      { type: 'done' },
      { type: 'error', code: 'busy', message: 'Try later' },
    ]);
  });

  it('parses events split across chunks', () => {
    const { events, parser } = collect();
    const wire = frame('delta', { text: 'Hi' }) + frame('delta', { text: 'yo' });
    const cut = wire.indexOf('"text"') + 3; // mid-data
    const blank = wire.indexOf('\n\n') + 1; // mid-blank-line
    parser.push(wire.slice(0, cut));
    parser.push(wire.slice(cut, blank));
    parser.push(wire.slice(blank));
    expect(events).toEqual([{ type: 'delta', text: 'Hi' }, { type: 'delta', text: 'yo' }]);

    const crlf = collect();
    crlf.parser.push(wire.replace(/\n/g, '\r\n'));
    expect(crlf.events).toEqual(events);
  });

  it('ignores unknown event types and malformed data', () => {
    const { events, parser } = collect();
    parser.push(frame('ping', { n: 1 }) + 'event: delta\ndata: {nope\n\n' + frame('delta', { text: 'ok' }));
    expect(events).toEqual([{ type: 'delta', text: 'ok' }]);
  });
});

describe('streamChat', () => {
  it('posts JSON with the bearer token to <url>/chat', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return streamOf([frame('done', {})])(url, init);
    }) as typeof fetch;
    const result = await streamChat({ url: 'https://agent.example', token: 'tok', body, onEvent: () => {}, fetchImpl });
    expect(result).toBe('done');
    expect(seen!.url).toBe('https://agent.example/chat');
    expect(seen!.init.method).toBe('POST');
    expect(seen!.init.headers).toMatchObject({ 'Content-Type': 'application/json', Authorization: 'Bearer tok' });
    expect(JSON.parse(seen!.init.body as string)).toEqual(body);
  });

  it('omits Authorization without a token', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return streamOf([])(_u, init);
    }) as typeof fetch;
    await streamChat({ url: 'https://agent.example/', token: null, body, onEvent: () => {}, fetchImpl });
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('a 401 becomes an unauthorized error', async () => {
    const events: AgentEvent[] = [];
    const fetchImpl = (async () => new Response('', { status: 401 })) as typeof fetch;
    const result = await streamChat({ url: 'https://agent.example', token: null, body, onEvent: e => events.push(e), fetchImpl });
    expect(result).toBe('error');
    expect(events).toEqual([{ type: 'error', code: 'unauthorized', message: 'Sign in to use the agent.' }]);
  });

  it('a non-2xx JSON body becomes one error event', async () => {
    const events: AgentEvent[] = [];
    const fetchImpl = (async () => new Response(
      JSON.stringify({ error: { code: 'busy', message: 'Slow down' } }), { status: 429 })) as typeof fetch;
    const result = await streamChat({ url: 'https://agent.example', token: 't', body, onEvent: e => events.push(e), fetchImpl });
    expect(result).toBe('error');
    expect(events).toEqual([{ type: 'error', code: 'busy', message: 'Slow down' }]);
  });

  it('a stream error event resolves error', async () => {
    const result = await streamChat({
      url: 'https://agent.example', token: 't', body, onEvent: () => {},
      fetchImpl: streamOf([frame('error', { code: 'x', message: 'y' })]),
    });
    expect(result).toBe('error');
  });

  it('a stream that ends without done resolves dropped', async () => {
    const events: AgentEvent[] = [];
    const result = await streamChat({
      url: 'https://agent.example', token: 't', body, onEvent: e => events.push(e),
      fetchImpl: streamOf([frame('delta', { text: 'Hi' })]),
    });
    expect(result).toBe('dropped');
    expect(events).toEqual([{ type: 'delta', text: 'Hi' }]);
  });
});
