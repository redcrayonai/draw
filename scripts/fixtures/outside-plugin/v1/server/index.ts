import { env, json, fail, type PluginRequest } from '@draw/server';

export const configured = (): boolean => Boolean(env.PINBOARD_GREETING);

export async function handle(event: PluginRequest): Promise<Response> {
  if (event.request.method !== 'GET' || event.path.length) return fail(404, 'REJECTED: no such plugin action.');
  return json({ greeting: env.PINBOARD_GREETING });
}
