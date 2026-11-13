import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

export type PermissionMode = 'local' | 'hosted';
export type Decision = 'ask' | 'deny';
export type DrawPermissions = { boards: Decision | 'allow'; conversation: Decision | 'allow'; snippets: Decision; uploads: Decision };
export type PermissionRecord = { permissions: DrawPermissions; managedDisabledTools?: string[] };
export class PermissionError extends Error {}
export const DEFAULT_PERMISSIONS: DrawPermissions = { boards: 'allow', conversation: 'allow', snippets: 'deny', uploads: 'deny' };
export const permissionPath = (mode: PermissionMode) => join(homedir(), '.redcrayon', 'permissions', `codex-${mode}.json`);

export function readPermissions(mode: PermissionMode, path = permissionPath(mode)): PermissionRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (!record || Object.keys(DEFAULT_PERMISSIONS).some(key => !(key === 'boards' || key === 'conversation' ? ['ask', 'allow', 'deny'] : ['ask', 'deny']).includes(record.permissions?.[key]))) throw new Error();
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

type PermissionOptions = { reconfigure?: boolean; defaults?: boolean };

export async function choosePermissions(mode: PermissionMode, options: PermissionOptions = {}): Promise<PermissionRecord> {
  return (await choosePermissionSet([mode], options))[0].record;
}

/** Review both backends together, before changing either saved policy. */
export async function choosePermissionSet(modes: readonly PermissionMode[], options: PermissionOptions = {}) {
  const entries = modes.map(mode => {
    const saved = readPermissions(mode);
    return { mode, editable: !saved || !!options.reconfigure, record: { ...saved, permissions: { ...(saved?.permissions ?? DEFAULT_PERMISSIONS) } } };
  });
  if (options.defaults || entries.every(entry => !entry.editable)) return entries;
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('REJECTED: review Draw permissions in a terminal, or use --permissions-defaults (Allow boards/chat; Deny source reads/uploads).');
  const color = (code: number, text: string) => process.env.NO_COLOR === undefined ? `\x1b[${code}m${text}\x1b[0m` : text;
  const label = (value: DrawPermissions[keyof DrawPermissions]) => color(value === 'allow' ? 32 : value === 'ask' ? 33 : 31, value[0].toUpperCase() + value.slice(1));
  const fields: [keyof DrawPermissions, string][] = [
    ['boards', 'Board access and edits (including deletion)'],
    ['conversation', 'Connect conversation to board chat'],
    ['snippets', 'Read repository source'],
    ['uploads', 'Upload source to hosted Draw (whole files)'],
  ];
  const groups = (editable: boolean) => fields.flatMap(([key, title]) => {
    const rows = new Map<string, typeof entries>();
    for (const entry of entries.filter(entry => (!editable || entry.editable) && (key !== 'uploads' || entry.mode === 'hosted'))) {
      const value = entry.record.permissions[key];
      rows.set(value, [...(rows.get(value) ?? []), entry]);
    }
    return [...rows.values()].map(group => ({ key, title, group, scope: group.map(entry => entry.mode).join(' + ') }));
  });
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const summary = () => {
    process.stderr.write(`\n${color(1, 'Draw permissions')}\n\n`);
    for (const { key, title, group, scope } of groups(false)) {
      process.stderr.write(`  ${title.padEnd(43)} ${label(group[0].record.permissions[key])}  ${color(2, `(${scope})`)}\n`);
    }
  };
  try {
    summary();
    process.stderr.write('\nAllow: routine tools run without prompting. Ask: approve when used. Deny: blocked.\n');
    process.stderr.write(color(2, 'Covers Draw only, not general Codex file access or text pasted onto boards.') + '\n\n');
    let customize = false;
    for (;;) {
      const answer = (await terminal.question(color(1, 'Use these settings? [Y/n] '))).trim().toLowerCase();
      if (['', 'y', 'yes'].includes(answer)) break;
      if (['n', 'no'].includes(answer)) { customize = true; break; }
      process.stderr.write('Choose yes or no.\n');
    }
    if (customize) {
      for (const { key, title, group, scope } of groups(true)) {
        const choices = key === 'boards' || key === 'conversation' ? ['ask', 'allow'] : ['ask', 'deny'];
        for (;;) {
          const answer = (await terminal.question(`\n${color(1, title)} ${color(2, `(${scope})`)}\n  ${choices.join('/')} [${group[0].record.permissions[key]}]: `)).trim().toLowerCase();
          if (!answer) break;
          if (choices.includes(answer)) {
            for (const entry of group) Object.assign(entry.record.permissions, { [key]: answer });
            break;
          }
          process.stderr.write(`Choose ${choices.join(' or ')}.\n`);
        }
      }
      summary();
    }
  } finally { terminal.close(); }
  return entries;
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
