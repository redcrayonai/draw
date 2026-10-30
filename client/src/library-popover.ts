import type { LibraryItem } from './module_bindings/types';
import type { NodeKind } from './interactions';
import { CHART_CONTRACTS, CHART_TYPES, type ChartType } from '../../module/src/chart-contracts';
import { ICON_SECTIONS } from '../../module/src/node-icons';
import { svgEl } from './charts/svg';
import { drawableIcons, iconSvg, loadLogos, logosReady } from './node-icons';

/** What a library tile places. */
export type LibraryPick =
  | { kind: 'node'; nodeKind: NodeKind }
  | { kind: 'chart'; type: ChartType }
  | { kind: 'icon'; icon: string }
  | { kind: 'saved'; item: LibraryItem };

/** The picks the Editor hands to main.ts; a node pick arms its kind instead. */
export type TemplatePick = Exclude<LibraryPick, { kind: 'node' }>;

export interface LibraryPopoverDeps {
  /** #tool-library: toggles the popover, carries aria-expanded, takes focus back on Esc and Enter. */
  anchor: HTMLElement;
  /** The canvas svg: a tile dragged out and released over it is dropped there. */
  dropTarget: Element;
  /** Click or Enter on a tile: arm it for the next canvas click. */
  onPick: (pick: LibraryPick) => void;
  /** A tile released over dropTarget, with the release point in client px. */
  onDrop: (pick: LibraryPick, clientX: number, clientY: number) => void;
  onRename: (item: LibraryItem) => void;
  onDelete: (item: LibraryItem) => void;
}

export const EMPTY_LIBRARY = 'No saved items yet — select nodes and press ⇧L';

const OBJECTS: ReadonlyArray<{ kind: NodeKind; name: string }> = [
  { kind: 'service', name: 'Service' },
  { kind: 'datastore', name: 'Datastore' },
  { kind: 'external', name: 'External' },
  { kind: 'boundary', name: 'Boundary' },
  { kind: 'note', name: 'Note' },
];

/** Pointer travel (px) before a press on a tile becomes a drag. */
const DRAG_SLOP = 4;

