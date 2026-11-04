import html from '../index.html?raw';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { LibraryItem } from './module_bindings/types';
import { CHART_CONTRACTS, CHART_TYPES } from '../../module/src/chart-contracts';
import { ICONS, ICON_SECTIONS } from '../../module/src/node-icons';
import { LibraryPopover, EMPTY_LIBRARY, type LibraryPick } from './library-popover';
import { rankEntries } from './library-rank';
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

function setup(items: LibraryItem[] = [], icons: string[] = []) {
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
    boardIcons: () => icons,
  };
  const pop = new LibraryPopover(host, deps);
  pop.setItems(items);
  const search = host.querySelector('.lib-search') as HTMLInputElement;
  return { pop, host, anchor, svg, deps, search };
}

const names = (host: HTMLElement, section: string) =>
  [...host.querySelectorAll(`.lib-section[aria-label="${section}"] .lib-name`)].map(e => e.textContent);
/** The flat search list: row names in rank order. */
const results = (host: HTMLElement) => [...host.querySelectorAll('.lib-row .lib-name')].map(e => e.textContent);
/** Names of the rows whose group label is `group`, in rank order. */
const inGroup = (host: HTMLElement, group: string) =>
  [...host.querySelectorAll<HTMLElement>('.lib-row')].filter(r => r.querySelector('.lib-group')!.textContent === group).map(r => r.querySelector('.lib-name')!.textContent);
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
const PLAIN = ICON_SECTIONS.filter(s => !s.pack);
const SECTIONS = ['Objects', 'Icon packs', ...PLAIN.map(s => s.title), 'Charts', 'My library'];
const pack = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-pack="${id}"]`)!;

describe('LibraryPopover', () => {
  beforeAll(() => loadLogos());
  it('renders Objects, Icon packs, Agents, Systems, AI logos, Cloud logos, Charts and My library in that order, with five objects and eleven charts', () => {
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
    for (const s of PLAIN) {
      const tiles = host.querySelectorAll(`.lib-section[aria-label="${s.title}"] .lib-tile`);
      expect(tiles.length).toBeGreaterThan(0);
      for (const t of tiles) expect(t.querySelector('svg.lib-node-icon')?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(host.querySelectorAll('.lib-grid[data-cols="4"]').length).toBeGreaterThanOrEqual(5);
    // series colour comes from classes only, never inline hex (logos keep their vendors' own colours)
    expect(host.querySelector('.lib-section[aria-label="Charts"]')!.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('every pack, opened and shown in full, holds its whole section with each tile drawn and hidden from assistive tech', () => {
    const { pop, host } = setup();
    pop.open();
    for (const s of ICON_SECTIONS.filter(s => s.pack)) {
      pack(host, s.id).querySelector<HTMLButtonElement>('.lib-pack-row')!.click();
      pack(host, s.id).querySelector<HTMLButtonElement>('.lib-pack-more')?.click();
      const tiles = [...pack(host, s.id).querySelectorAll<HTMLElement>('.lib-tile')];
      expect(tiles.map(t => t.title).sort()).toEqual(iconNames(s.id).sort());
      for (const t of tiles) expect(t.querySelector('svg.lib-node-icon')?.getAttribute('aria-hidden')).toBe('true');
      expect(pack(host, s.id).querySelector('.lib-grid')!.getAttribute('data-cols')).toBe('4');
    }
  });

  it('orders sections, packs sit under Objects, all closed on a fresh board', () => {
    const { pop, host } = setup();
    pop.open();
    expect([...host.querySelectorAll('.lib-section')].map(s => s.getAttribute('aria-label'))).toEqual(['Objects', 'Icon packs', 'Agents', 'Systems', 'AI logos', 'Cloud logos', 'Charts', 'My library']);
    expect([...host.querySelectorAll('.lib-section[aria-label="Icon packs"] .lib-packs > .lib-pack')].map(p => (p as HTMLElement).dataset.pack)).toEqual(['aws', 'azure', 'gcp', 'cloudflare', 'databases', 'kubernetes', 'cncf']);
    expect(host.querySelectorAll('.lib-pack-open')).toHaveLength(0);
    expect(host.querySelector('[data-pack] .lib-tile')).toBeNull();
    const row = pack(host, 'aws').querySelector('.lib-pack-row')!;
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.textContent).toContain('AWS');
    expect(row.textContent).toContain(String(iconNames('aws').length));
    expect(row.textContent).not.toContain('on this board');
  });

  it('a pack with no logo wears its neutral glyph, and a pack with one wears it', () => {
    const { pop, host } = setup();
    pop.open();
    for (const id of ['aws', 'cloudflare', 'databases', 'cncf']) {
      const icon = pack(host, id).querySelector('.lib-pack-row svg.lib-node-icon')!;
      expect(icon.getAttribute('width'), id).toBe('16');
      expect(icon.getAttribute('aria-hidden'), id).toBe('true');
      expect(icon.classList.contains('lib-node-icon-pending'), id).toBe(false);
    }
  });

  it('opens the packs this board uses, first, with its icons leading and the company logo next', () => {
    const { pop, host } = setup([], ['aws-s3', 'aws-lambda', 'cloudflare-r2', 'gcp-cloud-storage', 'agent']);
    pop.open();
    expect([...host.querySelectorAll('.lib-pack-open')].map(p => (p as HTMLElement).dataset.pack)).toEqual(['aws', 'gcp', 'cloudflare']);
    const aws = pack(host, 'aws');
    expect(aws.querySelector('.lib-pack-row')!.textContent).toContain('2 on this board');
    expect(aws.querySelector('.lib-pack-row')!.getAttribute('aria-expanded')).toBe('true');
    const tiles = [...aws.querySelectorAll<HTMLElement>('.lib-tile')];
    expect(tiles).toHaveLength(8);
    expect(tiles.slice(0, 3).map(t => t.title)).toEqual(['AWS Lambda', 'Amazon S3', 'AWS Cloud']);
    expect(tiles[1].querySelector('.lib-name')!.textContent).toBe('S3');
    expect(tiles[2].querySelector('.lib-name')!.textContent).toBe('AWS Cloud');
    expect([...host.querySelectorAll<HTMLElement>('[data-pack]')].map(p => p.dataset.pack)).toEqual(['aws', 'gcp', 'cloudflare', 'azure', 'databases', 'kubernetes', 'cncf']);
  });

  it('a pack tile drops the provider word from its label, keeps the full name as its title, and places the full id', () => {
    const { pop, host, deps } = setup([], ['azure-blob-storage', 'cloudflare-r2', 'aws-lambda', 'aws-s3']);
    pop.open();
    const label = (name: string) => tileNamed(host, name).querySelector('.lib-name')!.textContent;
    expect(label('Azure Blob Storage')).toBe('Blob Storage');
    expect(label('Cloudflare R2')).toBe('R2');
    expect(label('AWS Lambda')).toBe('Lambda');
    expect(label('Amazon S3')).toBe('S3');
    expect(label('Microsoft Azure')).toBe('Microsoft Azure');
    expect(label('Cloudflare')).toBe('Cloudflare');
    tileNamed(host, 'Amazon S3').click();
    expect(deps.onPick).toHaveBeenCalledWith({ kind: 'icon', icon: 'aws-s3' });
  });

  it('counts an icon once however many nodes wear it', () => {
    const { pop, host } = setup([], ['aws-s3', 'aws-s3', 'aws-s3']);
    pop.open();
    expect(pack(host, 'aws').querySelector('.lib-pack-row')!.textContent).toContain('1 on this board');
  });

  it('Show all reveals the pack, a closed row opens in place, and neither survives closing', () => {
    const { pop, host } = setup([], ['aws-s3']);
    pop.open();
    expect(pack(host, 'aws').querySelector('.lib-pack-more')!.textContent).toBe(`Show all ${iconNames('aws').length}`);
    (pack(host, 'aws').querySelector('.lib-pack-more') as HTMLButtonElement).click();
    expect(pack(host, 'aws').querySelectorAll('.lib-tile').length).toBe(ICONS.filter(i => i.section === 'aws').length);
    expect(pack(host, 'aws').querySelector('.lib-pack-more')).toBeNull();
    (pack(host, 'databases').querySelector('.lib-pack-row') as HTMLButtonElement).click();
    expect([...pack(host, 'databases').querySelectorAll('.lib-tile')].map(t => (t as HTMLElement).title)).toEqual(['Postgres', 'MySQL', 'MongoDB', 'Redis', 'Valkey', 'KeyDB', 'Dragonfly']);
    expect(pack(host, 'databases').querySelector('.lib-pack-more')).toBeNull();
    pop.close();
    pop.open();
    expect(pack(host, 'databases').classList.contains('lib-pack-open')).toBe(false);
    expect(pack(host, 'aws').querySelectorAll('.lib-tile')).toHaveLength(8);
  });

  it('a hand-opened pack keeps its place, and an on-board pack closed by hand keeps its own, until the popover closes', () => {
    const { pop, host } = setup([], ['cloudflare-r2']);
    const order = () => [...host.querySelectorAll<HTMLElement>('[data-pack]')].map(p => p.dataset.pack);
    const before = ['cloudflare', 'aws', 'azure', 'gcp', 'databases', 'kubernetes', 'cncf'];
    pop.open();
    expect(order()).toEqual(before);
    (pack(host, 'gcp').querySelector('.lib-pack-row') as HTMLButtonElement).click();
    expect(order()).toEqual(before);
    expect(pack(host, 'gcp').classList.contains('lib-pack-open')).toBe(true);
    (pack(host, 'gcp').querySelector('.lib-pack-row') as HTMLButtonElement).click();
    expect(pack(host, 'gcp').classList.contains('lib-pack-open')).toBe(false);
    (pack(host, 'cloudflare').querySelector('.lib-pack-row') as HTMLButtonElement).click();
    expect(order()).toEqual(before);
    const closed = pack(host, 'cloudflare');
    expect(closed.classList.contains('lib-pack-open')).toBe(false);
    expect(closed.querySelector('.lib-pack-row')!.getAttribute('aria-expanded')).toBe('false');
    expect(closed.querySelector('.lib-pack-row')!.textContent).not.toContain('on this board');
    (closed.querySelector('.lib-pack-row') as HTMLButtonElement).click();
    expect(pack(host, 'cloudflare').classList.contains('lib-pack-open')).toBe(true);
    (pack(host, 'cloudflare').querySelector('.lib-pack-row') as HTMLButtonElement).click();
    expect(pack(host, 'cloudflare').classList.contains('lib-pack-open')).toBe(false);
    pop.close();
    pop.open();
    expect(pack(host, 'cloudflare').classList.contains('lib-pack-open')).toBe(true);
  });

  it('an id no client draws counts for nothing', () => {
    const { pop, host } = setup([], ['clippy', 'aws-withdrawn']);
    pop.open();
    expect(host.querySelectorAll('.lib-pack-open')).toHaveLength(0);
  });

  it('reads the board again on each open', () => {
    const icons: string[] = [];
    const { pop, host } = setup([], icons);
    pop.open();
    expect(pack(host, 'aws').classList.contains('lib-pack-open')).toBe(false);
    pop.close();
    icons.push('aws-s3');
    pop.open();
    expect(pack(host, 'aws').classList.contains('lib-pack-open')).toBe(true);
  });

  it('Enter on a pack row toggles it and keeps focus, placing nothing', () => {
    const { pop, host, deps } = setup();
    pop.open();
    const row = pack(host, 'azure').querySelector<HTMLButtonElement>('.lib-pack-row')!;
    row.focus();
    const evt = key(row, { key: 'Enter' });
    expect(evt.defaultPrevented).toBe(false); // the browser's own click toggles it
    row.click();
    expect(deps.onPick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pack(host, 'azure').querySelector('.lib-pack-row'));
    expect(pack(host, 'azure').querySelector('.lib-pack-row')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('Show all puts focus on the first tile it revealed', () => {
    const { pop, host } = setup([], ['aws-s3']);
    pop.open();
    const more = pack(host, 'aws').querySelector<HTMLButtonElement>('.lib-pack-more')!;
    more.focus();
    more.click();
    expect(document.activeElement).toBe(pack(host, 'aws').querySelectorAll('.lib-tile')[8]);
  });

  it('arrows cross from an open pack into the next section', () => {
    const { pop, host } = setup([], ['aws-s3']);
    pop.open();
    const tiles = [...pack(host, 'aws').querySelectorAll<HTMLElement>('.lib-tile')];
    tiles[7].focus();
    key(tiles[7], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(host.querySelector('.lib-section[aria-label="Agents"] .lib-tile:nth-child(4)'));
  });

  it('search finds icons in closed packs and ranks packs on this board first', () => {
    const { pop, host, search } = setup([], ['aws-s3', 'cloudflare-r2', 'gcp-cloud-storage']);
    pop.open();
    type(search, 'blob');
    expect(results(host).slice(0, 4)).toEqual(['Amazon S3', 'Cloud Storage', 'Cloudflare R2', 'Azure Blob Storage']);
  });

  it('an icon outside a pack is not a pack on this board, so it earns no search boost', () => {
    const { pop, host, search } = setup([], ['agent']);
    pop.open();
    type(search, 'blob');
    expect(results(host)[0]).toBe('Azure Blob Storage');
    expect(host.querySelectorAll('.lib-pack-open')).toHaveLength(0);
  });

  it('Vercel, Supabase, Firebase and Neon stay in Cloud logos', () => {
    const { pop, host } = setup();
    pop.open();
    expect(names(host, 'Cloud logos')).toEqual(['Vercel', 'Supabase', 'Firebase', 'Neon']);
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

  it('search lists matches by name, ignoring case, with the group beside each row, and says when nothing matches', () => {
    const { pop, host, search } = setup([item(1, 'API gateway'), item(2, 'SLO panel')]);
    pop.open();
    type(search, 'slo');
    expect(inGroup(host, 'Objects')).toEqual([]);
    expect(inGroup(host, 'Charts')).toEqual(chartTitles.filter(t => t.toLowerCase().includes('slo')));
    expect(inGroup(host, 'My library')).toEqual(['SLO panel']);
    type(search, 'SERV');
    expect(inGroup(host, 'Objects')).toEqual(['Service']);
    expect(inGroup(host, 'Charts')).toEqual(chartTitles.filter(t => t.toLowerCase().includes('serv')));
    expect(inGroup(host, 'My library')).toEqual([]);
    type(search, CHART_CONTRACTS.table.title.toUpperCase());
    expect(inGroup(host, 'Charts')).toContain(CHART_CONTRACTS.table.title);
    type(search, 'zzz');
    expect(host.querySelectorAll('.lib-section')).toHaveLength(0);
    expect(host.querySelector('.lib-hint')).toBeNull();
    expect(host.querySelector('.lib-empty')?.textContent).toBe('Nothing matches "zzz"');
  });

  it('search also matches the type and kind ids, and "chart" for chart tiles', () => {
    const { pop, host, search } = setup();
    pop.open();
    type(search, 'timeseries');
    expect(inGroup(host, 'Charts')).toEqual([CHART_CONTRACTS.timeseries.title]);
    type(search, 'TOPLIST');
    expect(inGroup(host, 'Charts')).toEqual([CHART_CONTRACTS.toplist.title]);
    type(search, 'chart');
    expect(inGroup(host, 'Charts')).toEqual(chartTitles);
    expect(inGroup(host, 'Objects')).toEqual([]);
    type(search, 'datastore');
    expect(inGroup(host, 'Objects')).toEqual(['Datastore']);
  });

  it('icons and logos match their name, id, search terms and section title', () => {
    const { pop, host, search } = setup();
    pop.open();
    type(search, 'rag');
    expect(results(host)[0]).toBe('Knowledge base');
    expect(host.querySelector('.lib-row .lib-term')!.textContent).toBe('rag');
    type(search, 'COGNITION');
    expect(inGroup(host, 'AI logos')).toEqual(['Windsurf', 'Devin']);
    type(search, 'anthropic');
    expect(inGroup(host, 'AI logos')).toEqual(['Claude', 'Claude Code']);
    type(search, 'k8s');
    expect(inGroup(host, 'Kubernetes')[0]).toBe('Kubernetes');
    expect(inGroup(host, 'Objects')).toEqual([]);
    type(search, 'mcp-server');
    expect(inGroup(host, 'Agents')).toEqual(['MCP server']);
    type(search, 'logo');
    expect(inGroup(host, 'AI logos')).toEqual(iconNames('ai'));
    expect(inGroup(host, 'Cloud logos')).toEqual(iconNames('cloud'));
    expect(inGroup(host, 'Agents')).toEqual([]);
    type(search, 'systems');
    expect(inGroup(host, 'Systems')).toEqual(iconNames('systems'));
  });

  it('a query shows one ranked list with the group beside each row, and the hint', () => {
    const { pop, host, search } = setup([item(1, 'My lambda notes')]);
    pop.open();
    type(search, 'lambda');
    expect([...host.querySelectorAll('.lib-section')].map(s => s.getAttribute('aria-label'))).toEqual(['Search results']);
    expect(host.querySelector('.lib-section .eyebrow')).toBeNull();
    expect(host.querySelectorAll('.lib-grid[data-cols="1"] .lib-tile.lib-row').length).toBe(results(host).length);
    expect(results(host)[0]).toBe('AWS Lambda');
    expect(host.querySelector('.lib-row .lib-group')!.textContent).toBe('AWS');
    expect(host.querySelector('.lib-hint')!.textContent).toBe('↵ place top result · ↑↓ move · drag to canvas');
  });

  it('renders the top 40 rows of a long list and says how many there are; Enter and arrows work on those', () => {
    const { pop, host, deps, search } = setup();
    pop.open();
    type(search, 'a');
    const entry = (name: string, id: string, terms: readonly string[], group: string) => ({ value: name, name, id, terms, group, onBoard: false });
    const all = rankEntries('a', [
      ...['Service', 'Datastore', 'External', 'Boundary', 'Note'].map(n => entry(n, n.toLowerCase(), [], 'Objects')),
      ...ICONS.map(i => entry(i.name, i.id, i.terms, ICON_SECTIONS.find(s => s.id === i.section)!.title)),
      ...CHART_TYPES.map(t => entry(CHART_CONTRACTS[t].title, t, ['chart'], 'Charts')),
    ]);
    expect(all.length).toBeGreaterThan(40);
    expect(host.querySelectorAll('.lib-row')).toHaveLength(40);
    expect(results(host)).toEqual(all.slice(0, 40).map(r => r.name));
    expect([...host.querySelectorAll('.lib-hint')].map(h => h.textContent)).toEqual([
      `Showing 40 of ${all.length} · keep typing to narrow`,
      '↵ place top result · ↑↓ move · drag to canvas',
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>('.lib-row')];
    rows[39].focus();
    key(rows[39], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[39]);
    key(search, { key: 'Enter' });
    expect(deps.onPick).toHaveBeenCalledTimes(1);
  });

  it('a list inside the cap shows no count line', () => {
    const { pop, host, search } = setup();
    pop.open();
    type(search, 'clstor');
    expect([...host.querySelectorAll('.lib-hint')].map(h => h.textContent)).toEqual(['↵ place top result · ↑↓ move · drag to canvas']);
  });

  it('highlights matched letters and shows the term when only a term matched', () => {
    const { pop, host, search } = setup();
    pop.open();
    type(search, 'clstor');
    expect([...tileNamed(host, 'Cloud Storage').querySelectorAll('mark')].map(m => m.textContent)).toEqual(['Cl', 'Stor']);
    expect(tileNamed(host, 'Cloud Storage').querySelector('.lib-term')).toBeNull();
    type(search, 'blob');
    const s3 = tileNamed(host, 'Amazon S3');
    expect(s3.querySelector('.lib-term')!.textContent).toContain('blob');
    expect([...s3.querySelectorAll('.lib-term mark')].map(m => m.textContent)).toEqual(['blob']);
    expect(s3.querySelectorAll('.lib-name mark')).toHaveLength(0);
  });

  it('shows no highlight on the name when only the id or the group matched', () => {
    const { pop, host, search } = setup();
    pop.open();
    type(search, 'gcp-cloud-storage');
    const row = tileNamed(host, 'Cloud Storage');
    expect(row.querySelector('mark')).toBeNull();
    expect(row.querySelector('.lib-term')).toBeNull();
    expect(row.querySelector('.lib-group')!.textContent).toBe('Google Cloud');
    type(search, 'chart');
    expect(inGroup(host, 'Charts')).toEqual(chartTitles);
    for (const t of chartTitles) expect(tileNamed(host, t).querySelectorAll('.lib-name mark')).toHaveLength(0);
  });

  it('renders a saved name as text, never markup', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { pop, host, search } = setup([item(1, evil)]);
    pop.open();
    type(search, 'img');
    expect(host.querySelector('.lib-row img, .lib-saved img')).toBeNull();
    expect(results(host)).toContain(evil);
  });

  it('a saved row keeps its ⋯ menu and arms a saved pick', () => {
    const { pop, host, deps, search } = setup([item(1, 'My lambda notes')]);
    pop.open();
    type(search, 'lambda notes');
    const saved = host.querySelector<HTMLElement>('.lib-saved')!;
    expect(saved.querySelector('.lib-tile.lib-row .lib-group')!.textContent).toBe('My library');
    saved.querySelector<HTMLButtonElement>('.lib-more')!.click();
    host.querySelector<HTMLButtonElement>('.lib-menu [data-act="rename"]')!.click();
    expect(deps.onRename).toHaveBeenCalledWith(expect.objectContaining({ name: 'My lambda notes' }));
    saved.querySelector<HTMLElement>('.lib-tile')!.click();
    expect(deps.onPick).toHaveBeenLastCalledWith({ kind: 'saved', item: expect.objectContaining({ name: 'My lambda notes' }) });
  });

  it('Enter and ArrowDown work on the list', () => {
    const { pop, host, deps, search } = setup();
    pop.open();
    type(search, 'clstor');
    key(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(host.querySelector('.lib-row'));
    key(document.activeElement!, { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).title).toBe(host.querySelectorAll<HTMLElement>('.lib-row')[1].title);
    type(search, 'clstor');
    key(search, { key: 'Enter' });
    expect(deps.onPick).toHaveBeenCalledWith({ kind: 'icon', icon: 'gcp-cloud-storage' });
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
      ['xai', { kind: 'icon', icon: 'grok' }],
      ['k8s', { kind: 'icon', icon: 'kubernetes' }],
      ['lb', { kind: 'icon', icon: 'aws-elb' }],
    ] as const) {
      pop.open();
      type(search, query);
      key(search, { key: 'Enter' });
      expect(deps.onPick, query).toHaveBeenLastCalledWith(pick);
    }
    pop.open();
    type(search, 'auth');
    key(search, { key: 'Enter' });
    const authId = (deps.onPick.mock.lastCall![0] as { icon: string }).icon;
    expect(ICONS.find(i => i.id === authId)!.terms).toContain('auth');
    // the generic Model icon still lists for "claude", after the logo named so
    pop.open();
    type(search, 'claude');
    expect(inGroup(host, 'Agents')).toContain('Model');
    expect(results(host)[0]).toBe('Claude');
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
    const cloud = names(host, PLAIN[PLAIN.length - 1].title) as string[];
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

  it('style.css: a long pack name shrinks with an ellipsis instead of pushing the chevron out', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, encoding: 'utf8'): string };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const start = css.indexOf('\n.lib-pack-name {');
    expect(start).toBeGreaterThan(0);
    const rule = css.slice(start, css.indexOf('}', start));
    expect(rule).not.toMatch(/flex:\s*none/);
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
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
        boardIcons: () => [],
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
