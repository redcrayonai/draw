import { spawn } from 'node:child_process';
import type { PermissionMode, PermissionRecord } from './permissions';

type Frame = Record<string, any>;
const localTools = ['list_boards', 'open_board', 'read_board', 'apply_local_board', 'attach_conversation', 'read_code'];
const hostedTools = [
  'get_board', 'create_node', 'move_node', 'layout_board', 'update_node', 'resize_node', 'delete_node',
  'create_edge', 'hide_node', 'hide_edge', 'play_trace', 'start_tap', 'set_edge_latency', 'update_edge', 'delete_edge',
  'describe_charts', 'create_chart', 'set_chart_data', 'get_chart', 'pin_chart', 'set_time_window',
  'open_incident', 'start_session', 'create_branch', 'submit_branch', 'add_code_ref', 'mark_checkpoint',
  'plan_route', 'arrive', 'reroute', 'remove_code_ref', 'add_change_note', 'update_change_note',
  'remove_change_note', 'add_threat', 'wait_for_marks', 'watch_marks', 'start_chat', 'reply_to_mark',
  'list_marks', 'update_threat', 'remove_threat', 'set_node_doc', 'set_selection', 'apply_board',
  'save_telling', 'remove_telling',
];
const unavailable = () => new Error('UNAVAILABLE: could not access Codex settings. Check Codex settings and try again.');
function object(value: unknown): Frame {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Frame;
}
function disabledTools(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(tool => typeof tool !== 'string')) throw unavailable();
  return value;
}

type Rpc = (method: string, params: Frame) => Promise<Frame>;

async function withCodexConfig<T>(update: (read: Frame, user: Frame, rpc: Rpc) => Promise<T>): Promise<T> {
  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let sequence = 0;
  let buffer = '';
  let closed = false;
  let failure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { id: number; resolve(value: Frame): void; reject(error: Error): void } | undefined;
  const close = (error?: Error) => {
    if (closed) return;
    closed = true;
    failure = error;
    clearTimeout(timer);
    if (pending) { pending.reject(error ?? unavailable()); pending = undefined; }
    child.stdin.destroy();
    child.kill(); // Only this configuration subprocess belongs to us.
  };
  const write = (frame: Frame) => child.stdin.write(JSON.stringify(frame) + '\n');
  const rpc = (method: string, params: Frame): Promise<Frame> => new Promise((resolve, reject) => {
    if (closed) { reject(failure ?? unavailable()); return; }
    const id = ++sequence;
    pending = { id, resolve, reject };
    const timeout = method === 'config/read' ? 30_000 : 15_000;
    timer = setTimeout(() => close(new Error('UNCONFIRMED: Codex did not respond. Check Codex settings before retrying.')), timeout);
    try { write({ id, method, params }); } catch { close(unavailable()); }
  });
  child.on('error', () => close(unavailable()));
  child.on('exit', () => close(unavailable()));
  child.stdin.on('error', () => close(unavailable()));
  child.stdout.on('error', () => close(unavailable()));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (closed) return;
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) { close(unavailable()); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const frame = object(JSON.parse(line));
        if (!pending || frame.id !== pending.id) continue;
        if (frame.error) {
          const conflict = frame.error.data?.config_write_error_code === 'configVersionConflict';
          close(conflict ? new Error('UNCONFIRMED: Codex settings changed during setup. Run setup again to preserve those changes.') : unavailable());
          return;
        }
        if (!frame.result || typeof frame.result !== 'object' || Array.isArray(frame.result)) throw unavailable();
        clearTimeout(timer);
        const request = pending; pending = undefined; request.resolve(frame.result);
      } catch { close(unavailable()); return; }
    }
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'draw_permissions', version: '1.0.0' } });
    write({ method: 'initialized' });
    const read = await rpc('config/read', { includeLayers: true });
    const user = Array.isArray(read.layers) && read.layers.find((layer: Frame) => layer.name?.type === 'user' && !layer.name.profile && !layer.disabledReason);
    if (!user || typeof user.version !== 'string' || typeof user.name.file !== 'string') throw unavailable();
    return await update(read, user, rpc);
  } finally { close(); }
}

export function readCodexUserConfig() {
  return withCodexConfig(async (_read, user) => object(user.config));
}

async function writeConfig(rpc: Rpc, user: Frame, edits: Frame[]) {
  if (!edits.length) return;
  const written = await rpc('config/batchWrite', { filePath: user.name.file, expectedVersion: user.version, edits });
  if (written.status !== 'ok') throw new Error('UNCONFIRMED: another Codex configuration layer overrides Draw settings. Check Codex settings.');
}

