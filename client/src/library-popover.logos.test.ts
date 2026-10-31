import html from '../index.html?raw';
import { describe, it, expect, vi } from 'vitest';
import type { LibraryItem } from './module_bindings/types';
import { LibraryPopover, type LibraryPick } from './library-popover';
import { loadLogos, logosReady } from './node-icons';

// Its own file: logo artwork must not be loaded yet when the popover first opens.
const pointer = (target: EventTarget, type: string, x: number, y: number) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));

describe('LibraryPopover while logo artwork loads', () => {
  it('fills each logo tile in place, so a drag in progress and keyboard focus survive the artwork arriving', async () => {
    expect(logosReady()).toBe(false);
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
    };
    const pop = new LibraryPopover(host, deps);
    pop.open();
    const tile = [...host.querySelectorAll<HTMLElement>('.lib-tile')].find(t => t.title === 'Kubernetes')!;
    // a same-size placeholder holds the icon's place: the label does not jump
    expect(tile.querySelector('svg.lib-node-icon-pending')?.getAttribute('width')).toBe('20');
    tile.focus();
    pointer(tile, 'pointerdown', 10, 10);
    pointer(svg, 'pointermove', 300, 200);
    await loadLogos();
    await Promise.resolve();
    // the same button is still there, now with its artwork, and still focused
    expect(tile.isConnected).toBe(true);
    expect(tile.querySelector('.lib-node-icon-pending')).toBeNull();
    expect(tile.querySelector('svg.lib-node-icon .logo-art')).not.toBeNull();
    expect(document.activeElement).toBe(tile);
    pointer(svg, 'pointerup', 300, 200);
    expect(deps.onDrop).toHaveBeenCalledWith({ kind: 'icon', icon: 'kubernetes' }, 300, 200);
  });
});
