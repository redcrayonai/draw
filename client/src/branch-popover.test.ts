import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountBranchPopover } from './branch-popover';
import type { BranchRow } from './branches';
import html from '../index.html?raw';

const rows: BranchRow[] = [
  { boardId: 1n, name: 'acme-shop', current: false, base: true, muted: false },
  { boardId: 2n, name: 'add-queue', status: 'submitted', current: true, base: false, muted: false, delta: { addedNodes: 1, removedNodes: 0, addedEdges: 1, removedEdges: 0 } },
  { boardId: 3n, name: 'split-orders', status: 'draft', current: false, base: false, muted: false, delta: { addedNodes: 3, removedNodes: 1, addedEdges: 0, removedEdges: 0 } },
  { boardId: 4n, name: 'cache-ttl', status: 'implemented', current: false, base: false, muted: true },
];

function mount() {
  document.body.innerHTML = html;
  const chip = document.getElementById('branch-chip') as HTMLButtonElement;
  const pop = document.getElementById('branch-pop') as HTMLElement;
  const actions = { newBranch: vi.fn(), switchBoard: vi.fn(), openReview: vi.fn() };
  const popover = mountBranchPopover(chip, pop, actions);
  popover.update(rows, { name: 'add-queue', status: 'In review' }, true);
  return { chip, pop, actions, popover };
}
const rowEls = (pop: HTMLElement) => [...pop.querySelectorAll<HTMLButtonElement>('.branch-row')];

beforeEach(() => { document.body.innerHTML = ''; });

describe('branch chip', () => {
  it('shows the name and the status word', () => {
    const { chip } = mount();
    expect(chip.querySelector('.branch-name')!.textContent).toBe('add-queue');
    expect(chip.querySelector('.branch-status')!.textContent).toBe('In review');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('branch popover', () => {
  it('renders the rows in order, the base tagged, the current selected, the merged one muted', () => {
    const { pop } = mount();
    const els = rowEls(pop);
    expect(els.map(r => r.querySelector('.branch-row-name')!.textContent)).toEqual(['acme-shop', 'add-queue', 'split-orders', 'cache-ttl']);
    expect(els[0].querySelector('.branch-tag')!.textContent).toBe('base');
    expect(els[1].getAttribute('aria-selected')).toBe('true');
    expect(els[1].classList.contains('current')).toBe(true);
    expect(els[2].querySelector('.branch-delta')!.textContent).toBe('+3 −1');
    expect(els[3].classList.contains('muted')).toBe(true);
    expect(els[3].querySelector('.branch-row-status')!.textContent).toBe('Merged');
  });

  it('opens from the chip, switches on click, and does nothing on the current row', () => {
    const { chip, pop, actions } = mount();
    chip.click();
    expect(pop.hidden).toBe(false);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    rowEls(pop)[2].click();
    expect(actions.switchBoard).toHaveBeenCalledWith(3n);
    expect(pop.hidden).toBe(true);
    chip.click();
    rowEls(pop)[1].click();
    expect(actions.switchBoard).toHaveBeenCalledTimes(1);
  });

  it('moves with the arrow keys, switches on Enter, closes on Escape back to the chip', () => {
    const { chip, pop, actions } = mount();
    chip.click();
    const els = rowEls(pop);
    expect(document.activeElement).toBe(els[1]);
    els[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(els[2]);
    els[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(actions.switchBoard).toHaveBeenCalledWith(3n);
    chip.click();
    pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(pop.hidden).toBe(true);
    expect(document.activeElement).toBe(chip);
  });

  it('offers New branch only when the caller may create one', () => {
    const { pop, popover, actions } = mount();
    const button = pop.querySelector<HTMLButtonElement>('.branch-new')!;
    expect(button.hidden).toBe(false);
    button.click();
    expect(actions.newBranch).toHaveBeenCalled();
    popover.update(rows, { name: 'add-queue' }, false);
    expect(pop.querySelector<HTMLButtonElement>('.branch-new')!.hidden).toBe(true);
  });

  it('closes on a click outside', () => {
    const { chip, pop } = mount();
    chip.click();
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(pop.hidden).toBe(true);
  });
});
