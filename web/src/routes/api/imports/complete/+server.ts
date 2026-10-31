import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { bearer, fail } from '$lib/server/http';
import { completedIndexes, configured, historyId, ImportError, importFailure, jsonBody, pinnedRefs, validateGraph } from '$lib/server/imports';
import { callAs, sqlAs } from '$lib/server/board-db';
import type { RequestHandler } from './$types';

// Compare digests byte by byte so the time taken leaks neither length nor prefix.
async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const POST: RequestHandler = async ({ request }) => {
  const off = configured();
  if (off) return off;
  if (!(await sameSecret(bearer(request) ?? '', env.IMPORT_RUNNER_SECRET!))) return fail(401, 'Invalid import callback credentials.');
  try {
    const body = await jsonBody(request);
    const id = historyId(body.historyId);
    const service = env.SPACETIMEDB_SERVICE_TOKEN!;
    const history = (await sqlAs(service, `SELECT * FROM visible_architecture_history WHERE id = ${id}`))[0];
    if (!history) throw new ImportError(404, 'This import history does not exist.');
    if (body.status !== undefined) {
      if (!['ready', 'failed'].includes(String(body.status)) || typeof body.error !== 'string') throw new ImportError(400, 'A final callback needs ready or failed status and an error string.');
      const completed = await completedIndexes(id);
      const ready = completed.size === pinnedRefs(history).length;
      if (body.status === 'ready' && !ready) throw new ImportError(400, 'The import cannot finish before every pinned snapshot is published.');
      await callAs(service, 'set_architecture_import_status', [id, ready ? 'ready' : completed.size ? 'partial' : 'failed', ready ? '' : body.error]);
    } else {
      const refs = pinnedRefs(history);
      if (!Number.isInteger(body.index) || Number(body.index) < 0 || Number(body.index) >= refs.length || refs[Number(body.index)].ref !== body.ref || refs[Number(body.index)].sha !== body.sha) throw new ImportError(400, 'The callback ref and commit must match the pinned history snapshot.');
      if (body.graph !== undefined && body.error !== undefined) throw new ImportError(400, 'Send a snapshot graph or a ref error, not both.');
      if (body.graph !== undefined) {
        validateGraph(body.graph);
        await callAs(service, 'publish_architecture_snapshot', [id, body.index, body.ref, body.sha, JSON.stringify(body.graph)]);
      } else if (typeof body.error === 'string' && body.error) {
        const completed = await completedIndexes(id);
        if (completed.size === refs.length) await callAs(service, 'set_architecture_import_status', [id, 'ready', '']);
        else if (!completed.has(Number(body.index))) await callAs(service, 'set_architecture_import_status', [id, completed.size ? 'partial' : 'failed', `${body.ref}: ${body.error}`]);
      } else throw new ImportError(400, 'Send a graph or an error for this snapshot.');
    }
    return json({ ok: true });
  } catch (error) { return importFailure(error); }
};
