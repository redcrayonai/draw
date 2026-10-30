import { fileURLToPath } from 'node:url';

export default {
  envDir: false,
  resolve: { alias: {
    $auth: fileURLToPath(new URL('./auth-provider.mjs', import.meta.url)),
    ...(process.env.E2E_BINDINGS ? { './module_bindings/index': `${process.env.E2E_BINDINGS}/index.ts` } : {}),
  } },
  // A redeploy builds into the dir vite preview serves; emptying it would 404 a page
  // that reloads mid-build. Like a real deploy, old hashed assets stay until the new index lands.
  // shortcut: a reload in the ms between the new index.html and its chunks landing can still 404;
  // build into a temp dir and rename it over E2E_ASSETS if schema-upgrade flakes again.
  build: { outDir: process.env.E2E_ASSETS, emptyOutDir: false, rollupOptions: { input: {
    main: fileURLToPath(new URL('../client/index.html', import.meta.url)),
    embed: fileURLToPath(new URL('../client/embed.html', import.meta.url)),
  } } },
};
