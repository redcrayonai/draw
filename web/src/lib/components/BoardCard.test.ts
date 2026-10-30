import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import * as account from '$lib/session';
import { Timestamp } from 'spacetimedb';

vi.mock('$lib/config', () => ({
  config: { spacetimeUri: 'ws://127.0.0.1:3100', spacetimeDb: 'redcrayon-test', canvasUrl: 'http://localhost:5173' },
}));

import BoardCard from './BoardCard.svelte';
import { DEMO, at, myBoard, slugOf } from '$lib/test-rows';

const ACME = { id: 'org_1', name: 'Acme', role: 'org:admin' };
const BETA = { id: 'org_2', name: 'Beta', role: 'org:member' };

describe('BoardCard', () => {
  it('opens the board with provider session context attached', () => {
    const link = vi.spyOn(account, 'authenticatedHref').mockImplementation(href => {
      const url = new URL(href);
      url.searchParams.set('__session_hint', 'dev-browser');
      return url.toString();
    });
    render(BoardCard, { props: { board: myBoard({ boardId: 9n, name: 'payments' }), slug: slugOf(9n) } });
    const href = screen.getByRole('link', { name: 'Open in canvas' }).getAttribute('href')!;
    expect(new URL(href).hash).toBe(`#b=${slugOf(9n)}`);
    expect(new URL(href).searchParams.has('boardId')).toBe(false);
    expect(new URL(href).searchParams.get('__session_hint')).toBe('dev-browser');
    expect(link).toHaveBeenCalled();
    link.mockRestore();
  });
  it('renames an owned manual board with a trimmed name and preserves failures for retry', async () => {
    const onrename = vi.fn().mockRejectedValueOnce(new Error('Could not rename this board.')).mockResolvedValue(undefined);
    render(BoardCard, { props: { board: myBoard({ name: 'payments', access: 'owner' }), onrename } });
    await fireEvent.click(screen.getByRole('button', { name: 'Rename payments' }));
    expect(screen.getByLabelText('Board name')).toHaveValue('payments');
    expect(screen.getByLabelText('Board name')).toHaveFocus();
    await fireEvent.input(screen.getByLabelText('Board name'), { target: { value: ' new name ' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'Rename payments' }));
    expect(onrename).toHaveBeenCalledWith('new name');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not rename this board.');
    expect(screen.getByLabelText('Board name')).toHaveValue(' new name ');
    await fireEvent.submit(screen.getByRole('form', { name: 'Rename payments' }));
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('requires the board name to delete, allows cancellation, and retains a failed confirmation', async () => {
    const ondelete = vi.fn().mockRejectedValueOnce(new Error('Could not delete this board.'));
    render(BoardCard, { props: { board: myBoard({ name: 'payments', access: 'owner' }), ondelete } });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete payments' }));
    expect(screen.getByRole('button', { name: 'delete permanently' })).toBeDisabled();
    await fireEvent.submit(screen.getByRole('form', { name: 'Delete payments' }));
    expect(ondelete).not.toHaveBeenCalled();
    await fireEvent.keyDown(screen.getByLabelText('Board name to confirm deletion'), { key: 'Escape' });
    expect(screen.queryByRole('form')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete payments' }));
    await fireEvent.input(screen.getByLabelText('Board name to confirm deletion'), { target: { value: 'payments' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'Delete payments' }));
    expect(ondelete).toHaveBeenCalledOnce();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete this board.');
    expect(screen.getByRole('form', { name: 'Delete payments' })).toBeInTheDocument();
  });

  it('hides owner management for shared access and architecture snapshots', () => {
    const props = { onrename: vi.fn(), ondelete: vi.fn() };
    const first = render(BoardCard, { props: { ...props, board: myBoard({ access: 'public' }) } });
    expect(screen.queryByRole('button', { name: /Rename|Delete/ })).toBeNull();
    first.unmount();
    render(BoardCard, { props: { ...props, board: myBoard({ access: 'owner' }), version: { boardId: 1n, historyId: 7n, index: 0, assertionMode: 'fact', ref: 'main', sha: 'a'.repeat(40), status: 'published' } } });
    expect(screen.queryByRole('button', { name: /Rename|Delete/ })).toBeNull();
  });

  it('prevents duplicate board management submissions while a write is pending', async () => {
    let finish!: () => void;
    const ondelete = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(BoardCard, { props: { board: myBoard({ name: 'payments', access: 'owner' }), ondelete } });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete payments' }));
    await fireEvent.input(screen.getByLabelText('Board name to confirm deletion'), { target: { value: 'payments' } });
    const form = screen.getByRole('form', { name: 'Delete payments' });
    await fireEvent.submit(form);
    await fireEvent.submit(form);
    expect(ondelete).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'deleting…' })).toBeDisabled();
    finish();
  });

  it('labels intent boards and shows proposal status without factual health claims', () => {
    render(BoardCard, { props: { board: DEMO, version: { boardId: 1n, historyId: 7n, index: 0, assertionMode: 'intent', ref: 'main', sha: 'a'.repeat(40), status: 'accepted' } } });
    expect(screen.getByText('intent')).toBeInTheDocument();
    expect(screen.getByText('Proposal')).toBeInTheDocument();
    expect(screen.getByText('accepted')).toBeInTheDocument();
    expect(screen.queryByText(/proven/)).toBeNull();
  });

  it('linked: shown counts, canvas link and access badge, without evidence scores', () => {
    render(BoardCard, { props: { board: DEMO, slug: slugOf(1n) } });
    expect(screen.getByRole('heading', { name: 'Demo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in canvas' })).toHaveAttribute(
      'href',
      `http://localhost:5173/?db=redcrayon-test#b=${slugOf(1n)}`
    );
    expect(screen.getByText('8 nodes · 5 edges')).toBeInTheDocument();
    expect(screen.queryByText(/proven/)).toBeNull();
    expect(screen.getByText('public')).toBeInTheDocument();
    expect(screen.getByText('updated 1h ago')).toBeInTheDocument();
  });

  it('session: checkpoint and relative time, without coverage or evidence lines', () => {
    render(BoardCard, {
      props: {
        board: myBoard({
          isSession: true,
          repoFiles: 4,
          shownNodes: 3,
          shownEdges: 2,
          evImport: 1,
          evSource: 1,
          sessionCheckpoint: 3,
          sessionUpdatedAt: at(4 * 60_000),
          covChanged: 10,
          covOnBoard: 6,
          covExcluded: 2,
          covUncovered: 2,
        }),
      },
    });
    expect(screen.getByText('checkpoint 3 · 4m ago')).toBeInTheDocument();
    expect(screen.queryByText(/not on board/)).toBeNull();
    expect(screen.queryByText(/proven/)).toBeNull();
  });

  it('session without a checkpoint says so', () => {
    render(BoardCard, { props: { board: myBoard({ isSession: true }) } });
    expect(screen.getByText('no checkpoint yet')).toBeInTheDocument();
  });

  it('sketch: counts only, no proven %, no fake link-repo button', () => {
    render(BoardCard, { props: { board: myBoard({ shownNodes: 9, shownEdges: 11, evHuman: 11 }) } });
    expect(screen.getByText('9 nodes · 11 edges')).toBeInTheDocument();
    expect(screen.queryByText(/proven/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('calls a board with no nodes and no edges empty instead of counting zeros', () => {
    render(BoardCard, { props: { board: myBoard() } });
    expect(screen.getByText('empty board')).toBeInTheDocument();
    expect(screen.queryByText(/0 nodes/)).toBeNull();
  });

  it('closes from its own button', async () => {
    const onclose = vi.fn();
    render(BoardCard, { props: { board: myBoard({ name: 'payments' }), onclose } });
    await fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('adds code refs to the stats line', () => {
    render(BoardCard, { props: { board: myBoard({ shownNodes: 2, shownEdges: 1, refsOk: 2, refsStale: 1 }) } });
    expect(screen.getByText('2 nodes · 1 edge · 3 code refs')).toBeInTheDocument();
  });

  it('never shows zeros for a board whose stats are not computed', () => {
    render(BoardCard, { props: { board: myBoard({ statsReady: false, updatedAt: Timestamp.UNIX_EPOCH }) } });
    expect(screen.getByText('Counts are not computed for this board yet.')).toBeInTheDocument();
    expect(screen.queryByText(/nodes/)).toBeNull();
    expect(screen.queryByText(/updated/)).toBeNull();
  });

  it('team boards show the team name as the badge and have no share control', () => {
    render(BoardCard, {
      props: { board: myBoard({ access: 'team', orgId: 'org_1' }), teams: [ACME], onshare: async () => {} },
    });
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.queryByText(/share with/)).toBeNull();
  });

  it('owner cards share and unshare per team and show reducer errors verbatim', async () => {
    const onshare = vi.fn(async (_orgId: string, _share: boolean) => {});
    render(BoardCard, {
      props: { board: myBoard({ access: 'owner', sharedWith: ['org_2'] }), teams: [ACME, BETA], onshare },
    });
    expect(screen.getByText('shared with 1 team')).toBeInTheDocument();
    await fireEvent.click(screen.getByText('share with Acme'));
    expect(onshare).toHaveBeenCalledWith('org_1', true);
    await fireEvent.click(screen.getByText('unshare from Beta'));
    expect(onshare).toHaveBeenCalledWith('org_2', false);
    onshare.mockRejectedValueOnce(new Error('team rule: you are not a member of org org_1; sync your teams and retry'));
    await fireEvent.click(screen.getByText('share with Acme'));
    expect(
      await screen.findByText('team rule: you are not a member of org org_1; sync your teams and retry')
    ).toBeInTheDocument();
  });

  it('owner can still unshare from a team they left, even with no teams left', async () => {
    const onshare = vi.fn(async (_orgId: string, _share: boolean) => {});
    render(BoardCard, { props: { board: myBoard({ access: 'owner', sharedWith: ['org_gone'] }), teams: [], onshare } });
    expect(screen.getByText('shared with 1 team')).toBeInTheDocument();
    await fireEvent.click(screen.getByText('unshare from team org_gone'));
    expect(onshare).toHaveBeenCalledWith('org_gone', false);
  });

  it('owner cards share a board with each linked agent and show reducer errors verbatim', async () => {
    const onagent = vi.fn(async (_agent: string, _grant: boolean) => {});
    const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
    render(BoardCard, { props: { board: myBoard({ access: 'owner' }), agents: [A, B], granted: [B], onagent } });
    expect(screen.getByText('shared with 1 agent')).toBeInTheDocument();
    await fireEvent.click(screen.getByText(`let agent …${A.slice(-8)} edit`));
    expect(onagent).toHaveBeenCalledWith(A, true);
    await fireEvent.click(screen.getByText(`remove agent …${B.slice(-8)}`));
    expect(onagent).toHaveBeenCalledWith(B, false);
    onagent.mockRejectedValueOnce(new Error('share rule: agent is not linked to you'));
    await fireEvent.click(screen.getByText(`let agent …${A.slice(-8)} edit`));
    expect(await screen.findByText('share rule: agent is not linked to you')).toBeInTheDocument();
  });

  it('shows no agent control without linked agents, on shared cards, or without a handler', () => {
    const onagent = async () => {};
    const A = 'aa'.repeat(32);
    const first = render(BoardCard, { props: { board: myBoard({ access: 'owner' }), agents: [], onagent } });
    expect(screen.queryByText(/with an agent/)).toBeNull();
    first.unmount();
    const second = render(BoardCard, { props: { board: myBoard({ access: 'team', orgId: 'org_1' }), agents: [A], onagent } });
    expect(screen.queryByText(/with an agent/)).toBeNull();
    second.unmount();
    render(BoardCard, { props: { board: myBoard({ access: 'owner' }), agents: [A] } });
    expect(screen.queryByText(/with an agent/)).toBeNull();
  });

  it('owner cards share by link even with no teams, and show reducer errors verbatim', async () => {
    const onlink = vi.fn(async (_mode: 'view' | 'edit' | null) => {});
    render(BoardCard, { props: { board: myBoard({ access: 'owner' }), teams: [], onlink } });
    expect(screen.getByText('share with a link')).toBeInTheDocument();
    expect(screen.getByText('Anyone with the link can view. Editing needs sign-in.')).toBeInTheDocument();
    await fireEvent.click(screen.getByText('turn on link sharing'));
    expect(onlink).toHaveBeenCalledWith('view');
    onlink.mockRejectedValueOnce(new Error('share rule: only an owner of board 1 can share it'));
    await fireEvent.click(screen.getByText('turn on link sharing'));
    expect(await screen.findByText('share rule: only an owner of board 1 can share it')).toBeInTheDocument();
  });

  it('a shared owner card switches mode, shows the link, copies it and stops sharing', async () => {
    const onlink = vi.fn(async (_mode: 'view' | 'edit' | null) => {});
    const writeText = vi.fn(async (_t: string) => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const T = 'ab'.repeat(16);
    render(BoardCard, { props: { board: myBoard({ access: 'owner', linkMode: 'view', linkToken: T }), onlink } });
    expect(screen.getByText('shared by link · can view')).toBeInTheDocument();
    expect(screen.getByLabelText('Share link')).toHaveValue(`http://localhost:5173/?db=redcrayon-test#s=${T}`);
    await fireEvent.click(screen.getByText('can edit'));
    expect(onlink).toHaveBeenCalledWith('edit');
    await fireEvent.click(screen.getByText('copy'));
    expect(writeText).toHaveBeenCalledWith(`http://localhost:5173/?db=redcrayon-test#s=${T}`);
    expect(await screen.findByText('copied ✓')).toBeInTheDocument();
    await fireEvent.click(screen.getByText('stop sharing'));
    expect(onlink).toHaveBeenCalledWith(null);
    vi.unstubAllGlobals();
  });

  it('link cards and fact snapshots have no link control', () => {
    const onlink = vi.fn(async () => {});
    const first = render(BoardCard, { props: { board: myBoard({ access: 'link', linkMode: 'edit', linkToken: 'ab'.repeat(16) }), onlink } });
    expect(screen.getByText('can edit')).toBeInTheDocument(); // the badge
    expect(screen.queryByText(/share with a link|shared by link/)).toBeNull();
    first.unmount();
    render(BoardCard, { props: { board: myBoard({ access: 'owner' }), onlink, version: { boardId: 1n, historyId: 7n, index: 0, assertionMode: 'fact', ref: 'main', sha: 'a'.repeat(40), status: 'published' } } });
    expect(screen.queryByText('share with a link')).toBeNull();
  });
});

it('allows native editors to delegate their own linked agent without managing sharing', async () => {
  const onagent = vi.fn(async () => {});
  render(BoardCard, { props: {
    board: myBoard({ access: 'team' }),
    permission: { boardId: 1n, workspaceId: 4n, role: 'editor', defaultRole: 'none', canEdit: true, canManage: false },
    agents: ['bb'.repeat(32)], onagent,
  } });
  await fireEvent.click(screen.getByText('share with an agent'));
  await fireEvent.click(screen.getByRole('button', { name: 'let agent …bbbbbbbb edit' }));
  expect(onagent).toHaveBeenCalledWith('bb'.repeat(32), true);
});
it('offers explicit workspace moves for imported architecture snapshots', () => {
  render(BoardCard, { props: {
    board: myBoard({ access: 'owner' }),
    version: { boardId: 1n, historyId: 7n, index: 0, assertionMode: 'fact', ref: 'main', sha: 'a'.repeat(40), status: 'published' },
    workspaces: [{ id: 4n, name: 'Acme', personal: false, role: 'owner', createdAt: at(1) }],
  } });
  expect(screen.getByText('Move to a workspace')).toBeInTheDocument();
});
