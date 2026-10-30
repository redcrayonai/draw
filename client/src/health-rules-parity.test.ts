// The dashboard's health counters (module/src/health-rules.ts) must classify
// evidence and parse coverage exactly as the canvas does. The module cannot
// import client code, so it keeps a copy; this test fails when they drift.
import { describe, it, expect } from 'vitest';
import { evidenceClass } from './render';
import { parseCoverage } from './refs';
import * as mod from '../../module/src/health-rules';

const EVIDENCE = [
  '',
  'import',
  'test-import',
  'source:x:1',
  'source:',
  'human:y',
  'human:',
  'agent:user said',
  'agent:',
  'agent',
  'IMPORT',
  ' import',
  'test',
  'tests-import',
  'source',
  'human',
  'garbage',
];

// RC-538: a source citation is proven only while its status is 'ok'
const STATUS = ['ok', 'stale', ''];
const EVIDENCE_STATUS = EVIDENCE.flatMap(ev => STATUS.map(status => [ev, status] as [string, string]));

const COVERAGE = [
  '',
  'not json',
  '{',
  'null',
  '42',
  '"str"',
  '[]',
  '[1,2]',
  '{}',
  '{"changed":3}',
  '{"changed":"3"}',
  '{"changed":1.5}',
  '{"changed":-2}',
  '{"changed":1e400}',
  '{"uncovered":["a",1,null,"b"]}',
  '{"uncovered":"a"}',
  '{"deleted":["d",{}]}',
  '{"excluded":[{"reason":"gen","paths":["p",2]},{"reason":3},null,"x",{"reason":"no-paths"},{"reason":"bad","paths":"p"}]}',
  '{"excluded":{"reason":"r"}}',
  '{"changed":5,"uncovered":["u"],"excluded":[{"reason":"r","paths":["p"]}],"deleted":["d"],"extra":true}',
];

describe('module health rules match the canvas', () => {
  it.each(EVIDENCE_STATUS)('evidenceClass(%j, %j)', (ev, status) => {
    expect(mod.evidenceClass(ev, status)).toBe(evidenceClass(ev, status));
  });

  it.each(COVERAGE)('parseCoverage(%j)', json => {
    expect(mod.parseCoverage(json)).toEqual(parseCoverage(json));
  });
});

describe('edge evidence prefix rules', () => {
  it.each([
    ['human:alan', true, mod.HUMAN_EVIDENCE_RESERVED],
    ['human:alan', false, undefined],
    ['agent:user described it', true, undefined],
    ['agent:user described it', false, undefined], // undo replays an agent's edge as the human
    ['agent:', true, mod.AGENT_EVIDENCE_EMPTY],
    ['agent:   ', false, mod.AGENT_EVIDENCE_EMPTY],
    ['source:a.ts:1', true, undefined],
  ] as const)('checkEvidencePrefix(%j, agent=%j)', (ev, agent, want) => {
    const run = () => mod.checkEvidencePrefix(ev, agent);
    if (want) expect(run).toThrow(want);
    else expect(run).not.toThrow();
  });
});
