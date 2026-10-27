# Contributing

Run the application with [Docker Compose](SELF_HOSTING.md#run-it-with-docker-compose).
After a source change, run `docker compose up --build` again.

Keep pull requests focused on one change. Describe the problem, the resulting
behavior, and the checks that you ran. List any checks that you did not run.
Add a regression test for a behavior change.

## Package checks

The Nix development shell provides Node, pnpm, and the database CLI:

```sh
nix develop
```

Install dependencies in each package that you change:

```sh
pnpm -C <package> install --frozen-lockfile
pnpm -C <package> test
```

Run the package build or type check when its manifest provides that command.
For browser changes, use the [browser suite](e2e/README.md).

Reducer changes need the isolated database checks:

```sh
scripts/stdb-test.sh run
scripts/check-module-upgrade.sh
```

The isolated harness owns a separate database and deletes its test state.
Keep existing table columns and reducer arguments compatible with older clients.
Do not change the identity derivation from the issuer and subject claims.

After a module schema change, regenerate the committed bindings:

```sh
for pkg in client agent importer web; do
  spacetime generate --no-config --lang typescript --module-path module --out-dir "$pkg/src/module_bindings"
done
```

The generator does not delete obsolete files. Delete a generated file only
when its reducer or table no longer exists.

## Publication checks

```sh
node scripts/vendor-scan.mjs --public --enforce
gitleaks detect --source . --log-opts=--all
```

Keep credentials, personal data, internal records, and deployment identifiers
out of contributions. Keep generated bundles free of infrastructure vendor names.
Source can name a dependency when it explains the actual integration.
Report security concerns through [SECURITY.md](SECURITY.md).

## License

Contributions are licensed under the [Apache License 2.0](LICENSE).
