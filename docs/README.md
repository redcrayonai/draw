# Docs

From this directory, run:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Run `corepack pnpm build` to build the static site.

## Deploy to GitHub Pages

The docs publish at **https://docs.redcrayon.ai**. The `docs` workflow builds
and tests every pull request. A push to `main` also uploads the checked
`docs/dist` artifact and deploys it through the `github-pages` environment.
Manual runs deploy only when **Run workflow** selects `main`.

One-time GitHub setup, under **Settings → Pages**:

1. Choose **GitHub Actions** as the build source.
2. Choose **Public** site visibility so readers and the DocSearch crawler can access it.
3. Set **Custom domain** to `docs.redcrayon.ai`.
4. Once DNS resolves and GitHub provisions the certificate, enable **Enforce HTTPS**.

The `terraform-gcp` repository manages the Cloudflare DNS record:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | docs | redcrayonai.github.io | DNS only |

The CNAME target has no `/draw` path. Configure the custom domain in GitHub
before adding DNS. With a custom Actions workflow, GitHub stores the domain
in repository settings; a `CNAME` file in the artifact is not required.
The Astro `site` setting uses the custom domain with no `/draw` base path.

See [GitHub's custom-domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
To roll back, revert the docs change on `main`; the workflow publishes the
previous content after its checks pass.

## Algolia DocSearch

The site uses the [official Starlight DocSearch plugin](https://starlight.astro.build/guides/site-search/#algolia-docsearch).
Without Algolia settings, it uses Starlight's built-in search.

1. Set up a DocSearch index and crawler for the published docs URL in
   [Algolia DocSearch](https://docsearch.algolia.com/docs/docsearch-program/).
   Use `draw-docs` as the index name. Publish the docs before starting the
   crawler; the local dev server is not a public crawl target.
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

The docs workflow passes them to Astro for both checks and deployment.
Changing them requires a rebuild.
Leave all three unset to use local search. Partial configuration fails with
setup instructions.
