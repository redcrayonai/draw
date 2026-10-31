// The slice of the hosted assets layer that the SvelteKit adapter's worker
// calls through env.ASSETS: files from a workerd disk service (which sends every
// file as application/octet-stream), with a Content-Type and the adapter's
// _headers caching (immutable under /_app/immutable/, no-cache elsewhere).
const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // a directory answers with a JSON listing; the hosted layer does not list
    if (pathname.endsWith('/')) return new Response('Not found', { status: 404 });
    const res = await env.DISK.fetch(request);
    if (!res.ok) return res;
    const headers = new Headers(res.headers);
    headers.set('content-type', TYPES[pathname.slice(pathname.lastIndexOf('.') + 1)] ?? 'application/octet-stream');
    headers.set('cache-control', pathname.startsWith('/_app/immutable/') ? 'public, immutable, max-age=31536000' : 'no-cache');
    return new Response(res.body, { status: res.status, headers });
  },
};

// The adapter's worker reads caches.default on every request, which throws in
// workerd unless the Worker has a cacheApiOutbound. Always a miss (miniflare's
// cache-entry-noop protocol): the SPA shell is no-cache anyway.
export const noCache = {
  async fetch(request) {
    if (request.method === 'GET') return new Response(null, { status: 504, headers: { 'cf-cache-status': 'MISS' } });
    if (request.method === 'PUT') {
      await request.body?.pipeTo(new WritableStream());
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: request.method === 'PURGE' ? 404 : 405 });
  },
};
