import type { DbConnection } from '../module_bindings';
import { WEB_PARTS } from './plugins.generated';
export { WEB_PARTS } from './plugins.generated';

export function attachPluginParts(conn: DbConnection, stale: () => boolean): void {
  for (const { id, web } of WEB_PARTS) {
    try { web.attach?.(conn, stale); }
    catch (error) { console.warn('plugin.attach', id, error); }
  }
}

export function resetPluginParts(): void {
  for (const { id, web } of WEB_PARTS) {
    try { web.reset?.(); }
    catch (error) { console.warn('plugin.reset', id, error); }
  }
}
