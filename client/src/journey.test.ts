import { describe, expect, it } from 'vitest';
import { canStartGuest, readGuestClaim, claimForBoard, guestReturnUrl } from './journey';

const SLUG = 'c4bb879c7355360696d9';

describe('guest entry safety', () => {
  it('allows optional guest entry only without evidence of an account session', () => {
    expect(canStartGuest(false, false, '')).toBe(true);
    expect(canStartGuest(true, false, '')).toBe(false);
    expect(canStartGuest(false, true, '')).toBe(false);
    expect(canStartGuest(false, false, '__session=token')).toBe(false);
    expect(canStartGuest(false, false, '__session_xyz=token')).toBe(false);
    expect(canStartGuest(false, false, '__client_uat=123')).toBe(false);
    expect(canStartGuest(false, false, '__client_uat=0')).toBe(true);
  });

  it('ignores malformed persisted claim requests', () => {
    expect(readGuestClaim(null)).toBeUndefined();
    expect(readGuestClaim('broken')).toBeUndefined();
    expect(readGuestClaim('{"boardId":"9","code":"short"}')).toBeUndefined();
    expect(readGuestClaim(JSON.stringify({boardId: '9', code: 'a'.repeat(64), slug: 9}))).toBeUndefined();
    expect(readGuestClaim(JSON.stringify({boardId: '9', code: 'a'.repeat(64), slug: SLUG})))
      .toEqual({boardId: 9n, code: 'a'.repeat(64), slug: SLUG});
    // saved before claims carried the slug
    expect(readGuestClaim(JSON.stringify({boardId: '9', code: 'a'.repeat(64)})))
      .toEqual({boardId: 9n, code: 'a'.repeat(64), slug: ''});
  });

  it('claims only when sign-in returns to the claimed board, never on other boards or a fresh start', () => {
    const raw = JSON.stringify({boardId: '9', code: 'a'.repeat(64), slug: SLUG});
    const claim = {boardId: 9n, code: 'a'.repeat(64), slug: SLUG};
    expect(claimForBoard(raw, '', `#b=${SLUG}`)).toEqual(claim);
    expect(claimForBoard(raw, '?db=demo', `#b=${SLUG}`)).toEqual(claim);
    expect(claimForBoard(raw, '', '#b=a1b2c3d4e5f6a7b8c9d0')).toBeUndefined();
    expect(claimForBoard(raw, '?boardId=9', '')).toBeUndefined(); // a slug claim needs its slug
    expect(claimForBoard(raw, '?new=1', `#b=${SLUG}`)).toBeUndefined();
    expect(claimForBoard(raw, '', '')).toBeUndefined();
    // a sign-in begun before slugs comes back to ?boardId=
    const old = JSON.stringify({boardId: '9', code: 'a'.repeat(64)});
    expect(claimForBoard(old, '?boardId=9')).toEqual({...claim, slug: ''});
    expect(claimForBoard(old, '?boardId=10')).toBeUndefined();
  });

  it('returns to the exact failed drawing on sign-out, including an older guest board', () => {
    expect(guestReturnUrl(`http://localhost/?db=demo#b=${SLUG}`, SLUG)).toBe(`http://localhost/?db=demo#b=${SLUG}`);
    expect(guestReturnUrl('http://localhost/?db=demo#b=a1b2c3d4e5f6a7b8c9d0', SLUG)).toBe('http://localhost/?db=demo');
    expect(guestReturnUrl(`http://localhost/?db=demo#b=${SLUG}`, null)).toBe('http://localhost/?db=demo');
    expect(guestReturnUrl('http://localhost/?db=demo&new=1', SLUG)).toBe('http://localhost/?db=demo');
    // an old ?boardId= locator is dropped, never carried into the guest's start page
    expect(guestReturnUrl('http://localhost/?db=demo&boardId=9', '9')).toBe('http://localhost/?db=demo');
  });
});
