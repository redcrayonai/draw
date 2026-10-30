import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// VITE_AUTH_PROVIDER picks the sign-in this bundle ships: anonymous (the
// default), oidc, or the path of a module with the same exports, from web/.
const BUILT_IN: Record<string, string> = { anonymous: '../shared/auth-anonymous.ts', oidc: '../shared/auth-oidc.ts' };

export default defineConfig(({ mode }) => {
  const provider = loadEnv(mode, process.cwd(), 'VITE_').VITE_AUTH_PROVIDER || 'anonymous';
  return {
    plugins: [sveltekit()],
    // The canvas client owns 5173; VITE_CANVAS_URL and agent dashboard links assume 5174.
    server: { port: 5174, strictPort: true },
    resolve: {
      alias: { $auth: fileURLToPath(new URL(BUILT_IN[provider] ?? provider, import.meta.url)) },
      // $shared (../shared) imports these; resolve them here, where deploy builds install them.
      dedupe: ['@noble/hashes', 'jose'],
      ...(process.env.VITEST ? { conditions: ['browser'] } : {})
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest-setup.ts'],
      globals: true,
      // config.ts fails loud without these; no test connects anywhere.
      env: { VITE_SPACETIME_URI: 'ws://localhost:3000', VITE_SPACETIME_DB: 'vitest' }
    }
  };
});
