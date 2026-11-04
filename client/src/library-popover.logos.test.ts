import html from '../index.html?raw';
import { describe, it, expect, vi } from 'vitest';
import type { LibraryItem } from './module_bindings/types';
import { LibraryPopover, type LibraryPick } from './library-popover';
import { logosReady } from './node-icons';
import { LOGO_LOADERS, type LogoDrawing } from './node-logos';

// Its own file: logo artwork must not be loaded yet when the popover first opens.
const pointer = (target: EventTarget, type: string, x: number, y: number) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));

function setup() {
  document.body.innerHTML = html;
  const host = document.getElementById('library-popover') as HTMLElement;
  const svg = document.getElementById('board') as Element;
  const deps = {
    anchor: document.getElementById('tool-library') as HTMLElement,
    dropTarget: svg,
    onPick: vi.fn<(pick: LibraryPick) => void>(),
    onDrop: vi.fn<(pick: LibraryPick, clientX: number, clientY: number) => void>(),
    onRename: vi.fn<(item: LibraryItem) => void>(),
    onDelete: vi.fn<(item: LibraryItem) => void>(),
    boardIcons: () => [],
  };
  return { pop: new LibraryPopover(host, deps), host, svg, deps };
}

describe('LibraryPopover while logo artwork loads', () => {
  it('fills each logo tile in place, so a drag in progress and keyboard focus survive the artwork arriving', async () => {
    expect(logosReady()).toBe(false);
    const { pop, host, svg, deps } = setup();
    pop.open();
    const tile = [...host.querySelectorAll<HTMLElement>('.lib-tile')].find(t => t.title === 'Vercel')!;
    // a same-size placeholder holds the icon's place: the label does not jump
    expect(tile.querySelector('svg.lib-node-icon-pending')?.getAttribute('width')).toBe('20');
    // a pack row holds its logo's place at the row's own size
    const row = host.querySelector('[data-pack="aws"] .lib-pack-row')!;
    expect(row.querySelector('svg.lib-node-icon-pending')?.getAttribute('width')).toBe('16');
    tile.focus();
    pointer(tile, 'pointerdown', 10, 10);
    pointer(svg, 'pointermove', 300, 200);
    await vi.waitFor(() => expect(tile.querySelector('.lib-node-icon-pending')).toBeNull(), { timeout: 5000 });
    // the same button is still there, now with its artwork, and still focused
    expect(tile.isConnected).toBe(true);
    expect(tile.querySelector('svg.lib-node-icon .logo-art')).not.toBeNull();
    await vi.waitFor(() => expect(row.querySelector('.lib-node-icon-pending')).toBeNull(), { timeout: 5000 });
    expect(row.querySelector('svg.lib-node-icon .logo-art')).not.toBeNull();
    expect(row.querySelector('svg.lib-node-icon')?.getAttribute('width')).toBe('16');
    expect(document.activeElement).toBe(tile);
    pointer(svg, 'pointerup', 300, 200);
    expect(deps.onDrop).toHaveBeenCalledWith({ kind: 'icon', icon: 'vercel' }, 300, 200);
  });

  it('opening fetches no art from closed packs; opening a pack fetches its first tiles', async () => {
    const s3 = vi.spyOn(LOGO_LOADERS as Record<string, () => Promise<LogoDrawing>>, 'aws-s3');
    const lambda = vi.spyOn(LOGO_LOADERS as Record<string, () => Promise<LogoDrawing>>, 'aws-lambda');
    const { pop, host } = setup();
    pop.open();
    expect(s3).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('[data-pack="aws"] .lib-pack-row')!.click();
    expect(lambda).toHaveBeenCalled();
    const tile = [...host.querySelectorAll<HTMLElement>('.lib-tile')].find(t => t.title === 'AWS Lambda')!;
    await vi.waitFor(() => expect(tile.querySelector('.lib-node-icon-pending')).toBeNull(), { timeout: 5000 });
  });

  it('a search fetches art only for the rows it renders', () => {
    // 'a' ranks about 220 rows: RDS is in the top 40, Prometheus (a term-only match, in the last pack) far past it.
    const inside = vi.spyOn(LOGO_LOADERS as Record<string, () => Promise<LogoDrawing>>, 'aws-rds');
    const past = vi.spyOn(LOGO_LOADERS as Record<string, () => Promise<LogoDrawing>>, 'prometheus');
    const { pop, host } = setup();
    pop.open();
    const search = host.querySelector<HTMLInputElement>('.lib-search')!;
    search.value = 'a';
    search.dispatchEvent(new Event('input'));
    const titles = [...host.querySelectorAll<HTMLElement>('.lib-row')].map(r => r.title);
    expect(titles).toContain('Amazon RDS');
    expect(titles).not.toContain('Prometheus');
    expect(inside).toHaveBeenCalled();
    expect(past).not.toHaveBeenCalled();
  });
});
