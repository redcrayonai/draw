import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';

vi.mock('$lib/config', () => ({
  config: { spacetimeUri: 'ws://127.0.0.1:3100', spacetimeDb: 'redcrayon-test', canvasUrl: 'http://localhost:5173' },
}));

import ArchitectureHistories from './ArchitectureHistories.svelte';

const HISTORY = { id: 7n, name: 'payments', repository: 'https://github.com/acme/payments', refsJson: JSON.stringify([{ ref: 'main', sha: 'a'.repeat(40) }]), status: 'ready', error: '' };

describe('ArchitectureHistories', () => {
  it('deletes a history only after its name is typed, and keeps the form on a failure', async () => {
    const ondelete = vi.fn().mockRejectedValueOnce(new Error('Could not delete this history.'));
    render(ArchitectureHistories, { props: { histories: [HISTORY], versions: [], ondelete } });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete history payments' }));
    expect(screen.getByText('Delete “payments”, its versions and their boards permanently? This cannot be undone.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'delete permanently' })).toBeDisabled();
    await fireEvent.submit(screen.getByRole('form', { name: 'Delete payments' }));
    expect(ondelete).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('form')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete history payments' }));
    await fireEvent.input(screen.getByLabelText('History name to confirm deletion'), { target: { value: 'payments' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'Delete payments' }));
    expect(ondelete).toHaveBeenCalledWith(7n);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete this history.');
    expect(screen.getByRole('form', { name: 'Delete payments' })).toBeInTheDocument();
  });

  it('offers no delete without a handler', () => {
    render(ArchitectureHistories, { props: { histories: [HISTORY], versions: [] } });
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });
});
