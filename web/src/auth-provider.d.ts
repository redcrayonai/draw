// `$auth` resolves at build time to the VITE_AUTH_PROVIDER module (vite.config.ts).
declare module '$auth' {
  export const accounts: import('$shared/browser-auth').AuthProvider['accounts'];
  export const initAuth: import('$shared/browser-auth').AuthProvider['initAuth'];
}
