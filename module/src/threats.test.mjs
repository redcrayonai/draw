import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isThreatKind,
  THREAT_FIELD_RULE,
  THREAT_FLAGS_RULE,
  THREAT_JSON_RULE,
  THREAT_SEVERITY_RULE,
  THREAT_STAGE_RULE,
  THREAT_SUMMARY_RULE,
  THREAT_TITLE_RULE,
  THREAT_URL_RULE,
  MAX_SOURCE_CHARS,
  canRaiseStage,
  checkSeverity,
  checkStage,
  checkThreatFields,
  checkThreatText,
  parseFlags,
  parseSource,
  severityRank,
  worstThreat,
} from './threats.ts';

test('stage and severity', () => {
  assert.equal(checkStage('compromised'), 'compromised');
  assert.throws(() => checkStage('exploited'), { message: THREAT_STAGE_RULE });
  assert.equal(checkSeverity('critical'), 'critical');
  assert.throws(() => checkSeverity('CRITICAL'), { message: THREAT_SEVERITY_RULE }); // agent maps scanner case
});

test('text limits', () => {
  checkThreatText('CVE-1', 'x');
  assert.throws(() => checkThreatText('', 'x'), { message: THREAT_TITLE_RULE });
  assert.throws(() => checkThreatText('x'.repeat(121), 'x'), { message: THREAT_TITLE_RULE });
  assert.throws(() => checkThreatText('CVE-1', ''), { message: THREAT_SUMMARY_RULE });
  assert.throws(() => checkThreatText('CVE-1', 'x'.repeat(201)), { message: THREAT_SUMMARY_RULE });
});

test('optional field limits', () => {
  checkThreatFields('', '', '', '');
  checkThreatFields('x'.repeat(8), 'x'.repeat(120), 'x'.repeat(40), 'x'.repeat(80));
  for (const args of [
    ['x'.repeat(9), '', '', ''],
    ['', 'x'.repeat(121), '', ''],
    ['', '', 'x'.repeat(41), ''],
    ['', '', '', 'x'.repeat(81)],
  ]) assert.throws(() => checkThreatFields(...args), { message: THREAT_FIELD_RULE }, args.map(a => a.length).join());
  assert.equal(THREAT_FIELD_RULE, 'threat cvss, package, fixedIn and author must be at most 8, 120, 40 and 80 characters');
});

test('flags', () => {
  assert.deepEqual(parseFlags(''), []);
  assert.deepEqual(parseFlags('["KEV","exploit public"]'), ['KEV', 'exploit public']);
  assert.throws(() => parseFlags('["a","b","c","d","e","f","g"]'), { message: THREAT_FLAGS_RULE });
  assert.throws(() => parseFlags(JSON.stringify(['x'.repeat(25)])), { message: THREAT_FLAGS_RULE });
  assert.throws(() => parseFlags('[""]'), { message: THREAT_FLAGS_RULE });
  assert.throws(() => parseFlags('[1]'), { message: THREAT_JSON_RULE });
  assert.throws(() => parseFlags('{"a":1}'), { message: THREAT_JSON_RULE });
  assert.throws(() => parseFlags('not json'), { message: THREAT_JSON_RULE });
});

test('source', () => {
  assert.equal(parseSource(''), null);
  assert.deepEqual(parseSource('{"system":"Splunk","ref":"notable #48213"}'), { system: 'Splunk', ref: 'notable #48213' });
  assert.deepEqual(parseSource('{"system":"S","ref":"r","url":"https://x/1"}'), { system: 'S', ref: 'r', url: 'https://x/1' });
  assert.throws(() => parseSource('{"system":"S","ref":"r","url":"http://x"}'), { message: THREAT_URL_RULE });
  assert.throws(() => parseSource('{"system":"S","ref":"r","url":"javascript:alert(1)"}'), { message: THREAT_URL_RULE });
  for (const bad of ['[]', '"s"', 'null', 'not json', '{"ref":"r"}', '{"system":"S"}', '{"system":"","ref":"r"}', '{"system":"S","ref":""}'])
    assert.throws(() => parseSource(bad), { message: THREAT_JSON_RULE }, bad);
  assert.throws(() => parseSource(JSON.stringify({ system: 'x'.repeat(MAX_SOURCE_CHARS + 1), ref: 'r' })), { message: THREAT_JSON_RULE });
  assert.throws(() => parseSource(JSON.stringify({ system: 'S', ref: 'x'.repeat(MAX_SOURCE_CHARS + 1) })), { message: THREAT_JSON_RULE });
});

test('stage only rises', () => {
  assert.equal(canRaiseStage('vulnerable', 'compromised'), true);
  assert.equal(canRaiseStage('vulnerable', 'vulnerable'), true);
  assert.equal(canRaiseStage('compromised', 'compromised'), true);
  assert.equal(canRaiseStage('compromised', 'vulnerable'), false);
});

test('severity rank', () => {
  assert.deepEqual(['critical', 'high', 'medium', 'low'].map(severityRank), [0, 1, 2, 3]);
});

test('worstThreat orders open, compromised, severity', () => {
  const r = (stage, severity, containedBy = '') => ({ stage, severity, containedBy });
  assert.equal(worstThreat([]), undefined);
  assert.deepEqual(worstThreat([r('vulnerable', 'critical'), r('compromised', 'low')]), r('compromised', 'low'));
  assert.deepEqual(worstThreat([r('compromised', 'critical', 'ann'), r('vulnerable', 'low')]), r('vulnerable', 'low'));
  assert.deepEqual(worstThreat([r('vulnerable', 'low'), r('vulnerable', 'high')]), r('vulnerable', 'high'));
  assert.deepEqual(worstThreat([r('compromised', 'low', 'a'), r('vulnerable', 'high', 'b')]), r('compromised', 'low', 'a'));
});

test('isThreatKind: systems only, legacy blank is a service', () => {
  for (const k of ['', 'service', 'datastore', 'external']) assert.equal(isThreatKind(k), true, k);
  for (const k of ['note', 'boundary', 'chart', 'queue']) assert.equal(isThreatKind(k), false, k);
});
