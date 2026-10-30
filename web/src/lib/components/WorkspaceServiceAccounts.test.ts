import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/svelte';
import { Identity, Timestamp } from 'spacetimedb';
import { get } from 'svelte/store';
import { webcrypto, createHash } from 'node:crypto';
import { resetWorkspaces, workspaceServiceAccounts, workspaceApiKeys, serviceAccountState, boardPermissions } from '$lib/workspaces';
const h = vi.hoisted(() => ({ reducers: {
  createWorkspaceServiceAccount: vi.fn(async (_: unknown) => {}),
  updateWorkspaceServiceAccount: vi.fn(async (_: unknown) => {}),
  createWorkspaceApiKey: vi.fn(async (_: unknown) => {}),
  revokeWorkspaceApiKey: vi.fn(async (_: unknown) => {}),
} }));
vi.mock('$lib/stdb', async () => {
  const { writable } = await import('svelte/store');
  return { myBoards: writable([]), identityHex: writable('aa'.repeat(32)), getConn: () => ({ reducers: h.reducers }) };
});
import { myBoards, identityHex } from '$lib/stdb';
import WorkspaceServiceAccounts from './WorkspaceServiceAccounts.svelte';

const owner = new Identity('aa'.repeat(32));
const workspace = { id: 3n, name: 'Acme', personal: false, role: 'owner', createdAt: new Timestamp(1n) };
const account = { id: 7n, workspaceId: 3n, name: 'Build automation', role: 'editor', allBoards: true, boardIds: [], disabled: false, createdAt: new Timestamp(1n), createdBy: owner };
const key = { id: 'ab'.repeat(16), serviceAccountId: 7n, name: 'CI production', role: 'viewer', allBoards: false, boardIds: [12n], expiresAt: undefined, revoked: false, createdAt: new Timestamp(1n), createdBy: owner };
const setBoards = (myBoards as unknown as { set: (rows: unknown[]) => void }).set;
const setIdentity = (identityHex as unknown as { set: (identity: string) => void }).set;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  resetWorkspaces();
  localStorage.clear();
  sessionStorage.clear();
  setIdentity(owner.toHexString());
  serviceAccountState.set('live');
  workspaceServiceAccounts.set([account]);
  workspaceApiKeys.set([key]);
  setBoards([{ boardId: 12n, name: 'Architecture' }, { boardId: 13n, name: 'Roadmap' }, { boardId: 14n, name: 'Other company' }]);
  boardPermissions.set(new Map([
    [12n, { boardId: 12n, workspaceId: 3n }],
    [13n, { boardId: 13n, workspaceId: 3n }],
    [14n, { boardId: 14n, workspaceId: 4n }],
  ]) as never);
});

async function openKeyForm() {
  await fireEvent.click(screen.getByText('Build automation', { selector: 'summary' }));
  return within(screen.getByRole('form', { name: 'Create API key for Build automation' }));
}

