import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LocalBoard, LocalEdge, LocalFeedback, LocalNode, LocalOperation, LocalRef } from '../../shared/local';

const reject = (message: string): never => { throw new Error(`REJECTED: ${message}`); };
function text(value: unknown, max = 16000): asserts value is string {
  if (typeof value !== 'string' || value.length > max) reject('invalid text');
}
function refs(value: unknown): asserts value is LocalRef[] {
  if (!Array.isArray(value) || value.length > 100) reject('invalid code references');
  for (const ref of value as LocalRef[]) {
    if (!ref || typeof ref !== 'object') reject('invalid code reference');
    text(ref.path, 1024);
    if (!ref.path || ref.path.startsWith('/') || ref.path.includes('\\') || ref.path.split('/').includes('..') || !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 1 || ref.end < ref.start || ref.end - ref.start > 1000) reject('invalid code range');
  }
}
function node(value: LocalNode) {
  text(value.label, 1000); text(value.description); refs(value.refs);
  if (!['service', 'datastore', 'external', 'boundary', 'note', 'text'].includes(value.kind)) reject('invalid node kind');
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Math.abs(value[key]) > 1e6) reject('invalid geometry');
  }
  if (value.w < 16 || value.h < 16 || value.w > 10000 || value.h > 10000) reject('invalid node size');
}
function edge(value: LocalEdge, board: LocalBoard) {
  text(value.label, 1000); text(value.description); refs(value.refs);
  if (!['forward', 'both', 'none'].includes(value.direction)) reject('invalid edge direction');
  if (!board.nodes.some(n => n.id === value.from) || !board.nodes.some(n => n.id === value.to)) reject('edge endpoints must exist');
}
function patchKeys(patch: unknown, keys: string[]) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !keys.includes(key))) reject('invalid patch fields');
}

/** Apply to a private copy. The caller publishes only after the entire batch is durable. */
export function applyLocal(board: LocalBoard, operation: LocalOperation) {
  if (!operation || typeof operation !== 'object') reject('invalid operation');
  const nextId = () => String(board.nextId++);
  switch (operation.type) {
    case 'graph.restore': {
      if (!Array.isArray(operation.nodes) || !Array.isArray(operation.edges) || operation.nodes.length > 5000 || operation.edges.length > 10000) reject('invalid graph');
      const ids = new Set<string>();
      for (const value of [...operation.nodes, ...operation.edges]) {
        if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value.id) || Number(value.id) >= board.nextId || ids.has(value.id) || board.notes.some(n => n.id === value.id || n.replies.some(r => r.id === value.id))) reject('invalid restored identifier');
        ids.add(value.id);
      }
      for (const value of operation.nodes) { patchKeys(value, ['id', 'label', 'description', 'x', 'y', 'w', 'h', 'kind', 'refs']); node(value); }
      board.nodes = structuredClone(operation.nodes);
      for (const value of operation.edges) { patchKeys(value, ['id', 'from', 'to', 'label', 'description', 'direction', 'refs']); edge(value, board); }
      board.edges = structuredClone(operation.edges);
      break;
    }
    case 'node.put': {
      patchKeys(operation.patch, ['label', 'description', 'x', 'y', 'w', 'h', 'kind', 'refs']);
      const old = board.nodes.find(n => n.id === operation.id);
      if (operation.id !== undefined && !old) reject('node does not exist');
      const value: LocalNode = { ...(old ?? { id: nextId(), label: '', description: '', x: 0, y: 0, w: 160, h: 80, kind: 'service', refs: [] }), ...operation.patch };
      node(value);
      if (old) Object.assign(old, value); else board.nodes.push(value);
      break;
    }
    case 'edge.put': {
      patchKeys(operation.patch, ['from', 'to', 'label', 'description', 'direction', 'refs']);
      const old = board.edges.find(e => e.id === operation.id);
      if (operation.id !== undefined && !old) reject('edge does not exist');
      const value: LocalEdge = { ...(old ?? { id: nextId(), from: '', to: '', label: '', description: '', direction: 'forward', refs: [] }), ...operation.patch };
      edge(value, board);
      if (old) Object.assign(old, value); else board.edges.push(value);
      break;
    }
    case 'element.delete':
      if (![...board.nodes, ...board.edges].some(v => v.id === operation.id)) reject('element does not exist');
      board.nodes = board.nodes.filter(n => n.id !== operation.id);
      board.edges = board.edges.filter(e => e.id !== operation.id && e.from !== operation.id && e.to !== operation.id);
      break;
    case 'note.add':
      text(operation.text);
      if (!operation.text.trim() || ![...board.nodes, ...board.edges].some(v => v.id === operation.target)) reject('note needs text and an existing target');
      board.notes.push({ id: nextId(), target: operation.target, text: operation.text, resolved: false, replies: [] });
      break;
    case 'note.reply': case 'note.resolve': {
      const note = board.notes.find(n => n.id === operation.id);
      if (!note) return reject('note does not exist');
      if (operation.type === 'note.reply') { text(operation.text); note.replies.push({ id: nextId(), text: operation.text }); }
      else { if (typeof operation.resolved !== 'boolean') reject('invalid resolution'); note.resolved = operation.resolved; }
      break;
    }
    default: reject('unsupported operation');
  }
  if (board.nodes.length > 5000 || board.edges.length > 10000 || board.notes.length > 10000) reject('board size limit reached');
}

