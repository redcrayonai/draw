// Version actions from the dashboard: the server stores and fetches; the module decides who may.
import { apiToken } from './stdb';
import { appHref } from './boards';

async function post(path: string, body: unknown): Promise<Record<string, string>> {
  const token = await apiToken();
  if (!token) throw new Error('Not connected yet; wait a moment and retry.');
  const r = await fetch(appHref(path), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({ error: `The dashboard server answered ${r.status}.` }));
  if (!r.ok) throw new Error(out.error ?? `The dashboard server answered ${r.status}.`);
  return out;
}

export const saveVersion = (boardId: bigint) => post('/api/plugins/versions', { boardId: boardId.toString() });

// A retry after a failure reuses its key, also with the panel closed in between: if the first try made the board, the server returns that one.
const keys = new Map<bigint, string>();

export async function restoreVersion(versionId: bigint) {
  if (!keys.has(versionId)) keys.set(versionId, crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''));
  const board = await post(`/api/plugins/versions/${versionId}/restore`, { requestKey: keys.get(versionId) }) as { boardId: string; slug: string };
  keys.delete(versionId);
  return board;
}
