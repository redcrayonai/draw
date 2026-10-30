import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import NewBoardDialog from './NewBoardDialog.svelte';

describe('NewBoardDialog', () => {
  it('sends only one create while a request is pending', async () => {
    let finish!: () => void;
    const create = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const onclose = vi.fn();
    render(NewBoardDialog, { props: { teams: [], create, onclose } });
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'payments' } });
    const form = screen.getByRole('form', { name: 'New board' });
    await fireEvent.submit(form);
    await fireEvent.submit(form);
    expect(create).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'cancel' })).toBeDisabled();
    await fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });
    expect(onclose).not.toHaveBeenCalled();
    finish();
  });
  it('offers Just me plus each team, sends the trimmed name with the owner, and cancels', async () => {
    const create = vi.fn(async (_name: string, _orgId: string) => {});
    const onclose = vi.fn();
    render(NewBoardDialog, { props: { teams: [{ id: 'org_1', name: 'Acme', role: 'org:admin' }], create, onclose } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Just me', 'Acme']);
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: '  payments  ' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'New board' }));
    expect(create).toHaveBeenCalledWith('payments', '');
    await fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onclose).toHaveBeenCalled();
  });

  it('focuses the name on open and cancels on Escape', async () => {
    const onclose = vi.fn();
    render(NewBoardDialog, { props: { teams: [], create: async () => {}, onclose } });
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });
    expect(onclose).toHaveBeenCalledOnce();
  });
});


it('offers native workspace destinations and selects the current workspace', async () => {
  const create = vi.fn(async () => {});
  render(NewBoardDialog, { props: { teams: [], workspaces: [{ id: 4n, name: 'Acme', personal: false, role: 'member' }], destination: 'workspace:4', create, onclose: () => {} } });
  expect(screen.getByLabelText('Owner')).toHaveValue('workspace:4');
  await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'platform' } });
  await fireEvent.submit(screen.getByRole('form', { name: 'New board' }));
  expect(create).toHaveBeenCalledWith('platform', 'workspace:4');
});
