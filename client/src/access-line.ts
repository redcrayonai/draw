/** The my_boards fields that say who else can see a board. */
type BoardPermission = { workspaceId: bigint; canEdit: boolean; canManage: boolean };
type AccessRow = { access: string; linkMode: string; sharedWith: string[] };

/**
 * Who can see the board, broadest first (RC-570). linkMode is only filled on
 * owner and link rows, sharedWith only on owner rows, so a teammate sees
 * "shared with a team" and a link holder sees the link's mode. Undefined for
 * rows that cannot tell (an agent's grant, a linked agent's board): never a
 * "private" that may be wrong.
 */
export function accessLine(row: AccessRow, permission?: BoardPermission): string | undefined {
  if (permission && permission.workspaceId !== 0n) {
    return `workspace board · ${permission.canManage ? 'can manage access' : permission.canEdit ? 'can edit' : 'view only'}`;
  }
  if (row.access === 'public') return 'public · anyone can view';
  if (!['owner', 'team', 'link'].includes(row.access)) return undefined;
  // Guests holding an edit link stay read-only until they sign in (SH03, SH07).
  if (row.linkMode === 'edit') return 'link sharing on · signed-in people with the link can edit';
  if (row.linkMode === 'view') return 'link sharing on · anyone with the link can view';
  if (row.access === 'team' || row.sharedWith.length > 0) return 'shared with a team';
  return 'private';
}

/** Hidden without a row yet (no flash of "private") or on a version view. */
export function paintAccessLine(row: AccessRow | undefined, permission?: BoardPermission): void {
  const el = document.getElementById('access-line');
  if (!el) return;
  const text = row && accessLine(row, permission);
  el.hidden = !text;
  el.textContent = text ?? '';
}
