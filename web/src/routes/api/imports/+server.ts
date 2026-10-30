import { json } from '@sveltejs/kit';
import { verifyBearer } from '$lib/server/http';
import { assertDatabase, callerRequestHistory, configured, dispatch, github, githubPath, ImportError, importFailure, jsonBody, pinnedRefs, publicRepository, refNames, repositoryUrl, workspaceId } from '$lib/server/imports';
import { callAs } from '$lib/server/board-db';
import type { RequestHandler } from './$types';

// shortcut: no UI calls /api/imports, /refs or /retry since #71 hid the import dialog (demo scope); only direct API
// calls reach them, gated by OIDC_ISSUER or IMPORTS_ANONYMOUS. Post-launch, restore a UI or delete these routes and the importer.
export const POST: RequestHandler = async ({ request, url }) => {
  const off = configured();
  if (off) return off;
  // Where there are accounts, a DB token alone is not enough: the database also accepts anonymous ones.
  const token = await verifyBearer(request);
  if (token instanceof Response) return token;
  try {
    assertDatabase(url);
    const body = await jsonBody(request);
    const destination = body.workspaceId === undefined ? undefined : workspaceId(body.workspaceId);
    const repository = repositoryUrl(body.repository);
    const refs = refNames(body.refs);
    if (typeof body.requestKey !== 'string' || !body.requestKey || body.requestKey.length > 100) throw new ImportError(400, 'Include a requestKey of up to 100 characters.');
    const name = body.name === undefined ? repository.split('/').at(-1)! : body.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new ImportError(400, 'Give this history a name of up to 100 characters.');
    // A repeated browser request must retain the original commits if refs moved.
    let history = await callerRequestHistory(token, body.requestKey);
    if (history && (history.name !== name.trim() || history.repository !== repository || JSON.stringify(pinnedRefs(history).map((r) => r.ref)) !== JSON.stringify(refs))) {
      throw new ImportError(409, 'This request already created a different import. Close the form and start a new import.');
    }
    if (history && destination !== undefined) {
      // Revalidate the request's destination in core without consulting moving refs.
      await callAs(token, 'create_workspace_architecture_history', [destination, name.trim(), repository, JSON.stringify(pinnedRefs(history)), body.requestKey]);
    }
    if (!history) {
      await publicRepository(repository);
      const pinned = await Promise.all(refs.map(async (ref) => {
        const commit = await github(`${githubPath(repository)}/commits/${encodeURIComponent(ref)}`) as { sha?: string };
        if (!commit.sha || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new ImportError(502, 'GitHub did not return a commit for the selected ref. Try again shortly.');
        return { ref, sha: commit.sha };
      }));
      const args = [name.trim(), repository, JSON.stringify(pinned), body.requestKey];
      if (destination === undefined) await callAs(token, 'create_architecture_history', args);
      else await callAs(token, 'create_workspace_architecture_history', [destination, ...args]);
      history = await callerRequestHistory(token, body.requestKey);
      if (!history) throw new ImportError(502, 'The import was created but could not be read back. Reload the dashboard before retrying.');
    }
    if (!['running', 'ready'].includes(String(history.status))) await dispatch(history);
    return json({ historyId: String(history.id) }, { status: 202 });
  } catch (error) { return importFailure(error); }
};
