import { orderedSnapshots, type Version } from './architecture';
import { statusWord, type BranchStatus } from './branches';

/** Branch creation and review live in the header chip and its dialogs; the rail keeps the history and the diff. */
interface Actions {
  switchBoard(id: bigint): void;
  applyView(): void;
  sourceKey(): void;
  toggleDiff(on: boolean): void;
}

/** One mounted panel; table updates change its controls without adding listeners. */
export function mountArchitectureRail(parent: HTMLElement, actions: Actions) {
  const panel = document.createElement('section');
  panel.id = 'architecture-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Architecture history and branches');
  panel.innerHTML = `<div class="eyebrow">ARCHITECTURE</div>
    <div class="architecture-mode" role="status"></div>
    <label class="architecture-snapshot">Snapshot<select aria-label="Architecture snapshot"></select></label>
    <input type="range" aria-label="Architecture timeline" min="0" step="1" />
    <label class="architecture-proposal">Branch<select aria-label="Architecture branch"></select></label>
    <label class="architecture-diff"><input type="checkbox" /> Show changes</label>
    <div class="architecture-summary"></div><div class="architecture-actions"></div>`;
  parent.prepend(panel);
  const mode = panel.querySelector<HTMLElement>('.architecture-mode')!;
  const snapshots = panel.querySelector<HTMLSelectElement>('select[aria-label="Architecture snapshot"]')!;
  const range = panel.querySelector<HTMLInputElement>('input[type="range"]')!;
  const proposals = panel.querySelector<HTMLSelectElement>('select[aria-label="Architecture branch"]')!;
  const snapshotLabel = panel.querySelector<HTMLElement>('label.architecture-snapshot')!;
  const proposalLabel = panel.querySelector<HTMLElement>('label.architecture-proposal')!;
  const diffToggle = panel.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const summary = panel.querySelector<HTMLElement>('.architecture-summary')!;
  const buttons = panel.querySelector<HTMLElement>('.architecture-actions')!;
  let facts: Version[] = [];
  let current: Version | undefined;
  let rendered = '';
  snapshots.addEventListener('change', () => actions.switchBoard(BigInt(snapshots.value)));
  range.addEventListener('input', () => {
    const fact = facts[Number(range.value)];
    if (fact) actions.switchBoard(fact.boardId);
  });
  proposals.addEventListener('change', () => {
    const id = proposals.value ? BigInt(proposals.value) : current?.baseBoardId;
    if (id && id !== 0n) actions.switchBoard(id);
  });
  diffToggle.addEventListener('change', () => actions.toggleDiff(diffToggle.checked));
  const button = (label: string, action: () => void) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', action); buttons.append(b);
  };
  const option = (select: HTMLSelectElement, value: string, label: string) => {
    const opt = document.createElement('option'); opt.value = value; opt.textContent = label; select.append(opt);
  };
  return {
    update(version: Version | undefined, versions: Version[], names: Map<bigint, string>, changes: string, showDiff: boolean, selectedSourceKey?: string) {
      current = version;
      panel.hidden = !version;
      if (!version) return;
      const signature = JSON.stringify([version.boardId, version.assertionMode, version.status,
        versions.map(v => [v.boardId, v.baseBoardId, v.index, v.ref, v.sha, v.status, names.get(v.boardId)]),
        changes, showDiff, selectedSourceKey], (_key, value) => typeof value === 'bigint' ? String(value) : value);
      if (signature === rendered) return;
      rendered = signature;
      const intent = version.assertionMode === 'intent';
      // A branch of a plain board has no history: no snapshots, no timeline.
      const plain = version.historyId === 0n;
      facts = orderedSnapshots(versions, version.historyId);
      mode.textContent = intent
        ? `Branch of ${names.get(version.baseBoardId) ?? 'board'} · ${statusWord(version.status as BranchStatus)}`
        : `Fact · ${version.ref} · ${version.sha.slice(0, 7)}`;
      panel.classList.toggle('intent', intent);
      snapshotLabel.hidden = range.hidden = proposalLabel.hidden = plain;
      snapshots.replaceChildren();
      for (const fact of facts) option(snapshots, String(fact.boardId), `${fact.ref} · ${fact.sha.slice(0, 7)}`);
      snapshots.value = String(intent ? version.baseBoardId : version.boardId);
      range.max = String(Math.max(0, facts.length - 1));
      range.value = String(Math.max(0, facts.findIndex(v => v.boardId === (intent ? version.baseBoardId : version.boardId))));
      range.setAttribute('aria-valuetext', facts[Number(range.value)]?.ref ?? '');
      range.disabled = facts.length < 2;
      proposals.replaceChildren(); option(proposals, '', 'Factual timeline');
      for (const proposal of versions.filter(v => !plain && v.historyId === version.historyId && v.assertionMode === 'intent')) {
        option(proposals, String(proposal.boardId), `${names.get(proposal.boardId) ?? 'Branch'} · ${statusWord(proposal.status as BranchStatus)}`);
      }
      proposals.value = intent ? String(version.boardId) : '';
      diffToggle.checked = showDiff;
      summary.textContent = changes;
      buttons.replaceChildren();
      if (!intent) {
        button('Apply view to history', actions.applyView);
      } else if (selectedSourceKey !== undefined) {
        const key = document.createElement('small'); key.textContent = selectedSourceKey; buttons.append(key);
        button('Set source key', actions.sourceKey);
      }
    },
  };
}
