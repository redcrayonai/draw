# Browser tests

From the repository root:

```sh
nix develop
for p in module shared client web e2e; do pnpm -C "$p" install --frozen-lockfile; done
pnpm -C e2e exec playwright install chromium
pnpm -C e2e test
```

CI runs the same test command. Use `pnpm -C e2e test --headed` to watch a run.
Open failure traces with `pnpm -C e2e exec playwright show-trace test-results/<case>/trace.zip`.

Each worker starts an isolated SpacetimeDB, publishes a temporary copy of the module,
and builds and serves the canvas. Browser contexts keep owners and recipients separate.
The fixture removes the temporary database and stops its services on teardown.
It does not reuse a running development server, database, CLI profile, or app environment file.

Account cases replace the browser auth provider only in this test build.
A local issuer signs account tokens; the real database validates those tokens and applies its permission rules.
Guest connections use the database's anonymous identities.
This covers application authorization with simulated provider sessions.
The workspace cases also run the real generic OIDC adapter against a local test issuer. They verify the authorization-code callback, S256 PKCE, nonce validation, and invitation handoff through sign-in. They do not cover real provider signup, a specific external identity provider, guest-to-account handoff, or deployed staging resources.

Workspace cases cover native membership, teams, one-use invitations, guest board access, workspace creation destinations, explicit moves, and live permission revocation. Focused cases verify member-to-guest demotion, removal of open-board manager controls, guest manager access without roster disclosure, independent edit-link permissions, and account-switch/sign-out isolation of workspace data and cached permissions.

The service-account browser case creates a selected-board account and read/edit keys, checks digest-only storage and show-once secret clearing across account switches and reloads, rotates and revokes a key, disables an account, and verifies that ordinary members cannot manage accounts. Real database cases separately check live scope changes, expiry and revocation on existing connections. Actual MCP Worker cases authenticate managed keys through the shared Worker entry and verify scoped reads/writes and cached-token revocation.

The suite covers drawing persistence, private locator denial, SVG export, eight sharing combinations,
live link downgrade/revocation, and branching a hand-drawn board (fork, review, reject, merge, viewer limits, palette). The schema-upgrade drill adds retained edge data and a temporary appended column.
It reproduces the binary decoder failure when a candidate client runs ahead of the module.
Red crayon review cases circle, take back, cap and send marks, then answer them as a database-minted agent (no MCP Worker) to check the banner, history, unread badge, seat claims, deleted nodes, link permissions and private drafts.
Actual MCP Worker integration tests cover native workspace delegation, viewer and unrelated-workspace denial, revocation, and failed re-delegation across both MCP client eras. These tests use a test principal verifier and real database tokens; full external OAuth onboarding remains separate.
The 2026-10-23 true-up added cases for code consent (RC-690), agent grants, guest sign-in claims, provider outage, presence, hide sets, charts and the library, routes, threats, branches and snapshots, undo and drag, and phones.
Each case cites the decided behavior it checks; cases where main does not yet do what was decided are marked `test.fail()` with a `divergent (<id>)` comment, so fixing the product flips them red until the mark is removed.
`signIn`, `signOut`, `signInOnRequest` and `providerDown` drive the test auth provider per browser context, and `test.use({ clientEnv })` builds a file's own canvas (for example with `VITE_MCP_URL`).

The Versions save and restore case (`tests/board-versions.spec.ts`) needs an S3-compatible store: set the
`VERSIONS_S3_*` variables ([SELF_HOSTING.md](../SELF_HOSTING.md#versions-optional)). Without them it is skipped.

To test an existing canvas, set its URL:

```sh
E2E_BASE_URL=https://app-staging.example.com pnpm -C e2e test:staging
```

These three cases cover node/edge reload, private locator denial, and guest sharing/revocation.
They use the served app without the local auth alias. They do not sign in or exercise OAuth.
The `ci` workflow includes the isolated suite and ends with `ci-ready`.
