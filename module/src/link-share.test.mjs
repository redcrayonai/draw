import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAccountSender, isBrowserSession, isLinkMode, isShareToken } from './link-share.ts';

const BROWSER = { browser: 'https://auth.example.com', sessionClaim: 'sid', variant: 'production' };
// audience as the SDK reads it: aud as a list, [] when absent
const jwt = (issuer, payload = {}) => ({ issuer, audience: [payload.aud ?? []].flat(), fullPayload: payload });

test('a browser session with its session claim is an account; everything else is not', () => {
  assert.equal(isAccountSender(jwt(BROWSER.browser, { sid: 'sess_1' }), BROWSER), true);
  assert.equal(isAccountSender(jwt(BROWSER.browser, {}), BROWSER), false, 'OAuth tokens of the same issuer carry no sid');
  assert.equal(isAccountSender(jwt(BROWSER.browser, { sid: '' }), BROWSER), false);
  assert.equal(isAccountSender(jwt('http://localhost:8788/agent-id', { sid: 'sess_1' }), BROWSER), false, 'our issuer: guests and agents');
  assert.equal(isAccountSender(jwt('localhost', {}), BROWSER), false, 'DB-minted identities');
  assert.equal(isAccountSender(undefined, BROWSER), false);
});

test('without a session claim every token of the browser issuer is an account', () => {
  const plain = { ...BROWSER, sessionClaim: '' };
  assert.equal(isAccountSender(jwt(BROWSER.browser, {}), plain), true);
  assert.equal(isAccountSender(jwt('localhost', {}), plain), false);
  assert.equal(isAccountSender(undefined, plain), false);
});

test('without a browser issuer only the local variant counts every sender as an account', () => {
  const local = { browser: '', sessionClaim: '', variant: 'local' };
  assert.equal(isAccountSender(undefined, local), true);
  assert.equal(isAccountSender(jwt('localhost', {}), local), true);
  for (const variant of ['production', 'staging', 'none']) {
    const issuers = { browser: '', sessionClaim: '', variant };
    assert.equal(isAccountSender(undefined, issuers), false, variant);
    assert.equal(isAccountSender(jwt('localhost', { sid: 'sess_1' }), issuers), false, `${variant} with a jwt`);
  }
});

const APP = 'https://board.example.com';
// The hosted service: session tokens name the app origin in azp and carry sid; no client ids.
const HOSTED = { ...BROWSER, appOrigins: [APP], browserClientIds: [] };
// A standard OIDC provider (Keycloak): azp, when sent, is the client id; no session claim.
const OIDC = { ...BROWSER, sessionClaim: '', appOrigins: [APP], browserClientIds: ['redcrayon'] };

test('a browser session names one of our client ids in azp, or in aud when it has no azp', () => {
  assert.equal(isBrowserSession(jwt(OIDC.browser, { azp: 'redcrayon', aud: 'redcrayon' }), OIDC), true, 'Keycloak ID token');
  assert.equal(isBrowserSession(jwt(OIDC.browser, { azp: 'redcrayon', aud: 'account' }), OIDC), true, 'azp decides when present');
  assert.equal(isBrowserSession(jwt(OIDC.browser, { azp: APP }), OIDC), true, 'an app origin still counts');
  assert.equal(isBrowserSession(jwt(OIDC.browser, { aud: 'redcrayon' }), OIDC), true, 'no azp, aud = client id');
  assert.equal(isBrowserSession(jwt(OIDC.browser, { aud: ['other', 'redcrayon'] }), OIDC), true, 'no azp, aud list with the client id');
  assert.equal(isBrowserSession(jwt(OIDC.browser, { aud: 'other-client' }), OIDC), false, 'no azp, aud names another client');
  assert.equal(isBrowserSession(jwt(OIDC.browser, { aud: APP }), OIDC), false, 'aud is checked against client ids only');
  assert.equal(isBrowserSession(jwt(OIDC.browser, {}), OIDC), false, 'neither azp nor aud');
  assert.equal(isBrowserSession(jwt(OIDC.browser, { azp: 'other-client', aud: 'redcrayon' }), OIDC), false, 'azp names another client');
  assert.equal(isBrowserSession(jwt(OIDC.browser, { azp: '', aud: 'redcrayon' }), OIDC), false, 'an empty azp is still an azp');
  assert.equal(isBrowserSession(jwt('https://elsewhere.example', { azp: 'redcrayon' }), OIDC), false, 'another issuer');
  assert.equal(isBrowserSession(undefined, OIDC), false);
});

test("the hosted service's rule is unchanged: sid and azp in the app origins, nothing else", () => {
  assert.equal(isBrowserSession(jwt(HOSTED.browser, { sid: 'sess_1', azp: APP }), HOSTED), true);
  assert.equal(isBrowserSession(jwt(HOSTED.browser, { azp: APP }), HOSTED), false, 'OAuth token: no sid');
  assert.equal(isBrowserSession(jwt(HOSTED.browser, { sid: 'sess_1', azp: 'https://elsewhere.example' }), HOSTED), false, 'another app');
  assert.equal(isBrowserSession(jwt(HOSTED.browser, { sid: 'sess_1', azp: 'redcrayon' }), HOSTED), false, 'a client id is no app origin');
  assert.equal(isBrowserSession(jwt(HOSTED.browser, { sid: 'sess_1' }), HOSTED), false, 'no azp');
  assert.equal(isBrowserSession(jwt(HOSTED.browser, { sid: 'sess_1', aud: APP }), HOSTED), false, 'no azp: aud never names an app origin');
});

test('without a browser issuer no token is a browser session, the local variant included', () => {
  for (const variant of ['local', 'production', 'none']) {
    const issuers = { browser: '', sessionClaim: '', appOrigins: [APP], browserClientIds: ['redcrayon'], variant };
    assert.equal(isBrowserSession(jwt('localhost', { azp: 'redcrayon' }), issuers), false, variant);
    assert.equal(isBrowserSession(undefined, issuers), false, variant);
  }
});

test('modes and tokens', () => {
  assert.equal(isLinkMode('view'), true);
  assert.equal(isLinkMode('edit'), true);
  for (const v of ['', 'View', 'comment', null, 1]) assert.equal(isLinkMode(v), false, String(v));
  assert.equal(isShareToken('0123456789abcdef0123456789abcdef'), true);
  for (const v of ['', '0123456789ABCDEF0123456789ABCDEF', '0123456789abcdef', '0123456789abcdef0123456789abcdef0', '../x', null]) {
    assert.equal(isShareToken(v), false, String(v));
  }
});
