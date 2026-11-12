import './style.css';
import './local.css';
import { renderBoard, contentBounds } from './render';
import { Viewport } from './viewport';
import type { Node, Edge } from './module_bindings/types';
import type { LocalBoard, LocalOperation } from '../../shared/local';
import { boardHref } from '../../shared/board-link';
import { mountLocalChat } from './local-chat';
import { mountLocalRefs } from './local-refs';
import { mountLocalActivity } from './local-activity';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const svg = document.getElementById('canvas') as unknown as SVGSVGElement;
const world = document.getElementById('world') as unknown as SVGGElement;
const status = element('status');
const edit = element<HTMLFormElement>('edit');
const selection = new Set<bigint>();
const selectedEdges = new Set<bigint>();
const overrides = new Map<bigint, { x: number; y: number }>();
let board: LocalBoard | undefined;
let events: EventSource | undefined;
let busy = false;
let editorRevision = -1;
let editorId = '';
let editorDirty = false;
let editorInput = 0;
edit.oninput = () => { editorDirty = true; editorInput++; };
type Graph = Pick<LocalBoard, 'nodes' | 'edges'>;
const undo: { before: Graph; after: Graph }[] = [], redo: { before: Graph; after: Graph }[] = [];
const graph = (value: LocalBoard): Graph => structuredClone({ nodes: value.nodes, edges: value.edges });
const viewport = new Viewport(svg, world, render);
const say = (text: string) => { status.textContent = text; };
const chat = mountLocalChat(element('local-panel'), () => board, () => [...selection, ...selectedEdges].map(String), call, say);
const renderRefs = mountLocalRefs(element('local-panel'), () => board, selected, mutate, call, say);
const traffic = mountLocalActivity(element('local-panel'), world, () => board, render);
const directionLabel = document.createElement('label'); directionLabel.textContent = 'Direction';
const direction = document.createElement('select'); direction.name = 'direction';
direction.append(new Option('Forward', 'forward'), new Option('Both ways', 'both'), new Option('No arrows', 'none')); directionLabel.append(direction); edit.prepend(directionLabel);
const reloadFields = document.createElement('button'); reloadFields.type = 'button'; reloadFields.textContent = 'Reload fields';
reloadFields.onclick = () => { editorDirty = false; inspector(); }; edit.append(reloadFields);
async function call<T>(input: unknown): Promise<T> {
  const response = await fetch('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'UNAVAILABLE: request failed');
  return value;
}
function run(task: () => Promise<unknown>) { void task().catch(error => say(error.message)); }
function nodes(): Node[] {
  return (board?.nodes ?? []).map(n => ({ ...n, id: BigInt(n.id), boardId: 0n, sublabel: '', token: 'ink', focal: false, doc: n.description, hidden: false, imported: false, shape: n.kind === 'datastore' ? 'cylinder' : 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '' }));
}
function render() {
  if (!board) return;
  const edges: Edge[] = board.edges.map(e => ({ id: BigInt(e.id), boardId: 0n, fromNode: BigInt(e.from), toNode: BigInt(e.to), label: e.label, evidence: '', hidden: false, imported: false, color: '', strokeStyle: 'solid', evidenceSnippet: '', evidenceStatus: '', relation: e.direction === 'none' ? 'association' : 'calls', latencyMs: -1, latencySource: '' }));
  renderBoard(world, nodes(), edges, { selection, selectedEdges, overrides, handles: new Set(), edgeTarget: null, ghosts: new Set(), ghostEdges: new Set(), ghostSetNames: new Map(), overlay: false, codeOverlay: false, refsByNode: new Map(), scale: viewport.scale, edgeDirections: new Map(board.edges.map(e => [BigInt(e.id), e.direction])), live: traffic.live });
  traffic.sync();
  for (const item of world.querySelectorAll<SVGGElement>('.node[data-id]')) {
    item.setAttribute('tabindex', '0'); item.setAttribute('role', 'button');
    item.setAttribute('aria-label', board.nodes.find(n => n.id === item.dataset.id)?.label || 'Unnamed node');
  }
  for (const item of world.querySelectorAll<SVGPathElement>('.edge-hit[data-edge-id]')) {
    item.setAttribute('tabindex', '0'); item.setAttribute('role', 'button');
    const edge = board.edges.find(e => e.id === item.dataset.edgeId);
    item.setAttribute('aria-label', edge?.label || `Connection ${edge?.from} to ${edge?.to}`);
  }
}
function selected() {
  if (!board) return;
  return board.nodes.find(n => selection.has(BigInt(n.id))) ?? board.edges.find(e => selectedEdges.has(BigInt(e.id)));
}
function inspector() {
  chat.render();
  renderRefs();
  const item = selected(); edit.hidden = !item;
  const identity = item ? `${board!.slug}:${item.id}` : '';
  if (identity !== editorId) { editorId = identity; editorDirty = false; }
  if (item && !editorDirty) {
    editorRevision = board!.revision;
    for (const key of ['label', 'description', 'x', 'y', 'w', 'h']) {
      const input = edit.elements.namedItem(key) as HTMLInputElement;
      const value = key in item ? String(item[key as keyof typeof item]) : '';
      if (input.value !== value) input.value = value;
    }
    element('geometry').hidden = !('x' in item);
    directionLabel.hidden = 'x' in item;
    if ('direction' in item) direction.value = item.direction;
  }
  const container = element('notes'); container.replaceChildren();
  for (const note of board?.notes ?? []) {
    const section = document.createElement('section'); section.className = 'local-note';
    const target = [...board!.nodes, ...board!.edges].find(v => v.id === note.target);
    const heading = document.createElement('strong'); heading.textContent = `${note.resolved ? 'Resolved' : 'Open'} · ${target ? target.label || 'Unnamed element' : 'Detached'} · #${note.id}`;
    const text = document.createElement('p'); text.textContent = note.text;
    const toggle = document.createElement('button'); toggle.textContent = note.resolved ? 'Reopen' : 'Resolve';
    toggle.onclick = () => run(() => mutate([{ type: 'note.resolve', id: note.id, resolved: !note.resolved }]));
    section.append(heading, text, toggle);
    for (const reply of note.replies) { const p = document.createElement('p'); p.textContent = reply.text; section.append(p); }
    container.append(section);
  }
}
async function mutate(operations: LocalOperation[], expected = board?.revision, record = true) {
  if (!board || busy) throw new Error('UNAVAILABLE: wait for the current save before editing again');
  const before = graph(board), slug = board.slug;
  busy = true; say('Saving…');
  try {
    const result = await call<LocalBoard>({ action: 'apply_board', board: slug, revision: expected, operations });
    if (board.slug === slug && record && operations.some(op => op.type.startsWith('node.') || op.type.startsWith('edge.') || op.type === 'element.delete')) {
      undo.push({ before, after: graph(result) }); if (undo.length > 30) undo.shift(); redo.length = 0;
    }
    if (board.slug === slug && result.revision >= board.revision) board = result;
    say('Saved');
  }
  catch (error) { const latest = await call<LocalBoard>({ action: 'read_board', board: slug }); if (board.slug === slug && latest.revision >= board.revision) board = latest; throw error; }
  finally { busy = false; render(); inspector(); }
}
async function open(slug: string) {
  board = await call<LocalBoard>({ action: 'read_board', board: slug });
  traffic.reset();
  history.replaceState(null, '', boardHref({ app: location.origin, slug, db: 'local', home: 'local' }));
  selection.clear(); selectedEdges.clear(); overrides.clear(); render(); inspector();
  undo.length = 0; redo.length = 0;
  events?.close(); events = new EventSource(`/api/events?board=${encodeURIComponent(slug)}`);
  events.onmessage = event => { const value: LocalBoard = JSON.parse(event.data); if (value.slug === board?.slug && value.revision >= board.revision) { board = value; render(); inspector(); say('Connected · saved'); } };
  events.onerror = () => say('Disconnected · reconnecting');
  events.addEventListener('chat', event => chat.status(JSON.parse((event as MessageEvent).data)));
  events.addEventListener('activity', event => traffic.update(JSON.parse((event as MessageEvent).data)));
}
async function list() {
  const boards = await call<Pick<LocalBoard, 'slug' | 'name'>[]>({ action: 'list_boards' });
  const picker = element<HTMLSelectElement>('boards');
  if (JSON.stringify(boards.map(b => [b.name, b.slug])) !== JSON.stringify([...picker.options].map(o => [o.text, o.value]))) picker.replaceChildren(...boards.map(b => new Option(b.name, b.slug)));
  if (board) element<HTMLSelectElement>('boards').value = board.slug;
  return boards;
}
element('new-board').onclick = () => run(async () => { const name = prompt('Board name'); if (name) { const created = await call<LocalBoard>({ action: 'open_board', name }); await open(created.slug); await list(); } });
element<HTMLSelectElement>('boards').onchange = event => run(() => open((event.target as HTMLSelectElement).value));
element('add-node').onclick = () => run(() => { const p = viewport.screenToWorld(svg.getBoundingClientRect().left + 180, svg.getBoundingClientRect().top + 180); return mutate([{ type: 'node.put', patch: { label: 'Service', ...p } }]); });
element('add-edge').onclick = () => run(async () => { if (selection.size !== 2) { say('Select two nodes with Shift-click'); return; } const [from, to] = [...selection].map(String); await mutate([{ type: 'edge.put', patch: { from, to, label: 'calls' } }]); });
element('delete').onclick = () => run(async () => { const item = selected(); if (item) await mutate([{ type: 'element.delete', id: item.id }]); });
element('fit').onclick = () => viewport.fit(contentBounds(nodes()));
async function restore(backwards: boolean) {
  if (!board || busy) return;
  const from = backwards ? undo : redo, to = backwards ? redo : undo, entry = from[from.length - 1];
  if (!entry) return;
  if (JSON.stringify(graph(board)) !== JSON.stringify(backwards ? entry.after : entry.before)) { say('Graph changed elsewhere; undo would overwrite those edits'); return; }
  await mutate([{ type: 'graph.restore', ...(backwards ? entry.before : entry.after) }], board.revision, false);
  from.pop(); to.push(entry);
}
element('undo').onclick = () => run(() => restore(true));
element('redo').onclick = () => run(() => restore(false));
edit.onsubmit = event => { event.preventDefault(); run(async () => { const item = selected(); if (!item) return; const inputVersion = editorInput, identity = editorId; const values = new FormData(edit); const patch = { label: String(values.get('label')), description: String(values.get('description')) }; await mutate(['x' in item ? { type: 'node.put', id: item.id, patch: { ...patch, x: Number(values.get('x')), y: Number(values.get('y')), w: Number(values.get('w')), h: Number(values.get('h')) } } : { type: 'edge.put', id: item.id, patch: { ...patch, direction: direction.value as 'forward' | 'both' | 'none' } }], editorRevision); if (editorInput === inputVersion && editorId === identity) { editorDirty = false; inspector(); } }); };
let noteInput = 0;
element<HTMLFormElement>('note').oninput = () => { noteInput++; };
element<HTMLFormElement>('note').onsubmit = event => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement, submitted = noteInput; run(async () => { const item = selected(); if (!item) { say('Select an element for the note'); return; } await mutate([{ type: 'note.add', target: item.id, text: String(new FormData(form).get('text')) }]); if (noteInput === submitted) form.reset(); }); };
let drag: { x: number; y: number; id?: string; ox: number; oy: number; revision: number } | undefined;
svg.onpointerdown = event => {
  if (!board || busy) return;
  const hit = (event.target as Element).closest('[data-id]')?.getAttribute('data-id');
  const edge = (event.target as Element).closest('[data-edge-id]')?.getAttribute('data-edge-id');
  if (!event.shiftKey) { selection.clear(); selectedEdges.clear(); }
  if (hit) selection.add(BigInt(hit)); else if (edge) selectedEdges.add(BigInt(edge));
  const node = board.nodes.find(n => n.id === hit);
  drag = { x: event.clientX, y: event.clientY, id: node?.id, ox: node?.x ?? viewport.tx, oy: node?.y ?? viewport.ty, revision: board.revision };
  svg.setPointerCapture(event.pointerId); render(); inspector();
};
svg.onpointermove = event => {
  if (!drag) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (drag.id) { overrides.set(BigInt(drag.id), { x: drag.ox + dx / viewport.scale, y: drag.oy + dy / viewport.scale }); render(); }
  else viewport.panTo(drag.ox + dx, drag.oy + dy, 0);
};
svg.onpointerup = () => {
  const previous = drag; drag = undefined;
  if (previous?.id) { const patch = overrides.get(BigInt(previous.id)); overrides.clear(); if (patch) run(async () => { if (previous.revision !== board?.revision) { render(); say('Board changed during drag; try again'); return; } await mutate([{ type: 'node.put', id: previous.id, patch }]); }); }
};
svg.onpointercancel = () => { drag = undefined; overrides.clear(); render(); };
svg.onkeydown = event => {
  const node = (event.target as Element).closest<SVGGElement>('.node[data-id]');
  const edge = (event.target as Element).closest<SVGPathElement>('.edge-hit[data-edge-id]');
  if (node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (!event.shiftKey) selection.clear(); selectedEdges.clear(); selection.add(BigInt(node.dataset.id!)); render(); inspector(); }
  if (edge && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selection.clear(); selectedEdges.clear(); selectedEdges.add(BigInt(edge.dataset.edgeId!)); render(); inspector(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); run(() => restore(!event.shiftKey)); }
  const delta = ({ ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] } as Record<string, number[]>)[event.key];
  if (delta) { event.preventDefault(); const item = selected(); if (item && 'x' in item) run(() => mutate([{ type: 'node.put', id: item.id, patch: { x: item.x + delta[0], y: item.y + delta[1] } }])); else viewport.panBy(delta[0], delta[1]); }
};
svg.addEventListener('wheel', event => { event.preventDefault(); viewport.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * .001)); }, { passive: false });
run(async () => {
  const hash = new URLSearchParams(location.hash.slice(1)); const key = hash.get('key');
  if (key) { const response = await fetch('/session', { method: 'POST', headers: { Authorization: `Bearer ${key}` } }); if (!response.ok) throw new Error('UNAVAILABLE: reopen the startup link'); hash.delete('key'); history.replaceState(null, '', `#${hash}`); }
  const boards = await list(); const slug = hash.get('b') ?? boards[0]?.slug;
  if (slug) { await open(slug); element<HTMLSelectElement>('boards').value = slug; viewport.fit(contentBounds(nodes())); } else say('Create your first board');
  let polling = false;
  setInterval(() => {
    if (polling || document.hidden || busy) return;
    polling = true;
    run(async () => { try { const available = await list(); if (!board && available[0]) await open(available[0].slug); } finally { polling = false; } });
  }, 2000);
});
