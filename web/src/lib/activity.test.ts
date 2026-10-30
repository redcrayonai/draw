import { describe, it, expect, vi } from 'vitest';

vi.mock('./config', () => ({
  config: { spacetimeUri: 'ws://127.0.0.1:3100', spacetimeDb: 'redcrayon-test', canvasUrl: 'http://localhost:5173' },
}));

import { Identity, Timestamp } from 'spacetimedb';
import { actorLabel, filterFeed, marker, phrase, phraseParts, toEvent } from './activity';
import { activityEvent as ev } from './test-rows';

describe('phrase', () => {
  it.each([
    ['created payments', ev({ type: 'board.created', payload: { name: 'payments', via: 'manual' } })],
    ['shared payments with a team', ev({ type: 'board.shared', payload: { orgId: 'org_1' } })],
    ['stopped sharing payments with a team', ev({ type: 'board.unshared', payload: { orgId: 'org_1' } })],
    ['shared payments with an agent', ev({ type: 'board.agent_shared', payload: {} })],
    ['stopped sharing payments with an agent', ev({ type: 'board.agent_unshared', payload: {} })],
    ['shared payments by link (can edit)', ev({ type: 'board.link_shared', payload: { mode: 'edit' } })],
    ['shared payments by link (view only)', ev({ type: 'board.link_shared', payload: { mode: 'view' } })],
    ['stopped sharing payments by link', ev({ type: 'board.link_unshared', payload: {} })],
    ["included threats and code in the link to payments", ev({ type: 'board.link_includes', payload: { threats: true, code: true } })],
    ["included code in the link to payments", ev({ type: 'board.link_includes', payload: { threats: false, code: true } })],
    ["stopped including threats and code in the link to payments", ev({ type: 'board.link_includes', payload: { threats: false, code: false } })],
    ['started a session for redcrayonai on payments', ev({ type: 'session.started', payload: { repo: 'redcrayonai' } })],
    ['started a session on payments', ev({ type: 'session.started', payload: {} })],
    [
      'checkpoint 3 on payments: 6 of 10 changed files on the board',
      ev({ type: 'session.checkpoint', payload: { checkpoint: 3, changed: 10, onBoard: 6, uncovered: 2 } }),
    ],
    ['added “API Gateway” to payments', ev({ type: 'node.created' })],
    ['added 3 nodes to payments', ev({ type: 'node.created', count: 3 })],
    ['deleted “old” from payments', ev({ type: 'node.deleted', payload: { label: 'old' } })],
    ['deleted 2 nodes from payments', ev({ type: 'node.deleted', count: 2 })],
    ['hid “log” on payments', ev({ type: 'node.hidden', payload: { label: 'log' } })],
    ['unhid 4 nodes on payments', ev({ type: 'node.unhidden', count: 4 })],
    [
      'connected “api” → “db” (import) on payments',
      ev({ type: 'edge.created', payload: { from: 'api', to: 'db', evidence: 'import' } }),
    ],
    [
      'connected “api” → “db” (no evidence) on payments',
      ev({ type: 'edge.created', payload: { from: 'api', to: 'db', evidence: 'none' } }),
    ],
    [
      'connected “api” → “db” (stale source) on payments',
      ev({ type: 'edge.created', payload: { from: 'api', to: 'db', evidence: 'stale' } }),
    ],
    ['drew 12 edges on payments', ev({ type: 'edge.created', count: 12 })],
    ['deleted an edge on payments', ev({ type: 'edge.deleted', payload: { evidence: 'none' } })],
    ['hid 2 edges on payments', ev({ type: 'edge.hidden', count: 2 })],
    ['unhid an edge on payments', ev({ type: 'edge.unhidden' })],
    ['added 1 repo file to payments', ev({ type: 'repo.files_added', payload: { added: 1 } })],
    ['added 40 repo files to payments', ev({ type: 'repo.files_added', payload: { added: 40 } })],
    ['added repo files to payments in 3 batches', ev({ type: 'repo.files_added', count: 3, payload: { added: 40 } })],
    ['linked drain on payments', ev({ type: 'coderef.added', payload: { symbol: 'drain', path: 'web/x.ts' } })],
    ['linked 5 code refs on payments', ev({ type: 'coderef.added', count: 5 })],
    ['removed the code ref to drain from payments', ev({ type: 'coderef.removed', payload: { symbol: 'drain' } })],
    ['removed 2 code refs from payments', ev({ type: 'coderef.removed', count: 2 })],
    ['marked drain stale on payments', ev({ type: 'coderef.status', payload: { symbol: 'drain', status: 'stale' } })],
    ['updated 2 code ref statuses on payments', ev({ type: 'coderef.status', count: 2 })],
    ['flagged Migration 0042 on payments', ev({ type: 'changenote.added', payload: { title: 'Migration 0042', kind: 'migration' } })],
    ['flagged 3 changes on payments', ev({ type: 'changenote.added', count: 3 })],
    ['removed the change note Migration 0042 from payments', ev({ type: 'changenote.removed', payload: { title: 'Migration 0042' } })],
    ['removed 2 change notes from payments', ev({ type: 'changenote.removed', count: 2 })],
    ['reviewed Migration 0042 on payments', ev({ type: 'changenote.reviewed', payload: { title: 'Migration 0042' } })],
    ['reviewed 2 changes on payments', ev({ type: 'changenote.reviewed', count: 2 })],
    ['flagged a threat on payments', ev({ type: 'threat.added', payload: { stage: 'vulnerable' } })],
    ['flagged a compromised node on payments', ev({ type: 'threat.added', payload: { stage: 'compromised' } })],
    ['removed a threat from payments', ev({ type: 'threat.removed', payload: {} })],
    ['contained a threat on payments', ev({ type: 'threat.contained', payload: {} })],
    // a burst keeps only the last payload, so a count never claims a stage
    ['flagged 3 threats on payments', ev({ type: 'threat.added', count: 3, payload: { stage: 'compromised' } })],
    ['removed 2 threats from payments', ev({ type: 'threat.removed', count: 2 })],
    ['contained 2 threats on payments', ev({ type: 'threat.contained', count: 2 })],
    // members-only data never reaches the feed, even from an old row that still carries a title
    ['flagged a threat on payments', ev({ type: 'threat.added', payload: { title: 'openssl RCE', stage: 'vulnerable' } })],
    ['future.thing on payments ×2', ev({ type: 'future.thing', count: 2 })],
  ])('%s', (text, e) => {
    expect(phrase(e, 'payments')).toBe(text);
    const { before, after } = phraseParts(e);
    expect(`${before}payments${after}`).toBe(text); // the split never loses a word
  });
});

