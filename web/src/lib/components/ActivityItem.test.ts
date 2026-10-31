import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';

vi.mock('$lib/config', () => ({
  config: { spacetimeUri: 'ws://127.0.0.1:3100', spacetimeDb: 'redcrayon-test', canvasUrl: 'http://localhost:5173' },
}));

import ActivityItem from './ActivityItem.svelte';
import { activityEvent, slugOf } from '$lib/test-rows';

const ME = 'ab'.repeat(32);

describe('ActivityItem', () => {
  it('renders actor, the counted phrase with only the board name linked, marker and time', () => {
    render(ActivityItem, {
      props: {
        event: activityEvent({ boardId: '7', type: 'edge.created', count: 12, actorName: 'redcrayon-agent', actorKind: 'agent' }),
        boardName: 'payments',
        slug: slugOf(7n),
      },
    });
    expect(screen.getByText('redcrayon-agent').closest('p')).toHaveTextContent('redcrayon-agent (agent) drew 12 edges on payments');
    expect(screen.getByRole('link', { name: 'payments' })).toHaveAttribute(
      'href',
      `http://localhost:5173/?db=redcrayon-test#b=${slugOf(7n)}`
    );
    expect(screen.getByTestId('marker')).toHaveClass('dashed');
    expect(screen.getByTestId('marker')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('marker')).toHaveTextContent('R'); // monogram of the actor label
    expect(screen.getByText('(agent)')).toBeInTheDocument(); // the glyph's meaning, for screen readers
    expect(screen.getByText('4m ago')).toBeInTheDocument();
  });

  it('names the caller "you" with a filled human marker in the selection tint', () => {
    render(ActivityItem, { props: { event: activityEvent({ actor: ME, actorName: '' }), boardName: 'payments', me: ME } });
    expect(screen.getByText('you')).toBeInTheDocument();
    expect(screen.getByTestId('marker')).toHaveClass('square');
    expect(screen.getByTestId('marker')).toHaveClass('you');
    expect(screen.queryByText('(agent)')).toBeNull();
  });
});
