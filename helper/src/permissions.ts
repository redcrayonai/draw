import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

export type PermissionMode = 'local' | 'hosted';
export type Decision = 'ask' | 'deny';
export type DrawPermissions = Record<'boards' | 'conversation' | 'snippets' | 'uploads', Decision>;
export type PermissionRecord = { permissions: DrawPermissions; managedDisabledTools?: string[] };
export class PermissionError extends Error {}
export const DEFAULT_PERMISSIONS: DrawPermissions = { boards: 'ask', conversation: 'ask', snippets: 'deny', uploads: 'deny' };
export const permissionPath = (mode: PermissionMode) => join(homedir(), '.redcrayon', 'permissions', `codex-${mode}.json`);

export function readPermissions(mode: PermissionMode, path = permissionPath(mode)): PermissionRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (!record || Object.keys(DEFAULT_PERMISSIONS).some(key => !['ask', 'deny'].includes(record.permissions?.[key]))) throw new Error();
    if (record.managedDisabledTools !== undefined && (!Array.isArray(record.managedDisabledTools) || record.managedDisabledTools.some((name: unknown) => typeof name !== 'string'))) throw new Error();
    return record;
  } catch { throw new PermissionError('REJECTED: Draw permission settings are invalid; restore valid settings before using this integration.'); }
}

export function savePermissions(mode: PermissionMode, record: PermissionRecord, path = permissionPath(mode)) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

export async function choosePermissions(mode: PermissionMode, options: { reconfigure?: boolean; defaults?: boolean } = {}): Promise<PermissionRecord> {
  const saved = readPermissions(mode);
  if (saved && !options.reconfigure) return saved;
  if (options.defaults) return saved ?? { permissions: { ...DEFAULT_PERMISSIONS } };
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('REJECTED: review Draw permissions in a terminal, or use --permissions-defaults (Ask for boards/chat; Deny for source code).');
  const permissions = { ...(saved?.permissions ?? DEFAULT_PERMISSIONS) };
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write(`Draw ${mode} permissions for this Codex integration. Ask requests approval when used; Deny blocks without prompting.\n`);
  process.stderr.write('These settings cover Draw tools and source captures, not Codex terminal/file access or arbitrary text copied into a board.\n');
  try {
    const labels: [keyof DrawPermissions, string][] = [
      ['boards', 'Access boards, edit diagrams and notes, including deletion'],
      ['conversation', 'Connect this conversation to board chat'],
      ['snippets', 'Read repository source for code references'],
      ...(mode === 'hosted' ? [['uploads', 'Upload source files to hosted Draw (whole files, not just cited lines)'] as [keyof DrawPermissions, string]] : []),
    ];
    for (const [key, label] of labels) {
      for (;;) {
        const answer = (await terminal.question(`${label}? [ask/deny] (${permissions[key]}): `)).trim().toLowerCase();
        if (!answer) break;
        if (answer === 'ask' || answer === 'deny') { permissions[key] = answer; break; }
        process.stderr.write('Choose ask or deny.\n');
      }
    }
  } finally { terminal.close(); }
  return { ...saved, permissions };
}

/** Explicit plugin launchers enforce their policy; Codex terminal fallbacks use the same saved policy. */
export function runtimePermissions(mode: PermissionMode): DrawPermissions | undefined {
  const path = process.env.DRAW_PERMISSION_FILE || undefined;
  if (!path && !process.env.CODEX_THREAD_ID) return undefined;
  const record = readPermissions(mode, path ?? permissionPath(mode));
  if (path && !record) throw new PermissionError('REJECTED: Draw permission settings are missing; reinstall the Codex integration.');
  return record?.permissions;
}

export function enforceToolPermissions(name: string, mode: PermissionMode, args?: Record<string, unknown>) {
  const permissions = runtimePermissions(mode);
  if (!permissions) return;
  const sourceEdge = (edge: unknown) => !!edge && typeof edge === 'object' &&
    typeof (edge as Record<string, unknown>).evidence === 'string' && String((edge as Record<string, unknown>).evidence).startsWith('source:');
  const source = ['read_code', 'add_code_ref', 'mark_checkpoint', 'arrive'].includes(name) ||
    (name === 'create_edge' && sourceEdge(args)) ||
    (name === 'apply_board' && Array.isArray(args?.edges) && args.edges.some(sourceEdge));
  const denied = permissions.boards === 'deny' ? 'board access'
    : ['attach_conversation', 'start_chat'].includes(name) && permissions.conversation === 'deny' ? 'conversation attachment'
    : source && permissions.snippets === 'deny' ? 'source code access' : undefined;
  if (denied) throw new PermissionError(`REJECTED: Draw ${denied} is denied. Review it with draw permissions codex --mode ${mode}.`);
}
