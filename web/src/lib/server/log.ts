/**
 * One JSON line per event for Workers Logs and its Grafana export: a stable event
 * name, `area.event` and never deeper, plus fields.
 * An error becomes `name: message` (and its SQLSTATE), never the object: a
 * postgres error carries the query and its parameters.
 */
export function log(level: 'error' | 'warn' | 'info', event: string, fields: Record<string, unknown> = {}, error?: unknown) {
  const err =
    error === undefined
      ? {}
      : { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), code: (error as { code?: unknown })?.code };
  console[level](JSON.stringify({ event, ...fields, ...err }));
}
