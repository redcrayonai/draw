import html from '../index.html?raw';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Node, Edge } from './module_bindings/types';
import type { DbConnection } from './module_bindings';
import type { Ops } from './ops';
import { History } from './ops';
import { Editor, PUBLIC_EXAMPLE_HINT, READ_ONLY_HINT, type EditorDeps } from './interactions';
import { Viewport } from './viewport';
import { focusOf, nodeRect, renderBoard } from './render';
import { Crayon } from './crayon';

vi.mock('./chrome', () => ({ showError: vi.fn() }));

beforeEach(() => { document.body.innerHTML = html; });

function setup(factual = false, readOnly = false) {
  const node: Node = {
    id: 1n, boardId: 1n, label: 'Service', sublabel: 'src/components/very-long-file-name.ts',
    x: 100, y: 100, w: 160, h: 80, token: 'ink', focal: false, kind: 'service',
    doc: '', hidden: false, imported: false, shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '',
  };
  const svg = document.getElementById('board') as unknown as SVGSVGElement;
  const world = document.getElementById('world') as unknown as SVGGElement;
  svg.hasPointerCapture = () => false;
  const viewport = new Viewport(svg, world, () => {});
  const resizeNodeAction = vi.fn().mockResolvedValue(undefined);
  // Editors from earlier tests keep their window listeners (and selections):
  // a bare f in a later test reaches them too, so toggleFocal needs a history.
  const history = { batch: vi.fn().mockResolvedValue(undefined) };
  const updateNodeAction = vi.fn().mockResolvedValue(undefined);
  const deleteNodesAction = vi.fn().mockResolvedValue(undefined);
  const createNodeAction = vi.fn().mockResolvedValue(2n);
  let editor: Editor;
  const rerender = () => renderBoard(world, [node], [], {
    selection: editor.selection, selectedEdges: editor.selectedEdges, overrides: editor.overrides,
    handles: editor.handles, edgeTarget: null, ghosts: new Set(), ghostEdges: new Set(), ghostSetNames: new Map(),
    overlay: false, codeOverlay: false, refsByNode: new Map(), scale: 1,
  });
  editor = new Editor({ conn: {} as DbConnection, boardId: 1n, svg,
    wrap: document.getElementById('canvas-wrap')!, viewport,
    ops: { resizeNodeAction, history, updateNodeAction, deleteNodesAction, createNodeAction } as unknown as Ops, getNodes: () => [node], getEdges: () => [], rerender,
    topologyReadOnly: () => factual,
    readOnly: () => readOnly,
  });
  editor.selectNodes([node.id]);
  const pointer = (target: Element, type: string, x: number, y: number) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
  const drag = (dx: number, dy: number) => {
    pointer(world.querySelector('.resize-handle[data-corner="nw"]')!, 'pointerdown', node.x, node.y);
    pointer(svg, 'pointermove', node.x + dx, node.y + dy);
  };
  return { node, svg, editor, viewport, resizeNodeAction, history, updateNodeAction, deleteNodesAction, createNodeAction, pointer, drag };
}

describe('resizing fitted nodes', () => {
  it('holds opposite edges fixed when a north/west resize reaches the text minimum', () => {
    const { node, editor, drag } = setup();
    const before = nodeRect(node, editor.overrides);
    drag(20, 20);
    const after = nodeRect(node, editor.overrides);
    expect(after.x + after.w).toBe(before.x + before.w);
    expect(after.y + after.h).toBe(before.y + before.h);
  });

  it('expands from the visible bounds and records the stored dimensions for undo', () => {
    const { node, svg, editor, resizeNodeAction, pointer, drag } = setup();
    const before = nodeRect(node, editor.overrides);
    drag(-20, -20);
    const after = nodeRect(node, editor.overrides);
    expect(after).toEqual({ x: 80, y: 80, w: before.w + 20, h: before.h + 20 });
    pointer(svg, 'pointerup', 80, 80);
    expect(resizeNodeAction).toHaveBeenCalledWith(node.id,
      { x: node.x, y: node.y, w: node.w, h: node.h }, after);
  });
});

