// The canvas link id (#b=<slug>), Excalidraw-style: a locator, not a secret —
// reads stay ACL-checked, so the timestamp-seeded ctx.random is enough.
type Random = { fill(bytes: Uint8Array): Uint8Array };
type Boards = {
  slug: { filter(slug: string): Iterable<{ slug: string }> };
  id: { update(row: any): unknown };
};

/** 20 lowercase hex characters no board has yet. */
export function newSlug(boards: Boards, random: Random): string {
  let slug: string;
  do slug = Array.from(random.fill(new Uint8Array(10)), b => b.toString(16).padStart(2, '0')).join('');
  while ([...boards.slug.filter(slug)].length > 0);
  return slug;
}

/** Gives every board without a slug (made before slugs existed) its own; a second run finds none. */
export function backfillSlugs(boards: Boards, random: Random): number {
  const missing = [...boards.slug.filter('')];
  for (const board of missing) boards.id.update({ ...board, slug: newSlug(boards, random) });
  return missing.length;
}
