# The dashboard image's workerd config (from the RC-607 spike).
# workerd-entrypoint.sh copies it to /tmp/run with @NETWORKS@ set to its networks, next to
# the chosen build's worker.js and assets/. The drain cron is the compose
# stack's drain sidecar; workerd has no cron.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "dashboard", worker = .dashboard),
    (name = "assets", worker = .assets),
    (name = "assets-disk", disk = (path = "assets")),
    # Outbound: the stack's network (database, Postgres, import runner, a snapshot
    # store on it) and the public internet (the OIDC issuer's keys, a hosted snapshot
    # store). Loopback stays refused.
    (name = "internet", network = (allow = ["public", "@NETWORKS@"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [(name = "http", address = "*:5174", http = (), service = "dashboard")],
  logging = (structuredLogging = true),
);

const dashboard :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2026-08-21",
  bindings = [
    (name = "ASSETS", service = "assets"),
    (name = "DATABASE_URL", fromEnvironment = "DATABASE_URL"),
    (name = "SPACETIMEDB_URL", fromEnvironment = "SPACETIMEDB_URL"),
    (name = "SPACETIMEDB_DB", fromEnvironment = "SPACETIMEDB_DB"),
    (name = "SPACETIMEDB_SERVICE_TOKEN", fromEnvironment = "SPACETIMEDB_SERVICE_TOKEN"),
    (name = "IMPORT_RUNNER_URL", fromEnvironment = "IMPORT_RUNNER_URL"),
    (name = "IMPORT_RUNNER_SECRET", fromEnvironment = "IMPORT_RUNNER_SECRET"),
    (name = "IMPORT_CALLBACK_URL", fromEnvironment = "IMPORT_CALLBACK_URL"),
    (name = "OIDC_ISSUER", fromEnvironment = "OIDC_ISSUER"),
    (name = "IMPORTS_ANONYMOUS", fromEnvironment = "IMPORTS_ANONYMOUS"),
    (name = "VERSIONS_S3_ENDPOINT", fromEnvironment = "VERSIONS_S3_ENDPOINT"),
    (name = "VERSIONS_S3_BUCKET", fromEnvironment = "VERSIONS_S3_BUCKET"),
    (name = "VERSIONS_S3_REGION", fromEnvironment = "VERSIONS_S3_REGION"),
    (name = "VERSIONS_S3_ACCESS_KEY_ID", fromEnvironment = "VERSIONS_S3_ACCESS_KEY_ID"),
    (name = "VERSIONS_S3_SECRET_ACCESS_KEY", fromEnvironment = "VERSIONS_S3_SECRET_ACCESS_KEY"),
    # Versions without keys: the container credentials endpoint an ECS task role sets these for.
    (name = "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", fromEnvironment = "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"),
    (name = "AWS_CONTAINER_CREDENTIALS_FULL_URI", fromEnvironment = "AWS_CONTAINER_CREDENTIALS_FULL_URI"),
    (name = "AWS_CONTAINER_AUTHORIZATION_TOKEN", fromEnvironment = "AWS_CONTAINER_AUTHORIZATION_TOKEN"),
  ],
  # The adapter's worker reads caches.default on every request, which throws
  # without a cache: always a miss (assets.js noCache).
  cacheApiOutbound = (name = "assets", entrypoint = "noCache"),
);

# The slice of the hosted assets layer the adapter's worker needs (assets.js).
const assets :Workerd.Worker = (
  modules = [(name = "assets.js", esModule = embed "assets.js")],
  compatibilityDate = "2026-08-21",
  bindings = [(name = "DISK", service = "assets-disk")],
);
