import { describe, expect, it } from 'vitest';
import { Aggregator, MAX_EDGES, type TapMapping } from './tap-agg';
import { decodeJson, decodeProtobuf, type TapSpan } from './tap-otlp';

// ---- a tiny protobuf writer, enough to build ExportTraceServiceRequest bytes ----
const varint = (n: bigint | number): number[] => {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
};
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const bytesField = (field: number, b: number[] | Uint8Array) => [...tag(field, 2), ...varint(b.length), ...b];
const str = (field: number, s: string) => bytesField(field, [...new TextEncoder().encode(s)]);
const fixed64 = (field: number, n: bigint) => {
  const out = [...tag(field, 1)];
  for (let i = 0; i < 8; i++) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
  return out;
};
const hexBytes = (h: string) => h.match(/../g)!.map(x => parseInt(x, 16));

function pbSpan(id: string, parent: string | null, startNs: bigint, endNs: bigint, error = false, withAttrs = false): number[] {
  return [
    ...bytesField(1, hexBytes('0'.repeat(32))),
    ...bytesField(2, hexBytes(id)),
    ...(parent ? bytesField(4, hexBytes(parent)) : []),
    ...str(5, 'GET /users/42?email=a@b.c'),
    ...tag(6, 0), ...varint(2),
    ...fixed64(7, startNs),
    ...fixed64(8, endNs),
    ...(withAttrs ? bytesField(9, [...str(1, 'http.url'), ...bytesField(2, str(1, 'https://x/?token=secret'))]) : []),
    ...(error ? bytesField(15, [...tag(3, 0), ...varint(2)]) : []),
  ];
}
function pbRequest(service: string, spans: number[][]): Uint8Array {
  const resource = bytesField(1, [...str(1, 'service.name'), ...bytesField(2, str(1, service))]);
  const scope = bytesField(2, spans.flatMap(s => bytesField(2, s)));
  return new Uint8Array(bytesField(1, [...bytesField(1, resource), ...scope]));
}

describe('decodeProtobuf', () => {
  it('keeps service, ids, duration and error; drops names and attributes', () => {
    const body = pbRequest('api', [
      pbSpan('aaaaaaaaaaaaaaaa', null, 1_000_000_000n, 1_012_500_000n, false, true),
      pbSpan('bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa', 1_001_000_000n, 1_004_000_000n, true),
    ]);
    const spans = decodeProtobuf(body);
    expect(spans).toEqual([
      { service: 'api', spanId: 'aaaaaaaaaaaaaaaa', parentSpanId: null, ms: 12.5, error: false },
      { service: 'api', spanId: 'bbbbbbbbbbbbbbbb', parentSpanId: 'aaaaaaaaaaaaaaaa', ms: 3, error: true },
    ]);
    expect(JSON.stringify(spans)).not.toMatch(/secret|email|users/);
  });

  it('rejects truncated input', () => {
    expect(() => decodeProtobuf(new Uint8Array([0x0a, 0x05, 0x01]))).toThrow();
  });
});

describe('decodeJson', () => {
  it('reads OTLP/JSON with hex ids and string times', () => {
    const spans = decodeJson({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'db' } }, { key: 'host', value: { stringValue: 'secret-host' } }] },
        scopeSpans: [{ spans: [{ spanId: 'CCCC', parentSpanId: 'aaaa', name: 'SELECT secret', startTimeUnixNano: '1000000', endTimeUnixNano: '9000000', status: { code: 'STATUS_CODE_ERROR' } }] }],
      }],
    });
    expect(spans).toEqual([{ service: 'db', spanId: 'cccc', parentSpanId: 'aaaa', ms: 8, error: true }]);
  });

  it('ignores anything that is not a trace export', () => {
    expect(decodeJson({ nope: 1 })).toEqual([]);
    expect(decodeJson(null)).toEqual([]);
  });
});

