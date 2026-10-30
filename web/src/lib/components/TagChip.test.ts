import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import TagChip from './TagChip.svelte';

describe('TagChip', () => {
  it('shows label and count', () => {
    render(TagChip, { props: { label: 'infra', count: 2 } });
    expect(screen.getByText('infra')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('marks active chips with aria-pressed', () => {
    render(TagChip, { props: { label: 'payments', active: true } });
    expect(screen.getByRole('button', { name: /payments/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
