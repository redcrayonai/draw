import { json } from '@sveltejs/kit';
import { PLUGINS, available } from '$lib/server/plugins';
import type { PluginInfo } from '$lib/api-types';
import type { RequestHandler } from './$types';

// Which plugins this deployment offers; never which settings are missing (the log has those).
export const GET: RequestHandler = () =>
  json({ plugins: PLUGINS.map(({ id, name, description }) => ({ id, name, description, available: available(id) }) satisfies PluginInfo) });
