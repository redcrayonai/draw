import { describe, it, expect } from 'vitest';
import { githubBlobUrl } from './code-link';

const S = 'a'.repeat(40);
const URL_ = `https://github.com/o/r/blob/${S}/src/a%20b%23c.ts#L3-L5`;

describe('githubBlobUrl', () => {
  it.each([
    'git@github.com:o/r.git',
    'git@github.com:o/r',
    'https://github.com/o/r',
    'https://github.com/o/r.git',
    'https://user@github.com/o/r.git',
    'ssh://git@github.com/o/r.git',
    'https://GitHub.com/o/r/',
  ])('links %s', remote => {
    expect(githubBlobUrl(remote, S, 'src/a b#c.ts', 3, 5)).toBe(URL_);
  });

  it('keeps dots and dashes in the owner and repo names', () => {
    expect(githubBlobUrl('git@github.com:my-org/some.repo.git', S, 'a.ts', 1, 1)).toBe(`https://github.com/my-org/some.repo/blob/${S}/a.ts#L1-L1`);
  });

  it.each([
    'git@gitlab.com:o/r.git',
    'https://gitlab.com/o/r',
    'https://github.com.evil.test/o/r',
    'https://evil.test/github.com/o/r',
    'https://github.com/o',
    'https://github.com/o/r/extra',
    'git@github.com:o/r.git"onmouseover="x',
    '',
  ])('does not link %s', remote => {
    expect(githubBlobUrl(remote, S, 'a.ts', 1, 2)).toBeNull();
  });

  it('needs a commit', () => {
    expect(githubBlobUrl('https://github.com/o/r', '', 'a.ts', 1, 2)).toBeNull();
  });

  it('refuses a path that leaves the repo', () => {
    expect(githubBlobUrl('https://github.com/o/r', S, '../a.ts', 1, 2)).toBeNull();
    expect(githubBlobUrl('https://github.com/o/r', S, '/etc/a.ts', 1, 2)).toBeNull();
  });
});
