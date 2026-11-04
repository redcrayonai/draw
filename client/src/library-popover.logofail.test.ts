import html from '../index.html?raw';
import { describe, it, expect, vi } from 'vitest';
import type { LibraryItem } from './module_bindings/types';
import { LibraryPopover, type LibraryPick } from './library-popover';
import { LOGO_LOADERS, type LogoDrawing } from './node-logos';

function setup(boardIcons: string[] = []) {
  document.body.innerHTML = html;
  const host = document.getElementById('library-popover') as HTMLElement;
  const deps = {
    anchor: document.getElementById('tool-library') as HTMLElement,
    dropTarget: document.getElementById('board') as Element,
    onPick: vi.fn<(pick: LibraryPick) => void>(),
    onDrop: vi.fn<(pick: LibraryPick, clientX: number, clientY: number) => void>(),
    onRename: vi.fn<(item: LibraryItem) => void>(),
    onDelete: vi.fn<(item: LibraryItem) => void>(),
    boardIcons: () => boardIcons,
  };
  const pop = new LibraryPopover(host, deps);
  pop.open();
  const tile = (name: string) => [...host.querySelectorAll<HTMLElement>('.lib-tile')].find(t => t.title === name)!;
  return { deps, tile };
}

// Its own file: earlier opens would already have loaded Grok.
describe('LibraryPopover when a logo fails to load', () => {
  it('one logo that fails to load leaves the others filled and the popover working', async () => {
    vi.spyOn(LOGO_LOADERS as Record<string, () => Promise<LogoDrawing>>, 'grok').mockRejectedValue(new Error('offline'));
    const { deps, tile } = setup();
    await vi.waitFor(() => expect(tile('OpenAI').querySelector('.lib-node-icon-pending')).toBeNull(), { timeout: 5000 });
    expect(tile('Grok').querySelector('.lib-node-icon-pending')).not.toBeNull();
    tile('Grok').click();
    expect(deps.onPick).toHaveBeenCalledWith({ kind: 'icon', icon: 'grok' });
  });

  it('one logo that never arrives holds up no other tile', async () => {
    vi.spyOn(LOGO_LOADERS as Record<string, () => Promise<LogoDrawing>>, 'aws-s3').mockReturnValue(new Promise(() => {}));
    const { tile } = setup(['aws-s3', 'aws-lambda']);
    await vi.waitFor(() => expect(tile('AWS Lambda').querySelector('.lib-node-icon-pending')).toBeNull(), { timeout: 5000 });
    expect(tile('Amazon S3').querySelector('.lib-node-icon-pending')).not.toBeNull();
  });
});
