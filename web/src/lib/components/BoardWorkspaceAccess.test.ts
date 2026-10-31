import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { Identity, Timestamp } from 'spacetimedb';
import { resetWorkspaces, workspaceMembers, workspaceBoardGrants, workspaceTeamGrants } from '$lib/workspaces';
const h = vi.hoisted(() => ({ setWorkspaceBoardMember: vi.fn(async (_: unknown) => {}), setWorkspaceBoardTeam: vi.fn(async (_: unknown) => {}) }));
vi.mock('$lib/stdb', () => ({ getConn: () => ({ reducers: { setWorkspaceBoardMember: h.setWorkspaceBoardMember, setWorkspaceBoardTeam: h.setWorkspaceBoardTeam } }) }));
import BoardWorkspaceAccess from './BoardWorkspaceAccess.svelte';
beforeEach(() => { resetWorkspaces(); vi.clearAllMocks(); });
it('lets a guest manager revoke existing collaborators without the workspace roster', async () => {
  const manager = new Identity('aa'.repeat(32));
  const collaborator = new Identity('bb'.repeat(32));
  workspaceMembers.set([{ id: 1n, workspaceId: 4n, member: manager, role: 'guest', name: 'Guest manager' }]);
  workspaceBoardGrants.set([{ id: 1n, boardId: 2n, member: collaborator, role: 'editor' }]);
  render(BoardWorkspaceAccess, { props: {
    boardId: 2n,
    permission: { boardId: 2n, workspaceId: 4n, role: 'manager', defaultRole: 'none', canManage: true, canEdit: true },
    workspaces: [{ id: 4n, name: 'Client', personal: false, role: 'guest', createdAt: new Timestamp(1n) }],
  } });
  await fireEvent.click(screen.getByText('Access · Client'));
  const role = screen.getByRole('combobox', { name: 'Board role for Member bbbbbbbb' });
  expect(role).toHaveValue('editor');
  await fireEvent.change(role, { target: { value: '' } });
  expect(h.setWorkspaceBoardMember).toHaveBeenCalledWith({ boardId: 2n, member: collaborator, role: '' });
});

it('lets a guest manager revoke existing team access without discovering other teams', async () => {
  workspaceTeamGrants.set([{ id: 1n, boardId: 2n, teamId: 9n, role: 'editor' }]);
  render(BoardWorkspaceAccess, { props: {
    boardId: 2n,
    permission: { boardId: 2n, workspaceId: 4n, role: 'manager', defaultRole: 'none', canManage: true, canEdit: true },
    workspaces: [{ id: 4n, name: 'Client', personal: false, role: 'guest', createdAt: new Timestamp(1n) }],
  } });
  await fireEvent.click(screen.getByText('Access · Client'));
  const role = screen.getByRole('combobox', { name: 'Board role for team Team 9' });
  expect(role).toHaveValue('editor');
  await fireEvent.change(role, { target: { value: '' } });
  expect(h.setWorkspaceBoardTeam).toHaveBeenCalledWith({ boardId: 2n, teamId: 9n, role: '' });
});
