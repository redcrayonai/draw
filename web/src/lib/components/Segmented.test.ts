import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import Segmented from './Segmented.svelte';

describe('Segmented', () => {
  it('is a labelled group whose pressed button is the value', async () => {
    const onchange = vi.fn();
    render(Segmented, { props: { label: 'Sort', options: ['recent', 'name'], value: 'recent', onchange } });
    expect(screen.getByRole('group', { name: 'Sort' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'recent' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'name' })).toHaveAttribute('aria-pressed', 'false');
    await fireEvent.click(screen.getByRole('button', { name: 'name' }));
    expect(onchange).toHaveBeenCalledWith('name');
  });
});
