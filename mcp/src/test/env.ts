// A test Env: origins on a test domain, a fresh signing key, no bindings.
import type { Env } from '../env';

export async function newJwk(kid: string): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return JSON.stringify({ ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), kid });
}

export async function testEnv(over: Partial<Env> = {}): Promise<Env> {
  return {
    MCP_ORIGIN: 'https://mcp.redcrayon.test',
    APP_ORIGIN: 'https://app.redcrayon.test',
    OIDC_ISSUER: 'https://auth.redcrayon.test',
    DB_URL: 'http://db.invalid',
    DB_NAME: 'redcrayon',
    AGENT_JWK: await newJwk('k1'),
    VERSION: 'abcdef1234567890',
    USER: undefined as never,
    CAPTURE: undefined as never,
    ...over,
  };
}

import { CaptureVault, type CaptureStub } from '../captures';

/** CAPTURE Durable Objects in memory: one vault per id. */
export function memoryCaptures(now: () => number = Date.now): (id: string) => CaptureStub {
  const stores = new Map<string, CaptureStub>();
  return id => {
    let stub = stores.get(id);
    if (!stub) {
      let held: { chunks: string[]; created: number } | undefined;
      const vault = new CaptureVault({ write: (chunks, created) => void (held = { chunks, created }), take: () => { const h = held; held = undefined; return h; } }, now);
      stub = { put: async text => vault.put(text), take: async () => vault.take() };
      stores.set(id, stub);
    }
    return stub;
  };
}
