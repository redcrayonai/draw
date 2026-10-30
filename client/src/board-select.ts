import type { Board } from './module_bindings/types';
import { shareTokenOf } from '../../shared/share-link';

const UNAVAILABLE = 'This board is unavailable. It may be private or have been deleted.';

/** The board's link id from an Excalidraw-style `#b=<slug>` fragment. */
const slugOf = (hash: string): string | null => new URLSearchParams(hash.slice(1)).get('b');

export function hasBoardLink(search: string, hash = ''): boolean {
  const params = new URLSearchParams(search);
  return params.has('boardId') || params.has('board') || slugOf(hash) !== null || shareTokenOf(hash) !== null;
}

export function shouldOpenDashboard(search: string, signedIn: boolean, hash = ''): boolean {
  return signedIn && !hasBoardLink(search, hash) && new URLSearchParams(search).get('new') !== '1';
}

/** Explicit board links take priority. Bare entry is handled by guest/account routing.
 *  `links` are the caller's my_boards rows: a #s= link resolves through its token. */
export function selectBoard(
  boards: Iterable<Board>, search: string, hash = '',
  links: Iterable<{ boardId: bigint; linkToken: string }> = [],
): Board | string {
  const params = new URLSearchParams(search);
  const all = [...boards];
  const token = shareTokenOf(hash);
  if (token !== null) {
    const row = token ? [...links].find(l => l.linkToken === token) : undefined;
    return (row && all.find(b => b.id === row.boardId)) || UNAVAILABLE;
  }
  const slug = slugOf(hash);
  if (slug !== null) {
    return (slug && all.find(b => b.slug === slug)) || UNAVAILABLE;
  }
  const id = params.get('boardId');
  if (id !== null) {
    if (!/^\d+$/.test(id)) return 'This board link is invalid.';
    const want = BigInt(id);
    return all.find(b => b.id === want) ?? UNAVAILABLE;
  }
  const wanted = params.get('board');
  return all.find(b => b.name === wanted) ?? UNAVAILABLE;
}

/** A #s= token this page did not boot with has no visit row yet; only boot's
 *  openSharedLink records one, so fragment navigation to it must reboot. */
export function opensNewShareLink(hash: string, bootToken: string | null): boolean {
  const token = shareTokenOf(hash);
  return token !== null && token !== bootToken;
}

/** View-only: the public Demo, a view link, or an edit link while signed out.
 *  Read from the my_boards row, so it holds however the board was opened. */
export function viewOnly(row: { access: string; linkMode: string } | undefined, signedIn: boolean, permission?: { canEdit: boolean; canManage: boolean }): boolean {
  if (permission) return !permission.canEdit;
  if (!row) return false;
  return row.access === 'public' || (row.access === 'link' && (row.linkMode !== 'edit' || !signedIn));
}
