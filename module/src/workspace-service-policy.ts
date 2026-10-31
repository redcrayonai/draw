export type ServiceScope = { role: string; allBoards: boolean; boardIds: bigint[] };
const rank = (role: string): number => role === 'editor' ? 2 : role === 'viewer' ? 1 : 0;

export function serviceScope(role: string, allBoards: boolean, boardIds: bigint[]): ServiceScope {
  if (!rank(role)) throw new Error('service account rule: permission must be viewer or editor');
  if (boardIds.length > 500 || boardIds.some(id => id <= 0n)) throw new Error('service account rule: select at most 500 valid boards');
  const unique = [...new Set(boardIds)];
  if (!allBoards && unique.length === 0) throw new Error('service account rule: select at least one board');
  return { role, allBoards, boardIds: allBoards ? [] : unique };
}

export function scopeIsWithin(account: ServiceScope, key: ServiceScope): boolean {
  return rank(key.role) > 0 && rank(key.role) <= rank(account.role)
    && (key.allBoards || account.allBoards || key.boardIds.every(id => account.boardIds.includes(id)));
}

export function machineScopeRole(account: ServiceScope, key: ServiceScope, boardId: bigint): string {
  if (!rank(account.role) || !rank(key.role)) return '';
  if (!account.allBoards && !account.boardIds.includes(boardId) || !key.allBoards && !key.boardIds.includes(boardId)) return '';
  return rank(account.role) < rank(key.role) ? account.role : key.role;
}

export function apiKeyIsActive(key: { revoked: boolean; expiresAt?: { microsSinceUnixEpoch: bigint } } | undefined, now?: bigint): boolean {
  return !!key && !key.revoked && (now === undefined || key.expiresAt === undefined || key.expiresAt.microsSinceUnixEpoch > now);
}
