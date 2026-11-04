import html from '../index.html?raw';
import { describe, it, expect, vi } from 'vitest';
import type { LibraryItem } from './module_bindings/types';
import { LibraryPopover, type LibraryPick } from './library-popover';
import { LOGO_LOADERS, type LogoDrawing } from './node-logos';

// Its own file: earlier opens would already have loaded Grok.
describe('LibraryPopover when a logo fails to load', () => {
  it('one logo that fails to load leaves the others filled and the popover working', async () => {
    vi.spyOn(LOGO_LOADERS as Record<string, () => Promise<LogoDrawing>>, 'grok').mockRejectedValue(new Error('offline'));
    document.body.innerHTML = html;
    const host = document.getElementById('library-popover') as HTMLElement;
    const deps = {
      anchor: document.getElementById('tool-library') as HTMLElement,
      dropTarget: document.getElementById('board') as Element,
      onPick: vi.fn<(pick: LibraryPick) => void>(),
      onDrop: vi.fn<(pick: LibraryPick, clientX: number, clientY: number) => void>(),
      onRename: vi.fn<(item: LibraryItem) => void>(),
      onDelete: vi.fn<(item: LibraryItem) => void>(),
      boardIcons: () => [],
    };
    const pop = new LibraryPopover(host, deps);
    pop.open();
    const tile = (name: string) => [...host.querySelectorAll<HTMLElement>('.lib-tile')].find(t => t.title === name)!;
    await vi.waitFor(() => expect(tile('OpenAI').querySelector('.lib-node-icon-pending')).toBeNull(), { timeout: 5000 });
    expect(tile('Grok').querySelector('.lib-node-icon-pending')).not.toBeNull();
    tile('Grok').click();
    expect(deps.onPick).toHaveBeenCalledWith({ kind: 'icon', icon: 'grok' });
  });
});
