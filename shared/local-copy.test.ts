import { expect, it } from 'vitest';
import { localCopy } from './local-copy';
import type { LocalBoard } from './local';

it('shares diagram text and review replies while keeping local capabilities and source paths off the wire', () => {
  const board: LocalBoard = { slug: 'secret-slug', name: 'Checkout', repo: '/secret-repo', revision: 2, nextId: 5,
    conversation: { threadId: 'secret-thread' }, feedback: [], nodes: [{ id: '1', label: 'API', description: 'Checkout service', kind: 'service',
      icon: 'gateway', x: 60, y: 0, w: 160, h: 80, refs: [{ path: 'secret-path', start: 1, end: 2 }] }], edges: [],
    notes: [{ id: '2', target: '1', text: 'Retry?', resolved: false, replies: [{ id: '3', text: 'Yes' }] }] };
  const copy = localCopy(board);
  expect(JSON.stringify(copy)).not.toContain('secret');
  expect(copy.nodes[0]).toMatchObject({ icon: 'gateway', doc: 'Checkout service' });
  expect(copy.nodes[1]).toMatchObject({ label: 'Retry?', doc: 'API\nOpen\nYes' });
});
