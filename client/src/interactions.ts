import type { DbConnection } from './module_bindings/index';
import type { Node, Edge } from './module_bindings/types';
import { showError } from './chrome';
import { Viewport, chromeInsets, revealDelta, PANEL_GAP, MIN_FREE } from './viewport';
import type { EdgeStyle, NodePatch } from './ops';
import { DEFAULT_EDGE_STYLE, Ops } from './ops';
import { contentBounds, nodeRect, el, renderedText, renderedEdgeAnchor, type Rect } from './render';
import { layoutNodeText, editLines } from './node-layout';
import { layoutText, toggleMark } from './text-block';
import { iconSpec } from '../../module/src/node-icons';
import { toolbarPosition, popoverPosition } from './toolbar-position';
import type { LibraryPick, TemplatePick } from './library-popover';
import { CHART_MIN_W, CHART_MIN_H } from '../../module/src/chart-contracts';
import type { Crayon } from './crayon';

const GRID = 4;

export function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

export type NodeKind = 'service' | 'datastore' | 'external' | 'boundary' | 'note' | 'text';

const KINDS: NodeKind[] = ['service', 'datastore', 'external', 'boundary', 'note', 'text'];

/** Defaults for arm-to-place: rail key 1–5, click canvas to place. */
const PLACE_DEFAULTS: Record<NodeKind, { label: string; sublabel: string; w: number; h: number }> = {
  service: { label: 'Service', sublabel: 'svc', w: 160, h: 80 },
  datastore: { label: 'Datastore', sublabel: 'db', w: 160, h: 80 },
  external: { label: 'External', sublabel: 'external', w: 160, h: 80 },
  boundary: { label: 'boundary', sublabel: '', w: 320, h: 240 },
  note: { label: 'A note about this part of the system.', sublabel: '', w: 216, h: 88 },
  // Empty: the editor opens on it, and text left empty deletes it.
  text: { label: '', sublabel: '', w: 16, h: 28 },
};

/** Shown in the rail on a factual snapshot, and when a library pick meets one. */
export const READ_ONLY_HINT = 'Factual snapshot. Change the view or create a proposal.';
/** The same, on a public example (a board the visitor may read but not edit). */
export const PUBLIC_EXAMPLE_HINT = 'Public example. Explore the drawing or export it. Start a new board to draw.';

/** The rail's "armed · …" name for a library template. */
function templateName(pick: TemplatePick): string {
  if (pick.kind === 'chart') return `${pick.type} chart`;
  if (pick.kind === 'icon') return iconSpec(pick.icon)?.name ?? pick.icon;
  return pick.item.name;
}

/** How far a press may travel and still be a tap or click, not a drag or pan. */
function tapSlop(evt: PointerEvent): number {
  return evt.pointerType === 'touch' ? 10 : 6;
}

/** How far apart two clicks of a double may land; a finger lands less precisely than a mouse. */
function clickSlop(evt: PointerEvent): number {
  return evt.pointerType === 'touch' ? 24 : 6;
}

type Mode =
  | { kind: 'idle' }
  // tap: a finger pan that ends where it began is a tap on that node (or on empty canvas).
  | { kind: 'pan'; lastX: number; lastY: number; tap?: { x: number; y: number; nodeId: bigint | null } }
  | { kind: 'pinch'; dist: number; midX: number; midY: number }
  | { kind: 'marquee'; start: { x: number; y: number }; cur: { x: number; y: number }; base: Set<bigint>; additive: boolean }
  | {
      kind: 'dragNodes';
      start: { x: number; y: number };
      orig: Map<bigint, { x: number; y: number }>;
      moved: boolean;
      hitId: bigint;
      wasSelected: boolean;
      shift: boolean;
    }
  | { kind: 'drawEdge'; fromId: bigint; cur: { x: number; y: number } }
  | {
      kind: 'resizeNode';
      nodeId: bigint;
      corner: string;
      orig: { x: number; y: number; w: number; h: number };
      stored: { x: number; y: number; w: number; h: number };
      minSize: { w: number; h: number };
      start: { x: number; y: number };
      moved: boolean;
    };

export interface EditorDeps {
  conn: DbConnection;
  boardId: bigint;
  svg: SVGSVGElement;
  wrap: HTMLElement;
  viewport: Viewport;
  ops: Ops;
  getNodes: () => Node[];
  getEdges: () => Edge[];
  rerender: () => void;
  onSelectionChange?: () => void;
  /** True while a code ref (and its target) still exists; prunes expandedRef. */
  refAlive?: (id: bigint) => boolean;
  /** Code refs on an edge: under the code overlay its label run grows a
   *  ` · N refs` suffix, which the toolbar must clear (G51). */
  edgeRefCount?: (id: bigint) => number;
  /** Fired after an explicit toggleCodeOverlay: remember it, and let the
   *  rail hint follow. */
  onCodeOverlayChange?: () => void;
  /** True when the board has a session row: the agent draws it, so the
   *  hand-placement evidence hint does not apply (G10), and only then does
   *  the code overlay exist (G42). */
  hasSession?: () => boolean;
  topologyReadOnly?: () => boolean;
  /** Public examples permit inspection and navigation without board writes. */
  readOnly?: () => boolean;
  /** False for a signed-out guest: the module takes marks only from an account. */
  canMark?: () => boolean;
  /** Places a chart or saved library pick (main.ts) with its top-left at
   *  `at` (grid-snapped world px). Resolves to the new node ids; a rejection
   *  carries the sentence the error strip shows. */
  placeTemplate?: (pick: TemplatePick, at: { x: number; y: number }) => Promise<bigint[]>;
  /** L: open the library popover (or close it when focus is outside its search). */
  toggleLibrary?: () => void;
  /** ⇧L with a node selection: save it to the library. */
  addToLibrary?: () => void;
  /** Red crayon drafts (crayon.ts): a click on a node circles it, ⌘Z takes back the last.
   *  With the select tool, a loop's stroke or chip selects its mark; Delete removes it. */
  crayon?: Pick<Crayon, 'toggle' | 'undo' | 'drafts' | 'selected' | 'select' | 'remove'>;
}

/** Focus targets that take typed text: canvas shortcuts never fire there. */
export const TEXT_ENTRY = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/** Focus targets that Space activates (G26). */
const ACTIVATABLE = 'button, a[href], summary, [role="button"], [role="switch"], [role="option"], [role="menuitem"], [role="checkbox"]';
/** Panels with their own keyboard model: plain keys stay there (G26). */
const KEY_PANELS = '#inspector, #rail, #toolbar, [role="dialog"]';

// syncChrome runs on every render, drag and pan frames included, and an
// unchanged setAttribute or textContent still queues a mutation record:
// these write only a value that differs (G32, keyed-render contract).
function setAttr(target: Element, name: string, value: string): void {
  if (target.getAttribute(name) !== value) target.setAttribute(name, value);
}
function setText(target: Element, text: string): void {
  if (target.textContent !== text) target.textContent = text;
}
function setStyle(target: HTMLElement, prop: 'left' | 'top' | 'maxWidth', value: string): void {
  if (target.style[prop] !== value) target.style[prop] = value;
}
function setHidden(target: HTMLElement, hidden: boolean): void {
  if (target.hidden !== hidden) target.hidden = hidden;
}

export class Editor {
  selection = new Set<bigint>();
  /** Edges selected for inspection — view-local, never shared. */
  selectedEdges = new Set<bigint>();
  /** Evidence overlay: stroke weight/dash encode evidence class (⌥E). */
  overlay = false;
  /** Code overlay: ref badges on nodes and ref suffixes on edges (⌥C). The
   *  inspector CODE section shows either way (spec §4.4). */
  codeOverlay = false;
  /** Ref expanded in the inspector CODE section; null means "the first". */
  expandedRef: bigint | null = null;
  /** Node kind armed for placement (rail or keys 1–5); esc disarms. */
  armedKind: NodeKind | null = null;
  /** Chart or saved item armed from the library: one canvas click places it,
   *  then it disarms. Never set together with armedKind. */
  armedTemplate: TemplatePick | null = null;
  /** The red crayon (C): clicks circle nodes for review. Arming any other tool puts it down. */
  crayonOn = false;
  hoverId: bigint | null = null;
  edgeTarget: bigint | null = null;
  overrides = new Map<bigint, { x: number; y: number; w?: number; h?: number }>();
  /** Positions the last render drew for gliding nodes (main.ts sets it). */
  glide: ReadonlyMap<bigint, { x: number; y: number }> = new Map();
  private mode: Mode = { kind: 'idle' };
  private spaceDown = false;
  /** Focus last arrived by pointer (a click leaves focus on the button):
   *  Space and plain keys then go to the canvas, as before G26. */
  private pointerFocus = false;
  /** Persistent hand tool. Space-drag is the transient version of this. */
  private handMode = false;
  // Pointer capture retargets pointerup, which suppresses native dblclick —
  // detect double-clicks manually from consecutive pointerdowns.
  private lastClick: { time: number; x: number; y: number; nodeId: bigint | null } | null = null;
  /** Fingers on the canvas, by pointer id: a second one turns the gesture into a pinch. */
  private touches = new Map<number, { x: number; y: number }>();

  private toolbar = document.getElementById('toolbar') as HTMLDivElement;
  private tbKind = document.getElementById('tb-kind') as HTMLButtonElement;
  private tbToken = document.getElementById('tb-token') as HTMLButtonElement;
  private tbFocal = document.getElementById('tb-focal') as HTMLButtonElement;
  private tbDelete = document.getElementById('tb-delete') as HTMLButtonElement;
  private tbReset = document.getElementById('tb-reset-style') as HTMLButtonElement;
  private tbOverlayNote = document.getElementById('tb-overlay-note') as HTMLElement;
  private railHint = document.getElementById('rail-hint') as HTMLDivElement;
  private overlayRow = document.getElementById('overlay-row') as HTMLButtonElement;
  private codeOverlayRow = document.getElementById('code-overlay-row') as HTMLButtonElement;
  private shortcuts = document.getElementById('shortcuts') as HTMLDivElement;
  private hudZoom = document.getElementById('hud-zoom') as HTMLButtonElement;
  private hudZoomIn = document.getElementById('hud-zoom-in') as HTMLButtonElement;
  private hudZoomOut = document.getElementById('hud-zoom-out') as HTMLButtonElement;
  private hudFit = document.getElementById('hud-fit') as HTMLButtonElement;
  private dimBadge = document.getElementById('dim-badge') as HTMLDivElement | null;
  private editInput: HTMLInputElement | HTMLTextAreaElement | null = null;
  /** Selection (nodes|edges) last brought clear of the panels by revealSelection. */
  private revealedKey = '';
  /** Horizontal panel edges last seen by the panel observers. */
  private panelEdges = '';
  /** The selection's screen rect (client px) at the last syncChrome. */
  private selClient: Rect | null = null;

