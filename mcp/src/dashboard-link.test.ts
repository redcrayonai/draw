import { describe, it, expect } from 'vitest';
import { dashboardLinkUrl, newLinkCode } from './dashboard-link';

describe('dashboard link (spec §4)', () => {
  it('newLinkCode is 32 random bytes in base64url, inside the module rule', () => {
    const a = newLinkCode();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newLinkCode()).not.toBe(a);
  });

  it('dashboardLinkUrl points at /link with the code and any non-default database', () => {
    expect(dashboardLinkUrl('http://localhost:5174/', 'redcrayon', 'abc_-9')).toBe('http://localhost:5174/link?code=abc_-9');
    expect(dashboardLinkUrl('https://dash.example', 'rc dev', 'x')).toBe('https://dash.example/link?code=x&db=rc+dev');
  });
});