describe('Aggregator', () => {
  const mapping: TapMapping = { board: '5', services: { web: '12', api: '13', db: '16' } };
  const s = (service: string, spanId: string, parentSpanId: string | null, ms: number, error = false): TapSpan => ({ service, spanId, parentSpanId, ms, error });

  it('samples a call when the parent ran in another service, with percentiles per node pair', () => {
    let now = 0;
    const agg = new Aggregator(() => mapping, () => now);
    agg.add([s('web', 'w1', null, 50), s('api', 'a1', 'w1', 40), s('api', 'a1b', 'a1', 10)]);
    agg.add([s('db', 'd1', 'a1', 4), s('db', 'd2', 'a1', 6, true), s('db', 'd3', 'a1', 20)]);
    now = 1000;
    expect(agg.flush()).toEqual({
      t: 1, window_ms: 1000, unmapped: 0,
      edges: [
        { from: '13', to: '16', count: 3, errors: 1, p50: 6, p95: 20, max: 20 },
        { from: '12', to: '13', count: 1, errors: 0, p50: 40, p95: 40, max: 40 },
      ],
    });
    expect(agg.flush()).toBeNull();
  });

  it('waits for a parent that arrives in a later batch, then forgets it after 5 s', () => {
    let now = 0;
    const agg = new Aggregator(() => mapping, () => now);
    agg.add([s('db', 'd1', 'a1', 4)]);
    agg.add([s('api', 'a1', null, 30)]);
    expect(agg.flush()!.edges).toEqual([{ from: '13', to: '16', count: 1, errors: 0, p50: 4, p95: 4, max: 4 }]);
    agg.add([s('db', 'd2', 'a2', 4)]);
    now = 6000;
    agg.flush();
    agg.add([s('api', 'a2', null, 30)]);
    expect(agg.flush()).toBeNull();
  });

  it('counts calls involving an unmapped service and names it', () => {
    const agg = new Aggregator(() => mapping, () => 0);
    agg.add([s('web', 'w1', null, 5), s('cache', 'c1', 'w1', 1)]);
    expect(agg.flush()).toMatchObject({ edges: [], unmapped: 1 });
    expect([...agg.unmappedServices]).toEqual(['cache']);
  });

  it('reads the mapping on every sample, so an edited file applies at once', () => {
    const m: TapMapping = { board: '5', services: { web: '12' } };
    const agg = new Aggregator(() => m, () => 0);
    agg.add([s('web', 'w1', null, 5), s('api', 'a1', 'w1', 1)]);
    m.services.api = '13';
    agg.add([s('web', 'w2', null, 5), s('api', 'a2', 'w2', 2)]);
    expect(agg.flush()).toMatchObject({ unmapped: 1, edges: [{ from: '12', to: '13', count: 1 }] });
  });

  it(`sends at most ${MAX_EDGES} edges, busiest first`, () => {
    const services: Record<string, string> = { root: '0' };
    const spans: TapSpan[] = [s('root', 'r', null, 1)];
    for (let i = 1; i <= MAX_EDGES + 10; i++) {
      services[`s${i}`] = String(i);
      spans.push(s(`s${i}`, `x${i}`, 'r', 1));
      if (i === MAX_EDGES + 10) spans.push(s(`s${i}`, `y${i}`, 'r', 1));
    }
    const agg = new Aggregator(() => ({ board: '1', services }), () => 0);
    agg.add(spans);
    const w = agg.flush()!;
    expect(w.edges).toHaveLength(MAX_EDGES);
    expect(w.edges[0]).toMatchObject({ to: String(MAX_EDGES + 10), count: 2 });
  });
});

// ---- the tap: HTTP in, socket out ----
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { boardOfToken, createTap, parseTap, type TapSocket } from './tap';

const tokenFor = (board: string) => `h.${Buffer.from(JSON.stringify({ board })).toString('base64url')}.s`;

class FakeChannel implements TapSocket {
  readyState = 0;
  sent: unknown[] = [];
  private on: Record<string, ((ev: { data?: unknown; code?: number; reason?: string }) => void)[]> = {};
  addEventListener(type: string, fn: (ev: { data?: unknown; code?: number; reason?: string }) => void) {
    (this.on[type] ??= []).push(fn);
  }
  emit(type: string, ev: { data?: unknown; code?: number; reason?: string } = {}) {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const fn of this.on[type] ?? []) fn(ev);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.emit('close', { code: 1000 });
  }
}

