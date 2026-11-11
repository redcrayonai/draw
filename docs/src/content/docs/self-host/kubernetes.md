---
title: Kubernetes
description: Run the production stack on a Kubernetes cluster with the Helm chart.
---

The Helm chart runs the same images and settings as `compose.prod.yml`: the
canvas, dashboard, MCP server, import runner, the board database and Postgres. Each
release publishes the chart next to its images:

```
oci://ghcr.io/redcrayonai/charts/draw
```

The chart and image versions are the same: chart `0.4.0` runs images `0.4.0`.

## What you need

- A Kubernetes cluster, Helm 3.8 or later, and a default StorageClass with
  `ReadWriteOnce` volumes.
- An ingress controller that passes WebSockets through.
- Three DNS names that point at the ingress: `DOMAIN`, `dash.DOMAIN` and
  `mcp.DOMAIN`.
- A TLS certificate for the three names, for example from cert-manager.
- The cluster's Service range, for example `10.96.0.0/12` (see
  [Service range](#service-range)).

The database fetches the MCP server's signing keys from `https://mcp.DOMAIN`.
Pods in the cluster must reach that address through the ingress, and its
certificate must be one they trust. A certificate from a public CA, such as
Let's Encrypt, works.

## Install

Make a values file, `draw-values.yaml`:

```yaml
domain: draw.example.com
workerNetworks: ["10.96.0.0/12"]

ingress:
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    # the realtime socket stays open: give it a long timeout
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"

# an agent key, see "Agent keys" below
mcpApiKeys: "<sha256 hex of the key>:<user id>"
```

Then install a release:

```sh
helm install draw oci://ghcr.io/redcrayonai/charts/draw --version 0.4.0 \
  --namespace draw --create-namespace -f draw-values.yaml --timeout 15m
```

| | |
|---|---|
| canvas | `https://DOMAIN` |
| dashboard | `https://dash.DOMAIN` |
| MCP server | `https://mcp.DOMAIN/mcp` |

:::caution
Do not use `--wait` on the first install. The setup Job runs after the install
and makes the keys the dashboard and MCP server need, so they cannot become
ready before it. Upgrades can use `--wait`.
:::

After the install, the `draw-setup` Job publishes the database module,
migrates Postgres and seeds the Demo board. The dashboard and MCP server start
when it finishes. To follow it:

```sh
kubectl -n draw logs -f job/draw-setup
```

To check the stack, ask the MCP server for its health. `"db":"ok"` means that
the database fetched the MCP server's keys through the ingress:

```sh
curl https://mcp.draw.example.com/health
```

The chart makes the Postgres password and the import runner's secret on
install and keeps them on upgrade. To choose them, set
`secrets.postgresPassword` and `secrets.importRunnerSecret`: 16 or more
letters, digits, `-` or `_`.

## Service range

The dashboard and MCP server reach other services only on the networks they
are allowed. On Kubernetes, the services are on the cluster's Service range,
so set it in `workerNetworks`.

On Kubernetes 1.33 or later, `kubectl get servicecidr` lists it. On any
version, this command prints it in its error message
(`The range of valid IPs is ...`):

```sh
kubectl create service clusterip probe --tcp=80 --clusterip=1.1.1.1 --dry-run=server
```

If your OIDC issuer runs in the cluster, add its address too.

## Agent keys

Agents send a key as a bearer token. Make one, then put the hash and a user id
in `mcpApiKeys` (comma-separated for more than one):

```sh
key="$(openssl rand -hex 32)"; echo "agent key: $key"
printf '%s:%s\n' "$(printf %s "$key" | openssl dgst -sha256 | awk '{print $NF}')" YOUR_USER_ID
```

With `oidc` sign-in, the user id is your `sub` at the issuer, and the agent
draws on your boards. Without sign-in, any user id works: give the agent a
board's edit link. Point the plugin at the server with
`REDCRAYON_MCP_URL=https://mcp.DOMAIN/mcp`.

## Settings

The values match the settings in `.env.example`:

| Value | `.env` setting |
|---|---|
| `domain` | `DOMAIN` |
| `image.tag` | `REDCRAYON_VERSION` (default: the chart version) |
| `auth.provider`, `auth.oidcIssuer`, `auth.oidcClientId`, `auth.requireAuth` | `VITE_AUTH_PROVIDER`, `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `VITE_REQUIRE_AUTH` |
| `mcpApiKeys` | `MCP_API_KEYS` |
| `importsAnonymous` | `IMPORTS_ANONYMOUS` |
| `limits`, `importMaxRepoMb` | `REDCRAYON_LIMITS`, `IMPORT_MAX_REPO_MB` |
| `importer.tmpSize`, `importer.resources.limits.memory` | `IMPORTER_TMP_SIZE`, `IMPORTER_MEM_LIMIT` |
| `versions.*` | `VERSIONS_S3_*` |
| `pluginSettings` | `plugins.env` |

For real sign-in, register `https://DOMAIN/` and `https://dash.DOMAIN/` as
the client's redirect URIs. [Real sign-in](/self-host/quickstart/#real-sign-in)
tells more.

For a build with outside plugins, push your images to a registry and set
`image.registry` and `image.tag`, plus `imagePullSecrets` for a private
registry.

All values, with comments, are in `charts/draw/values.yaml`.

## Upgrade and roll back

Back up first (see [Back up](#back-up)). To upgrade, install the newer chart
version:

```sh
helm upgrade draw oci://ghcr.io/redcrayonai/charts/draw --version 0.5.0 \
  --namespace draw -f draw-values.yaml --timeout 15m
```

The setup Job runs before the upgrade changes the apps, so the new database
module is live before the apps that read it. If setup fails, the upgrade stops
and the old apps keep running.

To roll back, upgrade to the previous chart version with the same command. The
module rules in [Upgrade and roll back](/self-host/quickstart/#upgrade-and-roll-back)
apply.

## Back up

| Object | Holds | If lost |
|---|---|---|
| PVC `draw-database` | Boards and everything on them | All data |
| Secret `draw-state` | The identity that owns the database, the agent signing key, the dashboard's service token | The module can never be published again; agents' tokens stop working |
| Secret `draw` | The Postgres password and the import runner's secret | Postgres does not accept the dashboard |
| PVC `draw-postgres` | Activity history | The dashboard's activity panel |
| PVC `draw-mcp` | Usage counters, pending captures | Counters reset |

The names start with the release name (`draw` above). `helm uninstall` keeps
the PVCs and both Secrets. Delete them by hand to remove the data.

## Limits

- One replica of each app. The MCP server counts rate limits in its process.
- Postgres runs in the cluster. An external Postgres is not supported yet.
- The ingress must send the client's address in `X-Forwarded-For`, which the
  MCP server's per-address limits read. A load balancer in front of the
  ingress must keep the client's address, for example
  `externalTrafficPolicy: Local`.
