import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
vi.mock('$lib/plugins.generated', async () => ({ WEB_PARTS: [
  { id: 'broken', web: { BoardPanel: (await import('./fixtures/ThrowingPanel.svelte')).default } },
] }));
import BoardCard from './BoardCard.svelte';
import { myBoard, slugOf } from '$lib/test-rows';

it('keeps the card and its actions working when a plugin panel throws', async () => {
  const onrename = vi.fn();
  render(BoardCard, { props: {
    board: myBoard({ boardId: 9n, name: 'payments', access: 'owner' }),
    permission: { boardId: 9n, workspaceId: 4n, role: 'owner', canEdit: true, canManage: true, defaultRole: '' },
    slug: slugOf(9n), onrename, ondelete: vi.fn(),
  } });
  expect(screen.getByRole('heading', { name: 'payments' })).toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent("This plugin's panel failed. The rest of the card works.");
  expect(screen.getByRole('link', { name: 'Open in canvas' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Delete payments' })).toBeEnabled();
  await fireEvent.click(screen.getByRole('button', { name: 'Rename payments' }));
  expect(screen.getByRole('form', { name: 'Rename payments' })).toBeInTheDocument();
});
