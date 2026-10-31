import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';

vi.mock('$lib/config', () => ({
  config: { spacetimeUri: 'ws://127.0.0.1:3100', spacetimeDb: 'redcrayon-test', canvasUrl: 'http://localhost:5173' },
}));

import ActivityList from './ActivityList.svelte';
import { activityEvent } from '$lib/test-rows';

const names = new Map([['7', 'payments']]);
const events = (n: number) => Array.from({ length: n }, (_, i) => activityEvent({ id: String(i + 1) }));

describe('ActivityList', () => {
  it('shows the newest 8, then all of them on demand without fetching', async () => {
    render(ActivityList, { props: { result: { events: events(11) }, names } });
    expect(screen.getAllByTestId('marker')).toHaveLength(8);
    await fireEvent.click(screen.getByRole('button', { name: 'show all (11)' }));
    expect(screen.getAllByTestId('marker')).toHaveLength(11);
    expect(screen.queryByRole('button', { name: /show all/ })).toBeNull();
  });

  it('offers no show-all for 8 or fewer', () => {
    render(ActivityList, { props: { result: { events: events(8) }, names } });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('loads, fails and empties in place', () => {
    const { unmount } = render(ActivityList, { props: { result: null, names } });
    expect(screen.getByRole('status')).toHaveTextContent('Loading activity…');
    unmount();
    const failed = render(ActivityList, { props: { result: { error: 'Activity is not set up on this deployment yet.' }, names } });
    expect(screen.getByRole('alert')).toHaveTextContent('Activity is not set up on this deployment yet.');
    failed.unmount();
    render(ActivityList, { props: { result: { events: [] }, names } });
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });
});
