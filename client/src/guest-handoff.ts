import type { Auth } from './auth';
import { newClaimCode } from './journey';

/** Persist the capability before sign-in can redirect this page. */
export async function signInWithGuestBoard(
  auth: Pick<Auth, 'ensureSignedIn'>,
  board: { id: bigint; slug: string } | undefined,
  offer: (request: {boardId: bigint; code: string}) => Promise<void>,
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  key: string
): Promise<boolean> {
  if (board !== undefined) {
    const code = newClaimCode();
    await offer({boardId: board.id, code});
    // The slug finds the board again when sign-in returns to its #b= link (claimForBoard).
    storage.setItem(key, JSON.stringify({boardId: board.id.toString(), code, slug: board.slug}));
  }
  const signedIn = await auth.ensureSignedIn(true);
  if (!signedIn) storage.removeItem(key);
  return signedIn;
}
