import { blake3 } from '@noble/hashes/blake3.js';

const utf8 = new TextEncoder();

// Port of the database's Identity::from_claims (lib crate, identity.rs,
// v2.8.1): the identity the database assigns to a token with this issuer and
// subject, as lowercase hex without 0x. `iss` must match the token's `iss`
// byte for byte, trailing slash included, so two issuers give different ids.
export function identityFromClaims(iss: string, sub: string): string {
  const hash = blake3(utf8.encode(`${iss}|${sub}`)).subarray(0, 26);
  const checksumInput = new Uint8Array(28);
  checksumInput.set([0xc2, 0x00]);
  checksumInput.set(hash, 2);
  const id = new Uint8Array(32);
  id.set([0xc2, 0x00]);
  id.set(blake3(checksumInput).subarray(0, 4), 2);
  id.set(hash, 6);
  return Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('');
}
