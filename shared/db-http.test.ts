import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dateOf, dbHttp, DbError, hexOf, identityArg, microsOf } from './db-http';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const { sqlAs, callAs } = dbHttp('http://db.test', 'dash');

beforeEach(() => {
  fetchMock.mockReset();
});

describe('sqlAs', () => {
  it('posts the query as the caller and keys rows by column, big u64s exact', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        '[{"schema":{"elements":[{"name":{"some":"board_id"},"algebraic_type":{"U64":[]}},' +
          '{"name":{"some":"name"},"algebraic_type":{"String":[]}}]},' +
          '"rows":[[7,"Demo"],[18446744073709551615,"Big"]],"total_duration_micros":12}]'
      )
    );
    expect(await sqlAs('user-tok', 'SELECT board_id, name FROM my_boards')).toEqual([
      { board_id: 7, name: 'Demo' },
      { board_id: 18446744073709551615n, name: 'Big' }
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://db.test/v1/database/dash/sql');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer user-tok', 'content-type': 'text/plain' },
      body: 'SELECT board_id, name FROM my_boards'
    });
  });

  it('maps 401 to a DbError with a token-neutral message that keeps the response body', async () => {
    fetchMock.mockResolvedValue(new Response('invalid token', { status: 401 }));
    const err = await sqlAs('bad', 'SELECT board_id FROM my_boards').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err).toMatchObject({
      status: 401,
      message: 'the database rejected the token sent to sql: invalid token'
    });
  });

  it('passes the abort signal through', async () => {
    fetchMock.mockResolvedValue(new Response('[{"schema":{"elements":[]},"rows":[]}]'));
    const signal = AbortSignal.timeout(5000);
    await sqlAs('t', 'SELECT * FROM board', signal);
    expect(fetchMock.mock.calls[0][1].signal).toBe(signal);
  });
});

describe('callAs', () => {
  it('posts positional JSON with exact u64s to the snake_case reducer route', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await callAs('svc', 'ack_activity', [[18446744073709551615n, 3n], [2, 1]]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://db.test/v1/database/dash/call/ack_activity');
    expect(init.headers).toEqual({ authorization: 'Bearer svc', 'content-type': 'application/json' });
    expect(init.body).toBe('[[18446744073709551615,3],[2,1]]');
  });

  it('surfaces the reducer error text on 530', async () => {
    fetchMock.mockResolvedValue(new Response('not authorized: service account only', { status: 530 }));
    await expect(callAs('x', 'drop_org', ['org_1'])).rejects.toMatchObject({
      status: 530,
      message: 'not authorized: service account only'
    });
  });

  it('names the status and route for any other failure', async () => {
    fetchMock.mockResolvedValue(new Response('no such reducer', { status: 404 }));
    await expect(callAs('x', 'nope', [])).rejects.toMatchObject({
      status: 404,
      message: 'the database answered 404 to call/nope: no such reducer'
    });
  });
});

describe('cell decoding', () => {
  const hex = 'c200ba442d4987321578a3376323c5fdee07128c22a273ca119f80a80452c038';

  it('reads identities in either JSON form', () => {
    expect(hexOf([`0x${hex}`])).toBe(hex);
    expect(hexOf({ __identity__: `0x${hex.toUpperCase()}` })).toBe(hex);
    expect(identityArg(hex)).toEqual({ __identity__: `0x${hex}` });
    expect(identityArg(`0x${hex}`)).toEqual({ __identity__: `0x${hex}` });
  });

  it('reads timestamps in either JSON form', () => {
    const iso = '2026-10-05T12:00:00.123Z';
    const micros = Date.parse(iso) * 1000 + 456;
    expect(dateOf([micros]).toISOString()).toBe(iso);
    expect(dateOf({ __timestamp_micros_since_unix_epoch__: micros }).toISOString()).toBe(iso);
    expect(microsOf([micros])).toBe(BigInt(micros));
    expect(microsOf({ __timestamp_micros_since_unix_epoch__: micros })).toBe(BigInt(micros));
  });
});
