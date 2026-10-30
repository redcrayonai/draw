import { describe, expect, it } from 'vitest';
import { readPrivacyUrl } from './privacy-url';

describe('readPrivacyUrl', () => {
  it('takes an http(s) URL', () => {
    expect(readPrivacyUrl('https://example.com/privacy')).toBe('https://example.com/privacy');
    expect(readPrivacyUrl(' http://localhost:5174/privacy ')).toBe('http://localhost:5174/privacy');
  });

  it('shows no link when unset or not an http(s) URL', () => {
    for (const v of [undefined, '', '  ', 'privacy', 'javascript:alert(1)', 'mailto:a@example.com', 42]) {
      expect(readPrivacyUrl(v)).toBeUndefined();
    }
  });
});
