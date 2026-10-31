import { describe, expect, it } from 'vitest';
import { addThreatArgs, threatSummaries, updateThreatArgs } from './threats';

describe('threat args', () => {
  const base = { anchorId: '4', stage: 'compromised', severity: 'critical', title: 'CVE-2026-31337', summary: 'JWT bypass' } as const;

  it('writes flags and source as JSON, and empty strings when absent', () => {
    const a = addThreatArgs(1n, { ...base, flags: ['KEV'], source: { system: 'Splunk', ref: 'notable #1' } }, 'bot');
    expect(a).toMatchObject({ boardId: 1n, anchorId: 4n, flags: '["KEV"]', source: '{"system":"Splunk","ref":"notable #1"}', author: 'bot' });
    expect(addThreatArgs(1n, base, '')).toMatchObject({ flags: '', source: '', cvss: '', package: '', fixedIn: '' });
  });

  it('fields left out stay undefined on update', () => {
    const u = updateThreatArgs({ threatId: '3', stage: 'compromised' });
    expect(u).toEqual({ id: 3n, stage: 'compromised' });
    expect(Object.values(u).filter(v => v === undefined)).toHaveLength(8);
    expect(updateThreatArgs({ threatId: '3', flags: [] }).flags).toBe('[]');
  });
});

describe('threatSummaries', () => {
  it('is undefined when empty; contained is containedBy set; sorted by id', () => {
    expect(threatSummaries([])).toBeUndefined();
    const row = { anchorId: 1n, stage: 'vulnerable', severity: 'high', title: 't' };
    expect(threatSummaries([{ ...row, id: 2n, containedBy: 'x' }, { ...row, id: 1n, containedBy: '' }])).toEqual([
      { id: '1', anchorId: '1', stage: 'vulnerable', severity: 'high', title: 't', contained: false },
      { id: '2', anchorId: '1', stage: 'vulnerable', severity: 'high', title: 't', contained: true },
    ]);
  });
});
