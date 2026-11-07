import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// VITE_AUTH_PROVIDER picks the sign-in this bundle ships: anonymous (the
// default), oidc, or the path of a module with the same exports, from client/.
const BUILT_IN: Record<string, string> = { anonymous: '../shared/auth-anonymous.ts', oidc: '../shared/auth-oidc.ts' };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const provider = env.VITE_AUTH_PROVIDER || 'anonymous';
  // VITE_CANVAS_EXTRA: a module (from client/, or absolute) that adds to the canvas; see src/extra.ts.
  const extra = env.VITE_CANVAS_EXTRA || './src/extra.ts';
  return {
    build: { rollupOptions: { input: {
      main: fileURLToPath(new URL('./index.html', import.meta.url)),
      embed: fileURLToPath(new URL('./embed.html', import.meta.url)),
    } } },
    resolve: { alias: {
      $auth: fileURLToPath(new URL(BUILT_IN[provider] ?? provider, import.meta.url)),
      $extra: fileURLToPath(new URL(extra, import.meta.url)),
    } },
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
    },
  };
});
