import { dispatchPlugin } from '$lib/server/plugins';
import type { RequestHandler } from './$types';

export const fallback: RequestHandler = ({ request, url, params }) =>
  dispatchPlugin(params.plugin, { request, url, path: params.path ? params.path.split('/') : [] });