type Mark = [keyof SVGElementTagNameMap, Record<string, string>, string?];
const ROUND = { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** 26 × 16 tile icons after the approved mock. Colour comes only from the
 *  .series-N classes (style.css maps them to --series-N). */
const CHART_ICONS: Record<ChartType, Mark[]> = {
  timeseries: [
    ['polyline', { points: '1,12 8,9 14,3 20,6 25,5', class: 'line series-1', 'stroke-width': '1.6', ...ROUND }],
    ['polyline', { points: '1,14 8,13 14,12 20,13 25,13', class: 'line series-2', 'stroke-width': '1.6', ...ROUND }],
  ],
  bars: [
    ['rect', { x: '2', y: '7', width: '5', height: '9', class: 'fill series-1' }],
    ['rect', { x: '10', y: '3', width: '5', height: '13', class: 'fill series-1' }],
    ['rect', { x: '18', y: '9', width: '5', height: '7', class: 'fill series-1' }],
    ['rect', { x: '2', y: '4', width: '5', height: '2', class: 'fill series-2' }],
    ['rect', { x: '10', y: '0', width: '5', height: '2', class: 'fill series-2' }],
  ],
  toplist: [
    ['rect', { x: '1', y: '1', width: '24', height: '3', rx: '1.5', class: 'fill series-1' }],
    ['rect', { x: '1', y: '6', width: '16', height: '3', rx: '1.5', class: 'fill series-1' }],
    ['rect', { x: '1', y: '11', width: '9', height: '3', rx: '1.5', class: 'fill series-1' }],
  ],
  pie: [
    ['circle', { cx: '13', cy: '8', r: '6', class: 'line series-2', 'stroke-width': '3' }],
    ['path', { d: 'M13 2A6 6 0 0 1 19 8', class: 'line series-1', 'stroke-width': '3' }],
  ],
  treemap: [
    ['rect', { x: '1', y: '1', width: '13', height: '14', class: 'fill series-1' }],
    ['rect', { x: '15', y: '1', width: '10', height: '7', class: 'fill series-2' }],
    ['rect', { x: '15', y: '9', width: '10', height: '6', class: 'fill series-3' }],
  ],
  table: [
    ['path', { d: 'M1 3h24M1 8h24M1 13h24', class: 'ink', 'stroke-opacity': '0.6' }],
    ['path', { d: 'M10 1v14', class: 'ink', 'stroke-opacity': '0.3' }],
  ],
  stat: [['text', { x: '13', y: '12', 'text-anchor': 'middle', class: 'lib-icon-text' }, '99%']],
  waterfall: [
    ['rect', { x: '1', y: '1', width: '10', height: '3', rx: '1', class: 'fill series-1' }],
    ['rect', { x: '6', y: '6.5', width: '12', height: '3', rx: '1', class: 'fill series-2' }],
    ['rect', { x: '13', y: '12', width: '12', height: '3', rx: '1', class: 'fill series-3' }],
  ],
  scatter: [
    ['circle', { cx: '3', cy: '13', r: '1.6', class: 'fill series-1' }],
    ['circle', { cx: '8', cy: '10', r: '1.6', class: 'fill series-1' }],
    ['circle', { cx: '12', cy: '12', r: '1.6', class: 'fill series-2' }],
    ['circle', { cx: '15', cy: '6', r: '1.6', class: 'fill series-1' }],
    ['circle', { cx: '19', cy: '8', r: '1.6', class: 'fill series-2' }],
    ['circle', { cx: '23', cy: '3', r: '1.6', class: 'fill series-2' }],
  ],
  schedule: [
    ['path', { d: 'M1 5.5h24M1 10.5h24', class: 'ink', 'stroke-opacity': '0.3' }],
    ['rect', { x: '1', y: '1.5', width: '12', height: '2.5', rx: '1', class: 'fill series-1' }],
    ['rect', { x: '9', y: '6.75', width: '12', height: '2.5', rx: '1', class: 'fill series-1' }],
    ['rect', { x: '4', y: '12', width: '9', height: '2.5', rx: '1', class: 'fill series-1' }],
    ['path', { d: 'M20 11.25l2 2-2 2-2-2Z', class: 'fill series-1' }],
  ],
  kanban: [
    ['path', { d: 'M1 1.5h7M9.5 1.5h7M18 1.5h7', class: 'ink', 'stroke-opacity': '0.5' }],
    ['rect', { x: '1', y: '4', width: '7', height: '4.5', rx: '1', class: 'fill series-1' }],
    ['rect', { x: '1', y: '10.5', width: '7', height: '4.5', rx: '1', class: 'fill series-1' }],
    ['rect', { x: '9.5', y: '4', width: '7', height: '4.5', rx: '1', class: 'fill series-2' }],
    ['rect', { x: '18', y: '4', width: '7', height: '4.5', rx: '1', class: 'fill series-3' }],
  ],
};

function chartIcon(type: ChartType): SVGSVGElement {
  const svg = svgEl('svg', { class: 'lib-icon', width: '26', height: '16', viewBox: '0 0 26 16', 'aria-hidden': 'true' });
  for (const [tag, attrs, text] of CHART_ICONS[type]) {
    svg.append(svgEl(tag, attrs, text));
  }
  return svg;
}

/** The dock's own 20 px kind icon, so the two can never drift apart. */
function objectIcon(kind: NodeKind): Element | null {
  const icon = document.querySelector(`#dock .add-row[data-kind="${kind}"] svg`);
  return icon === null ? null : (icon.cloneNode(true) as Element);
}

/** An empty 20 px icon box: a logo tile's placeholder while its artwork loads. */
function pendingIcon(): SVGSVGElement {
  return svgEl('svg', { class: 'lib-node-icon lib-node-icon-pending', width: '20', height: '20', viewBox: '0 0 20 20', 'aria-hidden': 'true' });
}

function dotsIcon(): SVGSVGElement {
  const svg = svgEl('svg', { width: '14', height: '14', viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' });
  for (const cx of ['3.5', '8', '12.5']) {
    svg.append(svgEl('circle', { cx, cy: '8', r: '1.1' }));
  }
  return svg;
}

type Rect = { x: number; y: number; w: number; h: number };

/** The node rects of a version 1 payload; [] when it is not one. */
function thumbRects(payload: string): Rect[] {
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return [];
  }
  const nodes = (v as { version?: unknown; nodes?: unknown } | null)?.version === 1 ? (v as { nodes: unknown }).nodes : undefined;
  if (!Array.isArray(nodes)) {
    return [];
  }
  const rect = (n: unknown): n is Rect =>
    n !== null && typeof n === 'object' && ['x', 'y', 'w', 'h'].every(k => Number.isFinite((n as Record<string, unknown>)[k]));
  return nodes.every(rect) ? nodes : [];
}

function emptyLine(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'lib-empty';
  p.textContent = text;
  return p;
}

/**
 * The library popover above the dock (spec "Library popover", mock option A):
 * a search field, then Objects, Agents, Systems, AI logos, Cloud logos,
 * Charts and My library. Click or Enter arms a tile, a drag drops it on the
 * canvas, Esc closes. It owns no board state: main.ts turns picks into
 * placements.
 */
export class LibraryPopover {
  private readonly search: HTMLInputElement;
  private readonly body: HTMLDivElement;
  private readonly menu: HTMLDivElement;
  private items: LibraryItem[] = [];
  /** Tile button → what it places; rebuilt on every render. */
  private picks = new Map<Element, LibraryPick>();
  /** Saved-item thumbnails by id: a payload is parsed once, not per keystroke. */
  private thumbs = new Map<bigint, SVGSVGElement>();
  private menuFor: { item: LibraryItem; button: HTMLButtonElement } | null = null;
  private drag: { tile: HTMLElement; x: number; y: number; moved: boolean } | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly deps: LibraryPopoverDeps
  ) {
    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.className = 'lib-search';
    this.search.placeholder = 'Search objects, agents, logos, charts…';
    this.search.autocomplete = 'off';
    this.search.spellcheck = false;
    this.search.setAttribute('aria-label', 'Search the library');
    this.body = document.createElement('div');
    this.body.className = 'lib-body';
    this.menu = document.createElement('div');
    this.menu.className = 'lib-menu';
    this.menu.setAttribute('role', 'menu');
    this.menu.hidden = true;
    for (const [act, text] of [['rename', 'Rename'], ['delete', 'Delete']]) {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.setAttribute('role', 'menuitem');
      entry.dataset.act = act;
      entry.textContent = text;
      this.menu.append(entry);
    }
    host.replaceChildren(this.search, this.body);
    this.wire();
  }

  isOpen(): boolean {
    return !this.host.hidden;
  }

  open(): void {
    if (this.isOpen()) {
      return;
    }
    this.host.hidden = false;
    this.deps.anchor.setAttribute('aria-expanded', 'true');
    this.search.value = '';
    this.render();
    this.search.focus();
  }

  close(): void {
    if (!this.isOpen()) {
      return;
    }
    this.closeMenu(false);
    this.host.hidden = true;
    this.deps.anchor.setAttribute('aria-expanded', 'false');
  }

  toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  setItems(items: LibraryItem[]): void {
    // Newest first: ids are auto-increment.
    this.items = [...items].sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
    const live = new Set(this.items.map(i => i.id));
    for (const id of this.thumbs.keys()) {
      if (!live.has(id)) this.thumbs.delete(id);
    }
    if (this.isOpen()) {
      this.render();
    }
  }

  private wire(): void {
    this.deps.anchor.addEventListener('click', () => this.toggle());
    this.search.addEventListener('input', () => this.render());
    this.host.addEventListener('keydown', evt => this.onKey(evt));
    this.host.addEventListener('click', evt => {
      const target = evt.target as Element;
      const entry = this.menu.contains(target) ? target.closest<HTMLElement>('[data-act]') : null;
      if (entry !== null && this.menuFor !== null) {
        const { item } = this.menuFor;
        // Focus goes back to ⋯ before prompt()/confirm() runs: the hidden
        // menu item would drop it to <body>, where Esc and arrows are dead.
        this.closeMenu(true);
        if (entry.dataset.act === 'rename') this.deps.onRename(item);
        else this.deps.onDelete(item);
        return;
      }
      const more = target.closest<HTMLButtonElement>('.lib-more');
      if (more !== null) {
        if (this.menuFor?.button === more) this.closeMenu(true);
        else this.openMenu(more);
        return;
      }
      const tile = target.closest<HTMLElement>('.lib-tile');
      if (tile !== null) {
        this.choose(tile, false);
      }
    });
    this.host.addEventListener('contextmenu', evt => {
      const saved = (evt.target as Element).closest<HTMLElement>('.lib-saved');
      const more = saved?.querySelector<HTMLButtonElement>('.lib-more');
      if (more) {
        evt.preventDefault();
        this.openMenu(more);
      }
    });
    this.host.addEventListener('pointerdown', evt => {
      const target = evt.target as Element;
      if (this.menuFor !== null && !this.menu.contains(target) && target.closest('.lib-more') === null) {
        this.closeMenu(false);
      }
      const tile = target.closest<HTMLElement>('.lib-tile');
      if (tile !== null && evt.button === 0) {
        this.drag = { tile, x: evt.clientX, y: evt.clientY, moved: false };
      }
    });
    document.addEventListener('pointermove', evt => {
      const d = this.drag;
      if (d !== null && !d.moved && Math.hypot(evt.clientX - d.x, evt.clientY - d.y) > DRAG_SLOP) {
        d.moved = true;
        document.body.classList.add('lib-dragging');
      }
    });
    document.addEventListener('pointerup', evt => {
      const d = this.drag;
      this.drag = null;
      document.body.classList.remove('lib-dragging');
      if (d === null || !d.moved || !this.deps.dropTarget.contains(evt.target as Node)) {
        return;
      }
      const pick = this.picks.get(d.tile);
      if (pick === undefined) {
        return;
      }
      this.close();
      this.deps.onDrop(pick, evt.clientX, evt.clientY);
    });
    // Tiles are touch-action: pan-y, so a vertical swipe ends here, not in
    // pointerup: a drag left armed would drop on the next canvas tap.
    document.addEventListener('pointercancel', () => {
      this.drag = null;
      document.body.classList.remove('lib-dragging');
    });
    // Esc closes it even when focus is not on its search or tiles: a click
    // on blank popover space leaves focus on <body>, and the canvas would
    // otherwise take the key (clearing the selection, leaving this open).
    window.addEventListener('keydown', evt => {
      const target = evt.target as Node;
      const here = target === document.body || target === document.documentElement || this.deps.dropTarget.contains(target);
      if (evt.key !== 'Escape' || !this.isOpen() || !here) {
        return;
      }
      evt.preventDefault();
      evt.stopPropagation();
      this.close();
      if (target === document.body || target === document.documentElement) {
        this.deps.anchor.focus();
      }
    }, true);
    // Same rule as the top-bar popovers' dismissible(): pointer or keyboard
    // focus landing outside the popover and its button closes it.
    for (const type of ['pointerdown', 'focusin']) {
      document.addEventListener(type, evt => {
        const target = evt.target as Node;
        if (this.isOpen() && !this.host.contains(target) && !this.deps.anchor.contains(target)) {
          this.close();
        }
      });
    }
  }

  private onKey(evt: KeyboardEvent): void {
    const target = evt.target as HTMLElement;
    const inSearch = target === this.search;
    // ⌘Z, ⌘K and friends still work from a tile; the search swallows
    // everything but ⌘K, which opens the palette from anywhere.
    if ((!inSearch || evt.key.toLowerCase() === 'k') && (evt.metaKey || evt.ctrlKey)) {
      return;
    }
    // The main.ts window shortcuts (⇧T, ⌥⇧H, ⌘↵) have no typing guard.
    evt.stopPropagation();
    if (evt.key === 'Escape') {
      evt.preventDefault();
      if (this.menuFor !== null) {
        this.closeMenu(true);
        return;
      }
      this.close();
      this.deps.anchor.focus();
      return;
    }
    if (this.menuFor !== null && this.menu.contains(target)) {
      if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
        evt.preventDefault();
        const entries = [...this.menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const i = entries.indexOf(target as HTMLButtonElement);
        const step = evt.key === 'ArrowDown' ? 1 : entries.length - 1;
        entries[(i + step) % entries.length].focus();
      }
      return;
    }
    // Keys 1–5 still arm a kind directly, as on the canvas; in the search
    // they arm only before anything is typed (after that they are text).
    const digit = /^[1-5]$/.test(evt.key) && !evt.altKey && !evt.ctrlKey && !evt.metaKey ? OBJECTS[Number(evt.key) - 1] : undefined;
    if (digit !== undefined && (!inSearch || this.search.value === '')) {
      evt.preventDefault();
      this.close();
      this.deps.anchor.focus();
      this.deps.onPick({ kind: 'node', nodeKind: digit.kind });
      return;
    }
    if (evt.key === 'Enter') {
      const tile = inSearch ? this.bestMatch() : target.closest<HTMLElement>('.lib-tile');
      if (tile) {
        evt.preventDefault();
        this.choose(tile, true);
      }
      return;
    }
    if (evt.key.startsWith('Arrow')) {
      if (inSearch) {
        if (evt.key === 'ArrowDown') {
          evt.preventDefault();
          this.tiles()[0]?.focus();
        }
        return;
      }
      // A saved tile's ⋯ moves as its tile does.
      const tile = target.closest<HTMLElement>('.lib-tile') ?? target.closest('.lib-saved')?.querySelector<HTMLElement>('.lib-tile') ?? null;
      if (tile !== null) {
        evt.preventDefault();
        this.move(tile, evt.key);
      }
      return;
    }
    // evt.key, not evt.code: on Dvorak or Colemak the key that types l is not KeyL.
    if (!inSearch && evt.key === 'l' && !evt.altKey) {
      evt.preventDefault();
      this.close();
      this.deps.anchor.focus();
    }
  }

  private tiles(): HTMLElement[] {
    return [...this.body.querySelectorAll<HTMLElement>('.lib-tile')];
  }

  /** Enter in the search: the tile named exactly what was typed, else the first
   *  whose name starts with it, else the first match. "claude" places the Claude
   *  logo, not the generic Model icon that lists claude among its search terms. */
  private bestMatch(): HTMLElement | undefined {
    const tiles = this.tiles();
    const q = this.search.value.trim().toLowerCase();
    const name = (t: HTMLElement) => (t.title || '').toLowerCase();
    return tiles.find(t => name(t) === q) ?? tiles.find(t => q !== '' && name(t).startsWith(q)) ?? tiles[0];
  }

  private choose(tile: HTMLElement, keyboard: boolean): void {
    const pick = this.picks.get(tile);
    if (pick === undefined) {
      return;
    }
    this.close();
    if (keyboard) {
      this.deps.anchor.focus();
    }
    this.deps.onPick(pick);
  }

  /** Grid navigation: Left/Right in reading order across sections, Up/Down
   *  by column, crossing into the next section at the nearest column. */
  private move(tile: HTMLElement, key: string): void {
    const grids = [...this.body.querySelectorAll<HTMLElement>('.lib-grid')].map(g => ({
      cols: Number(g.dataset.cols),
      tiles: [...g.querySelectorAll<HTMLElement>('.lib-tile')],
    }));
    const flat = grids.flatMap(g => g.tiles);
    const gi = grids.findIndex(g => g.tiles.includes(tile));
    if (gi < 0) {
      return;
    }
    const { cols, tiles } = grids[gi];
    const i = tiles.indexOf(tile);
    const col = i % cols;
    let next: HTMLElement | undefined;
    if (key === 'ArrowRight') {
      next = flat[flat.indexOf(tile) + 1];
    } else if (key === 'ArrowLeft') {
      next = flat[flat.indexOf(tile) - 1];
    } else if (key === 'ArrowDown') {
      const lastRow = Math.floor((tiles.length - 1) / cols);
      if (Math.floor(i / cols) < lastRow) {
        next = tiles[Math.min(i + cols, tiles.length - 1)];
      } else if (gi + 1 < grids.length) {
        const below = grids[gi + 1].tiles;
        next = below[Math.min(col, below.length - 1)];
      }
    } else if (key === 'ArrowUp') {
      if (i >= cols) {
        next = tiles[i - cols];
      } else if (gi > 0) {
        const above = grids[gi - 1];
        const start = Math.floor((above.tiles.length - 1) / above.cols) * above.cols;
        next = above.tiles[Math.min(start + col, above.tiles.length - 1)];
      } else {
        this.search.focus();
        return;
      }
    }
    next?.focus();
  }

  private render(): void {
    // A focused tile or ⋯ is about to be replaced: focus would drop to <body>.
    const hadFocus = this.body.contains(document.activeElement);
    this.closeMenu(false);
    this.picks.clear();
    const query = this.search.value.trim();
    const q = query.toLowerCase();
    const hit = (name: string) => name.toLowerCase().includes(q);
    const sections: HTMLElement[] = [];
    // The ids match too: the card tag, the rail and the MCP tools say 'timeseries'.
    const objects = OBJECTS.filter(o => hit(o.name) || hit(o.kind));
    if (objects.length > 0) {
      sections.push(
        this.section('Objects', 5, objects.map(o => this.tile({ kind: 'node', nodeKind: o.kind }, o.name, objectIcon(o.kind))))
      );
    }
    // Icons and logos (spec 2026-10-18): the name, the id, a search term or the section title.
    // A logo whose artwork is still loading holds a same-size placeholder,
    // filled in place when it lands (fillLogos): no rebuild, so a drag in
    // progress, keyboard focus and the tile layout all survive it.
    if (!logosReady()) void loadLogos().then(() => this.fillLogos());
    const icons = drawableIcons();
    for (const { id, title } of ICON_SECTIONS) {
      const found = icons.filter(i => i.section === id && (hit(i.name) || hit(i.id) || hit(title) || i.terms.some(hit)));
      if (found.length > 0) {
        sections.push(this.section(title, 4, found.map(i => this.tile({ kind: 'icon', icon: i.id }, i.name, iconSvg(i.id, 20) ?? pendingIcon()))));
      }
    }
    const charts = CHART_TYPES.filter(t => hit(CHART_CONTRACTS[t].title) || hit(t) || hit('chart'));
    if (charts.length > 0) {
      sections.push(
        this.section('Charts', 4, charts.map(t => this.tile({ kind: 'chart', type: t }, CHART_CONTRACTS[t].title, chartIcon(t))))
      );
    }
    const saved = this.items.filter(i => hit(i.name));
    if (saved.length > 0) {
      sections.push(this.section('My library', 3, saved.map(i => this.savedTile(i))));
    } else if (q === '') {
      const mine = this.section('My library', 3, []);
      mine.append(emptyLine(EMPTY_LIBRARY));
      sections.push(mine);
    }
    if (sections.length === 0) {
      sections.push(emptyLine(`Nothing matches "${query}"`));
    }
    this.body.replaceChildren(...sections);
    if (hadFocus) {
      this.search.focus();
    }
  }

  /** Swap each logo placeholder for its artwork, in place. */
  private fillLogos(): void {
    for (const [tile, pick] of this.picks) {
      const pending = pick.kind === 'icon' ? tile.querySelector('.lib-node-icon-pending') : null;
      const art = pending && pick.kind === 'icon' ? iconSvg(pick.icon, 20) : null;
      if (pending && art) pending.replaceWith(art);
    }
  }

  private section(title: string, cols: number, tiles: HTMLElement[]): HTMLElement {
    const section = document.createElement('section');
    section.className = 'lib-section';
    section.setAttribute('aria-label', title);
    const eyebrow = document.createElement('div');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = title;
    section.append(eyebrow);
    if (tiles.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'lib-grid';
      grid.dataset.cols = String(cols);
      grid.append(...tiles);
      section.append(grid);
    }
    return section;
  }

  private tile(pick: LibraryPick, name: string, icon: Element | null): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lib-tile';
    button.title = name;
    if (icon !== null) {
      button.append(icon);
    }
    const label = document.createElement('span');
    label.className = 'lib-name';
    label.textContent = name;
    button.append(label);
    this.picks.set(button, pick);
    return button;
  }

  private savedTile(item: LibraryItem): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'lib-saved';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'lib-more';
    more.setAttribute('aria-label', `Actions for ${item.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.append(dotsIcon());
    wrap.append(this.tile({ kind: 'saved', item }, item.name, this.thumb(item)), more);
    return wrap;
  }

  /** One rect per saved node, scaled into 44 × 26. Only the node rects are
   *  read (no validation, no parseChart): an unreadable payload draws an
   *  empty frame, and inserting it reports the reason. */
  private thumb(item: LibraryItem): SVGSVGElement {
    const cached = this.thumbs.get(item.id);
    if (cached !== undefined) {
      return cached;
    }
    const svg = svgEl('svg', { class: 'lib-thumb', width: '44', height: '26', viewBox: '0 0 44 26', 'aria-hidden': 'true' });
    const nodes = thumbRects(item.payload);
    if (nodes.length > 0) {
      const w = Math.max(1, ...nodes.map(n => n.x + n.w));
      const h = Math.max(1, ...nodes.map(n => n.y + n.h));
      const s = Math.min(40 / w, 22 / h);
      const ox = (44 - w * s) / 2;
      const oy = (26 - h * s) / 2;
      for (const n of nodes) {
        svg.append(svgEl('rect', {
          class: 'lib-thumb-node',
          x: (ox + n.x * s).toFixed(1),
          y: (oy + n.y * s).toFixed(1),
          width: Math.max(1, n.w * s).toFixed(1),
          height: Math.max(1, n.h * s).toFixed(1),
          rx: '1',
        }));
      }
    }
    this.thumbs.set(item.id, svg);
    return svg;
  }

  private openMenu(more: HTMLButtonElement): void {
    const tile = more.parentElement?.querySelector('.lib-tile');
    const pick = tile ? this.picks.get(tile) : undefined;
    if (pick?.kind !== 'saved') {
      return;
    }
    this.closeMenu(false);
    this.menuFor = { item: pick.item, button: more };
    more.setAttribute('aria-expanded', 'true');
    more.parentElement!.append(this.menu);
    this.menu.hidden = false;
    this.menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }

  private closeMenu(focusButton: boolean): void {
    const open = this.menuFor;
    if (open === null) {
      return;
    }
    this.menuFor = null;
    this.menu.hidden = true;
    open.button.setAttribute('aria-expanded', 'false');
    if (focusButton) {
      open.button.focus();
    }
  }
}
