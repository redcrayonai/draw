export const roleRank = (role: string): number => ({ viewer: 1, editor: 2, manager: 3 }[role] ?? 0);
export const strongestRole = (...roles: string[]): string => roles.reduce((best, role) => roleRank(role) > roleRank(best) ? role : best, '');

/** Guests never inherit team or workspace-wide access; all access requires current membership. */
export function boardRole(membership: string, workspace: string, team: string, direct: string): string {
  if (!membership) return '';
  if (membership === 'owner' || membership === 'admin') return 'manager';
  if (membership === 'guest') return strongestRole(direct);
  return membership === 'member' ? strongestRole(workspace, team, direct) : '';
}

export const invitationRole = (boardId: bigint, role: string): boolean => boardId === 0n
  ? role === 'member' || role === 'admin'
  : roleRank(role) > 0;

export const invitationIsLive = (expiresAt: bigint, now: bigint): boolean => expiresAt > now;

export function workspaceName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('workspace rule: use a name of 1–100 characters without control characters');
  return name;
}
