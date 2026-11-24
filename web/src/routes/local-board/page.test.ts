import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { Timestamp } from 'spacetimedb';
import { myWorkspaces } from '$lib/workspaces';
import Page from './+page.svelte';

const { shareLocalCopy } = vi.hoisted(() => ({ shareLocalCopy: vi.fn() }));
vi.mock('$lib/config', () => ({ config: { accounts: 'test' } }));
vi.mock('$lib/reducer', () => ({ callReducer: (run: Function) => run({ procedures: { shareLocalCopy } }) }));
vi.mock('$lib/session', async () => {
  const { readable } = await import('svelte/store');
  return { session: readable({ status: 'signed-in' }) };
});

it('keeps the confirmed destination and audience if workspace access changes before the snapshot arrives', async () => {
  const origin = 'http://127.0.0.1:12345';
  const opener = { postMessage: vi.fn(), closed: false };
  vi.stubGlobal('opener', opener);
  history.replaceState(null, '', '#action=share&origin=' + encodeURIComponent(origin));
  const personal = { id: 1n, name: 'Personal', personal: true, role: 'owner', createdAt: Timestamp.now() };
  myWorkspaces.set([personal, { ...personal, id: 2n, name: 'Team', personal: false }]);
  shareLocalCopy.mockRejectedValue(new Error('Workspace access was removed.'));
  const message = (data: object) => window.dispatchEvent(new MessageEvent('message', { origin, source: window.opener, data }));
  try {
    render(Page);
    message({ type: 'draw.ready', name: 'Original' });
    await fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '2' } });
    await fireEvent.change(screen.getByLabelText('Who can view?'), { target: { value: 'link' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Share a copy' }));
    expect(opener.postMessage).toHaveBeenCalledWith({ type: 'draw.copy' }, origin);
    myWorkspaces.set([personal]);
    await tick();
    message({ type: 'draw.snapshot', requestKey: 'request', snapshot: {} });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Workspace access was removed.'));
    expect(shareLocalCopy).toHaveBeenCalledExactlyOnceWith({
      workspaceId: '2', linkToken: expect.stringMatching(/\S/), requestKey: 'request', snapshot: '{}',
    });
  } finally {
    myWorkspaces.set([]);
    history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
  }
});
