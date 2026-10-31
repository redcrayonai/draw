import { describe, it, expect } from 'vitest';
import { selectBoard, hasBoardLink, shouldOpenDashboard, viewOnly, opensNewShareLink } from './board-select';

const boards = [
  { id: 1n, name: 'Demo', slug: '' }, // made before slugs
  { id: 7n, name: 'feat/x', slug: 'a1b2c3d4e5f6a7b8c9d0' },
  { id: 9n, name: 'feat/x', slug: '0f1e2d3c4b5a69788796' }, // names are not unique
];

describe('selectBoard', () => {
  it('?boardId= picks the board by id and wins over ?board=', () => {
    expect(selectBoard(boards, '?boardId=9')).toEqual(boards[2]);
    expect(selectBoard(boards, '?board=Demo&boardId=9&db=rc-dev')).toEqual(boards[2]);
  });

  it('#b= picks the board by slug and wins over query links', () => {
    expect(selectBoard(boards, '?boardId=9', '#b=a1b2c3d4e5f6a7b8c9d0')).toEqual(boards[1]);
    for (const hash of ['#b=nope', '#b=']) {
      expect(selectBoard(boards, '', hash), hash).toBe('This board is unavailable. It may be private or have been deleted.');
    }
  });

  it('?board= picks the first board with that name; bare URLs need a personal board', () => {
    expect(selectBoard(boards, '?board=feat%2Fx')).toEqual(boards[1]);
    expect(typeof selectBoard(boards, '')).toBe('string');
  });

  it('unavailable links never expose other board names or IDs', () => {
    for (const search of ['?boardId=42', '?board=nope']) {
      expect(selectBoard(boards, search)).toBe('This board is unavailable. It may be private or have been deleted.');
    }
  });

  it('a boardId that is not a decimal number is refused, never read as a name or a number', () => {
    for (const bad of ['', 'abc', '-1', '1e3', '0x10', ' 7', '7.0']) {
      expect(selectBoard(boards, `?boardId=${encodeURIComponent(bad)}`), JSON.stringify(bad)).toBe(
        'This board link is invalid.'
      );
    }
  });

  it('explicit links take priority even when their value is invalid', () => {
    expect(hasBoardLink('?db=preview')).toBe(false);
    expect(hasBoardLink('?boardId=')).toBe(true);
    expect(hasBoardLink('?board=Demo')).toBe(true);
    expect(hasBoardLink('', '#b=a1b2')).toBe(true);
    expect(hasBoardLink('', '#other')).toBe(false);
  });

  it('sends signed-in root visitors to the dashboard and preserves explicit destinations', () => {
    expect(shouldOpenDashboard('?db=preview', true)).toBe(true);
    expect(shouldOpenDashboard('', false)).toBe(false);
    expect(shouldOpenDashboard('?boardId=7', true)).toBe(false);
    expect(shouldOpenDashboard('?board=Demo', true)).toBe(false);
    expect(shouldOpenDashboard('?new=1', true)).toBe(false);
    expect(shouldOpenDashboard('?new=0', true)).toBe(true);
    expect(shouldOpenDashboard('', true, '#b=a1b2')).toBe(false);
  });
});

describe('share links', () => {
  const T = 'ab'.repeat(16);
  const links = [{ boardId: 7n, linkToken: T }, { boardId: 9n, linkToken: '' }];

  it('#s= counts as a board link', () => {
    expect(hasBoardLink('', `#s=${T}`)).toBe(true);
    expect(hasBoardLink('', '#s=')).toBe(true);
  });

  it('#s= picks the board whose my_boards row holds the token, and wins over other links', () => {
    expect(selectBoard(boards, '?boardId=9', `#s=${T}`, links)).toEqual(boards[1]);
  });

  it('an unknown, empty or malformed token is unavailable without naming boards', () => {
    for (const hash of ['#s=' + 'cd'.repeat(16), '#s=', '#s=../x']) {
      expect(selectBoard(boards, '', hash, links), hash).toBe('This board is unavailable. It may be private or have been deleted.');
    }
  });

  it('viewOnly: public boards, view links and signed-out edit links; the row decides, not the URL', () => {
    expect(viewOnly(undefined, false)).toBe(false);
    expect(viewOnly({ access: 'owner', linkMode: 'view' }, true)).toBe(false);
    expect(viewOnly({ access: 'team', linkMode: '' }, false)).toBe(false);
    expect(viewOnly({ access: 'public', linkMode: '' }, true)).toBe(true);
    expect(viewOnly({ access: 'link', linkMode: 'view' }, true)).toBe(true);
    expect(viewOnly({ access: 'link', linkMode: 'edit' }, false)).toBe(true);
    expect(viewOnly({ access: 'link', linkMode: 'edit' }, true)).toBe(false);
  });

  it('opensNewShareLink: a #s= token the page did not boot with needs a fresh boot', () => {
    expect(opensNewShareLink(`#s=${'cd'.repeat(16)}`, T)).toBe(true);
    expect(opensNewShareLink(`#s=${T}`, null)).toBe(true);
    expect(opensNewShareLink(`#s=${T}`, T)).toBe(false);
    expect(opensNewShareLink('#b=a1b2c3d4e5f6a7b8c9d0', T)).toBe(false);
    expect(opensNewShareLink('', null)).toBe(false);
  });
});

describe('native board capabilities', () => {
  it('uses server capabilities ahead of legacy access labels, including revocation', () => {
    const owner = { access: 'owner', linkMode: '' };
    expect(viewOnly(owner, true, { canEdit: false, canManage: false })).toBe(true);
    expect(viewOnly({ access: 'link', linkMode: 'view' }, true, { canEdit: true, canManage: false })).toBe(false);
    expect(viewOnly(owner, true, { canEdit: true, canManage: true })).toBe(false);
  });
});
