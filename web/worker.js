// The deployed Worker: SvelteKit's generated worker plus a cron that drains
// the activity outbox through POST /api/activity/drain. The adapter writes the
// generated worker from adapter.wrangler.jsonc, since it overwrites whatever
// file `main` names.
import app from './.svelte-kit/cloudflare/_worker.js';
// Asked before SvelteKit: a Response, or undefined to fall through. The public
// build's is empty (worker-extra.js); a private build points wrangler's alias
// (wrangler.jsonc, or `--alias redcrayon-worker-extra:<path>`) at its own.
import extra from 'redcrayon-worker-extra';

export default {
  fetch: async (request, env, ctx) => (await extra?.(request, env, ctx)) ?? app.fetch(request, env, ctx),
  scheduled(_event, env, ctx) {
    const request = new Request('https://cron.invalid/api/activity/drain', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.SPACETIMEDB_SERVICE_TOKEN}` }
    });
    ctx.waitUntil(
      app.fetch(request, env, ctx).then(async (res) => {
        if (!res.ok) console.error(JSON.stringify({ event: 'cron.drain_status', entryPoint: 'cron', status: res.status, body: await res.text() }));
      })
    );
  }
};
