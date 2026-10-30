import { beforeEach, expect, it } from 'vitest';
import { readAnonymousToken, saveAnonymousToken, clearAnonymousToken } from './anonymous-identity';

const key = 'stdb_token:ws://localhost:3000/test';
beforeEach(() => { localStorage.clear(); document.cookie = `rc_guest_${encodeURIComponent(key)}=; Path=/; Max-Age=0`; });

it('shares only an explicitly enabled loopback development identity across local ports', () => {
  saveAnonymousToken(key, 'guest-token', true);
  localStorage.clear();
  expect(readAnonymousToken(key, true)).toBe('guest-token');
  expect(readAnonymousToken(key, false)).toBeUndefined();
  clearAnonymousToken(key, true);
  expect(readAnonymousToken(key, true)).toBeUndefined();
});

it('keeps normal anonymous sessions in local storage', () => {
  saveAnonymousToken(key, 'local-token', false);
  expect(document.cookie).not.toContain('local-token');
  expect(readAnonymousToken(key, false)).toBe('local-token');
});
