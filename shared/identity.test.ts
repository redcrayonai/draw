import { expect, it } from 'vitest';
import { identityFromClaims } from './identity';

it('derives the identity the database assigns to an (iss, sub) pair', () => {
  // A token the local server issued; this is the identity it reported for it.
  expect(identityFromClaims('localhost', 'a4bbb5fb-3c0c-44b4-8bd7-57b7d41fab9b')).toBe(
    'c200ba442d4987321578a3376323c5fdee07128c22a273ca119f80a80452c038'
  );
});

it('keeps a browser identity blake3(iss|sub): grants and agent links name it', () => {
  // Pinned when the module's browser issuer stopped being vendor-specific (RC-597); it must never change.
  expect(identityFromClaims('https://auth.example.com', 'user_2abcDEF')).toBe(
    'c2007a16d93c8a309ffa25899151cc526ea21f4ae3a1af0d2f34ee04902ff8ab'
  );
});