describe('phraseParts', () => {
  it('splits around the board name wherever the phrase puts it', () => {
    expect(phraseParts(ev({ type: 'board.created' }))).toEqual({ before: 'created ', after: '' });
    expect(
      phraseParts(ev({ type: 'session.checkpoint', payload: { checkpoint: 3, changed: 10, onBoard: 6 } }))
    ).toEqual({ before: 'checkpoint 3 on ', after: ': 6 of 10 changed files on the board' });
  });
});

describe('actorLabel and marker', () => {
  const me = 'ab'.repeat(32);
  it('names the caller "you", else the participant name, else kind plus the last 6 hex of the identity', () => {
    // every identity starts with the same c200 prefix, so the tail tells actors apart
    const nameless = `c200${'0'.repeat(54)}1a2b3c`;
    expect(actorLabel(ev({ actor: me }), me)).toBe('you');
    expect(actorLabel(ev({ actorName: 'maya' }), '')).toBe('maya');
    expect(actorLabel(ev({ actorName: '', actor: nameless }), '')).toBe('human-1a2b3c');
    expect(actorLabel(ev({ actorName: '', actor: nameless, actorKind: 'agent' }), '')).toBe('agent-1a2b3c');
  });
  it('agent = dashed, human = square, anything else = round', () => {
    expect(marker({ actorKind: 'agent' })).toBe('dashed');
    expect(marker({ actorKind: 'human' })).toBe('square');
    expect(marker({ actorKind: 'system' })).toBe('round');
  });
});

describe('my_activity rows', () => {
  const row = { id: 9n, boardId: 4n, type: 'node.created', actor: new Identity('cd'.repeat(32)), actorName: '', actorKind: 'robot',
    at: new Timestamp(60_000_000n), lastAt: new Timestamp(120_000_000n), count: 2, payload: '[1, 2]' };
  it('read as feed events with string ids, hex actors and ISO times; a payload that is not an object reads as {}', () => {
    expect(toEvent(row)).toEqual({ id: '9', boardId: '4', type: 'node.created', actor: 'cd'.repeat(32), actorName: '', actorKind: 'human',
      at: new Date(60_000).toISOString(), lastAt: new Date(120_000).toISOString(), count: 2, payload: {} });
    expect(toEvent({ ...row, actorKind: 'agent', payload: '{"label":"Queue"}' })).toMatchObject({ actorKind: 'agent', payload: { label: 'Queue' } });
  });
  it('filter to what a page shows, and pass loading and errors through', () => {
    const feed = { events: [ev({ id: '1', boardId: '1' }), ev({ id: '2', boardId: '2' }), ev({ id: '3', boardId: '1' })] };
    expect(filterFeed(feed, (e) => e.boardId === '1')).toEqual({ events: [feed.events[0], feed.events[2]] });
    expect(filterFeed(feed, () => true, 2)).toEqual({ events: [feed.events[0], feed.events[1]] });
    expect(filterFeed(null, () => true)).toBeNull();
    expect(filterFeed({ error: 'x' }, () => true)).toEqual({ error: 'x' });
  });
});
