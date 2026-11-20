// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderFlowLegend, type FlowLegendModel } from './flow-legend';

const model = (picked = -1, over: Partial<FlowLegendModel> = {}): FlowLegendModel => ({
  flows: [{ name: 'Checkout', title: 'How an order is paid', color: 'blue', steps: 7 }, { name: 'Sign-in', title: 'How a session starts', color: 'pink', steps: 1 }],
  picked, onPick: vi.fn(), onStep: vi.fn(), onShowAll: vi.fn(), ...over,
});
const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('.flow-legend-row')];

describe('renderFlowLegend', () => {
  it('stays hidden on a board without flows', () => {
    const root = document.createElement('div');
    renderFlowLegend(root, null);
    expect(root.hidden).toBe(true);
    renderFlowLegend(root, model(-1, { flows: [] }));
    expect(root.hidden).toBe(true);
  });

  it('lists each flow with its colour, name and step count, and offers the actions only for a picked flow', () => {
    const root = document.createElement('div');
    renderFlowLegend(root, model());
    expect(root.hidden).toBe(false);
    expect(rows(root).map(r => r.textContent)).toEqual(['Checkout7 steps', 'Sign-in1 step']);
    expect(rows(root)[1].querySelector('.flow-legend-dot')!.className).toContain('dot-pink');
    expect(rows(root).map(r => r.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
    expect(root.querySelector<HTMLElement>('.flow-legend-actions')!.hidden).toBe(true);
    renderFlowLegend(root, model(1));
    expect(rows(root).map(r => r.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(root.querySelector<HTMLElement>('.flow-legend-actions')!.hidden).toBe(false);
    expect(root.querySelector('.flow-legend-head')!.textContent).toBe('FlowsShowing 1 of 2');
  });

  it('keeps its buttons across repaints and calls the newest handlers', () => {
    const root = document.createElement('div');
    renderFlowLegend(root, model());
    const first = rows(root)[0];
    const next = model(0);
    renderFlowLegend(root, next);
    expect(rows(root)[0]).toBe(first);
    first.click();
    root.querySelector<HTMLButtonElement>('.flow-legend-step')!.click();
    root.querySelector<HTMLButtonElement>('.flow-legend-all')!.click();
    expect(next.onPick).toHaveBeenCalledWith(0);
    expect(next.onStep).toHaveBeenCalledTimes(1);
    expect(next.onShowAll).toHaveBeenCalledTimes(1);
  });
});