/** Returns only denials owned by this installer; independent user denials must survive policy edits. */
export async function configureCodexPermissions(choices: { mode: PermissionMode; record: PermissionRecord }[]) {
  for (const { mode, record } of choices) {
    if (!['local', 'hosted'].includes(mode) ||
      (['boards', 'conversation', 'snippets', 'uploads'] as const).some(key => !(key === 'boards' || key === 'conversation' ? ['ask', 'allow', 'deny'] : ['ask', 'deny']).includes(record.permissions[key]))) throw unavailable();
    disabledTools(record.managedDisabledTools);
  }
  return withCodexConfig(async (read, user, rpc) => {
    const plugin = 'draw@draw-binary';
    const server = 'draw';
    const settings = (config: Frame, id = plugin, name = server) => object(object(object(object(config.plugins)[id]).mcp_servers)[name]);
    const effective = settings(object(read.config));
    const saved = settings(object(user.config));
    let disabled = [...disabledTools(saved.disabled_tools), ...disabledTools(effective.disabled_tools)];
    const tools = { ...object(saved.tools), ...object(effective.tools) };
    const records = choices.map(({ mode, record }) => {
      const policy = record.permissions;
      const migrateLocal = mode === 'local' && !record.routed;
      const rename = (tool: string) => mode === 'local' && tool === 'apply_board' ? 'apply_local_board' : tool;
      const previous = new Set((record.managedDisabledTools ?? []).map(rename));
      const legacy = migrateLocal ? [plugin, 'draw-local@draw-local-dev'].flatMap(id =>
        [read.config, user.config].flatMap(config => disabledTools(settings(object(config), id, 'draw-local').disabled_tools).map(rename))) : [];
      if (migrateLocal) for (const tool of disabled) previous.delete(tool);
      const existing = new Set([...legacy, ...disabled]);
      const requested = policy.boards === 'deny' ? [...(mode === 'local' ? localTools : hostedTools)] : [
        ...(policy.conversation === 'deny' ? [mode === 'local' ? 'attach_conversation' : 'start_chat'] : []),
        ...(policy.snippets === 'deny' ? [mode === 'local' ? 'read_code' : 'add_code_ref'] : []),
      ];
      // Upload permission is enforced by the helper before capture; it has no separate MCP tool.
      const managed = requested.filter(tool => previous.has(tool) || !existing.has(tool));
      disabled = [...new Set([...existing].filter(tool => !previous.has(tool)).concat(requested))];
      for (const [tool, settings] of Object.entries(tools)) {
        if (!(mode === 'local' ? hostedTools : localTools).includes(tool)) tools[tool] = { ...object(settings), approval_mode: 'prompt' };
      }
      if (policy.boards === 'allow') {
        const sourceTools = mode === 'local' ? ['read_code'] : ['add_code_ref', 'mark_checkpoint', 'arrive', 'create_edge', 'apply_board'];
        const conversationTool = mode === 'local' ? 'attach_conversation' : 'start_chat';
        for (const tool of mode === 'local' ? localTools : hostedTools) {
          // Mixed source operations still prompt; future tools keep the prompt default.
          const prompt = sourceTools.includes(tool) || (tool === conversationTool && policy.conversation !== 'allow');
          tools[tool] = { ...object(tools[tool]), approval_mode: prompt ? 'prompt' : 'approve' };
        }
      }
      return { mode, record: { ...record, managedDisabledTools: managed, routed: true } };
    });
    const prefix = `plugins.${plugin}.mcp_servers.${server}`;
    const edits = Object.entries({ default_tools_approval_mode: 'prompt', disabled_tools: disabled, ...(Object.keys(tools).length ? { tools } : {}) })
      .map(([key, value]) => ({ keyPath: `${prefix}.${key}`, value, mergeStrategy: 'replace' }));
    await writeConfig(rpc, user, edits);
    return records;
  });
}

/** Run only after the unified plugin installs successfully; retain credentials and policy in place. */
export async function disableLegacyCodexIntegrations(): Promise<void> {
  await withCodexConfig(async (read, user, rpc) => {
    const listed = await rpc('plugin/list', { forceRefetch: false, marketplaceKinds: ['local', 'vertical', 'workspace-directory', 'shared-with-me', 'created-by-me-remote'] });
    if (!Array.isArray(listed.marketplaces) || (listed.marketplaceLoadErrors?.length ?? 0) > 0) throw unavailable();
    const configs = [object(user.config), object(read.config)];
    const plugins = new Map(configs.flatMap(config => Object.entries(object(config.plugins)))
      .filter(([id, settings]) => /^draw(?:-local)?@/.test(id) && object(settings).enabled !== false));
    for (const entry of listed.marketplaces) {
      const marketplace = object(entry);
      if (!Array.isArray(marketplace.plugins)) throw unavailable();
      for (const entry of marketplace.plugins) {
        const plugin = object(entry);
        if (plugin.installed === true && plugin.enabled === true && ['draw', 'draw-local'].includes(plugin.name)) {
          if (typeof plugin.id !== 'string' || !/^draw(?:-local)?@[a-zA-Z0-9_-]+$/.test(plugin.id)) throw unavailable();
          plugins.set(plugin.id, { enabled: true });
        }
      }
    }
    const edits: Frame[] = [];
    for (const id of plugins.keys()) {
      if (id !== 'draw@draw-binary') {
        if (!/^draw(?:-local)?@[a-zA-Z0-9_-]+$/.test(id)) throw unavailable();
        edits.push({ keyPath: `plugins.${id}.enabled`, value: false, mergeStrategy: 'replace' });
      }
    }
    for (const name of ['draw', 'redcrayon', 'draw-local']) {
      if (configs.some(config => {
        const settings = object(config.mcp_servers)[name];
        return settings !== undefined && object(settings).enabled !== false;
      })) {
        edits.push({ keyPath: `mcp_servers.${name}.enabled`, value: false, mergeStrategy: 'replace' });
      }
    }
    await writeConfig(rpc, user, edits);
  });
}
