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

export const saveVersion = (boardId: bigint) => post('/api/versions', { boardId: boardId.toString() });

/** A new restore request key; send the same one again to retry, so a lost answer never makes a second board. */
export const restoreKey = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

export const restoreVersion = (versionId: bigint, requestKey: string) =>
  post(`/api/versions/${versionId}/restore`, { requestKey }) as Promise<{ boardId: string; slug: string }>;
