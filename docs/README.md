# Docs

From this directory, run:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Run `corepack pnpm build` to build the static site.

## Algolia DocSearch

The site uses the [official Starlight DocSearch plugin](https://starlight.astro.build/guides/site-search/#algolia-docsearch).
Without Algolia settings, it uses Starlight's built-in search.

1. Set up a DocSearch index and crawler for the published docs URL in
   [Algolia DocSearch](https://docsearch.algolia.com/docs/docsearch-program/).
   The index must contain crawled pages before searches can return results.
2. Copy `.env.example` to `.env` and fill in the application ID, **search-only**
   API key, and index name. These values are public and appear in the built site.
   Never use an admin key.
3. Restart the dev server or rebuild the site.

For GitHub Actions, set these repository **Variables** under
**Settings → Secrets and variables → Actions → Variables**:

- `PUBLIC_ALGOLIA_APP_ID`
- `PUBLIC_ALGOLIA_SEARCH_API_KEY`
- `PUBLIC_ALGOLIA_INDEX_NAME`

The docs build workflow passes them to Astro. Set the same variables in any
future deployment workflow; changing them requires a rebuild.
Leave all three unset to use local search. Partial configuration fails with
setup instructions.
