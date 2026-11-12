import { spawn } from 'node:child_process';

type Policy = { boards: 'ask' | 'deny'; conversation: 'ask' | 'deny'; snippets: 'ask' | 'deny'; uploads: 'ask' | 'deny' };
type Frame = Record<string, any>;
const localTools = ['list_boards', 'open_board', 'read_board', 'apply_board', 'attach_conversation', 'read_code'];
const hostedTools = [
  'get_board', 'create_node', 'move_node', 'layout_board', 'update_node', 'resize_node', 'delete_node',
  'create_edge', 'hide_node', 'hide_edge', 'play_trace', 'start_tap', 'set_edge_latency', 'delete_edge',
  'describe_charts', 'create_chart', 'set_chart_data', 'get_chart', 'pin_chart', 'set_time_window',
  'open_incident', 'start_session', 'create_branch', 'submit_branch', 'add_code_ref', 'mark_checkpoint',
  'plan_route', 'arrive', 'reroute', 'remove_code_ref', 'add_change_note', 'update_change_note',
  'remove_change_note', 'add_threat', 'wait_for_marks', 'watch_marks', 'start_chat', 'reply_to_mark',
  'list_marks', 'update_threat', 'remove_threat', 'set_node_doc', 'set_selection', 'apply_board',
];
const unavailable = () => new Error('UNAVAILABLE: could not configure Draw permissions in Codex. Check Codex settings and try again.');
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

/** Returns only denials owned by this installer; independent user denials must survive policy edits. */
export async function configureCodexPermissions(
  mode: 'local' | 'hosted', policy: Policy, previousManagedDisabledTools: string[] = [],
): Promise<string[]> {
  if (!['local', 'hosted'].includes(mode) || ['boards', 'conversation', 'snippets', 'uploads'].some(key => !['ask', 'deny'].includes(policy[key as keyof Policy]))) throw unavailable();
  disabledTools(previousManagedDisabledTools);
  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let sequence = 0;
  let buffer = '';
  let closed = false;
  let failure: Error | undefined;
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
  const timer = setTimeout(() => close(new Error('UNCONFIRMED: Codex did not acknowledge the permission update. Check Codex settings before retrying.')), 15_000);
  const write = (frame: Frame) => child.stdin.write(JSON.stringify(frame) + '\n');
  const rpc = (method: string, params: Frame): Promise<Frame> => new Promise((resolve, reject) => {
    if (closed) { reject(failure ?? unavailable()); return; }
    const id = ++sequence;
    pending = { id, resolve, reject };
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
    const plugin = mode === 'local' ? 'draw-local@draw-local-dev' : 'draw@draw-binary';
    const server = mode === 'local' ? 'draw-local' : 'draw';
    const settings = (config: Frame) => object(object(object(object(config.plugins)[plugin]).mcp_servers)[server]);
    const effective = settings(object(read.config));
    const saved = settings(object(user.config));
    const existing = new Set([...disabledTools(saved.disabled_tools), ...disabledTools(effective.disabled_tools)]);
    const previous = new Set(previousManagedDisabledTools);
    const requested = policy.boards === 'deny' ? [...(mode === 'local' ? localTools : hostedTools)] : [
      ...(policy.conversation === 'deny' ? [mode === 'local' ? 'attach_conversation' : 'start_chat'] : []),
      ...(policy.snippets === 'deny' ? [mode === 'local' ? 'read_code' : 'add_code_ref'] : []),
    ];
    // Upload permission is enforced by the helper before capture; it has no separate MCP tool.
    const managed = requested.filter(tool => previous.has(tool) || !existing.has(tool));
    const disabled = [...new Set([...existing].filter(tool => !previous.has(tool)).concat(requested))];
    const tools = { ...object(saved.tools), ...object(effective.tools) };
    for (const [tool, settings] of Object.entries(tools)) tools[tool] = { ...object(settings), approval_mode: 'prompt' };
    const prefix = `plugins.${plugin}.mcp_servers.${server}`;
    const edits = Object.entries({ default_tools_approval_mode: 'prompt', disabled_tools: disabled, ...(Object.keys(tools).length ? { tools } : {}) })
      .map(([key, value]) => ({ keyPath: `${prefix}.${key}`, value, mergeStrategy: 'replace' }));
    const written = await rpc('config/batchWrite', { filePath: user.name.file, expectedVersion: user.version, edits });
    if (written.status !== 'ok') throw new Error('UNCONFIRMED: another Codex configuration layer overrides Draw permissions. Check Codex settings.');
    return managed;
  } finally { close(); }
}
