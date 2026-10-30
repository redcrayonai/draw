import { afterEach, expect, it, vi } from 'vitest';
import { log } from './log';

afterEach(() => vi.restoreAllMocks());

it('writes one JSON line with the event, fields and an error reduced to name, message and code', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const pg = Object.assign(new Error('invalid input syntax'), { code: '22P02', query: 'insert …', parameters: ['secret'] });
  log('error', 'activity.drain_failed', { entryPoint: 'cron' }, pg);
  expect(JSON.parse(error.mock.calls[0][0])).toEqual({
    event: 'activity.drain_failed',
    entryPoint: 'cron',
    error: 'Error: invalid input syntax',
    code: '22P02'
  });
});

it('leaves error fields out when there is no error', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  log('info', 'activity.drained', { entryPoint: 'cron', drained: 3 });
  expect(JSON.parse(info.mock.calls[0][0])).toEqual({ event: 'activity.drained', entryPoint: 'cron', drained: 3 });
});