describe('workspace service accounts', () => {
  it('creates a named account with selected boards and read-only permission', async () => {
    render(WorkspaceServiceAccounts, { props: { workspace } });
    const form = within(screen.getByRole('form', { name: 'Create service account' }));
    await fireEvent.input(form.getByLabelText('Service account name'), { target: { value: '  Release bot  ' } });
    await fireEvent.change(form.getByLabelText('Service account permission'), { target: { value: 'viewer' } });
    await fireEvent.change(form.getByLabelText('Service account boards'), { target: { value: 'selected' } });
    expect(form.queryByLabelText('Other company')).toBeNull();
    expect(form.getByRole('button', { name: 'create service account' })).toBeDisabled();
    await fireEvent.click(form.getByLabelText('Architecture'));
    await fireEvent.submit(screen.getByRole('form', { name: 'Create service account' }));
    expect(h.reducers.createWorkspaceServiceAccount).toHaveBeenCalledWith({ workspaceId: 3n, name: 'Release bot', role: 'viewer', allBoards: false, boardIds: [12n] });
  });

  it('keeps service account administration private to shared workspace admins', async () => {
    const view = render(WorkspaceServiceAccounts, { props: { workspace: { ...workspace, role: 'member' } } });
    expect(screen.queryByRole('heading', { name: 'Service accounts' })).toBeNull();
    await view.rerender({ workspace: { ...workspace, personal: true } });
    expect(screen.queryByRole('heading', { name: 'Service accounts' })).toBeNull();
  });

  it('reveals a key only after creation, sends only its hash, and forgets it when dismissed', async () => {
    let finish!: () => void;
    h.reducers.createWorkspaceApiKey.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    render(WorkspaceServiceAccounts, { props: { workspace } });
    const form = await openKeyForm();
    await fireEvent.input(form.getByLabelText('Key name'), { target: { value: 'Pipeline' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'Create API key for Build automation' }));
    await waitFor(() => expect(h.reducers.createWorkspaceApiKey).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText('New API key')).toBeNull();
    finish();
    const input = await screen.findByLabelText('New API key');
    const token = (input as HTMLInputElement).value;
    const args = h.reducers.createWorkspaceApiKey.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({ serviceAccountId: 7n, keyId: token.split('_')[1], keyHash: createHash('sha256').update(token).digest('hex'), name: 'Pipeline', role: 'viewer', allBoards: true, boardIds: [], expiresAt: undefined });
    expect(JSON.stringify(args, (_, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain(token);
    expect(Object.values(localStorage)).not.toContain(token);
    expect(Object.values(sessionStorage)).not.toContain(token);
    await fireEvent.click(screen.getByRole('button', { name: 'I saved this key' }));
    expect(screen.queryByLabelText('New API key')).toBeNull();
    expect(get(workspaceApiKeys)).toEqual([key]);
  });

  it('clears a revealed secret on account change and does not reveal an old pending result', async () => {
    render(WorkspaceServiceAccounts, { props: { workspace } });
    const form = await openKeyForm();
    await fireEvent.input(form.getByLabelText('Key name'), { target: { value: 'Pipeline' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'Create API key for Build automation' }));
    await screen.findByLabelText('New API key');
    setIdentity('bb'.repeat(32));
    await waitFor(() => expect(screen.queryByLabelText('New API key')).toBeNull());
    let finish!: () => void;
    h.reducers.createWorkspaceApiKey.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await fireEvent.input(form.getByLabelText('Key name'), { target: { value: 'Another pipeline' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'Create API key for Build automation' }));
    await waitFor(() => expect(h.reducers.createWorkspaceApiKey).toHaveBeenCalledTimes(2));
    setIdentity('cc'.repeat(32));
    finish();
    await waitFor(() => expect(form.getByRole('button', { name: 'create API key' })).toBeEnabled());
    expect(screen.queryByLabelText('New API key')).toBeNull();
  });

  it('copies a new secret, preserves copy fallback, and reports creation failures without displaying a secret', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('blocked')).mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(WorkspaceServiceAccounts, { props: { workspace } });
    const form = await openKeyForm();
    await fireEvent.input(form.getByLabelText('Key name'), { target: { value: 'Pipeline' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'Create API key for Build automation' }));
    const input = await screen.findByLabelText('New API key');
    await fireEvent.click(screen.getByRole('button', { name: 'copy API key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Select the API key and copy it.');
    await fireEvent.click(screen.getByRole('button', { name: 'copy API key' }));
    expect(writeText).toHaveBeenLastCalledWith((input as HTMLInputElement).value);
    expect(await screen.findByRole('button', { name: 'copied' })).toBeInTheDocument();
    h.reducers.createWorkspaceApiKey.mockRejectedValueOnce(new Error('Access changed.'));
    await fireEvent.input(form.getByLabelText('Key name'), { target: { value: 'Other' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'Create API key for Build automation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Access changed.');
    expect(screen.queryByLabelText('New API key')).toBeNull();
  });

  it('narrows keys to account boards, passes optional expiry, and rotates without revoking the original', async () => {
    workspaceServiceAccounts.set([{ ...account, role: 'viewer', allBoards: false, boardIds: [12n] }]);
    render(WorkspaceServiceAccounts, { props: { workspace } });
    const form = await openKeyForm();
    expect(form.getByRole('option', { name: 'Edit' })).toBeDisabled();
    await fireEvent.change(form.getByLabelText('Key boards'), { target: { value: 'selected' } });
    expect(form.queryByLabelText('Roadmap')).toBeNull();
    await fireEvent.click(form.getByLabelText('Architecture'));
    await fireEvent.input(form.getByLabelText('Key name'), { target: { value: 'Limited key' } });
    await fireEvent.input(form.getByLabelText('Expires at (optional)'), { target: { value: '2030-12-31T12:00' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'Create API key for Build automation' }));
    await screen.findByLabelText('New API key');
    const args = h.reducers.createWorkspaceApiKey.mock.calls[0][0] as { boardIds: bigint[]; expiresAt: Timestamp };
    expect(args.boardIds).toEqual([12n]);
    expect(args.expiresAt.toDate()).toEqual(new Date('2030-12-31T12:00'));
    await fireEvent.click(screen.getByRole('button', { name: 'rotate CI production' }));
    expect(form.getByLabelText('Key name')).toHaveValue('CI production replacement');
    expect(h.reducers.revokeWorkspaceApiKey).not.toHaveBeenCalled();
    await fireEvent.submit(screen.getByRole('form', { name: 'Create API key for Build automation' }));
    await waitFor(() => expect(h.reducers.createWorkspaceApiKey).toHaveBeenCalledTimes(2));
    await fireEvent.click(screen.getByRole('button', { name: 'revoke CI production' }));
    expect(h.reducers.revokeWorkspaceApiKey).toHaveBeenCalledWith({ keyId: key.id });
  });

  it('saves account scope and disables its keys without deleting the account', async () => {
    render(WorkspaceServiceAccounts, { props: { workspace } });
    await openKeyForm();
    const form = within(screen.getByRole('form', { name: 'Edit service account Build automation' }));
    await fireEvent.input(form.getByLabelText('Account name'), { target: { value: 'Release' } });
    await fireEvent.change(form.getByLabelText('Account permission'), { target: { value: 'viewer' } });
    await fireEvent.click(form.getByLabelText('Disable service account'));
    await fireEvent.submit(screen.getByRole('form', { name: 'Edit service account Build automation' }));
    expect(h.reducers.updateWorkspaceServiceAccount).toHaveBeenCalledWith({ serviceAccountId: 7n, name: 'Release', role: 'viewer', allBoards: true, boardIds: [], disabled: true });
  });

  it('drops moved boards from the editable selection instead of retaining invisible grants', async () => {
    workspaceServiceAccounts.set([{ ...account, allBoards: false, boardIds: [12n, 13n] }]);
    render(WorkspaceServiceAccounts, { props: { workspace } });
    await openKeyForm();
    setBoards([{ boardId: 12n, name: 'Architecture' }]);
    await waitFor(() => expect(within(screen.getByRole('form', { name: 'Edit service account Build automation' })).queryByLabelText('Roadmap')).toBeNull());
    await fireEvent.submit(screen.getByRole('form', { name: 'Edit service account Build automation' }));
    expect(h.reducers.updateWorkspaceServiceAccount).toHaveBeenCalledWith(expect.objectContaining({ boardIds: [12n] }));
  });

  it('can disable an account after its last selected board moves, and requires a valid board to enable it', async () => {
    workspaceServiceAccounts.set([{ ...account, allBoards: false, boardIds: [12n] }]);
    render(WorkspaceServiceAccounts, { props: { workspace } });
    await openKeyForm();
    setBoards([]);
    const form = within(screen.getByRole('form', { name: 'Edit service account Build automation' }));
    await waitFor(() => expect(form.getByRole('button', { name: 'save' })).toBeDisabled());
    await fireEvent.click(form.getByLabelText('Disable service account'));
    expect(form.getByRole('button', { name: 'save' })).toBeEnabled();
    await fireEvent.submit(screen.getByRole('form', { name: 'Edit service account Build automation' }));
    expect(h.reducers.updateWorkspaceServiceAccount).toHaveBeenCalledWith(expect.objectContaining({ allBoards: false, boardIds: [12n], disabled: true }));
    workspaceServiceAccounts.set([{ ...account, disabled: true, allBoards: false, boardIds: [12n] }]);
    await waitFor(() => expect(form.getByLabelText('Disable service account')).toBeChecked());
    await fireEvent.click(form.getByLabelText('Disable service account'));
    expect(form.getByRole('button', { name: 'save' })).toBeDisabled();
  });
});
