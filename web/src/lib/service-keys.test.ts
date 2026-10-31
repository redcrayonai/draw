import { describe, expect, it } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
import { newWorkspaceApiKey } from './service-keys';

describe('workspace API key creation', () => {
  it('uses independent random identifiers and secrets and hashes the whole bearer', async () => {
    const first = await newWorkspaceApiKey(webcrypto as unknown as Crypto);
    const second = await newWorkspaceApiKey(webcrypto as unknown as Crypto);
    expect(first.token).toMatch(/^rcak_[a-f0-9]{32}_[a-f0-9]{64}$/);
    expect(first.token.split('_')[1]).toBe(first.keyId);
    expect(first.keyHash).toBe(createHash('sha256').update(first.token).digest('hex'));
    expect(second.keyId).not.toBe(first.keyId);
    expect(second.token).not.toBe(first.token);
  });
});
