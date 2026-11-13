import { describe, expect, it } from 'vitest';
import { saveTellingArgs } from './tellings';

describe('saveTellingArgs', () => {
  it('fills frame and source and keeps key order', () => {
    expect(saveTellingArgs(1n, { audience: 'Product', title: 'T', steps: [{ nodes: ['2'], title: 'A', body: 'B' }] }, 'claude')).toEqual({
      boardId: 1n,
      audience: 'Product',
      title: 'T',
      steps: '[{"nodes":["2"],"frame":[],"title":"A","body":"B","source":""}]',
      author: 'claude',
    });
  });
});
