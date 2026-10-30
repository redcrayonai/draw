import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// VITE_AUTH_PROVIDER picks the sign-in this bundle ships: anonymous (the
// default), oidc, or the path of a module with the same exports, from client/.
const BUILT_IN: Record<string, string> = { anonymous: '../shared/auth-anonymous.ts', oidc: '../shared/auth-oidc.ts' };

export default defineConfig(({ mode }) => {
  const provider = loadEnv(mode, process.cwd(), 'VITE_').VITE_AUTH_PROVIDER || 'anonymous';
  return {
    build: { rollupOptions: { input: {
      main: fileURLToPath(new URL('./index.html', import.meta.url)),
      embed: fileURLToPath(new URL('./embed.html', import.meta.url)),
    } } },
    resolve: { alias: { $auth: fileURLToPath(new URL(BUILT_IN[provider] ?? provider, import.meta.url)) } },
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
    },
  };
});
