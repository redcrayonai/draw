import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { DbConnection } from '../module_bindings';

vi.mock('./boards', () => ({ appHref: (path: string) => path }));
import { attachPlugins, pluginCatalog, resetPlugins } from './plugins';

beforeEach(() => {
  resetPlugins();
  pluginCatalog.set(null);
});
afterEach(() => vi.unstubAllGlobals());

it('loads the deployment catalog when an older server lacks workspace plugin views', async () => {
  const plugins = [{ id: 'versions', name: 'Versions', description: 'Saved boards', available: true }];
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ plugins }) });
  vi.stubGlobal('fetch', fetch);
  const conn = { db: {}, subscriptionBuilder: vi.fn() };

  attachPlugins(conn as unknown as DbConnection, () => false);

  expect(fetch).toHaveBeenCalledWith('/api/plugins');
  expect(conn.subscriptionBuilder).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(get(pluginCatalog)).toEqual(plugins));
});

it.each(['unavailable', 'offline'])('finishes loading an %s catalog without workspace plugin views', async (failure) => {
  vi.stubGlobal('fetch', failure === 'offline'
    ? vi.fn().mockRejectedValue(new Error('offline'))
    : vi.fn().mockResolvedValue({ ok: false }));

  attachPlugins({ db: {} } as unknown as DbConnection, () => false);

  await vi.waitFor(() => expect(get(pluginCatalog)).toEqual([]));
});
