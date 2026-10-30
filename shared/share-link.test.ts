import { describe, it, expect } from 'vitest';
import { newShareToken, shareHref, shareTokenOf } from './share-link';

describe('share links', () => {
  it('shareHref keeps only a non-default db in the query and puts the token in the fragment', () => {
    expect(shareHref('https://draw.example.com/?boardId=4&new=1#b=abc', 'rc-dev', 'ab'.repeat(16)))
      .toBe(`https://draw.example.com/?db=rc-dev#s=${'ab'.repeat(16)}`);
    expect(shareHref('https://draw.example.com/?boardId=4', 'redcrayon', 'ab'.repeat(16)))
      .toBe(`https://draw.example.com/#s=${'ab'.repeat(16)}`);
  });

  it('newShareToken is 32 lowercase hex characters and never repeats', () => {
    const a = newShareToken(), b = newShareToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('shareTokenOf reads #s= and nothing else', () => {
    expect(shareTokenOf('#s=abc')).toBe('abc');
    expect(shareTokenOf('#s=')).toBe('');
    expect(shareTokenOf('#b=abc')).toBeNull();
    expect(shareTokenOf('')).toBeNull();
  });
});
