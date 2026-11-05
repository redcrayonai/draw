import { dispatchPlugin } from '$lib/server/plugins';
import type { RequestHandler } from './$types';

// Keep URLs used by dashboards that were already open before plugin routing shipped.
export const POST: RequestHandler = ({ request, url }) => dispatchPlugin('versions', { request, url, path: [] });
