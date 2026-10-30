import { describe, it, expect } from 'vitest';
import { parseRequireAuth, readSpacetime } from './config';

describe('parseRequireAuth', () => {
  it('treats only the documented enable values as true', () => {
    expect(parseRequireAuth('1')).toBe(true);
    expect(parseRequireAuth('true')).toBe(true);
    expect(parseRequireAuth('TRUE')).toBe(true);
    expect(parseRequireAuth(' 1 ')).toBe(true);
  });

  it('treats false-like and empty values as false', () => {
    expect(parseRequireAuth('0')).toBe(false);
    expect(parseRequireAuth('false')).toBe(false);
    expect(parseRequireAuth('')).toBe(false);
    expect(parseRequireAuth('   ')).toBe(false);
    expect(parseRequireAuth(undefined)).toBe(false);
    expect(parseRequireAuth(null)).toBe(false);
  });
});

describe('readSpacetime', () => {
  const env = { VITE_SPACETIME_URI: 'ws://localhost:3000', VITE_SPACETIME_DB: 'redcrayon-dash' };

  it('reads the uri and db and defaults the canvas url', () => {
    expect(readSpacetime(env, '')).toEqual({
      spacetimeUri: 'ws://localhost:3000',
      spacetimeDb: 'redcrayon-dash',
      canvasUrl: 'http://localhost:5173',
    });
  });

  it('lets ?db= override the database only when the build allows it', () => {
    const allowing = { ...env, VITE_SPACETIME_DB_ALLOWED: 'redcrayon-staging' };
    expect(readSpacetime(allowing, '?db=redcrayon-staging').spacetimeDb).toBe('redcrayon-staging');
    expect(readSpacetime(allowing, '?db=attacker').spacetimeDb).toBe('redcrayon-dash');
    expect(readSpacetime(env, '?db=redcrayon-staging').spacetimeDb).toBe('redcrayon-dash');
    expect(readSpacetime(allowing, '?db=').spacetimeDb).toBe('redcrayon-dash');
  });

  it('uses VITE_CANVAS_URL when set', () => {
    expect(readSpacetime({ ...env, VITE_CANVAS_URL: 'https://canvas.example' }, '').canvasUrl).toBe(
      'https://canvas.example'
    );
  });

  it('fails loud when the uri or db is missing', () => {
    expect(() => readSpacetime({ VITE_SPACETIME_DB: 'x' }, '')).toThrow(/VITE_SPACETIME_URI is not set/);
    expect(() => readSpacetime({ VITE_SPACETIME_URI: 'ws://x' }, '')).toThrow(/VITE_SPACETIME_DB is not set/);
  });
});
