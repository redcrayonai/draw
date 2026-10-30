// The sign-in this build ships: `$auth` is the module VITE_AUTH_PROVIDER names
// (vite.config.ts). Guest loads never call initAuth.
export { initAuth } from '$auth';
export { SignedOutError, type BrowserAuth as Auth } from '../../shared/browser-auth';