  constructor(private deps: EditorDeps) {
    this.wire();
    this.observePanels();
  }

  /** Keep the mounted editor and viewport; discard state from the old board. */
  switchBoard(boardId: bigint, ops: Ops): void {
    if (this.editInput) {
      this.editInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    this.deps.boardId = boardId;
    this.deps.ops = ops;
    this.mode = { kind: 'idle' };
    this.selection.clear();
    this.selectedEdges.clear();
    this.expandedRef = null;
    this.armedKind = null;
    this.armedTemplate = null;
    this.crayonOn = false;
    this.hoverId = null;
    this.edgeTarget = null;
    this.overrides.clear();
    this.lastClick = null;
    this.revealedKey = '';
    this.deps.viewport.stopAnimation();
    this.syncRail();
  }

  private selectionKey(): string {
    return `${[...this.selection].join(',')}|${[...this.selectedEdges].join(',')}`;
  }

  /** Where the node is drawn: its gesture preview, else its glide, else its row. */
  private rect(n: Node): Rect {
    return nodeRect(n, this.overrides.has(n.id) ? this.overrides : this.glide);
  }

  /** Keep a drag or resize preview on screen until its write settles: cleared
   *  sooner, the nodes jump back to their old rows for a round trip. A newer
   *  gesture's preview is left alone. */
  private holdPreview(preview: Editor['overrides'], write: Promise<void> | undefined): void {
    const clear = () => {
      if (this.overrides === preview) {
        this.overrides = new Map();
        this.deps.rerender();
      }
    };
    if (!write) {
      clear();
      return;
    }
    void write.catch(err => showError((err as Error).message)).finally(clear);
  }

  /** Fit every node into the canvas the rail, inspector and dock leave free (G6). */
  fitView(): void {
    this.deps.viewport.fit(contentBounds(this.deps.getNodes()), chromeInsets(this.deps.wrap));
  }

  /**
   * Pan the smallest distance that brings the selection clear of the rail,
   * the inspector, the dock and the toolbar's room above it (G7). Eased over
   * 200 ms, or a jump under prefers-reduced-motion. Never during a drag,
   * marquee or inline edit.
   */
  revealSelection(): void {
    if (this.mode.kind !== 'idle' || this.editInput !== null) {
      return;
    }
    const b = this.selectionBounds();
    if (b === null) {
      return;
    }
    const { viewport, wrap } = this.deps;
    const size = wrap.getBoundingClientRect();
    const insets = chromeInsets(wrap);
    const p = viewport.worldToScreen(b.x, b.y);
    const free = {
      left: insets.left || PANEL_GAP,
      right: size.width - (insets.right || PANEL_GAP),
      top: (insets.top || PANEL_GAP) + (this.toolbar.offsetHeight || 44) + 12,
      bottom: size.height - (insets.bottom || PANEL_GAP),
    };
    // Panels that leave no usable room (narrow screens) are not avoided.
    if (free.right - free.left < MIN_FREE) {
      free.left = PANEL_GAP;
      free.right = size.width - PANEL_GAP;
    }
    if (free.bottom - free.top < MIN_FREE / 2) {
      free.top = PANEL_GAP;
      free.bottom = size.height - PANEL_GAP;
    }
    const d = revealDelta({ x: p.x, y: p.y, w: b.w * viewport.scale, h: b.h * viewport.scale }, free);
    // A sub-pixel nudge is noise, not a reveal.
    if (Math.abs(d.dx) < 1 && Math.abs(d.dy) < 1) {
      return;
    }
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    viewport.panTo(viewport.tx + d.dx, viewport.ty + d.dy, reduced ? 0 : 200);
  }

  /** Reveal again when a panel opens, closes or changes width — never per
   *  frame: height-only changes (a ref expanding) leave the free rect alone. */
  private observePanels(): void {
    const panels = ['inspector', 'rail']
      .map(id => document.getElementById(id))
      .filter((p): p is HTMLElement => p !== null);
    const check = () => {
      const edges = panels
        .map(p => {
          const r = p.getBoundingClientRect();
          return `${p.hidden || p.classList.contains('collapsed')}:${Math.round(r.left)}:${Math.round(r.right)}`;
        })
        .join('|');
      if (edges !== this.panelEdges) {
        this.panelEdges = edges;
        this.revealSelection();
      }
    };
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(check);
      for (const p of panels) ro.observe(p);
    }
    // Dismissing or restoring the rail is a class flip, not a resize.
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(check);
      for (const p of panels) mo.observe(p, { attributes: true, attributeFilter: ['class', 'hidden'] });
    }
  }

  private get topologyReadOnly(): boolean {
    return this.deps.readOnly?.() === true || this.deps.topologyReadOnly?.() === true;
  }

  get handles(): Set<bigint> {
    if (this.topologyReadOnly || this.crayonOn) return new Set();
    const s = new Set(this.selection);
    if (this.hoverId !== null) {
      s.add(this.hoverId);
    }
    return s;
  }

  private setSelection(ids: Iterable<bigint>): void {
    this.selection = new Set(ids);
    if (this.selection.size > 0) {
      this.selectedEdges.clear();
    }
    this.deps.onSelectionChange?.();
  }

  /** Replace the node selection from outside and broadcast it (presence). */
  selectNodes(ids: Iterable<bigint>): void {
    this.setSelection(ids);
    this.deps.rerender();
  }

  /** Replace the (view-local) edge selection from outside. */
  selectEdges(ids: Iterable<bigint>): void {
    this.selection = new Set();
    this.selectedEdges = new Set(ids);
    this.deps.onSelectionChange?.();
    this.deps.rerender();
  }

  /** Arm a node kind for placement (or disarm with null / the same kind).
   *  Either way an armed library template is dropped. */
  arm(kind: NodeKind | null): void {
    if (kind !== null && this.topologyReadOnly) return;
    if (kind !== null && this.handMode) {
      this.handMode = false;
      this.deps.svg.classList.toggle('panning', this.panArmed);
    }
    this.armedTemplate = null;
    this.crayonOn = false;
    this.armedKind = kind !== null && this.armedKind === kind ? null : kind;
    this.syncRail();
  }

  /** Pick up the red crayon. Marks need write access: never on a board the person may only read. */
  armCrayon(): void {
    if (this.deps.readOnly?.() || this.deps.canMark?.() === false) return;
    if (this.handMode) {
      this.handMode = false;
      this.deps.svg.classList.toggle('panning', this.panArmed);
    }
    this.armedKind = null;
    this.armedTemplate = null;
    this.crayonOn = true;
    this.syncRail();
    // A selection's toolbar and handles, or a hover's focus dim, would sit over the circles.
    if (this.selection.size > 0 || this.selectedEdges.size > 0 || this.hoverId !== null) {
      this.hoverId = null;
      if (this.selection.size > 0 || this.selectedEdges.size > 0) {
        this.selectedEdges.clear();
        this.setSelection([]);
      }
      this.deps.rerender();
    }
  }

  /** A library pick on a board the caller cannot change: say why, once. */
  private refuseReadOnly(): boolean {
    if (!this.topologyReadOnly) return false;
    showError(this.deps.readOnly?.() ? PUBLIC_EXAMPLE_HINT : READ_ONLY_HINT);
    return true;
  }

  /** Arm a library pick. A node pick arms its kind exactly as keys 1–5 do
   *  (picking it again keeps it armed); a chart or saved pick arms a
   *  one-shot template for the next canvas click. */
  armTemplate(pick: LibraryPick): void {
    if (this.refuseReadOnly()) return;
    if (pick.kind === 'node') {
      if (this.armedKind !== pick.nodeKind) this.arm(pick.nodeKind);
      return;
    }
    if (this.handMode) {
      this.handMode = false;
      this.deps.svg.classList.toggle('panning', this.panArmed);
    }
    this.armedKind = null;
    this.crayonOn = false;
    this.armedTemplate = pick;
    this.syncRail();
  }

  /** Place a library pick with its top-left at a world point: the armed
   *  click and the drag-from-popover drop both end here. The new nodes
   *  become the selection. */
  placeTemplateAt(pick: LibraryPick, wx: number, wy: number): void {
    if (this.refuseReadOnly()) return;
    if (pick.kind === 'node') {
      this.placeKind(pick.nodeKind, wx, wy);
      return;
    }
    const place = this.deps.placeTemplate;
    if (place === undefined) {
      return;
    }
    const placedBoard = this.deps.boardId;
    place(pick, { x: snap(wx), y: snap(wy) })
      .then(ids => {
        if (this.deps.boardId !== placedBoard) return;
        this.setSelection(ids);
        this.deps.rerender();
      })
      .catch(err => showError((err as Error).message));
  }

  toggleOverlay(): void {
    this.overlay = !this.overlay;
    this.syncRail();
    this.deps.rerender();
  }

  /** Mirrors toggleOverlay: a view-local flag the renderer reads. An explicit
   *  toggle, reported through onCodeOverlayChange so it can be remembered.
   *  A board without a session has no code overlay: a no-op there (G42). */
  toggleCodeOverlay(): void {
    if (this.deps.hasSession?.() === false) {
      return;
    }
    this.codeOverlay = !this.codeOverlay;
    this.syncRail();
    this.deps.onCodeOverlayChange?.();
    this.deps.rerender();
  }

  /** Apply the board's default (G42): no change report; the caller rerenders. */
  setCodeOverlay(on: boolean): void {
    this.codeOverlay = on;
    this.syncRail();
  }

  /** True while a pan gesture should win over placing or selecting. */
  private get panArmed(): boolean {
    return this.spaceDown || this.handMode;
  }

  /** Select mode with no gesture and no inline edit in progress: only then
   *  may chart hover show (spec: hover never blocks a drag). */
  get hoverReady(): boolean {
    return (
      this.armedKind === null &&
      this.armedTemplate === null &&
      !this.crayonOn &&
      !this.panArmed &&
      this.mode.kind === 'idle' &&
      this.editInput === null
    );
  }

  private toggleCrayon(): void {
    if (this.crayonOn) this.arm(null);
    else this.armCrayon();
  }

  /** Toggle the persistent hand tool. Mutually exclusive with an armed kind. */
  setHand(on: boolean): void {
    this.handMode = on;
    if (on) {
      this.armedKind = null;
      this.armedTemplate = null;
      this.crayonOn = false;
    }
    this.deps.svg.classList.toggle('panning', this.panArmed);
    this.syncRail();
  }

  /** Reflect armed/overlay state into the rail chrome. renderSession calls
   *  this on every table change and clock tick: write only what differs. */
  syncRail(): void {
    for (const row of document.querySelectorAll<HTMLButtonElement>('.add-row')) {
      if (row.disabled !== this.topologyReadOnly) row.disabled = this.topologyReadOnly;
      row.classList.toggle('armed', row.dataset.kind === this.armedKind);
    }
    setAttr(this.overlayRow, 'aria-pressed', this.overlay ? 'true' : 'false');
    setAttr(this.codeOverlayRow, 'aria-pressed', this.codeOverlay ? 'true' : 'false');
    const armedName = this.crayonOn ? 'red crayon'
      : this.armedTemplate !== null ? templateName(this.armedTemplate) : this.armedKind;
    this.deps.svg.classList.toggle('armed', armedName !== null);
    // The dock's select tool is the "nothing armed, no hand" state.
    document
      .getElementById('tool-select')
      ?.classList.toggle('armed', armedName === null && !this.handMode);
    document.getElementById('tool-hand')?.classList.toggle('armed', this.handMode);
    document.getElementById('tool-library')?.classList.toggle('armed', this.armedTemplate !== null);
    const crayonTool = document.getElementById('tool-crayon') as HTMLButtonElement | null;
    crayonTool?.classList.toggle('armed', this.crayonOn);
    const guest = this.deps.canMark?.() === false;
    const noCrayon = this.deps.readOnly?.() === true || guest;
    if (crayonTool && crayonTool.disabled !== noCrayon) crayonTool.disabled = noCrayon;
    if (crayonTool) setAttr(crayonTool, 'title', guest ? 'Sign in to mark' : 'Red crayon · circle nodes to review · C');
    if (armedName !== null) {
      setHidden(this.railHint, false);
      const armed = `armed · ${armedName}`;
      // A kind stays armed for repeat placement; a note, text or library template places once.
      const tail = this.crayonOn
        ? 'click nodes to circle them · Send when done · esc puts it down'
        : this.armedTemplate !== null || this.armedKind === 'note' || this.armedKind === 'text'
        ? 'click canvas to place · esc to disarm'
        : 'keep clicking to place more · Esc or Select finishes';
      if (this.railHint.textContent !== armed + tail) {
        this.railHint.replaceChildren();
        const line = document.createElement('span');
        line.className = 'armed-line';
        line.textContent = armed;
        this.railHint.append(line, document.createElement('br'));
        this.railHint.append(tail);
      }
    } else {
      setText(this.railHint, this.deps.readOnly?.()
        ? PUBLIC_EXAMPLE_HINT
        : this.topologyReadOnly ? READ_ONLY_HINT
        : 'Choose a tool below to draw. Select a node to edit it.');
      setHidden(this.railHint, !this.deps.readOnly?.() && (this.deps.hasSession?.() ?? false));
    }
  }

  /** Drop ids that no longer exist (deleted remotely). */
  pruneSelection(): void {
    const alive = new Set(this.deps.getNodes().map(n => n.id));
    let changed = false;
    for (const id of this.selection) {
      if (!alive.has(id)) {
        this.selection.delete(id);
        changed = true;
      }
    }
    const aliveEdges = new Set(this.deps.getEdges().map(e => e.id));
    for (const id of this.selectedEdges) {
      if (!aliveEdges.has(id)) {
        this.selectedEdges.delete(id);
      }
    }
    if (this.expandedRef !== null && this.deps.refAlive !== undefined && !this.deps.refAlive(this.expandedRef)) {
      this.expandedRef = null;
    }
    if (changed) {
      this.deps.onSelectionChange?.();
    }
  }

  /** Click-to-place: a kind stays armed (multi-place) until esc; a note, text
   *  or library template places once and disarms. */
  private placeArmed(wx: number, wy: number): void {
    if (this.topologyReadOnly) return;
    const pick = this.armedTemplate;
    if (pick !== null) {
      this.armedTemplate = null;
      this.syncRail();
      this.placeTemplateAt(pick, wx, wy);
      return;
    }
    const kind = this.armedKind;
    if (kind !== null) {
      // A note or text is written right after it lands, so the next click is free.
      if (kind === 'note' || kind === 'text') this.arm(null);
      this.placeKind(kind, wx, wy);
    }
  }

  private placeKind(kind: NodeKind, wx: number, wy: number): void {
    if (this.topologyReadOnly) return;
    const placedBoard = this.deps.boardId;
    const d = PLACE_DEFAULTS[kind];
    void this.deps.ops
      .createNodeAction({
        boardId: this.deps.boardId,
        label: d.label,
        sublabel: d.sublabel,
        x: snap(wx),
        y: snap(wy),
        w: d.w,
        h: d.h,
        token: 'ink',
        focal: false,
        kind,
      })
      .then(id => {
        if (this.deps.boardId !== placedBoard) return;
        this.setSelection([id]);
        this.deps.rerender();
        // A new note or text opens its editor: the caret is ready for the text.
        const node = kind === 'note' || kind === 'text' ? this.deps.getNodes().find(n => n.id === id) : undefined;
        if (node !== undefined) this.startInlineEdit(node, 'label');
      })
      .catch(err => showError((err as Error).message));
  }

  private nodeAt(wx: number, wy: number): Node | null {
    // Topmost = smallest area containing the point (containers render below).
    let best: Node | null = null;
    for (const n of this.deps.getNodes()) {
      const r = this.rect(n);
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) {
        if (!best || n.w * n.h < best.w * best.h) {
          best = n;
        }
      }
    }
    return best;
  }

  private selectionBounds(): Rect | null {
    const nodes = this.deps.getNodes().filter(n => this.selection.has(n.id));
    if (nodes.length === 0 && this.selectedEdges.size > 0) {
      // Edges carry colour and line, so an edge-only selection still needs the
      // toolbar. Anchor it on the edge itself — the label run the renderer
      // drew, ref suffix included (G51), or its path midpoint — never on the
      // two endpoint nodes (G35).
      const world = this.deps.svg.querySelector<SVGGElement>('#world');
      let box: Rect | null = null;
      for (const id of this.selectedEdges) {
        const r = world !== null ? renderedEdgeAnchor(world, id) : null;
        if (r === null) {
          continue;
        }
        box = box === null ? r : {
          x: Math.min(box.x, r.x),
          y: Math.min(box.y, r.y),
          w: Math.max(box.x + box.w, r.x + r.w) - Math.min(box.x, r.x),
          h: Math.max(box.y + box.h, r.y + r.h) - Math.min(box.y, r.y),
        };
      }
      return box;
    }
    const b = contentBounds(nodes.map(n => ({ ...n, ...this.rect(n) })));
    if (!b) {
      return null;
    }
    return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
  }

  /** Place an open toolbar popover clear of the selection and the panels. */
  private positionPopover(menu: HTMLDetailsElement): void {
    const panel = menu.querySelector<HTMLElement>('.tb-popover');
    if (panel === null) return;
    const wrap = this.deps.wrap.getBoundingClientRect();
    const anchor = menu.getBoundingClientRect();
    const inspector = document.getElementById('inspector');
    const right = inspector !== null && !inspector.hidden && inspector.offsetWidth < wrap.width * 0.7
      ? Math.min(wrap.right - 16, inspector.getBoundingClientRect().left - 12)
      : wrap.right - 16;
    const rail = document.getElementById('rail');
    const minLeft = rail !== null && !rail.hidden && !rail.classList.contains('collapsed') && rail.offsetWidth < wrap.width * 0.7
      ? Math.max(wrap.left + 16, rail.getBoundingClientRect().right + 12) : wrap.left + 16;
    // Open away from the selection whichever side of it the bar sits on:
    // above the bar, beside it, or below it, never over the selection (G14).
    const bar = this.toolbar.getBoundingClientRect();
    const pos = popoverPosition(
      { x: bar.left, y: bar.top, w: bar.width, h: bar.height },
      anchor.left,
      { w: panel.offsetWidth, h: panel.offsetHeight },
      this.selClient ?? { x: 0, y: 0, w: 0, h: 0 },
      { left: minLeft, right, top: wrap.top + 16, bottom: wrap.bottom - 16 }
    );
    setStyle(panel, 'left', `${pos.left - anchor.left}px`);
    setStyle(panel, 'top', `${pos.top - anchor.top}px`);
  }

  /** True when any selected node is a chart: a chart cannot change kind. */
  private chartSelected(): boolean {
    return this.selection.size > 0 && this.deps.getNodes().some(n => n.kind === 'chart' && this.selection.has(n.id));
  }

  /** Reposition/refresh the contextual toolbar. Call after every render. */
  syncChrome(): void {
    const readOnly = this.deps.readOnly?.() ?? false;
    // The server refuses a kind change on a chart, so the cycle is off. A
    // chart card is always a rectangle (its plot is laid out for one).
    const chart = this.chartSelected();
    // Edge styles as the toolbar shows them: an edge-only selection reads its
    // colour, line and weight here, and Reset has something to do only while
    // one of them differs from a new edge's.
    const edgeStyles = this.selection.size === 0 && this.selectedEdges.size > 0
      ? this.deps.getEdges().filter(e => this.selectedEdges.has(e.id)).map(e => this.deps.ops.edgeStyle(e))
      : [];
    const resettable = edgeStyles.some(st => (Object.keys(DEFAULT_EDGE_STYLE) as (keyof EdgeStyle)[]).some(k => st[k] !== DEFAULT_EDGE_STYLE[k]));
    for (const button of this.toolbar.querySelectorAll<HTMLButtonElement>('button:not(#tb-more)')) {
      const disabled =
        // Add to library writes only the caller's own library, so it stays on.
        (readOnly && button.id !== 'tb-library') ||
        (this.topologyReadOnly && (button === this.tbKind || button === this.tbDelete)) ||
        (chart && (button === this.tbKind || button.closest('#tb-shape') !== null)) ||
        (button === this.tbReset && !resettable) ||
        // Speed sets how a moving edge moves: nothing to set until one has a motion.
        (button.closest('#tb-speed') !== null && !edgeStyles.some(st => st.motion !== DEFAULT_EDGE_STYLE.motion));
      if (button.disabled !== disabled) button.disabled = disabled;
    }
    const b = this.selectionBounds();
    if (!b || this.editInput) {
      setHidden(this.toolbar, true);
      for (const menu of this.toolbar.querySelectorAll<HTMLDetailsElement>('details')) menu.open = false;
      if (this.dimBadge) {
        setHidden(this.dimBadge, true);
      }
    } else {
      const p = this.deps.viewport.worldToScreen(b.x, b.y);
      setHidden(this.toolbar, false);
      const sel = this.deps.getNodes().filter(n => this.selection.has(n.id));
      const edgesOnly = sel.length === 0 && this.selectedEdges.size > 0;
      // Hide the node-only controls when only edges are selected, rather than
      // offering buttons that would act on nothing.
      this.toolbar.classList.toggle('edges-only', edgesOnly);
      const wrap = this.deps.wrap.getBoundingClientRect();
      const rail = document.getElementById('rail');
      const inspector = document.getElementById('inspector');
      let left = 16;
      let right = wrap.width - 16;
      if (rail !== null && !rail.hidden && !rail.classList.contains('collapsed')) {
        left = Math.max(left, rail.getBoundingClientRect().right - wrap.left + 12);
      }
      if (inspector !== null && !inspector.hidden) {
        right = Math.min(right, inspector.getBoundingClientRect().left - wrap.left - 12);
      }
      // On very small screens the side panels cover the working area; retain
      // usable controls within the viewport instead of a negative-width bar.
      if (right - left < 240) { left = 16; right = wrap.width - 16; }
      setStyle(this.toolbar, 'maxWidth', `${Math.max(0, right - left)}px`);
      const selScreen = { x: p.x, y: p.y, w: b.w * this.deps.viewport.scale, h: b.h * this.deps.viewport.scale };
      this.selClient = { ...selScreen, x: selScreen.x + wrap.left, y: selScreen.y + wrap.top };
      const pos = toolbarPosition(
        selScreen,
        { w: this.toolbar.offsetWidth, h: this.toolbar.offsetHeight },
        { left, right, top: 16, bottom: wrap.height - 16 }
      );
      setStyle(this.toolbar, 'left', `${pos.left}px`);
      setStyle(this.toolbar, 'top', `${pos.top}px`);
      setAttr(this.toolbar, 'data-side', pos.side);
      setText(this.tbKind, sel[0]?.kind ?? 'service');
      setText(this.tbToken, sel[0]?.token ?? 'ink');
      this.tbFocal.classList.toggle('active', sel.length > 0 && sel.every(n => n.focal));
      setAttr(this.tbFocal, 'aria-pressed', String(sel.length > 0 && sel.every(n => n.focal)));
      // Show the first selected node's style as the toolbar's current state,
      // or with only edges selected, the first edge's.
      const head = sel[0];
      const headEdge = edgeStyles[0];
      const curStroke = head?.strokeStyle ?? headEdge?.strokeStyle;
      // A node's '' colour derives from its kind and draws as ink, so the Ink
      // swatch is the pressed one; an edge's '' leaves the evidence overlay
      // (or the plain edge colour) in charge: the Default swatch.
      const pressedColor = head !== undefined ? head.color || 'ink' : headEdge?.color;
      const colorDot = document.getElementById('tb-color-dot');
      if (colorDot !== null) setAttr(colorDot, 'class', `sw-${pressedColor === undefined ? 'ink' : pressedColor || 'default'}`);
      // Every option says whether it is the current one, in words (G32).
      const press = (b: HTMLButtonElement, on: boolean) => {
        b.classList.toggle('on', on);
        setAttr(b, 'aria-pressed', String(on));
      };
      for (const sw of document.querySelectorAll<HTMLButtonElement>('#tb-swatches .swatch')) {
        press(sw, pressedColor !== undefined && sw.dataset.color === pressedColor);
        if (sw.dataset.color === (pressedColor ?? 'ink')) {
          const summary = this.toolbar.querySelector('#tb-color-menu summary');
          if (summary !== null) {
            setAttr(summary, 'aria-label', `Colour: ${sw.getAttribute('aria-label')}`);
            setAttr(summary, 'title', `Colour: ${sw.getAttribute('aria-label')}`);
          }
        }
      }
      for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-size button')) {
        press(b, head !== undefined && b.dataset.size === (head.size || 'm'));
      }
      for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-stroke button')) {
        press(b, curStroke !== undefined && b.dataset.stroke === (curStroke || 'solid'));
      }
      for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-shape button')) {
        press(b, head !== undefined && b.dataset.shape === (head.shape || 'rect'));
      }
      for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-weight button')) {
        press(b, headEdge !== undefined && b.dataset.weight === headEdge.weight);
      }
      for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-motion button')) {
        press(b, headEdge !== undefined && b.dataset.motion === headEdge.motion);
      }
      for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-speed button')) {
        press(b, headEdge !== undefined && b.dataset.speed === headEdge.motionSpeed);
      }
      // The overlay draws evidence instead of the line and weight shown here.
      setHidden(this.tbOverlayNote, !this.overlay);
      for (const menu of this.toolbar.querySelectorAll<HTMLDetailsElement>('details[open]')) this.positionPopover(menu);
      // The size readout sits under the selection; when the toolbar has
      // flipped below the selection it goes under the toolbar instead (G14).
      // An edge has no size: an edge-only selection shows no readout (G35).
      if (this.dimBadge) {
        setHidden(this.dimBadge, edgesOnly);
      }
      if (this.dimBadge && !edgesOnly) {
        const foot = this.deps.viewport.worldToScreen(b.x + b.w / 2, b.y + b.h);
        setText(this.dimBadge, `${Math.round(b.w)} \u00d7 ${Math.round(b.h)}`);
        setStyle(this.dimBadge, 'left', `${foot.x}px`);
        setStyle(this.dimBadge, 'top', pos.side === 'below'
          ? `${pos.top + this.toolbar.offsetHeight + 6}px`
          : `${foot.y + 10}px`);
      }
    }
    setText(this.hudZoom, `${Math.round(this.deps.viewport.scale * 100)}%`);
    // A new selection is revealed once the gesture that made it is over
    // (pointerup ends a click-drag or marquee), after this render has opened
    // the inspector it may sit under.
    const key = this.selectionKey();
    if (key !== this.revealedKey && this.mode.kind === 'idle' && this.editInput === null) {
      this.revealedKey = key;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => this.revealSelection());
      }
    }
  }

  private transientLayer(): SVGGElement {
    return this.deps.svg.querySelector('#transient') as SVGGElement;
  }

  /** Repaint the transient layer (marquee, ghost edge). Called from rerender. */
  drawTransient(): void {
    const layer = this.transientLayer();
    if (!layer) {
      return;
    }
    layer.replaceChildren();
    if (this.mode.kind === 'marquee') {
      const { start, cur } = this.mode;
      layer.append(
        el('rect', {
          class: 'marquee',
          x: String(Math.min(start.x, cur.x)),
          y: String(Math.min(start.y, cur.y)),
          width: String(Math.abs(cur.x - start.x)),
          height: String(Math.abs(cur.y - start.y)),
        })
      );
    } else if (this.mode.kind === 'drawEdge') {
      const from = this.deps.getNodes().find(n => n.id === (this.mode as any).fromId);
      if (from) {
        const r = this.rect(from);
        layer.append(
          el('line', {
            class: 'edge-ghost',
            x1: String(r.x + r.w / 2),
            y1: String(r.y + r.h / 2),
            x2: String(this.mode.cur.x),
            y2: String(this.mode.cur.y),
          })
        );
      }
    }
  }

  private marqueeSelection(): Set<bigint> {
    if (this.mode.kind !== 'marquee') {
      return this.selection;
    }
    const { start, cur, base, additive } = this.mode;
    const minX = Math.min(start.x, cur.x);
    const maxX = Math.max(start.x, cur.x);
    const minY = Math.min(start.y, cur.y);
    const maxY = Math.max(start.y, cur.y);
    const hit = new Set<bigint>();
    for (const n of this.deps.getNodes()) {
      const r = this.rect(n);
      if (r.x < maxX && r.x + r.w > minX && r.y < maxY && r.y + r.h > minY) {
        hit.add(n.id);
      }
    }
    if (!additive) {
      return hit;
    }
    const merged = new Set(base);
    for (const id of hit) {
      merged.add(id);
    }
    return merged;
  }

  private startPan(evt: PointerEvent, tap?: { x: number; y: number; nodeId: bigint | null }): void {
    this.mode = { kind: 'pan', lastX: evt.clientX, lastY: evt.clientY, tap };
    try { this.deps.svg.setPointerCapture(evt.pointerId); } catch { /* synthetic pointer */ }
  }

  /** Two fingers pinch from where they are now; what the first one started is dropped, preview and all. */
  private startPinch(): void {
    const [a, b] = [...this.touches.values()];
    if (this.mode.kind === 'dragNodes' || this.mode.kind === 'resizeNode') {
      this.overrides = new Map();
    }
    this.edgeTarget = null;
    this.mode = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
    this.deps.rerender();
  }

  private wire(): void {
    const { svg, wrap, viewport, conn } = this.deps;

    const menus = [...this.toolbar.querySelectorAll<HTMLDetailsElement>('details')];
    for (const menu of menus) {
      menu.addEventListener('toggle', () => {
        if (menu.open) {
          for (const other of menus) if (other !== menu) other.open = false;
          this.positionPopover(menu);
        }
      });
    }
    document.addEventListener('pointerdown', evt => {
      if (!this.toolbar.contains(evt.target as Element)) {
        for (const menu of menus) menu.open = false;
      }
    });
    this.toolbar.addEventListener('keydown', evt => {
      const open = menus.find(menu => menu.open);
      if (evt.key === 'Escape' && open !== undefined) {
        open.open = false;
        open.querySelector('summary')?.focus();
        evt.preventDefault();
        evt.stopPropagation();
      }
    });

    svg.addEventListener('pointerdown', evt => {
      // A reveal pan still easing (up to 200 ms) stops here: the gesture
      // about to start reads the world point under the pointer, and the
      // canvas must not keep sliding under a drag, marquee or pan (G7).
      viewport.stopAnimation();
      if (this.editInput) {
        return; // input blur handles commit
      }
      if (evt.pointerType === 'touch') {
        // The first finger down is primary: nothing is left over from a pointerup that never came.
        if (evt.isPrimary) this.touches.clear();
        this.touches.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
        if (this.touches.size > 1) {
          if (this.touches.size === 2) this.startPinch();
          evt.preventDefault();
          return;
        }
      }
      // A node marker is its own button (main opens its card on click): no drag, select or marquee.
      if ((evt.target as Element).closest('.board-marker[role="button"]')) return;
      const w = viewport.screenToWorld(evt.clientX, evt.clientY);

      // Red crayon: a node toggles its circle; empty canvas pans. Never a select or a drag.
      if (this.crayonOn && evt.button === 0 && !this.panArmed) {
        const node = this.nodeAt(w.x, w.y);
        if (node) this.deps.crayon?.toggle(node.id);
        else this.startPan(evt);
        evt.preventDefault();
        return;
      }

      // A draft mark's stroke or number chip (only they take the pointer): select the mark, not the node.
      const markHit = (evt.target as Element).closest<SVGElement>('#crayon .mark[data-node-id]');
      if (markHit && evt.button === 0 && !this.panArmed && this.armedKind === null && this.armedTemplate === null) {
        this.deps.crayon?.select(BigInt(markHit.dataset.nodeId!));
        if (this.selection.size > 0 || this.selectedEdges.size > 0) {
          this.selectedEdges.clear();
          this.setSelection([]);
          this.deps.rerender();
        }
        evt.preventDefault();
        return;
      }

      // Armed placement: a kind stays armed until esc; a note or library
      // template places once.
      if ((this.armedKind !== null || this.armedTemplate !== null) && evt.button === 0 && !this.panArmed) {
        this.placeArmed(w.x, w.y);
        evt.preventDefault();
        return;
      }

      // Edge selection: the fat transparent twin (or the label) carries the id.
      const edgeHit = (evt.target as Element).closest<SVGElement>('[data-edge-id]');
      if (edgeHit?.dataset.edgeId && evt.button === 0 && !this.panArmed) {
        const id = BigInt(edgeHit.dataset.edgeId);
        if (id < 0n) return;
        if (evt.shiftKey) {
          if (this.selectedEdges.has(id)) {
            this.selectedEdges.delete(id);
          } else {
            this.selectedEdges.add(id);
          }
        } else {
          this.selectedEdges = new Set([id]);
        }
        if (this.selection.size > 0) {
          this.setSelection([]);
        }
        if (evt.pointerType === 'touch') this.startPan(evt);
        this.deps.rerender();
        return;
      }

      if (evt.button === 0 && !this.panArmed && !evt.shiftKey) {
        const node = this.nodeAt(w.x, w.y);
        const now = performance.now();
        const lc = this.lastClick;
        const isDouble =
          lc !== null &&
          now - lc.time < 400 &&
          Math.hypot(evt.clientX - lc.x, evt.clientY - lc.y) < clickSlop(evt) &&
          lc.nodeId === (node?.id ?? null);
        this.lastClick = isDouble
          ? null
          : { time: now, x: evt.clientX, y: evt.clientY, nodeId: node?.id ?? null };
        if (isDouble) {
          evt.preventDefault();
          if (node) {
            const field = (evt.target as Element).closest('text')?.classList.contains('node-sublabel')
              ? 'sublabel'
              : 'label';
            this.startInlineEdit(node, field);
          } else {
            // Double-click on empty canvas drops text there, like Excalidraw.
            this.placeKind('text', w.x, w.y);
          }
          return;
        }
      }

      if (evt.button === 1 || (evt.button === 0 && this.panArmed)) {
        this.startPan(evt);
        evt.preventDefault();
        return;
      }
      if (evt.button !== 0) {
        return;
      }

      const resize = (evt.target as Element).closest<SVGRectElement>('.resize-handle');
      if (resize?.dataset.nodeId && evt.button === 0) {
        if (this.deps.readOnly?.()) return;
        const node = this.deps.getNodes().find(n => n.id === BigInt(resize.dataset.nodeId!));
        if (node) {
          this.mode = {
            kind: 'resizeNode',
            nodeId: node.id,
            corner: resize.dataset.corner!,
            orig: this.rect(node),
            stored: { x: node.x, y: node.y, w: node.w, h: node.h },
            // Text never sets a floor: the drawn rect is the stored rect (G2).
            // A chart keeps room for its plot; the server holds the same floor.
            minSize: node.kind === 'chart' ? { w: CHART_MIN_W, h: CHART_MIN_H } : node.kind === 'text' ? { w: 16, h: 16 } : { w: 64, h: 48 },
            start: w,
            moved: false,
          };
          try { svg.setPointerCapture(evt.pointerId); } catch { /* synthetic pointer */ }
          return;
        }
      }

      const handle = (evt.target as Element).closest<SVGCircleElement>('.edge-handle');
      if (handle?.dataset.nodeId) {
        if (this.topologyReadOnly) return;
        this.mode = { kind: 'drawEdge', fromId: BigInt(handle.dataset.nodeId), cur: w };
        try { svg.setPointerCapture(evt.pointerId); } catch { /* synthetic pointer */ }
        return;
      }

      const node = this.nodeAt(w.x, w.y);
      if (evt.pointerType === 'touch' && (!node || this.deps.readOnly?.())) {
        // A finger pans where a mouse would marquee, and over nodes on a board
        // it cannot edit; a tap still selects (or clears) on lift.
        this.startPan(evt, { x: evt.clientX, y: evt.clientY, nodeId: node?.id ?? null });
        return;
      }
      if (node) {
        const wasSelected = this.selection.has(node.id);
        if (evt.shiftKey) {
          if (wasSelected) {
            this.selection.delete(node.id);
          } else {
            this.selection.add(node.id);
          }
          this.selectedEdges.clear();
          this.deps.onSelectionChange?.();
          this.deps.rerender();
          return;
        }
        if (!wasSelected) {
          this.setSelection([node.id]);
        }
        if (this.deps.readOnly?.()) {
          this.deps.rerender();
          return;
        }
        const orig = new Map<bigint, { x: number; y: number }>();
        for (const n of this.deps.getNodes()) {
          if (this.selection.has(n.id)) {
            // From where it is drawn (mid-glide too); a glide frame is off the grid the module enforces.
            const r = this.rect(n);
            orig.set(n.id, { x: snap(r.x), y: snap(r.y) });
          }
        }
        this.mode = {
          kind: 'dragNodes',
          start: w,
          orig,
          moved: false,
          hitId: node.id,
          wasSelected,
          shift: false,
        };
        try { svg.setPointerCapture(evt.pointerId); } catch { /* synthetic pointer */ }
        this.deps.rerender();
        return;
      }

      this.mode = {
        kind: 'marquee',
        start: w,
        cur: w,
        base: new Set(this.selection),
        additive: evt.shiftKey,
      };
      if (!evt.shiftKey) {
        if (this.selection.size > 0) {
          this.setSelection([]);
        }
        if (this.selectedEdges.size > 0) {
          this.selectedEdges.clear();
        }
      }
      try { svg.setPointerCapture(evt.pointerId); } catch { /* synthetic pointer */ }
      this.deps.rerender();
    });

    svg.addEventListener('pointermove', evt => {
      if (this.touches.has(evt.pointerId)) {
        this.touches.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
      }
      // A press that ever travelled past the slop is a drag, pan or marquee
      // from then on, even back where it began: not a tap, nor the first click of a double.
      const lc = this.lastClick;
      if (this.mode.kind !== 'idle' && lc !== null && Math.hypot(evt.clientX - lc.x, evt.clientY - lc.y) >= tapSlop(evt)) {
        this.lastClick = null;
      }
      if (this.mode.kind === 'pan' && this.mode.tap && Math.hypot(evt.clientX - this.mode.tap.x, evt.clientY - this.mode.tap.y) >= tapSlop(evt)) {
        this.mode.tap = undefined;
      }
      const w = viewport.screenToWorld(evt.clientX, evt.clientY);
      switch (this.mode.kind) {
        case 'pinch': {
          const [a, b] = [...this.touches.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          const midX = (a.x + b.x) / 2;
          const midY = (a.y + b.y) / 2;
          // The midpoint drags the board; the spread zooms about it.
          viewport.panBy(midX - this.mode.midX, midY - this.mode.midY);
          if (this.mode.dist > 0) viewport.zoomAt(midX, midY, dist / this.mode.dist);
          this.mode = { kind: 'pinch', dist, midX, midY };
          return;
        }
        case 'pan': {
          viewport.panBy(evt.clientX - this.mode.lastX, evt.clientY - this.mode.lastY);
          this.mode.lastX = evt.clientX;
          this.mode.lastY = evt.clientY;
          return;
        }
        case 'marquee': {
          this.mode.cur = w;
          this.setSelection(this.marqueeSelection());
          this.deps.rerender();
          return;
        }
        case 'dragNodes': {
          const dx = snap(w.x - this.mode.start.x);
          const dy = snap(w.y - this.mode.start.y);
          if (Math.abs(w.x - this.mode.start.x) + Math.abs(w.y - this.mode.start.y) > 3) {
            this.mode.moved = true;
          }
          this.overrides = new Map(
            [...this.mode.orig].map(([id, o]) => [
              id,
              { x: Math.max(0, o.x + dx), y: Math.max(0, o.y + dy) },
            ])
          );
          this.deps.rerender();
          return;
        }
        case 'resizeNode': {
          const m = this.mode;
          const dx = snap(w.x - m.start.x);
          const dy = snap(w.y - m.start.y);
          if (Math.abs(w.x - m.start.x) + Math.abs(w.y - m.start.y) > 3) {
            m.moved = true;
          }
          let { x, y, w: nw, h: nh } = m.orig;
          if (m.corner.includes('e')) {
            nw = m.orig.w + dx;
          }
          if (m.corner.includes('s')) {
            nh = m.orig.h + dy;
          }
          if (m.corner.includes('w')) {
            x = m.orig.x + dx;
            nw = m.orig.w - dx;
          }
          if (m.corner.includes('n')) {
            y = m.orig.y + dy;
            nh = m.orig.h - dy;
          }
          if (nw < m.minSize.w) {
            if (m.corner.includes('w')) {
              x -= m.minSize.w - nw;
            }
            nw = m.minSize.w;
          }
          if (nh < m.minSize.h) {
            if (m.corner.includes('n')) {
              y -= m.minSize.h - nh;
            }
            nh = m.minSize.h;
          }
          this.overrides = new Map([[m.nodeId, { x, y, w: nw, h: nh }]]);
          this.deps.rerender();
          return;
        }
        case 'drawEdge': {
          this.mode.cur = w;
          const over = this.nodeAt(w.x, w.y);
          this.edgeTarget = over && over.id !== this.mode.fromId ? over.id : null;
          this.deps.rerender();
          return;
        }
        default: {
          // No hover focus with the crayon up: every node stays at full strength (mockup frame 1).
          const over = this.crayonOn ? null : this.nodeAt(w.x, w.y);
          const id = over?.id ?? null;
          if (id !== this.hoverId) {
            this.hoverId = id;
            this.deps.rerender();
          }
        }
      }
    });

    // Hover drives neighbour focus; it must not linger once the pointer leaves.
    svg.addEventListener('pointerleave', () => {
      if (this.hoverId === null) return;
      this.hoverId = null;
      this.deps.rerender();
    });

    svg.addEventListener('pointerup', evt => {
      this.touches.delete(evt.pointerId);
      if (this.mode.kind === 'pinch') {
        // Fingers left behind pinch on, or pan on, from where they are.
        const rest = [...this.touches.values()];
        if (rest.length >= 2) {
          this.startPinch();
        } else {
          this.mode = rest.length === 1 ? { kind: 'pan', lastX: rest[0].x, lastY: rest[0].y } : { kind: 'idle' };
        }
        return;
      }
      const mode = this.mode;
      this.mode = { kind: 'idle' };
      if (svg.hasPointerCapture(evt.pointerId)) {
        svg.releasePointerCapture(evt.pointerId);
      }
      if (this.deps.readOnly?.() && ['dragNodes', 'resizeNode', 'drawEdge'].includes(mode.kind)) {
        this.overrides.clear();
        this.edgeTarget = null;
        this.deps.rerender();
        return;
      }
      switch (mode.kind) {
        case 'dragNodes': {
          const overrides = this.overrides;
          if (!mode.moved) {
            this.overrides = new Map();
            if (mode.wasSelected && this.selection.size > 1) {
              this.setSelection([mode.hitId]);
            }
            this.deps.rerender();
            return;
          }
          // A node dragged somewhere was placed there on purpose: its new
          // selection is not revealed afterwards (G7).
          this.revealedKey = this.selectionKey();
          const moves = [...mode.orig]
            .map(([nodeId, from]) => {
              const to = overrides.get(nodeId);
              return to && (to.x !== from.x || to.y !== from.y)
                ? { nodeId, from, to }
                : null;
            })
            .filter((m): m is NonNullable<typeof m> => m !== null);
          this.deps.rerender();
          this.holdPreview(overrides, moves.length > 0 ? this.deps.ops.moveNodesAction(moves) : undefined);
          return;
        }
        case 'resizeNode': {
          const overrides = this.overrides;
          const preview = overrides.get(mode.nodeId);
          this.deps.rerender();
          this.holdPreview(
            overrides,
            mode.moved && preview && preview.w !== undefined && preview.h !== undefined
              ? this.deps.ops.resizeNodeAction(mode.nodeId, mode.stored, { x: preview.x, y: preview.y, w: preview.w, h: preview.h })
              : undefined
          );
          return;
        }
        case 'drawEdge': {
          const target = this.edgeTarget;
          this.edgeTarget = null;
          this.deps.rerender();
          if (target !== null) {
            void this.deps.ops
              .createEdgeAction({
                boardId: this.deps.boardId,
                fromNode: mode.fromId,
                toNode: target,
                label: '',
              })
              .catch(err => showError((err as Error).message));
          }
          return;
        }
        case 'marquee': {
          this.setSelection(this.marqueeSelection());
          this.deps.rerender();
          return;
        }
        case 'pan': {
          if (mode.tap && Math.hypot(evt.clientX - mode.tap.x, evt.clientY - mode.tap.y) < tapSlop(evt)) {
            this.selectedEdges.clear();
            this.setSelection(mode.tap.nodeId === null ? [] : [mode.tap.nodeId]);
          }
          this.deps.rerender();
          return;
        }
        default:
          this.deps.rerender();
      }
    });

    // The system took the pointer (an edge swipe, a palm): the gesture stops
    // where it is and writes nothing.
    svg.addEventListener('pointercancel', evt => {
      this.touches.delete(evt.pointerId);
      if (this.mode.kind === 'dragNodes' || this.mode.kind === 'resizeNode') {
        this.overrides = new Map();
      }
      this.mode = { kind: 'idle' };
      this.edgeTarget = null;
      this.deps.rerender();
    });

    svg.addEventListener(
      'wheel',
      evt => {
        evt.preventDefault();
        const k = evt.deltaMode === 1 ? 16 : 1;
        if (evt.ctrlKey || evt.metaKey) {
          viewport.zoomAt(evt.clientX, evt.clientY, Math.exp(-evt.deltaY * k * 0.01));
        } else {
          viewport.panBy(-evt.deltaX * k, -evt.deltaY * k);
        }
      },
      { passive: false }
    );

    // The :focus-visible heuristic, tracked here so it is testable: a pointer
    // press means the focus that follows is not the keyboard's; Tab and the
    // arrow keys move focus by keyboard.
    window.addEventListener('pointerdown', () => {
      this.pointerFocus = true;
    }, true);
    window.addEventListener('keydown', evt => {
      if (evt.key === 'Tab' || evt.key.startsWith('Arrow')) {
        this.pointerFocus = false;
      }
    }, true);

    window.addEventListener('keydown', evt => {
      if (this.editInput) {
        return; // the input's own handlers deal with keys
      }
      const target = evt.target instanceof Element ? evt.target : null;
      if (target?.closest(TEXT_ENTRY)) {
        return; // typing, not a shortcut
      }
      const meta = evt.metaKey || evt.ctrlKey;
      // With keyboard focus, a button, link or disclosure owns Space
      // (activation) and the inspector, rail and toolbar own their plain keys
      // (G26). After a click, focus stays on the clicked control but the keys
      // go to the canvas. Modifier shortcuts (⌥E, ⌥C, ⌘Z, ⌘D, ⌘0) work from
      // anywhere.
      const keyboardFocus = !this.pointerFocus;
      if (keyboardFocus && evt.code === 'Space' && target?.closest(ACTIVATABLE)) {
        return;
      }
      const plain = !meta && !evt.altKey;
      if (keyboardFocus && plain && evt.key !== 'Escape' && target?.closest(KEY_PANELS)) {
        return;
      }
      if (evt.code === 'Space' && !evt.repeat) {
        this.spaceDown = true;
        svg.classList.add('panning');
        evt.preventDefault();
        return;
      }
      if (evt.key === '?') {
        this.shortcuts.hidden = !this.shortcuts.hidden;
        return;
      }
      // 1–6 arm a node kind for placement; the same key again disarms. T arms text.
      if (!meta && !evt.altKey && /^[1-6]$/.test(evt.key) && !(evt.shiftKey && evt.code === 'Digit1')) {
        this.arm(KINDS[Number(evt.key) - 1]);
        return;
      }
      if (!meta && !evt.altKey && (evt.key === 't' || evt.key === 'T')) {
        this.arm('text');
        return;
      }
      // ⌥E toggles the evidence overlay (code, not key — alt changes the glyph).
      if (evt.altKey && !meta && evt.code === 'KeyE') {
        evt.preventDefault();
        this.toggleOverlay();
        return;
      }
      // ⌥C toggles the code overlay, same shape as ⌥E.
      if (evt.altKey && !meta && evt.code === 'KeyC') {
        evt.preventDefault();
        this.toggleCodeOverlay();
        return;
      }
      // L opens or closes the library; ⇧L saves the node selection to it.
      // preventDefault keeps the l out of the search field that opening focuses.
      // evt.key, not evt.code: on Dvorak or Colemak the key that types l is not KeyL.
      if ((evt.key === 'l' || evt.key === 'L') && !meta && !evt.altKey) {
        evt.preventDefault();
        if (!evt.shiftKey) {
          this.deps.toggleLibrary?.();
        } else if (this.selection.size > 0) {
          this.deps.addToLibrary?.();
        }
        return;
      }
      // C picks up the red crayon, or puts it down (⌥C is the code overlay).
      if ((evt.key === 'c' || evt.key === 'C') && !meta && !evt.altKey && !evt.shiftKey) {
        evt.preventDefault();
        this.toggleCrayon();
        return;
      }
      if ((evt.key === 'h' || evt.key === 'H') && !meta && !evt.altKey && !evt.shiftKey) {
        evt.preventDefault();
        this.setHand(!this.handMode);
        return;
      }
      if (evt.key === 'Escape') {
        if (!this.shortcuts.hidden) {
          this.shortcuts.hidden = true;
        } else if ((this.deps.crayon?.selected ?? null) !== null) {
          this.deps.crayon!.select(null);
        } else if (this.armedKind !== null || this.armedTemplate !== null || this.crayonOn) {
          this.arm(null);
        } else if (this.handMode) {
          this.setHand(false);
        } else if (this.mode.kind !== 'idle') {
          this.mode = { kind: 'idle' };
          this.overrides = new Map();
          this.edgeTarget = null;
          this.deps.rerender();
        } else if (this.selection.size > 0 || this.selectedEdges.size > 0) {
          this.selectedEdges.clear();
          this.setSelection([]);
          this.deps.rerender();
        }
        return;
      }
      if (meta && evt.key === '0') {
        evt.preventDefault();
        viewport.reset();
        return;
      }
      if (meta && (evt.key === '=' || evt.key === '+')) {
        evt.preventDefault();
        viewport.zoomCentered(1.25);
        return;
      }
      if (meta && evt.key === '-') {
        evt.preventDefault();
        viewport.zoomCentered(0.8);
        return;
      }
      if (evt.shiftKey && evt.code === 'Digit1') {
        evt.preventDefault();
        this.fitView();
        return;
      }
      if (meta && evt.key.toLowerCase() === 'z') {
        evt.preventDefault();
        if (this.deps.readOnly?.()) return;
        // With the crayon up, ⌘Z takes back the last circle before any board edit.
        if (this.crayonOn && !evt.shiftKey && (this.deps.crayon?.drafts().length ?? 0) > 0) {
          this.deps.crayon!.undo();
          return;
        }
        void (evt.shiftKey ? this.deps.ops.history.redo() : this.deps.ops.history.undo());
        return;
      }
      if (meta && evt.key.toLowerCase() === 'd') {
        evt.preventDefault();
        if (this.topologyReadOnly) return;
        const duplicatedBoard = this.deps.boardId;
        const sel = this.deps.getNodes().filter(n => this.selection.has(n.id));
        if (sel.length > 0) {
          void this.deps.ops
            .duplicateNodesAction(sel)
            .then(ids => {
              if (this.deps.boardId !== duplicatedBoard) return;
              this.setSelection(ids);
              this.deps.rerender();
            })
            .catch(err => showError((err as Error).message));
        }
        return;
      }
      if (evt.key === 'Delete' || evt.key === 'Backspace') {
        const mark = this.deps.crayon?.selected ?? null;
        if (mark !== null) this.deps.crayon!.remove([mark]);
        else this.deleteSelection();
        return;
      }
      if (evt.key === 'f' || evt.key === 'F') {
        this.toggleFocal();
        return;
      }
    });

    window.addEventListener('keyup', evt => {
      if (evt.code === 'Space' && this.spaceDown) {
        this.spaceDown = false;
        svg.classList.toggle('panning', this.panArmed);
      }
    });

    // Sub-project C style controls. One patch shape for all of them, so undo
    // and error reporting behave identically across colour/size/line/shape.
    // Edges carry colour and line too, and weight (RC-688): each control says
    // what it sets on the selected nodes and what on the selected edges.
    const styleSelection = (patch: { node?: NodePatch; edge?: Partial<EdgeStyle> }, label: string): void => {
      if (this.deps.readOnly?.()) return;
      const actionOps = this.deps.ops;
      const sel = patch.node ? this.deps.getNodes().filter(n => this.selection.has(n.id)) : [];
      const edges = patch.edge ? this.deps.getEdges().filter(e => this.selectedEdges.has(e.id)) : [];
      const count = sel.length + edges.length;
      if (count === 0) {
        return;
      }
      void actionOps.history.batch(`${label} on ${count} item${count === 1 ? '' : 's'}`, async () => {
        for (const n of sel) {
          try {
            await actionOps.updateNodeAction(n.id, patch.node!);
            // Free text fits its box to the new font size.
            if (n.kind === 'text' && patch.node!.size !== undefined) {
              const { w, h } = layoutText(n.label, patch.node!.size);
              if (w !== n.w || h !== n.h) await actionOps.resizeNodeAction(n.id, n, { x: n.x, y: n.y, w, h });
            }
          } catch (err) {
            showError((err as Error).message);
          }
        }
        for (const e of edges) {
          try {
            await actionOps.updateEdgeStyleAction(e.id, patch.edge!);
          } catch (err) {
            showError((err as Error).message);
          }
        }
      });
    };

    for (const sw of document.querySelectorAll<HTMLButtonElement>('#tb-swatches .swatch')) {
      sw.addEventListener('click', () => {
        const color = sw.dataset.color ?? '';
        styleSelection({ node: { color }, edge: { color } }, 'colour');
      });
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-size button')) {
      b.addEventListener('click', () => styleSelection({ node: { size: b.dataset.size ?? 'm' } }, 'size'));
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-stroke button')) {
      b.addEventListener('click', () => {
        const strokeStyle = b.dataset.stroke ?? 'solid';
        // A node border has no dotted look; the button shows for edges only.
        styleSelection({ node: strokeStyle === 'dotted' ? undefined : { strokeStyle }, edge: { strokeStyle } }, 'line');
      });
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-shape button')) {
      // A keyboard click can land before syncChrome disables the buttons.
      b.addEventListener('click', () => {
        if (!this.chartSelected()) styleSelection({ node: { shape: b.dataset.shape ?? 'rect' } }, 'shape');
      });
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-weight button')) {
      b.addEventListener('click', () => styleSelection({ edge: { weight: b.dataset.weight ?? 'regular' } }, 'weight'));
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-motion button')) {
      b.addEventListener('click', () => styleSelection({ edge: { motion: b.dataset.motion ?? 'none' } }, 'motion'));
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#tb-speed button')) {
      b.addEventListener('click', () => styleSelection({ edge: { motionSpeed: b.dataset.speed ?? 'normal' } }, 'speed'));
    }
    // Back to what a new edge gets: no colour of its own, solid, regular, still.
    this.tbReset.addEventListener('click', () => styleSelection({ edge: { ...DEFAULT_EDGE_STYLE } }, 'reset style'));

    this.tbDelete.addEventListener('click', () => this.deleteSelection());
    this.tbFocal.addEventListener('click', () => this.toggleFocal());
    this.tbToken.addEventListener('click', () => {
      if (this.deps.readOnly?.()) return;
      const actionOps = this.deps.ops;
      // accent is reserved for focal nodes — the cycle never offers it
      const order = ['ink', 'muted'];
      const sel = this.deps.getNodes().filter(n => this.selection.has(n.id));
      if (sel.length === 0) {
        return;
      }
      const cur = order.indexOf(sel[0].token);
      const next = order[(cur + 1) % order.length];
      void actionOps.history.batch(`set token on ${sel.length} nodes`, async () => {
        for (const n of sel) {
          try {
            await actionOps.updateNodeAction(n.id, { token: next });
          } catch (err) {
            showError((err as Error).message);
          }
        }
      });
    });
    this.tbKind.addEventListener('click', () => {
      const actionOps = this.deps.ops;
      // A keyboard click can land before syncChrome disables the button.
      if (this.topologyReadOnly || this.chartSelected()) return;
      const sel = this.deps.getNodes().filter(n => this.selection.has(n.id));
      if (sel.length === 0) {
        return;
      }
      const cur = KINDS.indexOf(sel[0].kind as NodeKind);
      const next = KINDS[(cur + 1) % KINDS.length];
      void actionOps.history.batch(`set kind on ${sel.length} nodes`, async () => {
        for (const n of sel) {
          try {
            await actionOps.updateNodeAction(n.id, { kind: next });
          } catch (err) {
            showError((err as Error).message);
          }
        }
      });
    });

    // Rail: click a row to arm its kind, click the switch to toggle overlay.
    for (const row of document.querySelectorAll<HTMLButtonElement>('.add-row')) {
      row.addEventListener('click', () => this.arm(row.dataset.kind as NodeKind));
    }
    this.overlayRow.addEventListener('click', () => this.toggleOverlay());
    this.codeOverlayRow.addEventListener('click', () => this.toggleCodeOverlay());
    document.getElementById('tool-select')?.addEventListener('click', () => {
      this.arm(null);
      this.setHand(false);
    });
    document.getElementById('tool-hand')?.addEventListener('click', () => this.setHand(!this.handMode));
    document.getElementById('tool-crayon')?.addEventListener('click', () => this.toggleCrayon());
    document.getElementById('empty-place')?.addEventListener('click', () => this.arm('service'));

    this.hudZoom.addEventListener('click', () => viewport.reset());
    this.hudZoomIn.addEventListener('click', () => viewport.zoomCentered(1.25));
    this.hudZoomOut.addEventListener('click', () => viewport.zoomCentered(0.8));
    this.hudFit.addEventListener('click', () => this.fitView());

    // The keyed renderer keeps #transient across renders, so drawTransient is
    // driven explicitly from rerender() rather than a mutation observer.
    this.syncRail();
    void conn;
  }

  private deleteSelection(): void {
    const actionOps = this.deps.ops;
    if (this.topologyReadOnly) return;
    if (this.selectedEdges.size > 0 && this.selection.size === 0) {
      const edges = this.deps.getEdges().filter(e => this.selectedEdges.has(e.id));
      this.selectedEdges.clear();
      void actionOps.history.batch(
        edges.length === 1 ? 'delete edge' : `delete ${edges.length} edges`,
        async () => {
          for (const e of edges) {
            try {
              await actionOps.deleteEdgeAction(e);
            } catch (err) {
              showError((err as Error).message);
            }
          }
        }
      );
      this.deps.rerender();
      return;
    }
    const sel = this.deps.getNodes().filter(n => this.selection.has(n.id));
    if (sel.length === 0) {
      return;
    }
    void this.deps.ops
      .deleteNodesAction(sel, this.deps.getEdges())
      .catch(err => showError((err as Error).message));
    this.setSelection([]);
  }

  private toggleFocal(): void {
    if (this.deps.readOnly?.()) return;
    const actionOps = this.deps.ops;
    const sel = this.deps.getNodes().filter(n => this.selection.has(n.id));
    if (sel.length === 0) {
      return;
    }
    void actionOps.history.batch(
      sel.length === 1 ? 'toggle focal' : `toggle focal on ${sel.length} nodes`,
      async () => {
        for (const n of sel) {
          try {
            await actionOps.updateNodeAction(n.id, { focal: !n.focal });
          } catch (err) {
            showError((err as Error).message);
          }
        }
      }
    );
  }

  startInlineEdit(node: Node, field: 'label' | 'sublabel'): void {
    if (this.editInput || this.deps.readOnly?.()) {
      return;
    }
    const { viewport, wrap } = this.deps;
    const r = this.rect(node);
    const s = viewport.scale;
    if (node.kind === 'chart') {
      // A chart's title and subtitle sit top-left on the card, one line each.
      // Edit on the drawn line, at its size, from the text's own x/y
      // (render.ts sets both as attributes in node-local units).
      const drawn = this.deps.svg.querySelector<SVGTextElement>(`#world [data-id="${node.id}"] text[data-field="${field}"]`);
      if (drawn === null) {
        return;
      }
      // The drawn sizes (style.css .chart-title 13 px, .chart-subtitle 11.5 px).
      const fontSize = (field === 'label' ? 13 : 11.5) * s;
      const x = Number(drawn.getAttribute('x') ?? 0);
      const p = viewport.worldToScreen(r.x + x, r.y + Number(drawn.getAttribute('y') ?? 0));
      const input = document.createElement('input');
      input.id = 'inline-edit';
      input.style.textAlign = 'left';
      input.classList.add('chart');
      if (field === 'sublabel') {
        input.classList.add('chart-sub');
      }
      input.value = field === 'label' ? node.label : node.sublabel;
      input.style.left = `${p.x - 3}px`;
      input.style.top = `${p.y - fontSize - 3 * s}px`;
      input.style.fontSize = `${fontSize}px`;
      input.style.width = `${Math.max(80, (r.w - 2 * x) * s)}px`;
      this.openInlineEdit(node, field, input);
      return;
    }
    if (node.kind === 'text') {
      // Free text edits in place, in its drawn face, and grows with what is typed.
      const t = layoutText(node.label, node.size);
      const p = viewport.worldToScreen(r.x, r.y);
      const area = document.createElement('textarea');
      area.id = 'inline-edit';
      area.classList.add('text');
      area.rows = 1;
      area.spellcheck = false;
      area.value = node.label;
      area.style.left = `${p.x - 3}px`;
      area.style.top = `${p.y - 1}px`;
      area.style.fontSize = `${t.fontSize * s}px`;
      area.style.lineHeight = `${t.lineHeight * s}px`;
      const fit = () => {
        area.style.width = '0';
        area.style.height = '0';
        area.style.width = `${area.scrollWidth + t.fontSize * s}px`;
        area.style.height = `${area.scrollHeight}px`;
      };
      area.addEventListener('input', fit);
      this.openInlineEdit(node, 'label', area);
      // Caret at the end, as in Excalidraw: one keystroke never replaces the whole block.
      area.setSelectionRange(area.value.length, area.value.length);
      fit();
      return;
    }
    if (node.kind !== 'boundary' && node.kind !== 'note') {
      // The editor sits on the drawn text block: the layout the renderer drew
      // (wrapped label, badge row), else the same layout computed fresh.
      const world = this.deps.svg.querySelector<SVGGElement>('#world');
      const t = (world !== null ? renderedText(world, node.id) : null) ?? layoutNodeText(node, r.w, r.h, null);
      const input = document.createElement(field === 'label' ? 'textarea' : 'input');
      input.id = 'inline-edit';
      input.style.textAlign = 'center';
      if (field === 'label') {
        // A label wraps to two lines like the drawn one; the box is that block.
        const area = input as HTMLTextAreaElement;
        area.rows = 1;
        area.spellcheck = false;
        const lh = t.lineHeight * s;
        // Line box of the first line: its baseline sits ≈0.34 em below the middle.
        const top = viewport.worldToScreen(r.x, r.y + t.labelY - t.lineHeight / 2 - 0.34 * t.fontSize).y;
        area.style.fontSize = `${t.fontSize * s}px`;
        area.style.lineHeight = `${lh}px`;
        // As tall as the whole label wraps (at most two lines), not the drawn
        // line count: the opaque editor covers the sublabel and badge while open.
        const rows = Math.max(t.lines.length, editLines(node.label, node.size, Math.max(t.room, 48)));
        area.style.height = `${rows * lh}px`;
        area.style.top = `${top - 1}px`;
        // Typing past the drawn lines grows the box to the two lines a label can show.
        area.addEventListener('input', () => {
          area.style.height = 'auto';
          area.style.height = `${Math.min(2 * lh, Math.max(lh, area.scrollHeight))}px`;
        });
      } else {
        input.classList.add('sublabel');
        const fontSize = 12 * s;
        input.style.fontSize = `${fontSize}px`;
        input.style.top = `${viewport.worldToScreen(r.x, r.y + t.subY).y - fontSize - 3 * s}px`;
      }
      const room = Math.max(field === 'label' ? t.room : r.w - 32, 48);
      input.style.width = `${room * s}px`;
      input.style.left = `${viewport.worldToScreen(r.x + (r.w - room) / 2, r.y).x - 3}px`;
      input.value = field === 'label' ? node.label : node.sublabel;
      this.openInlineEdit(node, field, input);
      return;
    }
    // Boundary and note labels keep their fixed first-line baselines, and edit
    // in the face they are drawn in (style.css): a boundary heading in 13 px
    // sans 600 from x 16 (40 beside an icon), a note body in 400 at its size's
    // 12 / 14 / 17 px.
    const boundary = node.kind === 'boundary';
    const baseFont = boundary ? 13 : node.size === 's' ? 12 : node.size === 'l' ? 17 : 14;
    const baselineY = boundary ? 24 : 33;
    // A boundary with an icon draws its heading further right (render.ts): edit it where it is.
    const drawnX = boundary ? Number(this.deps.svg.querySelector(`#world [data-id="${node.id}"] .node-boundary-label`)?.getAttribute('x')) : 0;
    const indent = boundary ? drawnX || 16 : 0;
    const fontSize = baseFont * s;
    const p = viewport.worldToScreen(r.x + indent, r.y + baselineY);
    const input = document.createElement(boundary ? 'input' : 'textarea');
    input.id = 'inline-edit';
    input.classList.add(boundary ? 'boundary' : 'note');
    input.value = node.label;
    input.style.left = `${p.x - 3}px`;
    input.style.top = `${p.y - fontSize - 3 * s}px`;
    input.style.fontSize = `${fontSize}px`;
    if (!boundary) {
      // A note body wraps over several lines (render.ts, 21 px apart): the
      // editor covers every drawn line and grows to the lines the box shows.
      const area = input as HTMLTextAreaElement;
      area.rows = 1;
      area.spellcheck = false;
      const lh = 21 * s;
      const maxLines = Math.max(1, Math.floor((r.h - 19) / 21));
      const drawn = this.deps.svg.querySelectorAll(`#world [data-id="${node.id}"] .note-body tspan`).length;
      // Never shorter than the drawn lines: the board does not redraw while editing.
      const floor = Math.min(maxLines, Math.max(1, drawn)) * lh;
      area.style.lineHeight = `${lh}px`;
      area.style.height = `${floor}px`;
      area.style.top = `${p.y - 0.34 * fontSize - lh / 2 - 1}px`;
      area.addEventListener('input', () => {
        area.style.height = 'auto';
        area.style.height = `${Math.min(maxLines * lh, Math.max(floor, area.scrollHeight))}px`;
      });
    }
    input.style.width = `${Math.max(80, (r.w - indent * 2) * s)}px`;
    this.openInlineEdit(node, 'label', input);
  }

  private openInlineEdit(node: Node, field: 'label' | 'sublabel', input: HTMLInputElement | HTMLTextAreaElement): void {
    const { wrap } = this.deps;
    this.editInput = input;
    this.deps.rerender();

    let done = false;
    const finish = (commit: boolean) => {
      if (done) {
        return;
      }
      done = true;
      // A label is one line of text: a pasted newline becomes a space. Free text keeps its lines.
      const value = node.kind === 'text' ? input.value.replace(/\s+$/, '') : input.value.replace(/\s*[\r\n]+\s*/g, ' ');
      input.remove();
      this.editInput = null;
      this.deps.rerender();
      // A double-click opens the editor before the first click's reveal
      // runs (it skips while editing): bring the selection clear now.
      this.revealSelection();
      // Re-read the row: the snapshot captured at double-click may be stale
      // if a collaborator edited other fields while the input was open.
      const fresh = this.deps.getNodes().find(n => n.id === node.id);
      if (!fresh) {
        return; // deleted remotely while editing
      }
      if (!commit || this.deps.readOnly?.()) {
        return;
      }
      if (fresh.kind === 'text') {
        this.commitText(fresh, value);
        return;
      }
      if (value === (field === 'label' ? fresh.label : fresh.sublabel)) {
        return;
      }
      void this.deps.ops
        .updateNodeAction(fresh.id, field === 'label' ? { label: value } : { sublabel: value })
        .catch(err => showError((err as Error).message));
    };
    (input as HTMLElement).addEventListener('keydown', evt => {
      evt.stopPropagation();
      if (node.kind === 'text') {
        // Enter breaks the line; ⌘Enter or Esc saves (Esc does not discard, as in Excalidraw).
        const mark = (evt.metaKey || evt.ctrlKey) && !evt.altKey ? markForKey(evt) : undefined;
        if (mark !== undefined) {
          evt.preventDefault();
          const next = toggleMark(input.value, input.selectionStart ?? 0, input.selectionEnd ?? 0, mark);
          input.value = next.value;
          input.setSelectionRange(next.start, next.end);
          input.dispatchEvent(new Event('input'));
        } else if (evt.key === 'Escape' || (evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey))) {
          evt.preventDefault();
          finish(true);
        }
        return;
      }
      if (evt.key === 'Enter') {
        evt.preventDefault();
        finish(true);
      } else if (evt.key === 'Escape') {
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    wrap.append(input);
    input.focus();
    input.select();
    // select() leaves the caret at the end; the label reads from its start.
    input.scrollTop = 0;
  }

  /** Save free text and fit its box in one undo step; text left empty is deleted. */
  private commitText(node: Node, value: string): void {
    const ops = this.deps.ops;
    const report = (err: unknown) => showError((err as Error).message);
    if (value.trim() === '') {
      void ops.deleteNodesAction([node], this.deps.getEdges()).catch(report);
      return;
    }
    const { w, h } = layoutText(value, node.size);
    if (value === node.label && w === node.w && h === node.h) return;
    void ops.history
      .batch('edit text', async () => {
        if (value !== node.label) await ops.updateNodeAction(node.id, { label: value });
        if (w !== node.w || h !== node.h) await ops.resizeNodeAction(node.id, node, { x: node.x, y: node.y, w, h });
      })
      .catch(report);
  }
}

/** ⌘B bold, ⌘I italic, ⌘⇧X strike, ⌘E code: the markdown marker each toggles. */
function markForKey(evt: KeyboardEvent): string | undefined {
  const key = evt.key.toLowerCase();
  if (evt.shiftKey) return key === 'x' ? '~~' : undefined;
  return key === 'b' ? '**' : key === 'i' ? '*' : key === 'e' ? '`' : undefined;
}
