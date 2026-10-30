import { describe, it, expect } from 'vitest';
import { accessLine, paintAccessLine } from './access-line';

const row = (access: string, linkMode = '', sharedWith: string[] = []) => ({ access, linkMode, sharedWith });

describe('accessLine (RC-570)', () => {
  it('public boards say anyone can view', () => {
    expect(accessLine(row('public'))).toBe('public · anyone can view');
  });

  it('an edit link says only signed-in holders can edit', () => {
    expect(accessLine(row('owner', 'edit', ['org_1']))).toBe('link sharing on · signed-in people with the link can edit');
    expect(accessLine(row('link', 'edit'))).toBe('link sharing on · signed-in people with the link can edit');
  });

  it('a view link says anyone with it can view', () => {
    expect(accessLine(row('owner', 'view'))).toBe('link sharing on · anyone with the link can view');
    expect(accessLine(row('link', 'view'))).toBe('link sharing on · anyone with the link can view');
  });

  it('a team grant, seen by the owner or a teammate', () => {
    expect(accessLine(row('owner', '', ['org_1']))).toBe('shared with a team');
    expect(accessLine(row('team'))).toBe('shared with a team');
  });

  it('an owner board with no sharing is private', () => {
    expect(accessLine(row('owner'))).toBe('private');
  });

  it('says nothing for rows that cannot tell', () => {
    expect(accessLine(row('grant'))).toBeUndefined();
    expect(accessLine(row('agent'))).toBeUndefined();
  });
});

describe('paintAccessLine', () => {
  it('hides the line until a row arrives, then shows its text', () => {
    document.body.innerHTML = '<p id="access-line" hidden></p>';
    const el = document.getElementById('access-line')!;
    paintAccessLine(undefined);
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe('');
    paintAccessLine(row('owner'));
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('private');
    paintAccessLine(row('grant'));
    expect(el.hidden).toBe(true);
  });
});

it('describes native capabilities without mistaking a viewer for a public share link', () => {
  expect(accessLine(row('link', 'view'), { workspaceId: 4n, canEdit: false, canManage: false })).toBe('workspace board · view only');
  expect(accessLine(row('team'), { workspaceId: 4n, canEdit: true, canManage: false })).toBe('workspace board · can edit');
  expect(accessLine(row('owner'), { workspaceId: 4n, canEdit: true, canManage: true })).toBe('workspace board · can manage access');
});