async function startTap(services: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'tap-'));
  const map = join(dir, 'tap.json');
  writeFileSync(map, JSON.stringify({ board: '5', services }));
  const sockets: FakeChannel[] = [];
  const logs: string[] = [];
  let now = 0;
  const tap = createTap({ token: tokenFor('5'), port: 0, map }, 'https://mcp.example.test', {
    connect: url => {
      const s = new FakeChannel();
      (s as unknown as { url: string }).url = url;
      sockets.push(s);
      return s;
    },
    log: l => logs.push(l),
    now: () => now,
  });
  await new Promise<void>(r => tap.server.listen(0, '127.0.0.1', () => r()));
  const port = (tap.server.address() as AddressInfo).port;
  const post = (body: BodyInit, type: string, extra: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/traces`, { method: 'POST', headers: { 'content-type': type, ...extra }, body });
  return { tap, sockets, logs, post, advance: (ms: number) => (now += ms), stop: () => tap.stop() };
}

const otlpJson = (spans: Array<[string, string, string | null, number]>) => ({
  resourceSpans: spans.map(([service, id, parent, ms]) => ({
    resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
    scopeSpans: [{ spans: [{ spanId: id, parentSpanId: parent ?? '', name: 'x', startTimeUnixNano: '0', endTimeUnixNano: String(ms * 1e6) }] }],
  })),
});

describe('redcrayon tap', () => {
  it('parses its flags and reads the board from the token', () => {
    expect(parseTap(['--token', 't', '--port', '4400'])).toEqual({ token: 't', port: 4400, map: join('.redcrayon', 'tap.json') });
    expect(() => parseTap([])).toThrow(/usage/);
    expect(boardOfToken(tokenFor('42'))).toBe('42');
    expect(() => boardOfToken('nope')).toThrow(/start_tap/);
  });

  it('authenticates, then sends windows only while someone watches', async () => {
    const t = await startTap({ web: '12', api: '13' });
    try {
      t.tap.tick();
      const ch = t.sockets[0];
      expect((ch as unknown as { url: string }).url).toBe('wss://mcp.example.test/live/5');
      ch.emit('open');
      expect(ch.sent[0]).toEqual({ auth: tokenFor('5'), role: 'tap' });
      ch.emit('message', { data: JSON.stringify({ ok: true, role: 'tap' }) });
      ch.emit('message', { data: JSON.stringify({ watching: false }) });

      expect((await t.post(JSON.stringify(otlpJson([['web', 'aa', null, 20], ['api', 'bb', 'aa', 7]])), 'application/json')).status).toBe(200);
      t.advance(1000);
      t.tap.tick();
      expect(ch.sent).toHaveLength(1); // nobody watching: nothing sent

      ch.emit('message', { data: JSON.stringify({ watching: true }) });
      const gz = gzipSync(Buffer.from(JSON.stringify(otlpJson([['web', 'cc', null, 20], ['api', 'dd', 'cc', 9]]))));
      expect((await t.post(gz, 'application/json', { 'content-encoding': 'gzip' })).status).toBe(200);
      t.advance(1000);
      t.tap.tick();
      expect(ch.sent[1]).toMatchObject({ window_ms: 1000, edges: [{ from: '12', to: '13', count: 1, p50: 9 }], unmapped: 0 });
      expect(t.logs.join('\n')).toMatch(/someone is watching/);
    } finally {
      t.stop();
    }
  });

  it('answers 400 to junk, 404 elsewhere, and keeps running', async () => {
    const t = await startTap({});
    try {
      expect((await t.post('{', 'application/json')).status).toBe(400);
      expect((await t.post(new Uint8Array([0x0a, 0xff]), 'application/x-protobuf')).status).toBe(400);
      const port = (t.tap.server.address() as AddressInfo).port;
      expect((await fetch(`http://127.0.0.1:${port}/v1/metrics`, { method: 'POST', body: '{}' })).status).toBe(404);
    } finally {
      t.stop();
    }
  });

  it('retries a dropped channel with backoff, and stops for good when the board refuses the token', async () => {
    const t = await startTap({});
    try {
      t.tap.tick();
      t.sockets[0].emit('close', { code: 1006 });
      t.tap.tick();
      expect(t.sockets).toHaveLength(1); // backoff not elapsed
      t.advance(1000);
      t.tap.tick();
      expect(t.sockets).toHaveLength(2);
      t.sockets[1].emit('close', { code: 4001, reason: 'This tap token is not valid for this board.' });
      expect(t.tap.fatal()).toMatch(/not valid/);
      t.advance(60_000);
      t.tap.tick();
      expect(t.sockets).toHaveLength(2);
    } finally {
      t.stop();
    }
  });
});
