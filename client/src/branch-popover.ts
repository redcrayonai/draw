import type { BranchRow } from './branches';
import { statusWord } from './branches';

interface Actions {
  newBranch(): void;
  switchBoard(id: bigint): void;
  openReview(id: bigint): void;
}

const dot = (status: string) => {
  const i = document.createElement('i');
  i.className = 'branch-dot';
  i.dataset.status = status;
  i.setAttribute('aria-hidden', 'true');
  return i;
};

const deltaText = (d: NonNullable<BranchRow['delta']>) => {
  const parts: [number, string][] = [[d.addedNodes + d.addedEdges, 'plus'], [d.removedNodes + d.removedEdges, 'minus']];
  return parts.filter(([n]) => n > 0).map(([n, cls]) => `<span class="${cls}">${cls === 'plus' ? '+' : '−'}${n}</span>`).join(' ');
};

/** The header chip and its popover: one mount, `update` rerenders the tree. */
export function mountBranchPopover(chip: HTMLButtonElement, pop: HTMLElement, actions: Actions) {
  const tree = pop.querySelector<HTMLElement>('.branch-tree')!;
  const newButton = pop.querySelector<HTMLButtonElement>('.branch-new')!;
  const name = chip.querySelector<HTMLElement>('.branch-name')!;
  const status = chip.querySelector<HTMLElement>('.branch-status')!;
  const chipDot = chip.querySelector<HTMLElement>('.branch-dot')!;
  let rows: BranchRow[] = [];

  const items = () => [...tree.querySelectorAll<HTMLButtonElement>('.branch-row')];
  const open = () => {
    pop.hidden = false;
    chip.setAttribute('aria-expanded', 'true');
    pop.style.setProperty('--branch-pop-left', `${chip.offsetLeft}px`);
    (items().find(r => r.classList.contains('current')) ?? items()[0])?.focus();
  };
  const close = (refocus = false) => {
    if (pop.hidden) return;
    pop.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    if (refocus) chip.focus();
  };
  const toggle = () => (pop.hidden ? open() : close());

  chip.addEventListener('click', toggle);
  newButton.addEventListener('click', () => { close(); actions.newBranch(); });
  document.addEventListener('pointerdown', e => {
    if (!pop.hidden && !pop.contains(e.target as Node) && !chip.contains(e.target as Node)) close();
  });
  pop.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
    if (next) { e.preventDefault(); next.focus(); }
  });

  const render = () => {
    tree.replaceChildren();
    for (const row of rows) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `branch-row${row.base ? '' : ' child'}${row.current ? ' current' : ''}${row.muted ? ' muted' : ''}`;
      b.setAttribute('role', 'treeitem');
      b.setAttribute('aria-selected', String(row.current));
      b.dataset.board = String(row.boardId);
      const main = document.createElement('span');
      main.className = 'branch-row-main';
      const n = document.createElement('span');
      n.className = 'branch-row-name';
      n.textContent = row.name;
      main.append(n);
      if (row.base) {
        const tag = document.createElement('span');
        tag.className = 'branch-tag';
        tag.textContent = 'base';
        main.append(tag);
      } else if (row.status) {
        const s = document.createElement('span');
        s.className = 'branch-row-status';
        s.textContent = statusWord(row.status);
        main.append(s);
      }
      const delta = document.createElement('span');
      delta.className = 'branch-delta';
      if (row.delta) delta.innerHTML = deltaText(row.delta);
      b.append(dot(row.base ? 'base' : row.status ?? 'draft'), main, delta);
      b.addEventListener('click', () => {
        close();
        if (row.current) actions.openReview(row.boardId);
        else actions.switchBoard(row.boardId);
      });
      b.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !row.current) { e.preventDefault(); close(); actions.switchBoard(row.boardId); }
      });
      tree.append(b);
    }
  };

  return {
    update(next: BranchRow[], text: { name: string; status?: string }, canCreate: boolean) {
      rows = next;
      name.textContent = text.name;
      status.textContent = text.status ?? '';
      const current = next.find(r => r.current);
      chipDot.hidden = !text.status;
      chipDot.dataset.status = current?.status ?? '';
      newButton.hidden = !canCreate;
      render();
    },
    open,
    close: () => close(),
    toggle,
  };
}
