import test from 'node:test';
import assert from 'node:assert/strict';
import { boardRole, invitationIsLive, invitationRole, workspaceName } from './workspace-policy.ts';

test('workspace guests only receive explicit board permissions', () => {
  assert.equal(boardRole('guest', 'editor', 'manager', 'viewer'), 'viewer');
  assert.equal(boardRole('guest', 'editor', 'manager', ''), '');
  assert.equal(boardRole('member', 'viewer', 'editor', ''), 'editor');
  assert.equal(boardRole('member', '', '', 'manager'), 'manager');
  assert.equal(boardRole('', 'editor', 'manager', 'manager'), '');
  assert.equal(boardRole('admin', '', '', ''), 'manager');
  assert.equal(boardRole('owner', '', '', ''), 'manager');
});

test('invitations cannot mint ownership or unknown capabilities', () => {
  assert.equal(invitationRole(0n, 'member'), true);
  assert.equal(invitationRole(0n, 'owner'), false);
  assert.equal(invitationRole(4n, 'editor'), true);
  assert.equal(invitationRole(4n, 'admin'), false);
});

test('invitations expire at their exact deadline and remain valid only before it', () => {
  const deadline = 604800000000n;
  assert.equal(invitationIsLive(deadline, deadline - 1n), true, 'one microsecond before expiry');
  assert.equal(invitationIsLive(deadline, deadline), false, 'the exact deadline is expired');
  assert.equal(invitationIsLive(deadline, deadline + 1n), false, 'one microsecond after expiry');
});

test('workspace names reject empty, control and oversized values', () => {
  assert.equal(workspaceName('  Platform  '), 'Platform');
  for (const name of ['', '  ', 'bad\nname', 'x'.repeat(101)]) assert.throws(() => workspaceName(name));
});