describe('architecture board context', () => {
  it('keeps the viewport and clears transient state when switching boards', () => {
    const { editor, viewport } = setup();
    viewport.tx = 400; viewport.ty = 200; viewport.scale = 0.7;
    editor.expandedRef = 30n;
    editor.selectedEdges.add(20n);
    editor.overrides.set(1n, { x: 900, y: 900 });
    editor.arm('service');
    editor.switchBoard(2n, {} as Ops);
    expect(editor.selection.size).toBe(0);
    expect(editor.selectedEdges.size).toBe(0);
    expect(editor.expandedRef).toBeNull();
    expect(editor.overrides.size).toBe(0);
    expect(editor.armedKind).toBeNull();
    expect([viewport.tx, viewport.ty, viewport.scale]).toEqual([400, 200, 0.7]);
  });

  it('disables topology controls on factual snapshots while allowing layout selection', () => {
    const { editor } = setup(true);
    editor.arm('service');
    expect(editor.armedKind).toBeNull();
    expect(editor.handles.size).toBe(0);
    editor.syncChrome();
    expect((document.getElementById('tb-kind') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('tb-delete') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('#tb-swatches .swatch')!.disabled).toBe(false);
    expect((document.getElementById('tb-focal') as HTMLButtonElement).disabled).toBe(false);
    expect(editor.selection.has(1n)).toBe(true);
  });

  it('keeps an in-flight style batch in the old board history after a switch', async () => {
    const { editor, node } = setup();
    const deps = (editor as unknown as { deps: import('./interactions').EditorDeps }).deps;
    deps.getNodes = () => [node, { ...node, id: 2n }];
    const oldHistory = new History(), newHistory = new History();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const undone: bigint[] = [];
    let first = true;
    const update = async (id: bigint) => {
      if (first) { first = false; await pending; }
      oldHistory.push({ label: 'style', undo: async () => { undone.push(id); }, redo: async () => {} });
    };
    const originalBatch = oldHistory.batch.bind(oldHistory);
    let finished!: Promise<void>;
    oldHistory.batch = (label, fn) => finished = originalBatch(label, fn);
    deps.ops = { history: oldHistory, updateNodeAction: update } as unknown as Ops;
    editor.selectNodes([1n, 2n]);
    document.querySelector<HTMLButtonElement>('#tb-swatches .swatch')!.click();
    await Promise.resolve();
    editor.switchBoard(2n, { history: newHistory, updateNodeAction: async () => { throw new Error('used new board ops'); } } as unknown as Ops);
    release();
    await finished;
    await newHistory.undo();
    expect(undone).toEqual([]);
    await oldHistory.undo();
    expect(undone).toEqual([2n, 1n]);
  });
});

describe('public examples are read only', () => {
  it('prevents opening the inline rename editor', () => {
    const { editor, node } = setup(false, true);
    editor.startInlineEdit(node, 'label');
    expect(document.getElementById('inline-edit')).toBeNull();
  });

  it('blocks style, emphasis, and topology actions even when dispatched directly', () => {
    const { editor } = setup(false, true);
    const deps = (editor as unknown as { deps: import('./interactions').EditorDeps }).deps;
    const batch = vi.fn().mockResolvedValue(undefined);
    const updateNodeAction = vi.fn().mockResolvedValue(undefined);
    deps.ops = { history: { batch }, updateNodeAction } as unknown as Ops;
    for (const selector of ['#tb-swatches .swatch', '#tb-size button', '#tb-stroke button', '#tb-shape button', '#tb-token', '#tb-focal', '#tb-kind']) {
      document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    expect(batch).not.toHaveBeenCalled();
    expect(updateNodeAction).not.toHaveBeenCalled();
    editor.arm('service');
    expect(editor.armedKind).toBeNull();
  });

  it('disables mutation controls and explains the example without calling it factual', () => {
    const { editor } = setup(false, true);
    editor.syncChrome();
    expect(editor.selection.has(1n)).toBe(true);
    expect(editor.handles.size).toBe(0);
    for (const button of document.querySelectorAll<HTMLButtonElement>('#toolbar button:not(#tb-more):not(#tb-library), .add-row')) {
      expect(button.disabled, button.outerHTML).toBe(true);
    }
    // Saving to your own library writes nothing to the board: the button
    // agrees with ⇧L and ⌘K "Add selection to library".
    expect((document.getElementById('tb-library') as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById('rail-hint')?.textContent).toBe('Public example. Explore the drawing or export it. Start a new board to draw.');
  });

  it('allows selection and pan while preventing a node drag from making a write', () => {
    const { editor, node, pointer, svg, viewport } = setup(false, true);
    const deps = (editor as unknown as { deps: import('./interactions').EditorDeps }).deps;
    const moveNodesAction = vi.fn().mockResolvedValue(undefined);
    deps.ops = { moveNodesAction } as unknown as Ops;
    editor.selection.clear();
    pointer(svg, 'pointerdown', node.x + 10, node.y + 10);
    pointer(svg, 'pointermove', node.x + 30, node.y + 30);
    expect(editor.selection.has(node.id)).toBe(true);
    expect(editor.overrides.size).toBe(0);
    pointer(svg, 'pointerup', node.x + 30, node.y + 30);
    expect(moveNodesAction).not.toHaveBeenCalled();
    editor.setHand(true);
    pointer(svg, 'pointerdown', 300, 300);
    pointer(svg, 'pointermove', 320, 320);
    expect([viewport.tx, viewport.ty]).toEqual([20, 20]);
  });

  it('a press on a node marker neither drags nor changes the selection', () => {
    const { editor, node, pointer, svg } = setup();
    editor.selection.clear();
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    marker.setAttribute('class', 'board-marker');
    marker.setAttribute('role', 'button');
    svg.querySelector(`[data-id="${node.id}"]`)!.append(marker);
    pointer(marker, 'pointerdown', node.x + 150, node.y + 5);
    pointer(svg, 'pointermove', node.x + 190, node.y + 45);
    expect(editor.overrides.size).toBe(0);
    expect(editor.selection.size).toBe(0);
    pointer(svg, 'pointerup', node.x + 190, node.y + 45);
  });

  it('tracks the hovered node (for neighbour focus) and clears it on pointerleave', () => {
    const { editor, node, pointer, svg } = setup(false, true);
    pointer(svg, 'pointermove', node.x + 30, node.y + 30);
    expect(editor.hoverId).toBe(node.id);
    expect(editor.handles.size).toBe(0);
    svg.dispatchEvent(new MouseEvent('pointerleave', { clientX: 0, clientY: 0 }));
    expect(editor.hoverId).toBeNull();
  });

  it('hit-tests a gliding node where it is drawn, not at its stored row', () => {
    const { editor, node, pointer, svg } = setup(false, true);
    editor.glide = new Map([[node.id, { x: node.x + 600, y: node.y }]]);
    pointer(svg, 'pointermove', node.x + 30, node.y + 30);
    expect(editor.hoverId).toBeNull();
    pointer(svg, 'pointermove', node.x + 630, node.y + 30);
    expect(editor.hoverId).toBe(node.id);
  });

  it('starts a drag from the drawn glide position, snapped to the grid', () => {
    const { editor, node, pointer, svg } = setup(false, false);
    editor.glide = new Map([[node.id, { x: node.x + 601.5, y: node.y }]]);
    pointer(svg, 'pointerdown', node.x + 630, node.y + 30);
    pointer(svg, 'pointermove', node.x + 630, node.y + 30 + 40);
    expect(editor.overrides.get(node.id)).toEqual({ x: node.x + 600, y: node.y + 40 });
  });

  it('blocks undo, redo and the focal shortcut', () => {
    const listener = vi.spyOn(window, 'addEventListener');
    const { editor } = setup(false, true);
    const keydown = listener.mock.calls.find(([type, _handler, options]) => type === 'keydown' && options !== true)![1] as EventListener;
    listener.mockRestore();
    const deps = (editor as unknown as { deps: import('./interactions').EditorDeps }).deps;
    const undo = vi.fn(), redo = vi.fn(), batch = vi.fn();
    deps.ops = { history: { undo, redo, batch } } as unknown as Ops;
    for (const init of [{ key: 'z', ctrlKey: true }, { key: 'z', ctrlKey: true, shiftKey: true }, { key: 'f' }]) {
      keydown(new KeyboardEvent('keydown', init));
    }
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it('does not commit an inline edit when the board becomes read only', () => {
    const { editor, node } = setup();
    const deps = (editor as unknown as { deps: import('./interactions').EditorDeps }).deps;
    const updateNodeAction = vi.fn().mockResolvedValue(undefined);
    deps.ops = { updateNodeAction } as unknown as Ops;
    editor.startInlineEdit(node, 'label');
    const input = document.getElementById('inline-edit') as HTMLTextAreaElement;
    input.value = 'Changed';
    deps.readOnly = () => true;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(updateNodeAction).not.toHaveBeenCalled();
  });

  it('holds the drag preview until the move lands, so the node never snaps back', async () => {
    const { editor, node, pointer, svg } = setup();
    const deps = (editor as unknown as { deps: import('./interactions').EditorDeps }).deps;
    let land!: () => void;
    const moveNodesAction = vi.fn(() => new Promise<void>(resolve => { land = resolve; }));
    deps.ops = { moveNodesAction, history: { batch: vi.fn() } } as unknown as Ops;
    pointer(svg, 'pointerdown', node.x + 10, node.y + 10);
    pointer(svg, 'pointermove', node.x + 30, node.y + 30);
    pointer(svg, 'pointerup', node.x + 30, node.y + 30);
    expect(moveNodesAction).toHaveBeenCalledTimes(1);
    expect(editor.overrides.size).toBe(1);
    land();
    await vi.waitFor(() => expect(editor.overrides.size).toBe(0));
  });

  it('discards a drag if the board becomes read only before pointer release', () => {
    const { editor, node, pointer, svg } = setup();
    const deps = (editor as unknown as { deps: import('./interactions').EditorDeps }).deps;
    const moveNodesAction = vi.fn().mockResolvedValue(undefined);
    deps.ops = { moveNodesAction, history: { batch: vi.fn() } } as unknown as Ops;
    pointer(svg, 'pointerdown', node.x + 10, node.y + 10);
    pointer(svg, 'pointermove', node.x + 30, node.y + 30);
    expect(editor.overrides.size).toBe(1);
    deps.readOnly = () => true;
    pointer(svg, 'pointerup', node.x + 30, node.y + 30);
    expect(editor.overrides.size).toBe(0);
    expect(moveNodesAction).not.toHaveBeenCalled();
  });
});

describe('canvas shortcuts and focused controls (G26)', () => {
  // Editors from earlier tests keep their window listeners; a Tab puts every
  // one of them back in keyboard-focus mode.
  beforeEach(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  });
  const key = (target: EventTarget, type: 'keydown' | 'keyup', init: KeyboardEventInit) => {
    const evt = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(evt);
    return evt;
  };
  const inspectorButton = () => {
    const btn = document.createElement('button');
    btn.textContent = 'copy ref';
    document.getElementById('inspector')!.append(btn);
    btn.focus();
    return btn;
  };

  it('Space on a focused inspector button does not add .panning and is left to activate it', () => {
    const { svg } = setup();
    const btn = inspectorButton();
    const evt = key(btn, 'keydown', { key: ' ', code: 'Space' });
    expect(svg.classList.contains('panning')).toBe(false);
    expect(evt.defaultPrevented).toBe(false);
  });

  it('Space on a focused rail switch or toolbar summary is left to the control', () => {
    const { svg } = setup();
    for (const el of [document.querySelector<HTMLElement>('#rail button')!, document.querySelector<HTMLElement>('#toolbar summary')!]) {
      const evt = key(el, 'keydown', { key: ' ', code: 'Space' });
      expect(evt.defaultPrevented).toBe(false);
    }
    expect(svg.classList.contains('panning')).toBe(false);
  });

  it('Space on the canvas still arms panning', () => {
    const { svg } = setup();
    const evt = key(document.body, 'keydown', { key: ' ', code: 'Space' });
    expect(svg.classList.contains('panning')).toBe(true);
    expect(evt.defaultPrevented).toBe(true);
    key(document.body, 'keyup', { key: ' ', code: 'Space' });
    expect(svg.classList.contains('panning')).toBe(false);
  });

  it('f, h, 1–5, ? and Backspace with inspector or rail focus do nothing on the canvas', () => {
    const { editor } = setup();
    const priv = editor as unknown as { toggleFocal(): void; deleteSelection(): void };
    const focal = vi.spyOn(priv, 'toggleFocal').mockImplementation(() => {});
    const del = vi.spyOn(priv, 'deleteSelection').mockImplementation(() => {});
    const btn = inspectorButton();
    const shortcuts = document.getElementById('shortcuts')!;
    const wasHidden = shortcuts.hidden;
    for (const k of ['f', 'h', '1', '?', 'Backspace', 'Delete']) key(btn, 'keydown', { key: k });
    key(document.querySelector('#rail button')!, 'keydown', { key: 'f' });
    expect(focal).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(shortcuts.hidden).toBe(wasHidden);
    expect(editor.armedKind).toBeNull();
  });

  it('modifier shortcuts still work from a focused panel control (⌥C)', () => {
    const { editor } = setup();
    const toggle = vi.spyOn(editor, 'toggleCodeOverlay').mockImplementation(() => {});
    key(inspectorButton(), 'keydown', { key: 'ç', code: 'KeyC', altKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('after a mouse click on a button, Space pans instead of pressing it again', () => {
    const { svg } = setup();
    const zoomIn = document.getElementById('hud-zoom-in')!;
    zoomIn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    zoomIn.focus();
    const evt = key(zoomIn, 'keydown', { key: ' ', code: 'Space' });
    expect(evt.defaultPrevented).toBe(true);
    expect(svg.classList.contains('panning')).toBe(true);
    key(zoomIn, 'keyup', { key: ' ', code: 'Space' });
  });

  it('after a mouse click in the rail, plain canvas shortcuts work; Tab hands keys back to the panel', () => {
    const { editor } = setup();
    const priv = editor as unknown as { toggleFocal(): void };
    const focal = vi.spyOn(priv, 'toggleFocal').mockImplementation(() => {});
    const sw = document.querySelector<HTMLElement>('#rail button')!;
    sw.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    sw.focus();
    key(sw, 'keydown', { key: 'f' });
    expect(focal).toHaveBeenCalledTimes(1);
    key(sw, 'keydown', { key: 'Tab' });
    key(sw, 'keydown', { key: 'f' });
    expect(focal).toHaveBeenCalledTimes(1);
  });

  it('plain keys with keyboard focus in the toolbar stay there', () => {
    const { editor } = setup();
    const priv = editor as unknown as { toggleFocal(): void };
    const focal = vi.spyOn(priv, 'toggleFocal').mockImplementation(() => {});
    const summary = document.querySelector<HTMLElement>('#toolbar summary')!;
    summary.focus();
    key(summary, 'keydown', { key: 'f' });
    expect(focal).not.toHaveBeenCalled();
  });

  it('a Space keyup without a Space keydown on the canvas leaves hand-mode panning alone', () => {
    const { svg, editor } = setup();
    editor.setHand(true);
    expect(svg.classList.contains('panning')).toBe(true);
    key(document.body, 'keyup', { key: ' ', code: 'Space' });
    expect(svg.classList.contains('panning')).toBe(true);
  });
});

describe('edge-only selection (G35)', () => {
  function edgeSetup(label = 'calls', refs = 0) {
    const base = { boardId: 1n, sublabel: '', w: 160, h: 80, token: 'ink', focal: false, kind: 'service', doc: '',
      hidden: false, imported: false, shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '', };
    const a: Node = { ...base, id: 1n, label: 'a', x: 100, y: 300 };
    const b: Node = { ...base, id: 2n, label: 'b', x: 900, y: 300 };
    const edge = { id: 7n, boardId: 1n, fromNode: 1n, toNode: 2n, label, evidence: '', color: '',
      strokeStyle: 'solid', hidden: false, imported: false } as Edge;
    const svg = document.getElementById('board') as unknown as SVGSVGElement;
    const world = document.getElementById('world') as unknown as SVGGElement;
    const wrap = document.getElementById('canvas-wrap')!;
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1440, bottom: 848, width: 1440, height: 848, x: 0, y: 0 }) as DOMRect;
    const viewport = new Viewport(svg, world, () => {});
    // What visible_edge_weight holds: an edge with no row is regular.
    const weights = new Map<bigint, string>();
    const updateEdgeStyleAction = vi.fn().mockResolvedValue(undefined);
    const updateNodeAction = vi.fn().mockResolvedValue(undefined);
    const ops = {
      history: new History(), updateEdgeStyleAction, updateNodeAction,
      edgeStyle: (e: Edge) => ({ color: e.color, strokeStyle: e.strokeStyle, weight: weights.get(e.id) ?? 'regular' }),
    } as unknown as Ops;
    let readOnly = false;
    const editor = new Editor({ conn: {} as DbConnection, boardId: 1n, svg, wrap, viewport,
      ops, getNodes: () => [a, b], getEdges: () => [edge], rerender: () => {}, readOnly: () => readOnly,
    });
    // The bar anchors on what the renderer drew (G35): draw the board the
    // way main.ts does before syncChrome.
    const draw = (codeOverlay = false, scale = 1) =>
      renderBoard(world, [a, b], [edge], {
        selection: new Set(), selectedEdges: new Set([edge.id]), overrides: new Map(), handles: new Set(), edgeTarget: null,
        ghosts: new Set(), ghostEdges: new Set(), ghostSetNames: new Map(), overlay: false, codeOverlay,
        refsByNode: new Map(), refsByEdge: refs > 0 ? new Map([[edge.id, { key: `${refs}`, count: refs, title: 'f' }]]) : undefined,
        scale,
      });
    draw();
    const setReadOnly = (on: boolean) => { readOnly = on; };
    return { editor, a, b, edge, viewport, draw, weights, updateEdgeStyleAction, updateNodeAction, setReadOnly };
  }

  it('edge-only selection hides the readout', () => {
    const { editor, edge } = edgeSetup();
    const dim = document.getElementById('dim-badge')!;
    editor.selectNodes([1n]);
    editor.syncChrome();
    expect(dim.hidden).toBe(false);
    editor.selectEdges([edge.id]);
    editor.syncChrome();
    expect(dim.hidden).toBe(true);
    expect(document.getElementById('toolbar')!.hidden).toBe(false);
  });

  it('anchors the toolbar at the edge label, not across both endpoints', () => {
    const { editor, edge } = edgeSetup();
    editor.selectEdges([edge.id]);
    editor.syncChrome();
    const toolbar = document.getElementById('toolbar')!;
    // label centred on the path midpoint (260 → 900 at y 340); the bar sits
    // 12 px above the 18 px label box, which is centred on the line: 331–349
    expect(parseFloat(toolbar.style.left)).toBe(580);
    expect(parseFloat(toolbar.style.top)).toBe(331 - 12);
  });

  it('under the code overlay the bar clears the whole run, " · N refs" included (G51)', () => {
    const { editor, edge, draw } = edgeSetup('calls', 3);
    const selClient = () => (editor as unknown as { selClient: { x: number; w: number } }).selClient;
    editor.selectEdges([edge.id]);
    editor.syncChrome();
    expect(selClient().w).toBeCloseTo('calls'.length * 7.3 + 8, 5);
    editor.setCodeOverlay(true);
    draw(true);
    editor.syncChrome();
    expect(selClient().w).toBeCloseTo('calls · 3 refs'.length * 7.3 + 8, 5);
    expect(selClient().x + selClient().w / 2).toBeCloseTo(580, 5);
  });

  it('an unlabelled edge with refs puts the bar above its "N refs" box, not on it', () => {
    const { editor, edge, viewport, draw } = edgeSetup('', 2);
    editor.setCodeOverlay(true);
    draw(true);
    editor.selectEdges([edge.id]);
    editor.syncChrome();
    const toolbar = document.getElementById('toolbar')!;
    expect(parseFloat(toolbar.style.top)).toBe(331 - 12);
    // below 60% zoom the count is not drawn: the bar goes back to the midpoint
    viewport.scale = 0.5;
    draw(true, 0.5);
    editor.syncChrome();
    expect(parseFloat(toolbar.style.top)).toBe(340 * 0.5 - 12);
  });
  describe('edge style controls (RC-688)', () => {
    const q = <T extends Element = HTMLButtonElement>(sel: string) => document.querySelector<T>(sel)!;
    const pressed = (sel: string, attr: string) => [...document.querySelectorAll<HTMLButtonElement>(sel)]
      .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.getAttribute(attr));
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));

    it('offers dotted, weight, Default and Reset for an edge selection, and not for a node selection', () => {
      const { editor, edge } = edgeSetup();
      const toolbar = q<HTMLElement>('#toolbar');
      editor.selectNodes([1n]);
      editor.syncChrome();
      expect(toolbar.classList.contains('edges-only')).toBe(false);
      editor.selectEdges([edge.id]);
      editor.syncChrome();
      expect(toolbar.classList.contains('edges-only')).toBe(true);
    });

    it("shows the edge's own colour, line and weight, and Default for an edge without a colour", () => {
      const { editor, edge, weights } = edgeSetup();
      editor.selectEdges([edge.id]);
      editor.syncChrome();
      expect(pressed('#tb-swatches .swatch', 'data-color')).toEqual(['']);
      expect(q('#tb-color-menu summary').getAttribute('aria-label')).toBe('Colour: Default');
      expect(q('#tb-color-dot').getAttribute('class')).toBe('sw-default');
      expect(pressed('#tb-stroke button', 'data-stroke')).toEqual(['solid']);
      expect(pressed('#tb-weight button', 'data-weight')).toEqual(['regular']);
      Object.assign(edge, { color: 'purple', strokeStyle: 'dotted' });
      weights.set(edge.id, 'bold');
      editor.syncChrome();
      expect(pressed('#tb-swatches .swatch', 'data-color')).toEqual(['purple']);
      expect(q('#tb-color-menu summary').getAttribute('aria-label')).toBe('Colour: Purple');
      expect(pressed('#tb-stroke button', 'data-stroke')).toEqual(['dotted']);
      expect(pressed('#tb-weight button', 'data-weight')).toEqual(['bold']);
    });

    it('a node selection never shows the Default swatch as its colour', () => {
      const { editor } = edgeSetup();
      editor.selectNodes([1n]);
      editor.syncChrome();
      expect(pressed('#tb-swatches .swatch', 'data-color')).toEqual(['ink']);
      expect(pressed('#tb-weight button', 'data-weight')).toEqual([]);
    });

    it('each control sets one part of the style on the selected edges, as one undo step', async () => {
      const { editor, edge, updateEdgeStyleAction } = edgeSetup();
      editor.selectEdges([edge.id]);
      editor.syncChrome();
      q('#tb-weight [data-weight="bold"]').click();
      q('#tb-stroke [data-stroke="dotted"]').click();
      q('#tb-swatches [data-color="blue"]').click();
      q('#tb-swatches [data-color=""]').click();
      await settle();
      expect(updateEdgeStyleAction.mock.calls).toEqual([
        [edge.id, { weight: 'bold' }],
        [edge.id, { strokeStyle: 'dotted' }],
        [edge.id, { color: 'blue' }],
        [edge.id, { color: '' }],
      ]);
    });

    it('dotted never reaches a node: a node border has no dotted look', async () => {
      const { editor, updateNodeAction, updateEdgeStyleAction } = edgeSetup();
      editor.selectNodes([1n]);
      q('#tb-stroke [data-stroke="dotted"]').click();
      q('#tb-weight [data-weight="bold"]').click();
      await settle();
      expect(updateNodeAction).not.toHaveBeenCalled();
      expect(updateEdgeStyleAction).not.toHaveBeenCalled();
      q('#tb-stroke [data-stroke="dashed"]').click();
      await settle();
      expect(updateNodeAction).toHaveBeenCalledWith(1n, { strokeStyle: 'dashed' });
    });

    it('Reset is off for a default edge, and puts a styled one back to colour none, solid, regular', async () => {
      const { editor, edge, weights, updateEdgeStyleAction } = edgeSetup();
      const reset = q('#tb-reset-style');
      editor.selectEdges([edge.id]);
      editor.syncChrome();
      expect(reset.disabled).toBe(true);
      for (const style of [{ color: 'red' }, { strokeStyle: 'dashed' }]) {
        Object.assign(edge, style);
        editor.syncChrome();
        expect(reset.disabled, JSON.stringify(style)).toBe(false);
        Object.assign(edge, { color: '', strokeStyle: 'solid' });
      }
      weights.set(edge.id, 'medium');
      editor.syncChrome();
      expect(reset.disabled).toBe(false);
      reset.click();
      await settle();
      expect(updateEdgeStyleAction).toHaveBeenCalledWith(edge.id, { color: '', strokeStyle: 'solid', weight: 'regular' });
    });

    it('says, while the evidence overlay is on, that line and weight show evidence', () => {
      const { editor, edge } = edgeSetup();
      const note = q<HTMLElement>('#tb-overlay-note');
      editor.selectEdges([edge.id]);
      editor.syncChrome();
      expect(note.hidden).toBe(true);
      editor.toggleOverlay();
      editor.syncChrome();
      expect(note.hidden).toBe(false);
      editor.toggleOverlay();
      editor.syncChrome();
      expect(note.hidden).toBe(true);
    });

    it('a read-only board disables and ignores every edge style control', async () => {
      const { editor, edge, weights, updateEdgeStyleAction, setReadOnly } = edgeSetup();
      weights.set(edge.id, 'bold');
      setReadOnly(true);
      editor.selectEdges([edge.id]);
      editor.syncChrome();
      for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-weight button, #tb-stroke button, #tb-swatches .swatch, #tb-reset-style')) {
        expect(b.disabled, b.outerHTML).toBe(true);
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      await settle();
      expect(updateEdgeStyleAction).not.toHaveBeenCalled();
    });

    it('an identical rerender of an edge selection writes nothing to the toolbar', () => {
      const { editor, edge, weights } = edgeSetup();
      weights.set(edge.id, 'medium');
      editor.selectEdges([edge.id]);
      editor.syncChrome();
      const mo = new MutationObserver(() => {});
      mo.observe(q('#toolbar'), { attributes: true, childList: true, characterData: true, subtree: true });
      editor.syncChrome();
      expect(mo.takeRecords()).toEqual([]);
      mo.disconnect();
    });
  });
});

describe('toolbar toggles expose their state (G32)', () => {
  it('every toolbar option has aria-pressed matching .on', () => {
    const { editor, node } = setup();
    const options = () => [...document.querySelectorAll<HTMLButtonElement>(
      '#tb-swatches .swatch, #tb-size button, #tb-stroke button, #tb-shape button')];
    const check = () => {
      for (const b of options()) {
        expect(b.getAttribute('aria-pressed'), b.outerHTML).toBe(String(b.classList.contains('on')));
      }
    };
    editor.syncChrome();
    check();
    expect(options().filter(b => b.classList.contains('on')).map(b => b.dataset.color ?? b.dataset.size ?? b.dataset.stroke ?? b.dataset.shape))
      .toEqual(['ink', 'm', 'solid', 'rect']);
    Object.assign(node, { color: 'blue', size: 'l', strokeStyle: 'dashed', shape: 'ellipse' });
    editor.syncChrome();
    check();
    expect(options().filter(b => b.classList.contains('on')).map(b => b.dataset.color ?? b.dataset.size ?? b.dataset.stroke ?? b.dataset.shape))
      .toEqual(['blue', 'l', 'dashed', 'ellipse']);
    expect(document.querySelector('#tb-color-menu summary')!.getAttribute('aria-label')).toBe('Colour: Blue');
    node.color = '';
    editor.syncChrome();
    expect(document.querySelector('#tb-color-menu summary')!.getAttribute('aria-label')).toBe('Colour: Ink');
  });

  it("a node coloured '' (ink) presses the Ink swatch, as the summary says", () => {
    const { editor, node } = setup();
    const ink = document.querySelector<HTMLButtonElement>('#tb-swatches .swatch[data-color="ink"]')!;
    const pressed = () => [...document.querySelectorAll<HTMLButtonElement>('#tb-swatches .swatch')]
      .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.color);
    node.color = '';
    editor.syncChrome();
    expect(ink.getAttribute('aria-pressed')).toBe('true');
    expect(ink.classList.contains('on')).toBe(true);
    expect(pressed()).toEqual(['ink']);
    expect(document.querySelector('#tb-color-menu summary')!.getAttribute('aria-label')).toBe('Colour: Ink');
    node.color = 'red';
    editor.syncChrome();
    expect(pressed()).toEqual(['red']);
    expect(ink.classList.contains('on')).toBe(false);
  });

  it('an identical rerender writes nothing to the toolbar, the size readout or the zoom label', () => {
    const { editor } = setup();
    const mo = new MutationObserver(() => {});
    for (const id of ['toolbar', 'dim-badge', 'hud-zoom']) {
      mo.observe(document.getElementById(id)!, { attributes: true, childList: true, characterData: true, subtree: true });
    }
    const written = () => mo.takeRecords().map(r =>
      `${(r.target as Element).id || (r.target as Element).tagName} ${r.type} ${r.attributeName ?? ''}`.trim());
    // a node selected, then with an open menu, then nothing selected
    const states = [
      () => {},
      () => { (document.getElementById('tb-color-menu') as HTMLDetailsElement).open = true; },
      () => editor.selectNodes([]),
    ];
    for (const enter of states) {
      enter();
      editor.syncChrome();
      expect(written().length).toBeGreaterThanOrEqual(0);
      editor.syncChrome();
      expect(written()).toEqual([]);
    }
    mo.disconnect();
  });
});

describe('revealSelection timing (G7)', () => {
  function revealSetup() {
    const base = { boardId: 1n, sublabel: '', w: 160, h: 80, token: 'ink', focal: false, kind: 'service', doc: '',
      hidden: false, imported: false, shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '', };
    const nodes: Node[] = [{ ...base, id: 1n, label: 'a', x: 100, y: 300 }, { ...base, id: 2n, label: 'b', x: 600, y: 300 }];
    const svg = document.getElementById('board') as unknown as SVGSVGElement;
    const world = document.getElementById('world') as unknown as SVGGElement;
    svg.hasPointerCapture = () => false;
    const wrap = document.getElementById('canvas-wrap')!;
    const viewport = new Viewport(svg, world, () => {});
    let editor: Editor;
    const rerender = () => {
      renderBoard(world, nodes, [], {
        selection: editor.selection, selectedEdges: editor.selectedEdges, overrides: editor.overrides,
        handles: editor.handles, edgeTarget: null, ghosts: new Set(), ghostEdges: new Set(), ghostSetNames: new Map(),
        overlay: false, codeOverlay: false, refsByNode: new Map(), scale: 1,
      });
      editor.syncChrome();
    };
    const moveNodesAction = vi.fn().mockResolvedValue(undefined);
    editor = new Editor({ conn: {} as DbConnection, boardId: 1n, svg, wrap, viewport,
      ops: { moveNodesAction, history: { batch: vi.fn() } } as unknown as Ops, getNodes: () => nodes, getEdges: () => [], rerender,
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    // counted, not run: this test is about when, not how far
    const reveal = vi.spyOn(editor, 'revealSelection').mockImplementation(() => {});
    const pointer = (type: string, x: number, y: number) =>
      svg.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    return { editor, reveal, pointer };
  }

  it('a click reveals the new selection once, after pointerup; dragging it does not', () => {
    const { reveal, pointer } = revealSetup();
    pointer('pointerdown', 150, 340);
    expect(reveal).not.toHaveBeenCalled(); // mid-gesture
    pointer('pointerup', 150, 340);
    expect(reveal).toHaveBeenCalledTimes(1);
    reveal.mockClear();
    pointer('pointerdown', 650, 340);
    pointer('pointermove', 900, 340);
    pointer('pointerup', 900, 340);
    expect(reveal).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('a new gesture stops a running reveal pan (G7)', () => {
  it.each([
    ['a marquee on the empty canvas', 1000, 700],
    ['a drag on a node', 150, 340],
  ])('%s: the canvas stops sliding before the gesture starts', (_, x, y) => {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++next, cb); return next; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    const flush = (t: number) => { const due = [...frames.values()]; frames.clear(); for (const cb of due) cb(t); };
    try {
      const base = { boardId: 1n, sublabel: '', w: 160, h: 80, token: 'ink', focal: false, kind: 'service', doc: '',
        hidden: false, imported: false, shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '', };
      const nodes: Node[] = [{ ...base, id: 1n, label: 'a', x: 100, y: 300 }];
      const svg = document.getElementById('board') as unknown as SVGSVGElement;
      const world = document.getElementById('world') as unknown as SVGGElement;
      svg.hasPointerCapture = () => false;
      const viewport = new Viewport(svg, world, () => {});
      new Editor({ conn: {} as DbConnection, boardId: 1n, svg, wrap: document.getElementById('canvas-wrap')!,
        viewport, ops: { history: { batch: vi.fn() } } as unknown as Ops, getNodes: () => nodes, getEdges: () => [], rerender: () => {},
      });
      // a reveal pan is under way
      const t0 = performance.now();
      viewport.panTo(-300, 0, 200);
      flush(t0 + 40);
      const at = viewport.tx;
      expect(at).toBeLessThan(0);
      svg.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }));
      flush(t0 + 400);
      expect(viewport.tx).toBe(at);
      svg.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: x, clientY: y }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('rail hint (G10)', () => {
  function editorWith(hasSession: () => boolean) {
    const svg = document.getElementById('board') as unknown as SVGSVGElement;
    const world = document.getElementById('world') as unknown as SVGGElement;
    return new Editor({ conn: {} as DbConnection, boardId: 1n, svg,
      wrap: document.getElementById('canvas-wrap')!, viewport: new Viewport(svg, world, () => {}),
      ops: {} as Ops, getNodes: () => [], getEdges: () => [], rerender: () => {}, hasSession,
    });
  }
  const hint = () => document.getElementById('rail-hint')!;

  it('rail hint hidden on session board', () => {
    const editor = editorWith(() => true);
    editor.syncRail();
    expect(hint().hidden).toBe(true);
  });

  it('a session row arriving later hides the hint; arming still shows the armed line', () => {
    let session = false;
    const editor = editorWith(() => session);
    editor.syncRail();
    expect(hint().hidden).toBe(false);
    expect(hint().textContent).toBe('Choose a tool below to draw. Select a node to edit it.');
    session = true;
    editor.syncRail();
    expect(hint().hidden).toBe(true);
    editor.arm('service');
    expect(hint().hidden).toBe(false);
    expect(hint().textContent).toContain('armed · service');
    expect(hint().textContent).toContain('keep clicking to place more');
    editor.arm(null);
    expect(hint().hidden).toBe(true);
  });

  it('a second syncRail with unchanged state writes nothing (keyed render)', () => {
    for (const [session, kind] of [[false, null], [true, null], [true, 'service']] as const) {
      document.body.innerHTML = html;
      const editor = editorWith(() => session);
      editor.arm(kind);
      editor.syncRail();
      const observer = new MutationObserver(() => {});
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      editor.syncRail();
      expect(observer.takeRecords(), `session=${session} armed=${kind}`).toEqual([]);
      observer.disconnect();
    }
  });
});

describe('chart hover gate', () => {
  it('is ready only in select mode with no gesture or inline edit in progress', () => {
    const { node, svg, editor, pointer } = setup();
    expect(editor.hoverReady).toBe(true);
    editor.arm('service');
    expect(editor.hoverReady).toBe(false);
    editor.arm(null);
    editor.setHand(true);
    expect(editor.hoverReady).toBe(false);
    editor.setHand(false);
    pointer(svg, 'pointerdown', node.x + 80, node.y + 40);
    expect(editor.hoverReady).toBe(false);
    pointer(svg, 'pointerup', node.x + 80, node.y + 40);
    expect(editor.hoverReady).toBe(true);
    editor.startInlineEdit(node, 'label');
    expect(editor.hoverReady).toBe(false);
    document.getElementById('inline-edit')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(editor.hoverReady).toBe(true);
  });
});

describe('touch', () => {
  const touch = (svg: Element, type: string, id: number, x: number, y: number) =>
    svg.dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, clientX: x, clientY: y, pointerType: 'touch', pointerId: id, isPrimary: id === 1,
    }));

  it('a finger on empty canvas pans instead of marqueeing; only a tap there clears the selection', () => {
    const { node, svg, editor, viewport } = setup();
    touch(svg, 'pointerdown', 1, 400, 400);
    touch(svg, 'pointermove', 1, 430, 420);
    touch(svg, 'pointerup', 1, 430, 420);
    expect([viewport.tx, viewport.ty]).toEqual([30, 20]);
    expect([...editor.selection]).toEqual([node.id]);
    touch(svg, 'pointerdown', 1, 400, 400);
    touch(svg, 'pointerup', 1, 403, 401);
    expect(editor.selection.size).toBe(0);
  });

  it('a pan that comes back to where it began is still a pan, not a tap', () => {
    const { node, svg, editor } = setup();
    touch(svg, 'pointerdown', 1, 400, 400);
    touch(svg, 'pointermove', 1, 450, 400);
    touch(svg, 'pointermove', 1, 402, 400);
    touch(svg, 'pointerup', 1, 402, 400);
    expect([...editor.selection]).toEqual([node.id]);
  });

  it('a short pan is not the first tap of a double: the next press pans again', () => {
    const { svg, viewport } = setup();
    touch(svg, 'pointerdown', 1, 400, 400);
    touch(svg, 'pointermove', 1, 415, 400);
    touch(svg, 'pointerup', 1, 415, 400);
    touch(svg, 'pointerdown', 1, 415, 400);
    touch(svg, 'pointermove', 1, 445, 400);
    expect(viewport.tx).toBe(45);
  });

  it('two fingers zoom about their midpoint, and the one left behind pans on', () => {
    const { svg, viewport } = setup();
    touch(svg, 'pointerdown', 1, 300, 300);
    touch(svg, 'pointerdown', 2, 400, 300);
    touch(svg, 'pointermove', 2, 500, 300);
    expect(viewport.scale).toBe(2);
    // The world point under the first midpoint (350, 300) is under the new one (400, 300).
    expect(viewport.screenToWorld(400, 300)).toEqual({ x: 350, y: 300 });
    touch(svg, 'pointerup', 2, 500, 300);
    const tx = viewport.tx;
    touch(svg, 'pointermove', 1, 310, 300);
    expect(viewport.tx).toBe(tx + 10);
  });

  it('a second finger drops the drag the first one started', () => {
    const { node, svg, editor } = setup();
    touch(svg, 'pointerdown', 1, node.x + 10, node.y + 10);
    touch(svg, 'pointermove', 1, node.x + 60, node.y + 60);
    expect(editor.overrides.size).toBe(1);
    touch(svg, 'pointerdown', 2, 400, 400);
    expect(editor.overrides.size).toBe(0);
  });

  it('a cancelled drag ends where it is and writes nothing', () => {
    const { node, svg, editor } = setup();
    touch(svg, 'pointerdown', 1, node.x + 10, node.y + 10);
    touch(svg, 'pointermove', 1, node.x + 60, node.y + 60);
    touch(svg, 'pointercancel', 1, node.x + 60, node.y + 60);
    expect(editor.overrides.size).toBe(0);
    expect(editor.hoverReady).toBe(true);
  });

  it('on a read-only board a finger over a node pans, and a tap selects it', () => {
    const { node, svg, editor, viewport } = setup(false, true);
    editor.selectNodes([]);
    touch(svg, 'pointerdown', 1, node.x + 10, node.y + 10);
    touch(svg, 'pointermove', 1, node.x + 40, node.y + 10);
    touch(svg, 'pointerup', 1, node.x + 40, node.y + 10);
    expect(viewport.tx).toBe(30);
    expect(editor.selection.size).toBe(0);
    touch(svg, 'pointerdown', 1, node.x + 40, node.y + 10);
    touch(svg, 'pointerup', 1, node.x + 40, node.y + 10);
    expect([...editor.selection]).toEqual([node.id]);
  });

  it('a double tap allows a finger\'s drift', () => {
    const { node, svg } = setup();
    for (const dx of [0, 15]) {
      touch(svg, 'pointerdown', 1, node.x + 80 + dx, node.y + 40);
      touch(svg, 'pointerup', 1, node.x + 80 + dx, node.y + 40);
    }
    expect(document.getElementById('inline-edit')).not.toBeNull();
  });
});

describe('drawn = stored (G2)', () => {
  it('readout equals stored size', () => {
    const { node, editor } = setup();
    node.label = 'result texts and the companion checkpoint summary formatter';
    node.w = 160;
    node.h = 48;
    editor.syncChrome();
    expect(document.getElementById('dim-badge')!.textContent).toBe('160 × 48');
  });

  it('resize stops at 64 × 48 whatever the label', () => {
    const { node, editor, drag } = setup();
    node.label = 'result texts and the companion checkpoint summary formatter';
    drag(400, 400);
    const r = nodeRect(node, editor.overrides);
    expect({ w: r.w, h: r.h }).toEqual({ w: 64, h: 48 });
  });

  it('the inline label editor covers the wrapped label block', () => {
    const { node, editor, viewport } = setup();
    node.label = 'result texts and the companion checkpoint summary formatter';
    node.sublabel = '';
    node.w = 280;
    node.h = 96;
    editor.selectNodes([]);
    const label = document.querySelector('[data-id="1"] .node-label')!;
    expect(label.querySelectorAll('tspan')).toHaveLength(2);
    editor.startInlineEdit(node, 'label');
    const input = document.getElementById('inline-edit') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    const lh = parseFloat(input.style.lineHeight);
    expect(lh).toBe(19);
    // two rows tall, as wide as the text room, centred on the node
    expect(parseFloat(input.style.height)).toBe(2 * lh);
    expect(parseFloat(input.style.width)).toBe(280 - 32);
    // the first line box (inside the 1 px border) puts its baseline on the drawn one
    const baseline = viewport.worldToScreen(node.x, node.y + Number(label.getAttribute('y'))).y;
    const top = parseFloat(input.style.top) + 1;
    expect(top + lh / 2 + 0.34 * 15).toBeCloseTo(baseline, 5);
    expect(parseFloat(input.style.left) + 3).toBeCloseTo(viewport.worldToScreen(node.x + 16, 0).x, 5);
    // Enter commits, never a newline
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(document.getElementById('inline-edit')).toBeNull();
  });
});

describe('inline label editor shows the whole label (P9)', () => {
  it('a long label drawn on one line opens two lines tall, scrolled to its start', () => {
    const { node, editor } = setup();
    node.label = 'result texts and the companion checkpoint summary formatter';
    node.sublabel = 'agent/src/results.ts';
    node.w = 280;
    node.h = 64;
    editor.selectNodes([]);
    // the sublabel leaves room for one drawn label line
    const drawn = document.querySelector('[data-id="1"] .node-label')!;
    expect(drawn.querySelectorAll('tspan').length).toBeLessThanOrEqual(1);
    expect(drawn.textContent!.endsWith('…')).toBe(true);
    editor.startInlineEdit(node, 'label');
    const input = document.getElementById('inline-edit') as HTMLTextAreaElement;
    const lh = parseFloat(input.style.lineHeight);
    expect(parseFloat(input.style.height)).toBe(2 * lh);
    expect(input.scrollTop).toBe(0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('closing the editor reveals the selection the double-click skipped', () => {
    const { node, editor } = setup();
    editor.selectNodes([node.id]);
    editor.startInlineEdit(node, 'label');
    const reveal = vi.spyOn(editor, 'revealSelection');
    const input = document.getElementById('inline-edit') as HTMLTextAreaElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(reveal).toHaveBeenCalled();
  });

  it('a short label stays one line tall', () => {
    const { node, editor } = setup();
    node.label = 'api';
    node.sublabel = 'agent/src/api.ts';
    node.w = 280;
    node.h = 64;
    editor.selectNodes([]);
    editor.startInlineEdit(node, 'label');
    const input = document.getElementById('inline-edit') as HTMLTextAreaElement;
    expect(parseFloat(input.style.height)).toBe(parseFloat(input.style.lineHeight));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
});

describe('inline editor matches the drawn text of each kind', () => {
  const open = (kind: string, size = 'm') => {
    const { node, editor, viewport } = setup();
    Object.assign(node, { kind, size, label: 'agent process', sublabel: '' });
    editor.selectNodes([]);
    editor.startInlineEdit(node, 'label');
    const input = document.getElementById('inline-edit') as HTMLInputElement;
    const close = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { node, input, viewport, close };
  };

  it('a boundary label edits in its own 13 px sans heading, from where it is drawn', () => {
    const { node, input, viewport, close } = open('boundary');
    expect([...input.classList]).toEqual(['boundary']);
    expect(input.style.fontSize).toBe('13px');
    // the drawn label starts at x 16; the text sits inside a 1 px border and 2 px padding
    expect(parseFloat(input.style.left) + 3).toBeCloseTo(viewport.worldToScreen(node.x + 16, 0).x, 5);
    close();
  });

  it.each([['s', 12], ['m', 14], ['l', 17]])('a size-%s note body edits at its drawn %i px, weight 400', (size, px) => {
    const { input, close } = open('note', size);
    expect([...input.classList]).toEqual(['note']);
    expect(input.style.fontSize).toBe(`${px}px`);
    close();
  });

  it('a note body edits in a wrapping textarea, so no drawn line shows below it', () => {
    const { input, close } = open('note');
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.style.lineHeight).toBe('21px');
    close();
  });

  it('a service label keeps the plain 500 editor', () => {
    const { input, close } = open('service');
    expect(input.classList.contains('boundary') || input.classList.contains('note')).toBe(false);
    close();
  });

  it('style.css gives each modifier the drawn family and weight', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const rule = (sel: string) => {
      const at = css.indexOf(`\n${sel} {`);
      return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
    };
    expect(rule('#inline-edit')).toMatch(/font-weight: 500;/);
    expect(rule('#inline-edit.boundary')).toMatch(/font-weight: 600;/);
    expect(rule('#inline-edit.boundary')).not.toMatch(/--mono/);
    expect(rule('#inline-edit.note')).toMatch(/font-weight: 400;/);
    expect(rule('#inline-edit.note')).not.toMatch(/--mono/);
  });
});

describe('code overlay needs a session (G42)', () => {
  function editorWith(hasSession: () => boolean, onCodeOverlayChange = vi.fn()) {
    const svg = document.getElementById('board') as unknown as SVGSVGElement;
    const world = document.getElementById('world') as unknown as SVGGElement;
    const rerender = vi.fn();
    const editor = new Editor({ conn: {} as DbConnection, boardId: 1n, svg,
      wrap: document.getElementById('canvas-wrap')!, viewport: new Viewport(svg, world, () => {}),
      ops: {} as Ops, getNodes: () => [], getEdges: () => [], rerender, hasSession, onCodeOverlayChange,
    });
    return { editor, rerender, onCodeOverlayChange };
  }
  const row = () => document.getElementById('code-overlay-row')!;

  it('⌥C is a no-op on a board without a session', () => {
    const { editor, rerender, onCodeOverlayChange } = editorWith(() => false);
    editor.toggleCodeOverlay();
    expect(editor.codeOverlay).toBe(false);
    expect(row().getAttribute('aria-pressed')).toBe('false');
    expect(onCodeOverlayChange).not.toHaveBeenCalled();
    expect(rerender).not.toHaveBeenCalled();
  });

  it('on a session board ⌥C toggles and reports the explicit change', () => {
    const { editor, onCodeOverlayChange } = editorWith(() => true);
    editor.toggleCodeOverlay();
    expect(editor.codeOverlay).toBe(true);
    expect(row().getAttribute('aria-pressed')).toBe('true');
    expect(onCodeOverlayChange).toHaveBeenCalledTimes(1);
  });

  it('setCodeOverlay applies the default silently: no change report, no rerender', () => {
    const { editor, rerender, onCodeOverlayChange } = editorWith(() => true);
    editor.setCodeOverlay(true);
    expect(editor.codeOverlay).toBe(true);
    expect(row().getAttribute('aria-pressed')).toBe('true');
    expect(onCodeOverlayChange).not.toHaveBeenCalled();
    expect(rerender).not.toHaveBeenCalled();
  });
});

describe('charts in the editor', () => {
  const asChart = (node: Node) =>
    Object.assign(node, { kind: 'chart', label: 'p99 latency', sublabel: 'checkout · last hour', w: 352, h: 224 });

  it('resize stops at the chart minimum, 224 × 144', () => {
    const { node, editor, drag } = setup();
    asChart(node);
    drag(400, 400);
    const r = nodeRect(node, editor.overrides);
    expect({ w: r.w, h: r.h }).toEqual({ w: 224, h: 144 });
  });

  it('the kind cycle is off while a chart is selected, and a click that gets through changes nothing', () => {
    const { node, editor } = setup();
    const tbKind = document.getElementById('tb-kind') as HTMLButtonElement;
    editor.syncChrome();
    expect(tbKind.disabled).toBe(false);
    asChart(node);
    // A keyboard click can land before syncChrome disables the button.
    tbKind.click();
    const deps = (editor as unknown as { deps: import('./interactions').EditorDeps }).deps;
    expect(deps.ops.history.batch).not.toHaveBeenCalled();
    editor.syncChrome();
    expect(tbKind.disabled).toBe(true);
  });

  it('the shape control is off while a chart is selected; a chart card draws as a rect whatever its stored shape and token', () => {
    const { node, editor } = setup();
    const shapes = () => [...document.querySelectorAll<HTMLButtonElement>('#tb-shape button')];
    editor.syncChrome();
    expect(shapes().map(b => b.disabled)).toEqual([false, false, false]);
    asChart(node);
    Object.assign(node, { shape: 'ellipse', token: 'muted' });
    shapes()[2].click(); // a keyboard click can land before syncChrome
    const deps = (editor as unknown as { deps: import('./interactions').EditorDeps }).deps;
    expect(deps.ops.history.batch).not.toHaveBeenCalled();
    editor.syncChrome();
    expect(shapes().map(b => b.disabled)).toEqual([true, true, true]);
    editor.selectNodes([]); // redraw the card as a chart
    const rect = document.querySelector('[data-id="1"] .node-rect')!;
    expect([rect.getAttribute('data-shape'), rect.getAttribute('rx'), rect.getAttribute('ry')]).toEqual(['rect', '10', '10']);
    expect(document.querySelector('[data-id="1"] text[data-field="label"]')!.textContent).toBe('p99 latency');
  });

  it('double-click editing puts a one-line editor on the drawn subtitle and title, and Enter saves', () => {
    const { node, editor, viewport } = setup();
    asChart(node);
    editor.selectNodes([]); // redraw the card as a chart
    const drawn = document.querySelector('[data-id="1"] text[data-field="sublabel"]')!;
    expect(drawn.classList.contains('chart-subtitle')).toBe(true);
    const updateNodeAction = vi.fn().mockResolvedValue(undefined);
    const deps = (editor as unknown as { deps: import('./interactions').EditorDeps }).deps;
    deps.ops = { ...deps.ops, updateNodeAction } as unknown as Ops;

    editor.startInlineEdit(node, 'sublabel');
    const input = document.getElementById('inline-edit') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect([...input.classList]).toEqual(['chart', 'chart-sub']);
    expect(input.style.textAlign).toBe('left');
    expect(input.value).toBe('checkout · last hour');
    const p = viewport.worldToScreen(node.x + Number(drawn.getAttribute('x')), node.y + Number(drawn.getAttribute('y')));
    const fontSize = parseFloat(input.style.fontSize);
    expect(fontSize).toBe(11.5);
    expect(parseFloat(input.style.left) + 3).toBeCloseTo(p.x, 5);
    expect(parseFloat(input.style.top) + fontSize + 3).toBeCloseTo(p.y, 5);
    input.value = 'checkout · p99';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(updateNodeAction).toHaveBeenCalledWith(1n, { sublabel: 'checkout · p99' });

    editor.startInlineEdit(node, 'label');
    const title = document.getElementById('inline-edit') as HTMLInputElement;
    expect(title.tagName).toBe('INPUT'); // a service label opens a textarea
    expect([...title.classList]).toEqual(['chart']);
    expect(title.value).toBe('p99 latency');
    // The title edits left aligned, at 13 px, on the drawn title row.
    expect(title.style.textAlign).toBe('left');
    expect(parseFloat(title.style.fontSize)).toBe(13);
    const row = document.querySelector('[data-id="1"] text[data-field="label"]')!;
    const tp = viewport.worldToScreen(node.x + Number(row.getAttribute('x')), node.y + Number(row.getAttribute('y')));
    expect(parseFloat(title.style.left) + 3).toBeCloseTo(tp.x, 5);
    expect(parseFloat(title.style.top) + 13 + 3).toBeCloseTo(tp.y, 5);
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('inline-edit')).toBeNull();
  });
});

describe('library templates and the L keys', () => {
  // Editors from earlier tests keep their window listeners; a Tab puts every
  // one of them back in keyboard-focus mode.
  beforeEach(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  });
  const depsOf = (editor: Editor) => (editor as unknown as { deps: EditorDeps }).deps;
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const key = (target: EventTarget, init: KeyboardEventInit) => {
    const evt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(evt);
    return evt;
  };

  it('a chart tile arms; one canvas click places it at the snapped point, selects it and disarms', async () => {
    const { editor, svg, pointer } = setup();
    const placeTemplate = vi.fn().mockResolvedValue([7n]);
    depsOf(editor).placeTemplate = placeTemplate;
    expect(editor.hoverReady).toBe(true);
    editor.armTemplate({ kind: 'chart', type: 'bars' });
    expect(editor.armedTemplate).toEqual({ kind: 'chart', type: 'bars' });
    expect(editor.armedKind).toBeNull();
    expect(editor.hoverReady).toBe(false); // no chart hover while placing
    expect(svg.classList.contains('armed')).toBe(true);
    expect(document.getElementById('tool-library')!.classList.contains('armed')).toBe(true);
    expect(document.getElementById('tool-select')!.classList.contains('armed')).toBe(false);
    expect(document.getElementById('rail-hint')!.textContent).toContain('armed · bars chart');
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    editor.syncRail();
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    pointer(svg, 'pointerdown', 203, 149);
    expect(placeTemplate).toHaveBeenCalledWith({ kind: 'chart', type: 'bars' }, { x: 204, y: 148 });
    expect(editor.armedTemplate).toBeNull();
    expect(svg.classList.contains('armed')).toBe(false);
    await flush();
    expect([...editor.selection]).toEqual([7n]);
  });

  it('an icon tile arms once, names itself in the rail, and one canvas click places it (spec 2026-10-18)', async () => {
    const { editor, svg, pointer } = setup();
    const placeTemplate = vi.fn().mockResolvedValue([8n]);
    depsOf(editor).placeTemplate = placeTemplate;
    editor.armTemplate({ kind: 'icon', icon: 'orchestrator' });
    expect(editor.armedTemplate).toEqual({ kind: 'icon', icon: 'orchestrator' });
    expect(document.getElementById('rail-hint')!.textContent).toContain('armed · Orchestrator');
    pointer(svg, 'pointerdown', 41, 79);
    expect(placeTemplate).toHaveBeenCalledWith({ kind: 'icon', icon: 'orchestrator' }, { x: 40, y: 80 });
    expect(editor.armedTemplate).toBeNull();
    await flush();
    expect([...editor.selection]).toEqual([8n]);
  });

  it('a node tile arms its kind like keys 1–5, and a dropped node places through createNodeAction', async () => {
    const { editor } = setup();
    editor.armTemplate({ kind: 'node', nodeKind: 'datastore' });
    expect(editor.armedKind).toBe('datastore');
    expect(editor.armedTemplate).toBeNull();
    editor.armTemplate({ kind: 'node', nodeKind: 'datastore' });
    expect(editor.armedKind).toBe('datastore'); // picking it again keeps it armed; arm() would toggle
    const createNodeAction = vi.fn().mockResolvedValue(9n);
    (depsOf(editor).ops as unknown as Record<string, unknown>).createNodeAction = createNodeAction;
    editor.placeTemplateAt({ kind: 'node', nodeKind: 'note' }, 101, 99);
    expect(createNodeAction).toHaveBeenCalledWith({
      boardId: 1n, label: 'A note about this part of the system.', sublabel: '', x: 100, y: 100, w: 216, h: 88,
      token: 'ink', focal: false, kind: 'note',
    });
    await flush();
    expect([...editor.selection]).toEqual([9n]);
  });

  it('Esc, arming a kind, the hand tool and a board switch each drop an armed template', () => {
    const { editor } = setup();
    const pick = { kind: 'chart', type: 'pie' } as const;
    editor.armTemplate(pick);
    expect(editor.hoverReady).toBe(false);
    key(document.body, { key: 'Escape' });
    expect(editor.armedTemplate).toBeNull();
    expect(editor.hoverReady).toBe(true);
    editor.armTemplate(pick);
    editor.arm('service');
    expect(editor.armedTemplate).toBeNull();
    expect(editor.armedKind).toBe('service');
    editor.armTemplate(pick);
    expect(editor.armedKind).toBeNull();
    editor.setHand(true);
    expect(editor.armedTemplate).toBeNull();
    editor.setHand(false);
    editor.armTemplate(pick);
    editor.switchBoard(2n, {} as Ops);
    expect(editor.armedTemplate).toBeNull();
  });

  it('a factual board refuses templates with the read-only sentence', async () => {
    const chrome = await import('./chrome');
    vi.mocked(chrome.showError).mockClear();
    const { editor } = setup(true);
    const placeTemplate = vi.fn().mockResolvedValue([]);
    depsOf(editor).placeTemplate = placeTemplate;
    editor.armTemplate({ kind: 'chart', type: 'stat' });
    expect(editor.armedTemplate).toBeNull();
    editor.placeTemplateAt({ kind: 'chart', type: 'stat' }, 0, 0);
    expect(placeTemplate).not.toHaveBeenCalled();
    expect(chrome.showError).toHaveBeenCalledWith(READ_ONLY_HINT);
    expect(READ_ONLY_HINT).toBe('Factual snapshot. Change the view or create a proposal.');
  });

  it('a public example refuses templates with the public-example sentence', async () => {
    const chrome = await import('./chrome');
    vi.mocked(chrome.showError).mockClear();
    const { editor } = setup(false, true);
    const placeTemplate = vi.fn().mockResolvedValue([]);
    depsOf(editor).placeTemplate = placeTemplate;
    editor.armTemplate({ kind: 'chart', type: 'stat' });
    expect(editor.armedTemplate).toBeNull();
    editor.placeTemplateAt({ kind: 'chart', type: 'stat' }, 0, 0);
    expect(placeTemplate).not.toHaveBeenCalled();
    expect(vi.mocked(chrome.showError).mock.calls).toEqual([[PUBLIC_EXAMPLE_HINT], [PUBLIC_EXAMPLE_HINT]]);
  });

  it('a rejected placement shows the sentence and keeps the selection', async () => {
    const chrome = await import('./chrome');
    vi.mocked(chrome.showError).mockClear();
    const { editor, svg, pointer } = setup();
    depsOf(editor).placeTemplate = vi.fn().mockRejectedValue(new Error('charts are not supported on architecture boards yet'));
    editor.armTemplate({ kind: 'chart', type: 'table' });
    pointer(svg, 'pointerdown', 400, 400);
    await flush();
    expect(chrome.showError).toHaveBeenCalledWith('charts are not supported on architecture boards yet');
    expect([...editor.selection]).toEqual([1n]);
  });

  it('L toggles the library and ⇧L saves a node selection; not while typing, not with ⌘ or ⌥', () => {
    const { editor } = setup();
    const toggleLibrary = vi.fn();
    const addToLibrary = vi.fn();
    Object.assign(depsOf(editor), { toggleLibrary, addToLibrary });
    // evt.key, not evt.code: Dvorak types l on the P key and n on the L key
    expect(key(document.body, { key: 'l', code: 'KeyP' }).defaultPrevented).toBe(true);
    expect(toggleLibrary).toHaveBeenCalledTimes(1);
    key(document.body, { key: 'n', code: 'KeyL' });
    expect(toggleLibrary).toHaveBeenCalledTimes(1);
    key(document.body, { key: 'L', code: 'KeyP', shiftKey: true });
    expect(addToLibrary).toHaveBeenCalledTimes(1);
    key(document.body, { key: 'l', code: 'KeyL', metaKey: true });
    key(document.body, { key: '¬', code: 'KeyL', altKey: true });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    key(input, { key: 'l', code: 'KeyL' });
    key(input, { key: 'L', code: 'KeyL', shiftKey: true });
    expect(toggleLibrary).toHaveBeenCalledTimes(1);
    expect(addToLibrary).toHaveBeenCalledTimes(1);
    input.remove();
    editor.selectNodes([]);
    key(document.body, { key: 'L', code: 'KeyL', shiftKey: true });
    expect(addToLibrary).toHaveBeenCalledTimes(1);
  });

  it('⇧L saves the selection on a public example too: it writes only your own library', () => {
    const { editor } = setup(false, true);
    const addToLibrary = vi.fn();
    Object.assign(depsOf(editor), { addToLibrary });
    key(document.body, { key: 'L', code: 'KeyL', shiftKey: true });
    expect(addToLibrary).toHaveBeenCalledTimes(1);
  });
});

describe('placing a note', () => {
  it('disarms after one click and opens the new note for typing', async () => {
    const { editor, node, svg, pointer } = setup();
    const note: Node = { ...node, id: 2n, kind: 'note', label: 'A note about this part of the system.', x: 500, y: 500, w: 216, h: 88 };
    const deps = (editor as unknown as { deps: EditorDeps }).deps;
    const createNodeAction = vi.fn().mockResolvedValue(note.id);
    deps.ops = { createNodeAction } as unknown as Ops;
    deps.getNodes = () => [node, note];
    editor.arm('note');
    pointer(svg, 'pointerdown', 500, 500);
    expect(editor.armedKind).toBeNull();
    expect(createNodeAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'note' }));
    await Promise.resolve();
    await Promise.resolve();
    const input = document.getElementById('inline-edit') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(note.label);
  });
});

describe('free text', () => {
  const open = (label: string) => {
    const t = setup();
    Object.assign(t.node, { kind: 'text', label, sublabel: '', w: 16, h: 28 });
    t.history.batch.mockImplementation((_label: string, fn: () => Promise<void>) => fn());
    t.editor.selectNodes([]);
    t.editor.startInlineEdit(t.node, 'label');
    const input = document.getElementById('inline-edit') as HTMLTextAreaElement;
    const key = (k: string, mods: KeyboardEventInit = {}) =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
    return { ...t, input, key };
  };

  it('Enter breaks the line, ⌘B wraps the selection, Esc saves the label and fits the box', async () => {
    const { node, input, key, updateNodeAction, resizeNodeAction } = open('');
    expect([...input.classList]).toEqual(['text']);
    input.value = 'Payments\nflow';
    key('Enter');
    expect(document.getElementById('inline-edit')).toBe(input);
    input.setSelectionRange(0, 8);
    key('b', { metaKey: true });
    expect(input.value).toBe('**Payments**\nflow');
    key('b', { metaKey: true });
    expect(input.value).toBe('Payments\nflow');
    key('Escape');
    expect(document.getElementById('inline-edit')).toBeNull();
    await Promise.resolve();
    expect(updateNodeAction).toHaveBeenCalledWith(node.id, { label: 'Payments\nflow' });
    await Promise.resolve();
    const [, , to] = resizeNodeAction.mock.calls[0];
    expect(to).toMatchObject({ x: node.x, y: node.y, h: 2 * 28 });
    expect(to.w % 4).toBe(0);
  });

  it('opens with the caret at the end, so a first keystroke does not replace the block', () => {
    const { input, key } = open('**Payments**');
    expect([input.selectionStart, input.selectionEnd]).toEqual([12, 12]);
    key('Escape');
  });

  it('text left empty is deleted', () => {
    const { node, input, key, deleteNodesAction, updateNodeAction } = open('Old');
    input.value = '  ';
    key('Escape');
    expect(deleteNodesAction).toHaveBeenCalledWith([node], []);
    expect(updateNodeAction).not.toHaveBeenCalled();
  });

  it('a double-click on empty canvas drops text there', () => {
    const { svg, pointer, editor, createNodeAction } = setup();
    editor.selectNodes([]);
    pointer(svg, 'pointerdown', 600, 600);
    pointer(svg, 'pointerup', 600, 600);
    pointer(svg, 'pointerdown', 600, 600);
    expect(createNodeAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'text', label: '', x: 600, y: 600 }));
  });
});

describe('red crayon', () => {
  beforeEach(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  });
  const depsOf = (editor: Editor) => (editor as unknown as { deps: EditorDeps }).deps;
  // This editor's own keydown listener: earlier editors keep theirs on window.
  let keydown: EventListener;
  const crayonSetup = (factual = false, readOnly = false) => {
    const listener = vi.spyOn(window, 'addEventListener');
    const s = setup(factual, readOnly);
    keydown = listener.mock.calls.find(([type, _handler, options]) => type === 'keydown' && options !== true)![1] as EventListener;
    listener.mockRestore();
    return s;
  };
  const key = (init: KeyboardEventInit) => keydown(new KeyboardEvent('keydown', { cancelable: true, ...init }));
  const withCrayon = (editor: Editor, drafts: { nodeId: bigint; note: string }[] = []) => {
    const crayon = { toggle: vi.fn(), undo: vi.fn(), drafts: () => drafts, selected: null, select: vi.fn(), remove: vi.fn() };
    depsOf(editor).crayon = crayon;
    return crayon;
  };

  it('c arms the crayon and moves .armed to #tool-crayon; arming another tool puts it down', () => {
    const { editor } = crayonSetup();
    expect(editor.selection.size).toBe(1);
    key({ key: 'c', code: 'KeyC' });
    expect(editor.crayonOn).toBe(true);
    expect(editor.selection.size).toBe(0); // no toolbar or handles over the circles
    expect(document.getElementById('tool-crayon')!.classList.contains('armed')).toBe(true);
    expect(document.getElementById('tool-select')!.classList.contains('armed')).toBe(false);
    editor.arm('service');
    expect(editor.crayonOn).toBe(false);
    expect(document.getElementById('tool-crayon')!.classList.contains('armed')).toBe(false);
    editor.armCrayon();
    expect(editor.armedKind).toBeNull();
    editor.setHand(true);
    expect(editor.crayonOn).toBe(false);
    editor.armCrayon();
    key({ key: 'Escape' });
    expect(editor.crayonOn).toBe(false);
    expect(document.getElementById('tool-select')!.classList.contains('armed')).toBe(true);
  });

  it('a click on a node circles it: no select, no drag', () => {
    const { editor, node, svg, pointer } = crayonSetup();
    const crayon = withCrayon(editor);
    editor.selectNodes([]);
    editor.armCrayon();
    pointer(svg, 'pointerdown', node.x + 50, node.y + 40);
    pointer(svg, 'pointermove', node.x + 90, node.y + 80);
    pointer(svg, 'pointerup', node.x + 90, node.y + 80);
    expect(crayon.toggle).toHaveBeenCalledWith(node.id);
    expect(editor.selection.size).toBe(0);
    expect(editor.overrides.size).toBe(0);
  });

  it('no hover focus while the crayon is up: every node stays at full strength', () => {
    const { editor, node, svg, pointer } = crayonSetup();
    editor.selectNodes([]);
    pointer(svg, 'pointermove', node.x + 50, node.y + 40);
    expect(editor.hoverId).toBe(node.id);
    editor.armCrayon();
    expect(editor.hoverId).toBeNull();
    pointer(svg, 'pointermove', node.x + 60, node.y + 40);
    expect(editor.hoverId).toBeNull();
    expect(focusOf(editor.hoverId, editor.selection)).toBeNull();
  });

  it('⌘Z takes back the last circle while the crayon has drafts', () => {
    const { editor } = crayonSetup();
    const crayon = withCrayon(editor, [{ nodeId: 1n, note: '' }]);
    const undo = vi.fn();
    (depsOf(editor).ops as unknown as { history: { undo: () => void } }).history.undo = undo;
    editor.armCrayon();
    key({ key: 'z', metaKey: true });
    expect(crayon.undo).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
  });

  describe('with the select tool, a draft mark is selectable', () => {
    const marked = () => {
      const s = crayonSetup();
      const crayon = new Crayon();
      crayon.toggle(1n);
      crayon.toggle(7n);
      depsOf(s.editor).crayon = crayon;
      // What crayon.ts draws: a loop, its fat transparent twin and the number chip.
      const ns = 'http://www.w3.org/2000/svg';
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'mark');
      g.setAttribute('data-node-id', '1');
      const hit = document.createElementNS(ns, 'path');
      hit.setAttribute('class', 'mark-hit');
      const chip = document.createElementNS(ns, 'circle');
      g.append(hit, chip);
      document.getElementById('crayon')!.append(g);
      return { ...s, crayon, hit, chip };
    };

    it('a click on the stroke or the chip selects the mark, not the node', () => {
      const { editor, crayon, hit, chip, pointer, node } = marked();
      expect(editor.selection.size).toBe(1);
      pointer(hit, 'pointerdown', node.x - 5, node.y - 5);
      expect(crayon.selected).toBe(1n);
      expect(editor.selection.size).toBe(0);
      crayon.select(null);
      pointer(chip, 'pointerdown', node.x + 170, node.y - 5);
      expect(crayon.selected).toBe(1n);
    });

    it('a click inside the loop still selects the node', () => {
      const { editor, crayon, svg, pointer, node } = marked();
      editor.selectNodes([]);
      pointer(svg, 'pointerdown', node.x + 50, node.y + 40);
      expect(editor.selection.has(node.id)).toBe(true);
      expect(crayon.selected).toBeNull();
    });

    it('Delete removes the selected mark and leaves the board alone; the rest renumber', () => {
      const { editor, crayon, hit, pointer, node } = marked();
      pointer(hit, 'pointerdown', node.x - 5, node.y - 5);
      key({ key: 'Backspace' });
      expect(crayon.drafts().map(d => d.nodeId)).toEqual([7n]);
      expect(crayon.selected).toBeNull();
      expect(editor.selection.size).toBe(0);
    });

    it('Esc lets go of the mark and keeps it', () => {
      const { crayon, hit, pointer, node } = marked();
      pointer(hit, 'pointerdown', node.x - 5, node.y - 5);
      key({ key: 'Escape' });
      expect(crayon.selected).toBeNull();
      expect(crayon.drafts()).toHaveLength(2);
    });
  });

  it('will not arm on a board the person may only read', () => {
    const { editor } = crayonSetup(false, true);
    editor.armCrayon();
    expect(editor.crayonOn).toBe(false);
    key({ key: 'c', code: 'KeyC' });
    expect(editor.crayonOn).toBe(false);
    editor.syncRail();
    expect((document.getElementById('tool-crayon') as HTMLButtonElement).disabled).toBe(true);
  });
  it('a signed-out guest cannot pick it up: the dock button says to sign in', () => {
    const { editor } = crayonSetup();
    const tool = document.getElementById('tool-crayon') as HTMLButtonElement;
    let signedIn = false;
    depsOf(editor).canMark = () => signedIn;
    editor.armCrayon();
    key({ key: 'c', code: 'KeyC' });
    expect(editor.crayonOn).toBe(false);
    editor.syncRail();
    expect(tool.disabled).toBe(true);
    expect(tool.title).toBe('Sign in to mark');
    signedIn = true;
    editor.syncRail();
    expect(tool.disabled).toBe(false);
    expect(tool.title).toBe('Red crayon · circle nodes to review · C');
    editor.armCrayon();
    expect(editor.crayonOn).toBe(true);
  });
});
