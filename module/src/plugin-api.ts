export { table, t, SenderError } from 'spacetimedb/server';
export { Identity, Timestamp } from 'spacetimedb';
export { BUNDLE_VERSION, MAX_BUNDLE_BYTES, BundleError, bundleText, captureBoard, parseBundle, restoreBoard } from './board-bundle';
export { sha256Bytes } from './sha256';
export { pluginEnabled } from './plugins';
export { roleRank } from './workspace-policy';
export { assignBoardWorkspace, humanBoardRole, membership } from './workspaces';

export interface ModuleApi {
  reducer: any;
  isHuman: (ctx: any) => boolean;
  assertService: (ctx: any) => void;
  spendWrite: (ctx: any) => void;
  assertBoardName: (name: string) => void;
  insertBoard: (ctx: any, name: string) => any;
  initCallerBoard: (ctx: any, boardId: bigint, name: string, via: string) => void;
  refreshStats: (ctx: any, boardId: bigint) => void;
  emit: (ctx: any, boardId: bigint, type: string, payload: Record<string, unknown>) => void;
}

export type ModulePart = {
  tables: Record<string, unknown>;
  features?: (db: any, api: ModuleApi) => Record<string, unknown>;
};
