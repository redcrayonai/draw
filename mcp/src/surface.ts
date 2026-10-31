/**
 * Everything the Worker says to a client, as text, for the vendor scan
 * (spec §12: tools/list, instructions, every failure row, the HTTP bodies,
 * the metadata documents, serverInfo). `pnpm run surface` writes it.
 */
import { z } from 'zod';
import * as copy from './copy';
import { discovery } from './issuer';
import { INSTRUCTIONS, TOOLS } from './tools';
import type { Env } from './env';

const env = { MCP_ORIGIN: 'https://mcp.example.com', APP_ORIGIN: 'https://app.example.com', OIDC_ISSUER: 'https://auth.example.com' } as Env;

export function surface(): string {
  const out: string[] = [INSTRUCTIONS];
  for (const [name, def] of Object.entries(TOOLS)) out.push(name, def.title, def.description, JSON.stringify(z.toJSONSchema(def.input)));
  out.push(
    copy.NO_TOKEN,
    copy.SIGN_IN_ENDED,
    copy.MISSING_SCOPE,
    copy.TOO_LARGE,
    copy.tooMany(30),
    copy.boardNotFound('42'),
    copy.linkNotFound('https://app.example.com/#b=c4bb879c7355360696d9'),
    copy.targetNotFound('node', '17', 'main'),
    copy.noSession('Demo'),
    copy.rateLimited(12),
    copy.planLimit(3, 'October', 'support@example.com'),
    copy.quotaSpent('support@example.com'),
    copy.unavailableWrite('7f3a9c'),
    copy.unavailableRead('7f3a9c'),
    copy.internalError('7f3a9c'),
    copy.unconfirmed('7f3a9c'),
    copy.idTooLarge('9007199254740993'),
    copy.sameCall(3),
    copy.captureNeeded('add_code_ref', 'ref src/a.ts --board 42'),
    copy.captureNeeded('mark_checkpoint', 'checkpoint --board 42 --base abc'),
    JSON.stringify({ error: 'not_found' }),
    JSON.stringify({ error: 'method_not_allowed' }),
    JSON.stringify({ error: 'forbidden_origin' }),
    JSON.stringify({ error: 'internal_error', ref: '7f3a9c' }),
    JSON.stringify({ error: 'temporarily_unavailable' }),
    JSON.stringify(discovery(env)),
    JSON.stringify({ name: 'draw', title: 'draw' }),
  );
  return out.join('\n') + '\n';
}
