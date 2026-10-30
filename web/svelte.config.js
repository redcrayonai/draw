import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  kit: {
    // Pinned to 7.x (Kit 2); 8.x needs Kit 3. Settings come from adapter.wrangler.jsonc.
    adapter: adapter({ config: 'adapter.wrangler.jsonc' }),
    // The DB HTTP client and identity code, shared with the mcp Worker.
    alias: { $shared: '../shared' }
  }
};
