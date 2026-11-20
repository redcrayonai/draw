// The flow legend: a pure view. main.ts builds the model; this paints it and calls its handlers.
// Built once per list of flows and updated in place after that, so a pressed row keeps its focus.
export interface FlowLegendModel {
  flows: { name: string; title: string; color: string; steps: number }[];
  /** The flow shown alone, or -1 while the board shows them all. */
  picked: number;
  onPick(i: number): void; onStep(): void; onShowAll(): void;
}

interface Parts { model: FlowLegendModel; key: string; hint: HTMLElement; rows: HTMLButtonElement[]; actions: HTMLElement }

const parts = new WeakMap<HTMLElement, Parts>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function build(root: HTMLElement, m: FlowLegendModel, key: string): Parts {
  const p = { model: m, key } as Parts;
  const head = el('div', 'flow-legend-head');
  p.hint = el('span', '');
  head.append(el('span', '', 'Flows'), p.hint);
  p.rows = m.flows.map((f, i) => {
    const row = el('button', 'flow-legend-row');
    row.type = 'button';
    row.title = f.title;
    row.append(el('span', `flow-legend-dot dot-${f.color}`), el('span', 'flow-legend-name', f.name), el('span', 'flow-legend-count', `${f.steps} ${f.steps === 1 ? 'step' : 'steps'}`));
    row.addEventListener('click', () => p.model.onPick(i));
    return row;
  });
  const act = (label: string, cls: string, fn: () => void) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  p.actions = el('div', 'flow-legend-actions');
  p.actions.append(act('Step through', 'btn-primary flow-legend-step', () => p.model.onStep()), act('Show all', 'btn-primary flow-legend-all', () => p.model.onShowAll()));
  root.replaceChildren(head, ...p.rows, p.actions);
  return p;
}

export function renderFlowLegend(root: HTMLElement, m: FlowLegendModel | null): void {
  if (!m || m.flows.length === 0) { root.hidden = true; return; }
  root.hidden = false;
  const key = JSON.stringify(m.flows);
  let p = parts.get(root);
  if (!p || p.key !== key) { p = build(root, m, key); parts.set(root, p); }
  p.model = m;
  const one = m.picked >= 0;
  root.classList.toggle('picked', one);
  const hint = one ? `Showing 1 of ${m.flows.length}` : 'Click to show one';
  if (p.hint.textContent !== hint) p.hint.textContent = hint;
  p.rows.forEach((row, i) => row.setAttribute('aria-pressed', String(i === m.picked)));
  // Show all held focus and is about to hide: hand it to the row it un-pressed.
  if (!one && p.actions.contains(document.activeElement)) p.rows[0]?.focus();
  p.actions.hidden = !one;
}
