import type { ArchitectureHistory as HistoryRow, ArchitectureVersion as VersionRow } from '../module_bindings/types';

export type ArchitectureHistory = Pick<HistoryRow, 'id' | 'name' | 'repository' | 'refsJson' | 'status' | 'error'>;
export type ArchitectureVersion = Pick<VersionRow, 'boardId' | 'historyId' | 'index' | 'assertionMode' | 'ref' | 'sha' | 'status'>;
export type PinnedRef = { ref: string; sha: string };
