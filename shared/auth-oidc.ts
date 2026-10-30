import { createOidcProvider } from './oidc';

// VITE_AUTH_PROVIDER=oidc. Register a public client (PKCE, no secret) whose
// redirect URIs are the canvas and dashboard origins with a trailing slash.
const issuer = import.meta.env.VITE_OIDC_ISSUER;
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID;
if (!issuer || !clientId) throw new Error('VITE_AUTH_PROVIDER=oidc needs VITE_OIDC_ISSUER and VITE_OIDC_CLIENT_ID');

export const { accounts, initAuth } = createOidcProvider(issuer, clientId);
