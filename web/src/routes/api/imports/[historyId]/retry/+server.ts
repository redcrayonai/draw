import { json } from '@sveltejs/kit';
import { verifyBearer } from '$lib/server/http';
import { assertDatabase, configured, dispatch, historyId, importFailure, ownedHistory } from '$lib/server/imports';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params, url }) => {
  const off = configured();
  if (off) return off;
  // Where there are accounts, a DB token alone is not enough: the database also accepts anonymous ones.
  const token = await verifyBearer(request);
  if (token instanceof Response) return token;
  try {
    assertDatabase(url);
    const history = await ownedHistory(token, historyId(params.historyId));
    await dispatch(history);
    return json({ historyId: String(history.id) }, { status: 202 });
  } catch (error) { return importFailure(error); }
};
