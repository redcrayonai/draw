// The explicit server interface available to plugin parts; keep generated registries out of this graph.
export { json } from '@sveltejs/kit';
export { env } from '$env/dynamic/private';
export { bearer, fail, notConfigured } from './http';
export { callAs, procedureAs, sqlAs, DbError } from './board-db';
export { log } from './log';

export type PluginRequest = { request: Request; url: URL; path: string[] };
export type ServerPart = {
  configured?: () => boolean;
  handle?: (event: PluginRequest) => Promise<Response>;
};
