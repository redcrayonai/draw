import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv, searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

// VITE_AUTH_PROVIDER picks the sign-in this bundle ships: anonymous (the
// default), oidc, or the path of a module with the same exports, from client/.
const BUILT_IN: Record<string, string> = { anonymous: '../shared/auth-anonymous.ts', oidc: '../shared/auth-oidc.ts' };

// Plugins linked in by `node scripts/builder.mjs link` are served from their real path.
const pluginDir = fileURLToPath(new URL('../plugins', import.meta.url));
// A link whose checkout moved is skipped, not fatal: `builder unlink` removes it.
const linkedPlugins = existsSync(pluginDir) ? readdirSync(pluginDir).flatMap(name => { try { return [realpathSync(`${pluginDir}/${name}`)]; } catch { return []; } }) : [];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const provider = env.VITE_AUTH_PROVIDER || 'anonymous';
  // VITE_CANVAS_EXTRA: a module (from client/, or absolute) that adds to the canvas; see src/extra.ts.
  const extra = env.VITE_CANVAS_EXTRA || './src/extra.ts';
  return {
    build: { rollupOptions: { input: {
      main: fileURLToPath(new URL('./index.html', import.meta.url)),
      embed: fileURLToPath(new URL('./embed.html', import.meta.url)),
      local: fileURLToPath(new URL('./local.html', import.meta.url)),
    } } },
    server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), pluginDir, ...linkedPlugins] } },
    resolve: { alias: {
      $auth: fileURLToPath(new URL(BUILT_IN[provider] ?? provider, import.meta.url)),
      $extra: fileURLToPath(new URL(extra, import.meta.url)),
      // The canvas plugin interface (plugins/README.md): a plugin's client/ part imports only this.
      '@draw/canvas': fileURLToPath(new URL('./src/plugin-api.ts', import.meta.url)),
    } },
    test: {
      include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)', 'test/**/*.{test,spec}.?(c|m)[jt]s?(x)', '../plugins/*/client/**/*.test.ts'],
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
    },
  };
});
