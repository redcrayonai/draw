import { describe, it, expect } from 'vitest';
import { embedHref, embedSnippet, embedToken } from './embed-link';

describe('chart embed capabilities', () => {
  const token = 'ab'.repeat(16);
  it('keeps the secret in the fragment, drops board locators, and preserves the database and theme', () => {
    const url = new URL(embedHref('https://draw.example/?board=private#b=private', 'staging', token, 'dark'));
    expect(url.pathname).toBe('/embed.html');
    expect(url.search).toBe('?db=staging&theme=dark');
    expect(url.hash).toBe(`#e=${token}`);
    expect(embedHref('https://draw.example/', 'redcrayon', token)).toBe(`https://draw.example/embed.html#e=${token}`);
    expect(embedToken(url.hash)).toBe(token);
    expect(embedToken('#e=bad')).toBeNull();
    expect(embedToken(`#s=${token}`)).toBeNull();
  });
  it('escapes titles and URL query separators in copyable HTML', () => {
    expect(embedSnippet('https://draw.example/embed.html?db=dev&theme=dark#e=ab', '"><script>')).toContain('title="&quot;&gt;&lt;script&gt;"');
    expect(embedSnippet('https://draw.example/?a=1&b=2', 'chart')).toContain('?a=1&amp;b=2');
  });
});
