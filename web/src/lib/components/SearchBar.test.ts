import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import SearchBar from './SearchBar.svelte';

describe('SearchBar', () => {
  it('emits typed value via oninput', async () => {
    const spy = vi.fn();
    render(SearchBar, { props: { value: '', oninput: spy } });
    const input = screen.getByRole('searchbox', { name: 'Search boards' });
    await fireEvent.input(input, { target: { value: 'pay' } });
    expect(spy).toHaveBeenCalledWith('pay');
  });
});
