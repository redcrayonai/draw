import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { lineHash, lineHashes } from './code-hash';

describe('code-hash (RC-690)', () => {
  it('lineHash is the first 32 lowercase hex characters of the line\'s SHA-256', () => {
    const full = createHash('sha256').update('const a = 1', 'utf8').digest('hex');
    expect(lineHash('const a = 1')).toBe(full.slice(0, 32));
    expect(lineHash('const a = 1')).toMatch(/^[0-9a-f]{32}$/);
    expect(lineHash('é')).toBe(createHash('sha256').update(Buffer.from('é', 'utf8')).digest('hex').slice(0, 32));
  });

  it('lineHashes hashes each line in order', () => {
    expect(lineHashes([])).toEqual([]);
    expect(lineHashes(['a', 'b'])).toEqual([lineHash('a'), lineHash('b')]);
  });
});
