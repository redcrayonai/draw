import { expect, it } from 'vitest';
import { DEFAULT_DB, pickDb, setDb } from './db-target';

it('honours ?db= only for an allowed database', () => {
  expect(pickDb('?db=staging', 'prod', 'dev, staging')).toBe('staging');
  expect(pickDb('?db=evil', 'prod', 'dev,staging')).toBe('prod');
  expect(pickDb('?db=evil', 'prod', undefined)).toBe('prod');
  expect(pickDb('?db=', 'prod', '')).toBe('prod');
  expect(pickDb('', 'prod', 'dev')).toBe('prod');
});

it('setDb names every database but the default', () => {
  expect(setDb(new URL('https://x.example/?boardId=1'), DEFAULT_DB).toString()).toBe('https://x.example/?boardId=1');
  expect(setDb(new URL('https://x.example/?boardId=1'), 'rc-dev').toString()).toBe('https://x.example/?boardId=1&db=rc-dev');
});

it('setDb leaves out the home database of the deployment that opens the link', () => {
  expect(setDb(new URL('https://x.example/'), 'redcrayon-staging', 'redcrayon-staging').toString()).toBe('https://x.example/');
  expect(setDb(new URL('https://x.example/'), 'redcrayon', 'redcrayon-staging').toString()).toBe('https://x.example/?db=redcrayon');
  expect(setDb(new URL('https://x.example/'), 'redcrayon', 'redcrayon').toString()).toBe('https://x.example/');
});
