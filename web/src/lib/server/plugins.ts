// Deployment availability is separate from each workspace's plugin switch.
import { PLUGIN_LIST } from './plugins.generated';
import { fail, log, type PluginRequest } from './plugin-api';

export const PLUGINS = PLUGIN_LIST;
export function available(id: string): boolean {
  const plugin = PLUGINS.find((p) => p.id === id);
  if (!plugin) return false;
  try { return plugin.server?.configured?.() ?? true; }
  catch (error) {
    log('error', 'plugin.config_failed', { plugin: id }, error);
    return false;
  }
}

export async function dispatchPlugin(id: string, event: PluginRequest): Promise<Response> {
  const plugin = PLUGINS.find((p) => p.id === id);
  if (!plugin) return fail(404, 'REJECTED: no such plugin.');
  if (!available(id)) return fail(503, `UNAVAILABLE: this deployment does not offer ${plugin.name}.`);
  if (!plugin.server?.handle) return fail(404, 'REJECTED: no such plugin action.');
  return plugin.server.handle(event);
}
