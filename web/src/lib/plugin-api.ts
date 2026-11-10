import type { Component } from 'svelte';
import type { DbConnection } from '../module_bindings';

export { authenticatedHref } from './session';
export { ago, canvasHref, idTail, appHref } from './boards';
export { offered, pluginCatalog, pluginOn, workspacePlugins } from './plugins';
export { apiToken } from './stdb';
export { myWorkspaces } from './workspaces';
export { default as Button } from './components/Button.svelte';
export { writable } from 'svelte/store';
export type { DbConnection } from '../module_bindings';
export type { MyBoardVersion } from '../module_bindings/types';

export type BoardPanelProps = { boardId: bigint; workspaceId: bigint; canEdit: boolean; disabled: boolean };
export type WebPart = {
  BoardPanel?: Component<BoardPanelProps>;
  attach?: (conn: DbConnection, stale: () => boolean) => void;
  reset?: () => void;
};
