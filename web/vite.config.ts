import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv, searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

// VITE_AUTH_PROVIDER picks the sign-in this bundle ships: anonymous (the
// default), oidc, or the path of a module with the same exports, from web/.
const BUILT_IN: Record<string, string> = { anonymous: '../shared/auth-anonymous.ts', oidc: '../shared/auth-oidc.ts' };

// Plugins linked in by `node scripts/builder.mjs link` are served from their real path.
const pluginDir = fileURLToPath(new URL('../plugins', import.meta.url));
const linkedPlugins = existsSync(pluginDir) ? readdirSync(pluginDir).map(name => realpathSync(`${pluginDir}/${name}`)) : [];

export default defineConfig(({ mode }) => {
  const provider = loadEnv(mode, process.cwd(), 'VITE_').VITE_AUTH_PROVIDER || 'anonymous';
  return {
    plugins: [sveltekit()],
    // The canvas client owns 5173; VITE_CANVAS_URL and agent dashboard links assume 5174.
    server: { port: 5174, strictPort: true, fs: { allow: [searchForWorkspaceRoot(process.cwd()), pluginDir, ...linkedPlugins] } },
    resolve: {
      alias: { $auth: fileURLToPath(new URL(BUILT_IN[provider] ?? provider, import.meta.url)) },
      // $shared (../shared) imports these; resolve them here, where deploy builds install them.
      dedupe: ['@noble/hashes', 'jose', 'spacetimedb', '@testing-library/svelte'],
      ...(process.env.VITEST ? { conditions: ['browser'] } : {})
    },
    test: {
      include: ['src/**/*.{test,spec}.{js,ts}', '../plugins/*/{server,web}/**/*.test.ts'],
      environment: 'jsdom',
      setupFiles: ['./vitest-setup.ts'],
      globals: true,
      // config.ts fails loud without these; no test connects anywhere.
      env: { VITE_SPACETIME_URI: 'ws://localhost:3000', VITE_SPACETIME_DB: 'vitest' }
    }
  };
});
