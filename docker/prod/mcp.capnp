# The mcp image's workerd config (from the RC-607 spike). workerd-entrypoint.sh
# copies it to /tmp/run with @NETWORKS@ set to its networks, next to worker.js.
#
# Settings are `fromEnvironment`: unset means null, which the Worker treats as
# "not configured". Analytics Engine, the canary cron and OTLP are hosted-only
# and stay unbound; logs are structured JSON on stdout.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "mcp", worker = .mcp),
    (name = "do-disk", disk = (path = "/data", writable = true)),
    # Outbound: the stack's network (database) and the public internet (the
    # OIDC issuer's keys). Loopback and other private ranges stay refused.
    (name = "internet", network = (allow = ["public", "@NETWORKS@"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [(name = "http", address = "*:8788", http = (), service = "mcp")],
  extensions = [(modules = [(name = "redcrayon-internal:ratelimit", esModule = embed "ratelimit.js", internal = true)])],
  logging = (structuredLogging = true),
);

const mcp :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  # nodejs_compat (wrangler.jsonc) is the default from 2026-08-04 on.
  compatibilityDate = "2026-08-21",
  bindings = [
    (name = "MCP_ORIGIN", fromEnvironment = "MCP_ORIGIN"),
    (name = "APP_ORIGIN", fromEnvironment = "APP_ORIGIN"),
    (name = "OIDC_ISSUER", fromEnvironment = "OIDC_ISSUER"),
    (name = "MCP_API_KEYS", fromEnvironment = "MCP_API_KEYS"),
    (name = "DB_URL", fromEnvironment = "DB_URL"),
    (name = "DB_NAME", fromEnvironment = "DB_NAME"),
    (name = "AGENT_JWK", fromEnvironment = "AGENT_JWK"),
    (name = "AGENT_JWK_NEXT", fromEnvironment = "AGENT_JWK_NEXT"),
    (name = "AGENT_JWK_PREV", fromEnvironment = "AGENT_JWK_PREV"),
    (name = "VERSION", fromEnvironment = "VERSION"),
    (name = "USER", durableObjectNamespace = "User"),
    (name = "CAPTURE", durableObjectNamespace = "Capture"),
    (name = "LIVE", durableObjectNamespace = "Live"),
    # The hosted rate-limit binding does not exist in workerd: same names and
    # limits as wrangler.jsonc, counted in this process (ratelimit.js).
    (name = "CALLS_RL", wrapped = (moduleName = "redcrayon-internal:ratelimit", innerBindings = [(name = "limit", json = "120"), (name = "period", json = "60")])),
    (name = "IP_RL", wrapped = (moduleName = "redcrayon-internal:ratelimit", innerBindings = [(name = "limit", json = "60"), (name = "period", json = "60")])),
    (name = "ANTHROPIC_RL", wrapped = (moduleName = "redcrayon-internal:ratelimit", innerBindings = [(name = "limit", json = "600"), (name = "period", json = "60")])),
    (name = "FACTS_RL", wrapped = (moduleName = "redcrayon-internal:ratelimit", innerBindings = [(name = "limit", json = "120"), (name = "period", json = "60")])),
  ],
  durableObjectNamespaces = [
    (className = "User", uniqueKey = "redcrayon-mcp-User", enableSql = true),
    (className = "Capture", uniqueKey = "redcrayon-mcp-Capture", enableSql = true),
    (className = "Live", uniqueKey = "redcrayon-mcp-Live", enableSql = true),
  ],
  # EXPERIMENTAL in workerd: the version is pinned (Dockerfile); back up /data.
  durableObjectStorage = (localDisk = "do-disk"),
);
