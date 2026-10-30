import html from '../index.html?raw';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { LibraryItem } from './module_bindings/types';
import { CHART_CONTRACTS, CHART_TYPES } from '../../module/src/chart-contracts';
import { ICONS, ICON_SECTIONS } from '../../module/src/node-icons';
import { LibraryPopover, EMPTY_LIBRARY, type LibraryPick } from './library-popover';
import { loadLogos } from './node-icons';

const PAYLOAD = JSON.stringify({
  version: 1,
  nodes: [
    { key: 0, label: 'api', sublabel: '', x: 0, y: 0, w: 160, h: 80, token: 'ink', kind: 'service', doc: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm' },
    { key: 1, label: 'db', sublabel: '', x: 240, y: 0, w: 160, h: 80, token: 'ink', kind: 'datastore', doc: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm' },
  ],
  edges: [{ from: 0, to: 1, label: '', color: '', strokeStyle: 'solid' }],
});

const item = (id: number, name: string, payload = PAYLOAD): LibraryItem =>
  ({ id: BigInt(id), owner: {}, orgId: '', name, payload, createdAt: {} }) as unknown as LibraryItem;

function setup(items: LibraryItem[] = []) {
  document.body.innerHTML = html;
  const anchor = document.getElementById('tool-library') as HTMLButtonElement;
  const host = document.getElementById('library-popover') as HTMLElement;
  const svg = document.getElementById('board') as Element;
  const deps = {
    anchor,
    dropTarget: svg,
    onPick: vi.fn<(pick: LibraryPick) => void>(),
    onDrop: vi.fn<(pick: LibraryPick, clientX: number, clientY: number) => void>(),
    onRename: vi.fn<(item: LibraryItem) => void>(),
    onDelete: vi.fn<(item: LibraryItem) => void>(),
  };
  const pop = new LibraryPopover(host, deps);
  pop.setItems(items);
  const search = host.querySelector('.lib-search') as HTMLInputElement;
  return { pop, host, anchor, svg, deps, search };
}

const names = (host: HTMLElement, section: string) =>
  [...host.querySelectorAll(`.lib-section[aria-label="${section}"] .lib-name`)].map(e => e.textContent);
const tileNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLElement>('.lib-tile')].find(t => t.title === name)!;
const key = (target: EventTarget, init: KeyboardEventInit) => {
  const evt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(evt);
  return evt;
};
const pointer = (target: EventTarget, type: string, x: number, y: number) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
const type = (search: HTMLInputElement, text: string) => {
  search.value = text;
  search.dispatchEvent(new Event('input'));
};
const chartTitles = CHART_TYPES.map(t => CHART_CONTRACTS[t].title);
const iconNames = (section: string) => ICONS.filter(i => i.section === section).map(i => i.name);
const SECTIONS = ['Objects', ...ICON_SECTIONS.map(s => s.title), 'Charts', 'My library'];

describe('LibraryPopover', () => {
  beforeAll(() => loadLogos());
  it('renders Objects, Agents, Systems, AI logos, Cloud logos, Charts and My library in that order, with five objects and eleven charts', () => {
    const { pop, host } = setup([item(1, 'API gateway')]);
    pop.open();
    expect([...host.querySelectorAll('.lib-section')].map(s => s.getAttribute('aria-label'))).toEqual(SECTIONS);
    expect([...host.querySelectorAll('.lib-section .eyebrow')].map(e => e.textContent)).toEqual(SECTIONS);
    expect(names(host, 'Objects')).toEqual(['Service', 'Datastore', 'External', 'Boundary', 'Note']);
    expect(names(host, 'Agents')).toEqual(iconNames('agents'));
    expect(names(host, 'Systems')).toEqual(iconNames('systems'));
    expect(names(host, 'AI logos')).toEqual(iconNames('ai'));
    expect(names(host, 'Cloud logos')).toEqual(iconNames('cloud'));
    expect(names(host, 'Charts')).toEqual(chartTitles);
    expect(names(host, 'My library')).toEqual(['API gateway']);
    expect(host.querySelectorAll('.lib-section[aria-label="Charts"] svg.lib-icon')).toHaveLength(11);
    expect(host.querySelectorAll('.lib-section[aria-label="Objects"] .lib-tile svg')).toHaveLength(5);
    // every icon and logo tile has its drawing, hidden from assistive tech: the tile's text names it
    for (const s of ICON_SECTIONS) {
      const tiles = host.querySelectorAll(`.lib-section[aria-label="${s.title}"] .lib-tile`);
      expect(tiles.length).toBeGreaterThan(0);
      for (const t of tiles) expect(t.querySelector('svg.lib-node-icon')?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(host.querySelectorAll('.lib-grid[data-cols="4"]').length).toBeGreaterThanOrEqual(5);
    // series colour comes from classes only, never inline hex (logos keep their vendors' own colours)
    expect(host.querySelector('.lib-section[aria-label="Charts"]')!.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('the dock button toggles it and tracks aria-expanded; opening focuses the search', () => {
    const { pop, anchor, search } = setup();
    expect(pop.isOpen()).toBe(false);
    anchor.click();
    expect(pop.isOpen()).toBe(true);
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(search);
    anchor.click();
    expect(pop.isOpen()).toBe(false);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the save hint when the library is empty', () => {
    const { pop, host } = setup();
    pop.open();
    expect(names(host, 'My library')).toEqual([]);
    expect(host.querySelector('.lib-section[aria-label="My library"] .lib-empty')?.textContent).toBe(EMPTY_LIBRARY);
    expect(EMPTY_LIBRARY).toBe('No saved items yet — select nodes and press ⇧L');
  });

  it('search filters all three sections by name, ignoring case, and says when nothing matches', () => {
    const { pop, host, search } = setup([item(1, 'API gateway'), item(2, 'SLO panel')]);
    pop.open();
    type(search, 'slo');
    expect(names(host, 'Objects')).toEqual([]);
    expect(names(host, 'Charts')).toEqual(chartTitles.filter(t => t.toLowerCase().includes('slo')));
    expect(names(host, 'My library')).toEqual(['SLO panel']);
    type(search, 'SERV');
    expect(names(host, 'Objects')).toEqual(['Service']);
    expect(names(host, 'Charts')).toEqual(chartTitles.filter(t => t.toLowerCase().includes('serv')));
    expect(host.querySelector('.lib-section[aria-label="My library"]')).toBeNull();
    type(search, CHART_CONTRACTS.table.title.toUpperCase());
    expect(names(host, 'Charts')).toContain(CHART_CONTRACTS.table.title);
    type(search, 'zzz');
    expect(host.querySelectorAll('.lib-section')).toHaveLength(0);
    expect(host.querySelector('.lib-empty')?.textContent).toBe('Nothing matches "zzz"');
  });

  it('search also matches the type and kind ids, and "chart" for chart tiles', () => {
    const { pop, host, search } = setup();
    pop.open();
    type(search, 'timeseries');
    expect(names(host, 'Charts')).toEqual([CHART_CONTRACTS.timeseries.title]);
    type(search, 'TOPLIST');
    expect(names(host, 'Charts')).toEqual([CHART_CONTRACTS.toplist.title]);
    type(search, 'chart');
    expect(names(host, 'Charts')).toEqual(chartTitles);
    expect(names(host, 'Objects')).toEqual([]);
    type(search, 'datastore');
    expect(names(host, 'Objects')).toEqual(['Datastore']);
  });

  it('icons and logos match their name, id, search terms and section title', () => {
    const { pop, host, search } = setup();
    pop.open();
    type(search, 'rag');
    expect(names(host, 'Agents')).toEqual(['Knowledge base']);
    type(search, 'COGNITION');
    expect(names(host, 'AI logos')).toEqual(['Windsurf', 'Devin']);
    type(search, 'anthropic');
    expect(names(host, 'AI logos')).toEqual(['Claude', 'Claude Code']);
    type(search, 'k8s');
    expect(names(host, 'Cloud logos')).toEqual(['Kubernetes']);
    expect(names(host, 'Objects')).toEqual([]);
    type(search, 'mcp-server');
    expect(names(host, 'Agents')).toEqual(['MCP server']);
    type(search, 'logo');
    expect(names(host, 'AI logos')).toEqual(iconNames('ai'));
    expect(names(host, 'Cloud logos')).toEqual(iconNames('cloud'));
    expect(names(host, 'Agents')).toEqual([]);
    type(search, 'systems');
    expect(names(host, 'Systems')).toEqual(iconNames('systems'));
  });

  it('an icon tile arms an icon pick by click, by Enter from the search, and names itself by its text', () => {
    const { pop, host, deps, search } = setup();
    pop.open();
    const tile = tileNamed(host, 'Orchestrator');
    expect(tile.textContent).toBe('Orchestrator');
    tile.click();
    expect(deps.onPick).toHaveBeenLastCalledWith({ kind: 'icon', icon: 'orchestrator' });
    expect(pop.isOpen()).toBe(false);
    pop.open();
    type(search, 'hermes');
    key(search, { key: 'Enter' });
    expect(deps.onPick).toHaveBeenLastCalledWith({ kind: 'icon', icon: 'hermes-agent' });
  });

  it('Enter from the search prefers the tile named what was typed over an earlier tile that only matches a term', () => {
    const { pop, deps, search, host } = setup();
    for (const [query, pick] of [
      ['claude', { kind: 'icon', icon: 'claude' }],
      ['Claude Code', { kind: 'icon', icon: 'claude-code' }],
      ['kube', { kind: 'icon', icon: 'kubernetes' }],
      ['openai', { kind: 'icon', icon: 'openai' }],
      ['rag', { kind: 'icon', icon: 'knowledge-base' }],
    ] as const) {
      pop.open();
      type(search, query);
      key(search, { key: 'Enter' });
      expect(deps.onPick, query).toHaveBeenLastCalledWith(pick);
    }
    // the generic Model icon still lists for "claude"
    pop.open();
    type(search, 'claude');
    expect(names(host, 'Agents')).toContain('Model');
  });

  it('a click arms the tile and closes the popover', () => {
    const { pop, host, deps } = setup();
    pop.open();
    tileNamed(host, CHART_CONTRACTS.bars.title).click();
    expect(deps.onPick).toHaveBeenCalledWith({ kind: 'chart', type: 'bars' });
    expect(pop.isOpen()).toBe(false);
  });

  it('Enter arms the focused tile, or the first match from the search, and returns focus to the dock button', () => {
    const { pop, host, anchor, deps, search } = setup();
    pop.open();
    const datastore = tileNamed(host, 'Datastore');
    datastore.focus();
    const evt = key(datastore, { key: 'Enter' });
    expect(evt.defaultPrevented).toBe(true);
    expect(deps.onPick).toHaveBeenLastCalledWith({ kind: 'node', nodeKind: 'datastore' });
    expect(pop.isOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);
    pop.open();
    type(search, CHART_CONTRACTS.waterfall.title);
    key(search, { key: 'Enter' });
    expect(deps.onPick).toHaveBeenLastCalledWith({ kind: 'chart', type: 'waterfall' });
  });

  it('arrow keys move across the tile grid and back to the search', () => {
    const { pop, host, search } = setup([item(1, 'A'), item(2, 'B')]);
    pop.open();
    const chart = (i: number) => tileNamed(host, chartTitles[i]);
    const press = (from: HTMLElement, k: string) => {
      from.focus();
      key(from, { key: k });
      return document.activeElement;
    };
    expect(press(search, 'ArrowDown')).toBe(tileNamed(host, 'Service'));
    expect(press(tileNamed(host, 'Service'), 'ArrowRight')).toBe(tileNamed(host, 'Datastore'));
    expect(press(tileNamed(host, 'Datastore'), 'ArrowLeft')).toBe(tileNamed(host, 'Service'));
    // Objects → Agents: reading order across sections, then by column
    const agents = iconNames('agents');
    expect(press(tileNamed(host, 'Note'), 'ArrowRight')).toBe(tileNamed(host, agents[0]));
    expect(press(tileNamed(host, agents[0]), 'ArrowLeft')).toBe(tileNamed(host, 'Note'));
    expect(press(tileNamed(host, 'Datastore'), 'ArrowDown')).toBe(tileNamed(host, agents[1]));
    expect(press(tileNamed(host, agents[1]), 'ArrowUp')).toBe(tileNamed(host, 'Datastore'));
    expect(press(tileNamed(host, agents[1]), 'ArrowDown')).toBe(tileNamed(host, agents[5]));
    // the last logo section → Charts, and back up to its last row, same column
    const cloud = iconNames('cloud');
    expect(press(chart(0), 'ArrowLeft')).toBe(tileNamed(host, cloud[cloud.length - 1]));
    // the column is clamped to the last tile of a short row
    expect(press(chart(3), 'ArrowUp')).toBe(tileNamed(host, cloud[Math.min(Math.floor((cloud.length - 1) / 4) * 4 + 3, cloud.length - 1)]));
    expect(press(chart(1), 'ArrowDown')).toBe(chart(5));
    expect(press(chart(5), 'ArrowDown')).toBe(chart(9));
    // last chart row → My library (newest first: B, A), same column clamped
    expect(press(chart(9), 'ArrowDown')).toBe(tileNamed(host, 'A'));
    expect(press(chart(10), 'ArrowDown')).toBe(tileNamed(host, 'A'));
    expect(press(tileNamed(host, 'Service'), 'ArrowUp')).toBe(search);
  });

  it('Escape closes it, returns focus to the dock button, and the canvas never sees the key', () => {
    const { pop, anchor, search } = setup();
    pop.open();
    const later = vi.fn();
    window.addEventListener('keydown', later);
    try {
      key(search, { key: 'Escape' });
    } finally {
      window.removeEventListener('keydown', later);
    }
    expect(pop.isOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(later).not.toHaveBeenCalled();
  });

  it('keeps typing in the search away from canvas shortcuts, but lets ⌘ shortcuts on tiles through', () => {
    const { pop, host, search } = setup();
    pop.open();
    const later = vi.fn();
    window.addEventListener('keydown', later);
    try {
      key(search, { key: 'T', code: 'KeyT', shiftKey: true });
      key(search, { key: 'Ó', code: 'KeyH', altKey: true, shiftKey: true });
      expect(later).not.toHaveBeenCalled();
      expect(pop.isOpen()).toBe(true);
      const tile = tileNamed(host, 'Service');
      tile.focus();
      key(tile, { key: 'z', metaKey: true });
      expect(later).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', later);
    }
  });

  it('L on a tile closes it; l typed in the search does not', () => {
    const { pop, host, anchor, search } = setup();
    pop.open();
    const tile = tileNamed(host, 'Note');
    tile.focus();
    key(tile, { key: 'l', code: 'KeyP' }); // Dvorak: the key that types l
    expect(pop.isOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);
    pop.open();
    key(search, { key: 'l', code: 'KeyL' });
    expect(pop.isOpen()).toBe(true);
    tileNamed(host, 'Note').focus();
    key(tileNamed(host, 'Note'), { key: 'n', code: 'KeyL' }); // Dvorak n sits on the L key
    expect(pop.isOpen()).toBe(true);
  });

  it('keys 1–5 arm that kind and close it, from a tile or an empty search; typed after text they are text', () => {
    const { pop, host, anchor, deps, search } = setup();
    pop.open();
    tileNamed(host, 'Note').focus();
    expect(key(tileNamed(host, 'Note'), { key: '2' }).defaultPrevented).toBe(true);
    expect(deps.onPick).toHaveBeenLastCalledWith({ kind: 'node', nodeKind: 'datastore' });
    expect(pop.isOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);
    pop.open();
    key(search, { key: '5' });
    expect(deps.onPick).toHaveBeenLastCalledWith({ kind: 'node', nodeKind: 'note' });
    expect(pop.isOpen()).toBe(false);
    pop.open();
    type(search, 'q');
    expect(key(search, { key: '3' }).defaultPrevented).toBe(false);
    expect(pop.isOpen()).toBe(true);
    expect(deps.onPick).toHaveBeenCalledTimes(2);
  });

  it('Ctrl/⌘/Alt + a digit in the empty search is not a kind shortcut: nothing armed, popover open, no preventDefault', () => {
    const { pop, deps, search } = setup();
    pop.open();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(key(search, { key: '1', ...mod }).defaultPrevented).toBe(false);
    }
    expect(deps.onPick).not.toHaveBeenCalled();
    expect(pop.isOpen()).toBe(true);
  });

  it('lets ⌘K out of the search so the palette opens from it', () => {
    const { pop, search } = setup();
    const later = vi.fn();
    window.addEventListener('keydown', later);
    try {
      pop.open();
      key(search, { key: 'k', metaKey: true });
      key(search, { key: 'z', metaKey: true });
      expect(later).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', later);
    }
  });

  it('Esc closes it with focus anywhere inside it or on the canvas, before the canvas sees the key', () => {
    const { pop, host, svg, anchor } = setup();
    const later = vi.fn();
    window.addEventListener('keydown', later);
    try {
      pop.open();
      (document.activeElement as HTMLElement).blur(); // a click on blank popover space leaves focus on <body>
      key(document.body, { key: 'Escape' });
      expect(pop.isOpen()).toBe(false);
      expect(document.activeElement).toBe(anchor);
      pop.open();
      key(svg, { key: 'Escape' });
      expect(pop.isOpen()).toBe(false);
      pop.open();
      key(host.querySelector('.lib-section')!, { key: 'Escape' });
      expect(pop.isOpen()).toBe(false);
      expect(later).not.toHaveBeenCalled();
      // closed: Esc is the canvas's again
      key(document.body, { key: 'Escape' });
      expect(later).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', later);
    }
  });

  it('style.css: tiles let touch scroll the popover vertically', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, encoding: 'utf8'): string };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const start = css.indexOf('\n.lib-tile {');
    expect(start).toBeGreaterThan(0);
    const rule = css.slice(start, css.indexOf('}', start));
    expect(rule).not.toMatch(/touch-action:\s*none/);
    expect(rule).toMatch(/touch-action:\s*pan-y/);
  });

  it('lists saved items newest first, each with a thumbnail rect per node', () => {
    const { pop, host } = setup([item(1, 'Old')]);
    pop.open();
    // a thumbnail reads node rects only: a chart the contract now rejects still draws
    const stale = JSON.parse(PAYLOAD);
    stale.nodes[1] = { ...stale.nodes[1], kind: 'chart', chart: { type: 'pie', csv: 'x,y\na,12ms\n', options: '{}', source: 'sample' } };
    pop.setItems([item(1, 'Old'), item(5, 'New'), item(3, 'Broken', '{"version":2}'), item(4, 'Stale', JSON.stringify(stale))]);
    expect(names(host, 'My library')).toEqual(['New', 'Stale', 'Broken', 'Old']);
    const thumbs = [...host.querySelectorAll('.lib-saved')].map(s => s.querySelectorAll('.lib-thumb rect').length);
    expect(thumbs).toEqual([2, 2, 0, 2]);
  });

  it('the ⋯ button opens Rename and Delete; each calls back with the item', () => {
    const saved = item(1, 'API gateway');
    const { pop, host, deps } = setup([saved]);
    pop.open();
    const more = host.querySelector<HTMLButtonElement>('.lib-more')!;
    expect(more.getAttribute('aria-label')).toBe('Actions for API gateway');
    more.click();
    const menu = host.querySelector<HTMLElement>('.lib-menu')!;
    expect(menu.hidden).toBe(false);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const entries = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(entries.map(b => b.textContent)).toEqual(['Rename', 'Delete']);
    expect(document.activeElement).toBe(entries[0]);
    key(entries[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(entries[1]);
    key(entries[1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(entries[0]);
    entries[0].click();
    expect(deps.onRename).toHaveBeenCalledWith(saved);
    expect(menu.hidden).toBe(true);
    more.click();
    menu.querySelector<HTMLButtonElement>('[data-act="delete"]')!.click();
    expect(deps.onDelete).toHaveBeenCalledWith(saved);
    expect(pop.isOpen()).toBe(true);
  });

  it('after Rename or Delete focus stays in the popover, so Esc and the arrows still work', () => {
    const saved = item(1, 'API gateway');
    const { pop, host, deps, search } = setup([saved, item(2, 'Other')]);
    let focusedInCallback: Element | null = null;
    deps.onRename.mockImplementation(() => { focusedInCallback = document.activeElement; });
    deps.onDelete.mockImplementation(it => pop.setItems([item(2, 'Other')].filter(i => i.id !== it.id)));
    pop.open();
    const moreOf = (name: string) => host.querySelector<HTMLButtonElement>(`.lib-more[aria-label="Actions for ${name}"]`)!;
    const pickFromMenu = (name: string, act: string) => {
      moreOf(name).focus();
      key(moreOf(name), { key: 'Enter' });
      moreOf(name).click(); // Enter on a button clicks it
      host.querySelector<HTMLButtonElement>(`.lib-menu [data-act="${act}"]`)!.click();
    };
    pickFromMenu('API gateway', 'rename');
    expect(focusedInCallback).toBe(moreOf('API gateway')); // focus moved before the prompt
    expect(document.activeElement).toBe(moreOf('API gateway'));
    // arrows from ⋯ move as from its tile (a cancelled rename leaves focus here)
    key(moreOf('API gateway'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tileNamed(host, 'Other'));
    moreOf('API gateway').focus();
    pickFromMenu('API gateway', 'delete');
    expect(names(host, 'My library')).toEqual(['Other']);
    expect(document.activeElement).toBe(search); // its tile is gone
    key(search, { key: 'Escape' });
    expect(pop.isOpen()).toBe(false);
  });

  it('a right-click on a saved tile opens the same menu; Escape closes only the menu', () => {
    const { pop, host } = setup([item(1, 'API gateway')]);
    pop.open();
    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    tileNamed(host, 'API gateway').dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    const menu = host.querySelector<HTMLElement>('.lib-menu')!;
    expect(menu.hidden).toBe(false);
    key(document.activeElement!, { key: 'Escape' });
    expect(menu.hidden).toBe(true);
    expect(pop.isOpen()).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('.lib-more'));
  });

  it('dragging a tile onto the canvas drops it at the pointer; a click-sized move does not', () => {
    const { pop, host, svg, deps } = setup();
    pop.open();
    pointer(tileNamed(host, 'Datastore'), 'pointerdown', 10, 10);
    pointer(svg, 'pointermove', 12, 11);
    pointer(svg, 'pointerup', 12, 11);
    expect(deps.onDrop).not.toHaveBeenCalled();
    expect(pop.isOpen()).toBe(true);
    pointer(tileNamed(host, CHART_CONTRACTS.pie.title), 'pointerdown', 10, 10);
    pointer(svg, 'pointermove', 300, 200);
    expect(document.body.classList.contains('lib-dragging')).toBe(true);
    pointer(svg, 'pointerup', 300, 200);
    expect(deps.onDrop).toHaveBeenCalledWith({ kind: 'chart', type: 'pie' }, 300, 200);
    expect(deps.onPick).not.toHaveBeenCalled();
    expect(pop.isOpen()).toBe(false);
    expect(document.body.classList.contains('lib-dragging')).toBe(false);
  });

  // Tiles are touch-action: pan-y, so a vertical swipe ends in pointercancel,
  // not pointerup: the next tap on the canvas must not drop the swiped tile.
  it('a swipe the browser cancels (touch scroll) drops nothing on the next canvas tap', () => {
    const { pop, host, svg, deps } = setup();
    pop.open();
    const tile = tileNamed(host, CHART_CONTRACTS.pie.title);
    pointer(tile, 'pointerdown', 10, 10);
    pointer(tile, 'pointermove', 10, 30);
    pointer(tile, 'pointercancel', 10, 30);
    expect(document.body.classList.contains('lib-dragging')).toBe(false);
    pointer(svg, 'pointerdown', 300, 200);
    pointer(svg, 'pointerup', 300, 200);
    expect(deps.onDrop).not.toHaveBeenCalled();
  });

  it('a pointerdown outside closes it; one inside does not', () => {
    const { pop, host } = setup();
    pop.open();
    tileNamed(host, 'Service').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(pop.isOpen()).toBe(true);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(pop.isOpen()).toBe(false);
  });

  // Review Focus 4: a module that predates the library has no my_library view,
  // so main.ts never receives a row and setItems is never called with any.
  it('with no my_library view (old module) it still shows every section and an empty My library', () => {
    document.body.innerHTML = html;
    const host = document.getElementById('library-popover') as HTMLElement;
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    try {
      const pop = new LibraryPopover(host, {
        anchor: document.getElementById('tool-library') as HTMLElement,
        dropTarget: document.getElementById('board') as Element,
        onPick: vi.fn(),
        onDrop: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
      });
      pop.open();
      expect([...host.querySelectorAll('.lib-section')].map(s => s.getAttribute('aria-label'))).toEqual(SECTIONS);
      expect(names(host, 'Objects')).toHaveLength(5);
      expect(names(host, 'Charts')).toEqual(chartTitles);
      expect(names(host, 'My library')).toEqual([]);
      expect(host.querySelector('.lib-section[aria-label="My library"] .lib-empty')?.textContent).toBe(EMPTY_LIBRARY);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