type StoreData = { version: 1; boards: LocalBoard[] };
function validateStoredBoard(board: LocalBoard) {
  if (!board || typeof board !== 'object' || !Array.isArray(board.nodes) || !Array.isArray(board.edges) || !Array.isArray(board.notes) || !Array.isArray(board.feedback) || !Number.isSafeInteger(board.revision) || board.revision < 0 || !Number.isSafeInteger(board.nextId) || board.nextId < 1) reject('invalid stored board');
  text(board.name, 200); text(board.repo, 4096); text(board.slug, 100);
  if (!isAbsolute(board.repo) || !/^[a-zA-Z0-9_-]+$/.test(board.slug)) reject('invalid stored board identity');
  const ids = new Set<string>();
  const id = (value: string, unique = true) => {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) >= board.nextId || (unique && ids.has(value))) reject('invalid stored identifier');
    if (unique) ids.add(value);
  };
  for (const n of board.nodes) { id(n.id); node(n); }
  for (const e of board.edges) { id(e.id); edge(e, board); }
  for (const note of board.notes) {
    id(note.id); id(note.target, false); text(note.text);
    if (typeof note.resolved !== 'boolean' || !Array.isArray(note.replies)) reject('invalid stored review');
    for (const reply of note.replies) { id(reply.id); text(reply.text); }
  }
  const messages = new Set<string>();
  for (const feedback of board.feedback) {
    text(feedback.id, 100); text(feedback.text, 32000); text(feedback.context, 2 * 1024 * 1024); text(feedback.reply, 256000);
    if (messages.has(feedback.id) || !/^[a-zA-Z0-9_-]+$/.test(feedback.id) || !['saved', 'pending', 'delivered', 'uncertain', 'answered'].includes(feedback.state)) reject('invalid stored delivery');
    messages.add(feedback.id);
  }
}
export class LocalStore {
  private data: StoreData = { version: 1, boards: [] };
  private closed = false;
  private failed = false;
  private readonly file: string;
  private readonly lock: string;
  constructor(readonly directory: string, private readonly persist = atomicWrite) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'boards.json');
    this.lock = join(directory, 'writer.lock');
    let fd: number;
    try { fd = openSync(this.lock, 'wx', 0o600); }
    catch { throw new Error('UNAVAILABLE: local store is locked. Stop the other server; after a crash, verify it has exited before removing writer.lock.'); }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.boards)) throw new Error('UNAVAILABLE: unsupported local store format; keep the file and use a compatible version.');
        const slugs = new Set<string>();
        for (const board of data.boards) { validateStoredBoard(board); if (slugs.has(board.slug)) reject('duplicate stored board'); slugs.add(board.slug); }
        this.data = data;
        if (data.boards.some((b: LocalBoard) => b.feedback.some(f => f.state === 'pending'))) {
          for (const b of data.boards as LocalBoard[]) for (const f of b.feedback) if (f.state === 'pending') f.state = 'uncertain';
          this.persist(this.file, JSON.stringify(data));
        }
      }
    } catch (error) { unlinkSync(this.lock); throw error; }
    finally { closeSync(fd); }
  }
  list() { return this.data.boards.map(({ slug, name, repo, revision }) => ({ slug, name, repo, revision })); }
  read(slug: string): LocalBoard {
    const board = this.data.boards.find(b => b.slug === slug);
    if (!board) return reject('board does not exist');
    return structuredClone(board);
  }
  create(name: string, repo: string): LocalBoard {
    text(name, 200);
    if (!name.trim()) reject('board name is required');
    const board: LocalBoard = { slug: randomUUID(), name, repo: realpathSync(repo), revision: 0, nextId: 1, nodes: [], edges: [], notes: [], feedback: [] };
    this.commit({ version: 1, boards: [...this.data.boards, board] });
    return structuredClone(board);
  }
  mutate(slug: string, revision: number, operations: LocalOperation[]): LocalBoard {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 200) reject('supply 1–200 operations');
    const board = this.read(slug);
    if (revision !== board.revision) reject('board changed; read the latest revision before retrying');
    for (const operation of operations) applyLocal(board, operation);
    board.revision++;
    this.commit({ version: 1, boards: this.data.boards.map(b => b.slug === slug ? board : b) });
    return structuredClone(board);
  }
  attach(slug: string, conversation: NonNullable<LocalBoard['conversation']>) {
    const board = this.read(slug); board.conversation = conversation; this.replace(board); return board;
  }
  feedback(slug: string, id: string, prompt: string, selected: string[]) {
    text(id, 100); text(prompt, 32000);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !prompt.trim() || !Array.isArray(selected) || selected.length > 100 || selected.some(v => typeof v !== 'string')) reject('invalid feedback');
    const board = this.read(slug);
    const previous = board.feedback.find(f => f.id === id);
    if (previous) { if (previous.text !== prompt) reject('message ID already used'); return previous; }
    if (board.feedback.length >= 500) reject('feedback limit reached');
    const notes = board.notes.filter(n => !n.resolved);
    const targets = new Set([...selected, ...notes.map(n => n.target)]);
    const context = JSON.stringify({ board: { slug, name: board.name, revision: board.revision }, selected, elements: [...board.nodes, ...board.edges].filter(v => targets.has(v.id)), notes });
    const feedback: LocalFeedback = { id, text: prompt, context, state: 'saved', reply: '' };
    board.feedback.push(feedback); this.replace(board); return structuredClone(feedback);
  }
  updateFeedback(slug: string, id: string, patch: Partial<Pick<LocalFeedback, 'state' | 'reply'>>) {
    const board = this.read(slug); const feedback = board.feedback.find(f => f.id === id);
    if (!feedback) return reject('feedback does not exist');
    Object.assign(feedback, patch);
    if (feedback.reply.length > 256000) reject('reply limit reached');
    this.replace(board);
  }
  private replace(board: LocalBoard) {
    board.revision++;
    this.commit({ version: 1, boards: this.data.boards.map(b => b.slug === board.slug ? board : b) });
  }
  private commit(data: StoreData) {
    if (this.closed) reject('store is closed');
    if (this.failed) reject('previous save failed; restart the local server before editing');
    const serialized = JSON.stringify(data);
    if (data.boards.some(board => Buffer.byteLength(JSON.stringify(board)) > 2 * 1024 * 1024)) reject('board size limit reached (2 MB)');
    if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) reject('local store size limit reached');
    try { this.persist(this.file, serialized); }
    catch (error) { this.failed = true; throw error; }
    this.data = data;
  }
  close() { if (!this.closed) { this.closed = true; unlinkSync(this.lock); } }
}

export function atomicWrite(file: string, contents: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    const directory = openSync(dirname(file), 'r');
    try { renameSync(temporary, file); fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
