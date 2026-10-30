const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/** Only the hash leaves this browser; the bearer is shown after the server accepts it. */
export async function newWorkspaceApiKey(source: Crypto = crypto): Promise<{ keyId: string; keyHash: string; token: string }> {
  const keyId = hex(source.getRandomValues(new Uint8Array(16)));
  const token = `rcak_${keyId}_${hex(source.getRandomValues(new Uint8Array(32)))}`;
  const keyHash = hex(new Uint8Array(await source.subtle.digest('SHA-256', new TextEncoder().encode(token))));
  return { keyId, keyHash, token };
}
