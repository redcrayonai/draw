import { describe, expect, it } from 'vitest';
import { origins, type Env } from './env';

describe('board URLs', () => {
  const env = {
    MCP_ORIGIN: 'https://mcp.example.com',
    APP_ORIGIN: 'https://draw.example.com',
    OIDC_ISSUER: 'https://auth.example.com',
  } as Env;

  // APP_ORIGIN serves DB_NAME, its home database, so the link never names it.
  it('links a board by its slug, naming no database', () => {
    expect(origins({ ...env, DB_NAME: 'redcrayon' }).boardUrl('k3x9q2m7p1w4r8t6y5u0')).toBe('https://draw.example.com/#b=k3x9q2m7p1w4r8t6y5u0');
    expect(origins({ ...env, DB_NAME: 'redcrayon-staging' }).boardUrl('k3x9q2m7p1w4r8t6y5u0'))
      .toBe('https://draw.example.com/#b=k3x9q2m7p1w4r8t6y5u0');
  });

  it('never falls back to ?boardId= for a board without a slug', () => {
    expect(() => origins({ ...env, DB_NAME: 'redcrayon' }).boardUrl('')).toThrow(/backfill_board_slugs/);
  });
});
