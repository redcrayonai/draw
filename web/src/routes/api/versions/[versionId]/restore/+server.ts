import { dispatchPlugin } from '$lib/server/plugins';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, url, params }) =>
  dispatchPlugin('versions', { request, url, path: [params.versionId, 'restore'] });
