import html from '../local.html?raw';
import { expect, it } from 'vitest';
import { ICONS } from '../../module/src/node-icons';
import { LOCAL_ICONS } from '../../shared/local';
import { LibraryPopover } from './library-popover';
import { iconPaint } from './node-icons';

it('offers local boards exactly the unbranded sections, each drawn as a stroke icon', () => {
  expect(LOCAL_ICONS).toEqual(ICONS.filter(i => i.section === 'agents' || i.section === 'systems').map(i => i.id));
  expect(LOCAL_ICONS.map(iconPaint)).toEqual(LOCAL_ICONS.map(() => 'stroke'));
});

it('shows a local board objects and unbranded icons only: no packs, logos, charts or saved items', () => {
  document.body.innerHTML = html;
  const host = document.getElementById('library-popover')!;
  const pop = new LibraryPopover(host, {
    anchor: document.getElementById('tool-library')!, dropTarget: document.getElementById('canvas')!,
    onPick: () => {}, onDrop: () => {}, onRename: () => {}, onDelete: () => {}, boardIcons: () => [], only: new Set(LOCAL_ICONS),
  });
  pop.open();
  expect([...host.querySelectorAll('.lib-section')].map(s => s.getAttribute('aria-label'))).toEqual(['Objects', 'Agents', 'Systems']);
  expect(host.querySelectorAll('.lib-tile')).toHaveLength(5 + LOCAL_ICONS.length);
  expect(host.querySelector('.lib-node-icon-pending')).toBeNull(); // no logo artwork is fetched
  const search = host.querySelector<HTMLInputElement>('.lib-search')!;
  for (const [query, found] of [['s3', 0], ['openai', 0], ['pie', 0], ['queue', 1]] as const) {
    search.value = query; search.dispatchEvent(new Event('input'));
    expect(host.querySelectorAll('.lib-tile'), query).toHaveLength(found);
  }
});
