import { afterEach, expect, it, vi } from 'vitest';
import type { DbConnection } from '../module_bindings';

const h = vi.hoisted(() => ({
  broken: { attach: vi.fn(), reset: vi.fn() },
  healthy: { attach: vi.fn(), reset: vi.fn() },
}));
vi.mock('./plugins.generated', () => ({ WEB_PARTS: [
  { id: 'broken', web: h.broken }, { id: 'healthy', web: h.healthy },
] }));
import { attachPluginParts, resetPluginParts } from './plugin-mounts';

afterEach(() => vi.restoreAllMocks());

it('attaches other parts with the same connection and stale check after one throws', () => {
  const error = new Error('broken attach');
  h.broken.attach.mockImplementationOnce(() => { throw error; });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const conn = {} as DbConnection;
  const stale = () => true;
  attachPluginParts(conn, stale);
  expect(h.healthy.attach).toHaveBeenCalledWith(conn, stale);
  expect(warn).toHaveBeenCalledWith('plugin.attach', 'broken', error);
});

it('resets other parts after one throws so their account data is cleared', () => {
  const error = new Error('broken reset');
  h.broken.reset.mockImplementationOnce(() => { throw error; });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetPluginParts();
  expect(h.healthy.reset).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith('plugin.reset', 'broken', error);
});
