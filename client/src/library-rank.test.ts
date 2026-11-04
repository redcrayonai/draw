import { describe, it, expect } from 'vitest';
import { rankEntries, type SearchEntry } from './library-rank';

const e = (name: string, over: Partial<SearchEntry<string>> = {}): SearchEntry<string> =>
  ({ value: name, name, id: name.toLowerCase().replace(/\W+/g, '-'), terms: [], group: '', onBoard: false, ...over });
const names = (q: string, list: SearchEntry<string>[]) => rankEntries(q, list).map(r => r.name);

describe('rankEntries', () => {
  it('an exact name beats everything, and a word of a name beats a term', () => {
    expect(names('claude', [e('Model', { terms: ['claude'] }), e('Claude Code'), e('Claude')])).toEqual(['Claude', 'Claude Code', 'Model']);
    expect(names('s3', [e('Other', { terms: ['s3'] }), e('Amazon S3')])).toEqual(['Amazon S3', 'Other']);
  });
  it('a pack on this board outranks a name prefix, not an exact name', () => {
    const list = [e('Blob Storage'), e('Amazon S3', { terms: ['blob'], onBoard: true })];
    expect(names('blob', list)).toEqual(['Amazon S3', 'Blob Storage']);
    expect(names('blob storage', list)).toEqual(['Blob Storage']);
  });
  it('orders prefix, word prefix, exact term, substring, fuzzy, then partial term', () => {
    const list = [e('Zed', { terms: ['storage'] }), e('Cloud Datastore'), e('Restore'), e('My Store'), e('Storage'), e('S T O R')];
    expect(names('stor', list)).toEqual(['Storage', 'My Store', 'Cloud Datastore', 'Restore', 'S T O R', 'Zed']);
  });
  it('an exact term ranks above substring and fuzzy name matches, below prefix and word prefix', () => {
    const list = [e('Restore'), e('Zed', { terms: ['stor'] }), e('My Store')];
    expect(names('stor', list)).toEqual(['My Store', 'Zed', 'Restore']);
    expect(rankEntries('stor', list)[1].term).toBe('stor');
  });
  it('a fuzzy on-board hit does not beat an exact term off-board', () => {
    expect(names('xai', [e('Vertex AI', { onBoard: true }), e('Grok', { terms: ['xai'] })])).toEqual(['Grok', 'Vertex AI']);
  });
  it('within a tier, on-board comes first', () => {
    expect(names('stor', [e('Storage'), e('Store', { onBoard: true })])).toEqual(['Store', 'Storage']);
    expect(names('stor', [e('Cloud Datastore'), e('Restore', { onBoard: true })])).toEqual(['Restore', 'Cloud Datastore']);
  });
  it('fuzzy prefers the tighter span and reports the letters', () => {
    const r = rankEntries('clstor', [e('Cloud Datastore'), e('Cloud Storage')]);
    expect(r.map(x => x.name)).toEqual(['Cloud Storage', 'Cloud Datastore']);
    expect(r[0].highlight).toEqual([0, 1, 6, 7, 8, 9]);
  });
  it('terms are substring only, and report the term', () => {
    expect(names('sg', [e('Amazon S3', { terms: ['storage'] })])).toEqual([]);
    expect(rankEntries('blob', [e('Amazon S3', { terms: ['blob storage'] })])[0].term).toBe('blob storage');
  });
  it('matches ids and section titles below names', () => {
    expect(names('timeseries', [e('Time series', { id: 'timeseries' })])).toEqual(['Time series']);
    expect(names('ai logos', [e('Grok', { group: 'AI logos' })])).toEqual(['Grok']);
  });
  it('one letter is never fuzzy', () => {
    expect(names('z', [e('Amazon S3')])).toEqual(['Amazon S3']); // substring
    expect(names('q', [e('Amazon S3')])).toEqual([]);
  });
  it('treats regex characters as text and blank queries as no match', () => {
    for (const q of ['(', 'c++', '[', '\\', '.*']) expect(() => rankEntries(q, [e('Amazon S3')])).not.toThrow();
    expect(names('c++', [e('C++ thing'), e('Cloud')])).toEqual(['C++ thing']);
    expect(names('   ', [e('Amazon S3')])).toEqual([]);
  });
  it('keeps input order on a tie', () => {
    expect(names('cloud', [e('Vercel', { group: 'Cloud logos' }), e('Neon', { group: 'Cloud logos' })])).toEqual(['Vercel', 'Neon']);
  });
  it('copies name and group, highlights name matches, and leaves id and group matches unhighlighted', () => {
    const [sub] = rankEntries('tor', [e('Restore', { group: 'Cloud' })]);
    expect(sub).toMatchObject({ value: 'Restore', name: 'Restore', group: 'Cloud', highlight: [3, 4, 5] });
    expect(sub.term).toBeUndefined();
    const [word] = rankEntries('sto', [e('My Store')]);
    expect(word.highlight).toEqual([3, 4, 5]);
    const [byId] = rankEntries('timeseries', [e('Time series', { id: 'timeseries' })]);
    expect(byId.highlight).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9, 10]); // fuzzy on name wins first
    const [byGroup] = rankEntries('ai logos', [e('Grok', { group: 'AI logos' })]);
    expect(byGroup.highlight).toEqual([]);
    expect(byGroup.term).toBeUndefined();
  });
  it('fuzzy takes the earliest shortest window', () => {
    expect(rankEntries('ab', [e('a b a b')])[0].highlight).toEqual([0, 2]);
  });
});
