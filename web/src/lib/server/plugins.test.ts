// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { env } from '$env/dynamic/private';
import { dispatchPlugin, available } from './plugins';
import { GET as CATALOG } from '../../routes/api/plugins/+server';
import { fallback } from '../../routes/api/plugins/[plugin]/[...path]/+server';

const fixture = vi.hoisted(() => ({ configured: true, broken: false, response: new Response('plugin response', { status: 202, headers: { 'x-plugin': 'yes' } }), handle: vi.fn() }));
vi.mock('./plugins.generated', () => ({ PLUGIN_LIST: [
  { id: 'sample', name: 'Sample', description: 'A sample', settings: ['SECRET'], canvasSettings: [], server: { configured: () => { if (fixture.broken) throw new Error('bad configuration'); return fixture.configured; }, handle: fixture.handle } },
  { id: 'bare', name: 'Bare', description: 'No server', settings: [], canvasSettings: [] },
  { id: 'panel', name: 'Panel', description: 'A canvas panel', settings: [], canvasSettings: ['PANEL_ENDPOINT'] }
] }));
beforeEach(() => { fixture.configured = true; fixture.broken = false; fixture.handle.mockReset().mockResolvedValue(fixture.response); });
const request = new Request('http://dash.test/api/plugins/sample/a/b?db=dash', { method: 'PATCH' });
const url = new URL(request.url);

it('rejects unknown plugins and known plugins without a handler', async () => {
  for (const id of ['unknown', 'bare']) {
    const response = await dispatchPlugin(id, { request, url, path: [] });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/^REJECTED:/) });
  }
  expect(available('unknown')).toBe(false);
  expect(available('bare')).toBe(true);
});
it('answers unavailable before calling a plugin with incomplete configuration', async () => {
  fixture.configured = false;
  expect(available('sample')).toBe(false);
  const response = await dispatchPlugin('sample', { request, url, path: [] });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'UNAVAILABLE: this deployment does not offer Sample.' });
  expect(fixture.handle).not.toHaveBeenCalled();
});
it('passes the original request, URL, path and exact response through the generic route for every method', async () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const original = new Request(request, { method });
    const response = await fallback({ request: original, url, params: { plugin: 'sample', path: 'a/b' } } as never);
    expect(response).toBe(fixture.response);
    expect(fixture.handle).toHaveBeenLastCalledWith({ request: original, url, path: ['a', 'b'] });
  }
  await fallback({ request, url, params: { plugin: 'sample', path: '' } } as never);
  expect(fixture.handle).toHaveBeenLastCalledWith({ request, url, path: [] });
});

it('contains a broken configuration check and keeps settings out of the catalog', async () => {
  fixture.broken = true;
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await CATALOG({} as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plugins: [
      { id: 'sample', name: 'Sample', description: 'A sample', available: false },
      { id: 'bare', name: 'Bare', description: 'No server', available: true },
      { id: 'panel', name: 'Panel', description: 'A canvas panel', available: false }
    ] });
    expect(logged).toHaveBeenCalled();
    expect((await dispatchPlugin('sample', { request, url, path: [] })).status).toBe(503);
  } finally { logged.mockRestore(); }
});

it('offers a plugin with canvas settings only when every one is set', () => {
  env.PANEL_ENDPOINT = '';
  expect(available('panel')).toBe(false);
  env.PANEL_ENDPOINT = '  ';
  expect(available('panel')).toBe(false);
  env.PANEL_ENDPOINT = 'https://panel.test';
  try { expect(available('panel')).toBe(true); } finally { env.PANEL_ENDPOINT = ''; }
});
