/** An auth outage must never silently replace an account session with a guest. */
export function canStartGuest(required: boolean, accountSeen: boolean, cookies: string): boolean {
  if (required || accountSeen) return false;
  return !cookies.split(';').some(cookie => {
    const [name, ...parts] = cookie.trim().split('=');
    const value = parts.join('=');
    return /^__session(?:_|$)/.test(name) && Boolean(value)
      || /^__client_uat(?:_|$)/.test(name) && Boolean(value) && value !== '0';
  });
}

/** Where sign-out lands: the failed claim's own board (`#b=<slug>`) when it is on screen, else a bare start. */
export function guestReturnUrl(href: string, failedSlug: string | null): string {
  const url = new URL(href);
  const returnToBoard = Boolean(failedSlug) && new URLSearchParams(url.hash.slice(1)).get('b') === failedSlug;
  for (const key of ['new', 'board', 'boardId']) url.searchParams.delete(key);
  if (!returnToBoard) url.hash = '';
  return url.toString();
}

/** slug: the board's #b= link, which sign-in returns to; '' in claims saved before slugs. */
export type GuestClaim = { boardId: bigint; code: string; slug: string };

export function readGuestClaim(raw: string | null): GuestClaim | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (typeof value.boardId !== 'string' || !/^\d+$/.test(value.boardId)
      || typeof value.code !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value.code)
      || (value.slug !== undefined && typeof value.slug !== 'string')) return undefined;
    return { boardId: BigInt(value.boardId), code: value.code, slug: value.slug ?? '' };
  } catch {
    return undefined;
  }
}

/** The claim, when sign-in came back to its board: `#b=<slug>`, or `?boardId=` from a sign-in begun before slugs. */
export function claimForBoard(raw: string | null, search: string, hash = ''): GuestClaim | undefined {
  const claim = readGuestClaim(raw);
  const params = new URLSearchParams(search);
  const slug = new URLSearchParams(hash.slice(1)).get('b');
  const here = claim && (claim.slug ? slug === claim.slug : params.get('boardId') === claim.boardId.toString());
  return claim && here && params.get('new') !== '1' ? claim : undefined;
}

/** Never put a claim secret in URLs, analytics, or persistent storage. */
export function newClaimCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
