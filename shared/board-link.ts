// The only builder of board links (scripts/board-links.test.mjs checks). Old
// ?boardId=<id> links still open (client/src/board-select.ts), but nothing makes one.
import { setDb } from './db-target';

/** `<app>/#b=<slug>`, plus ?db= for a database other than `app`'s home (setDb). */
export function boardHref({ app, slug, db, home }: { app: string; slug: string; db: string; home?: string }): string {
  if (!slug) throw new Error('this board has no link yet: run backfill_board_slugs');
  return setDb(new URL(`${new URL(app).origin}/#b=${encodeURIComponent(slug)}`), db, home).toString();
}
