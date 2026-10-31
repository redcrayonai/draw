import type { BranchAction, BranchStatus } from './branches';

export type ChangeRow = { sign: '+' | '−' | '~'; title: string; detail: string; meta: string };

export const ACTION_LABELS: Record<BranchAction, string> = { submit: 'Submit for review', accept: 'Accept', reject: 'Reject', merge: 'Merge', reconcile: 'Check latest import' };
const STEP_INDEX: Record<BranchStatus, number> = { draft: 0, submitted: 1, accepted: 2, rejected: 2, implemented: 3 };
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
// An edge row is titled "A → B" (spec, review modal); a node row is its label.
const isEdge = (row: ChangeRow) => row.title.includes(' → ');

/** The one sentence under the change list: what the primary action will do. */
export function guidance(primary: BranchAction | undefined, status: BranchStatus, baseName: string, changes: ChangeRow[]): string {
  if (primary === 'submit') return 'Submitting asks the owner to review this set.';
  if (primary === 'accept') return 'Accepting locks this set. Any later graph edit returns the branch to draft.';
  if (primary === 'reconcile') return 'Checks the newest import of this repository for these changes.';
  if (primary === 'merge') {
    const added = changes.filter(c => c.sign === '+'), removed = changes.filter(c => c.sign === '−');
    const n = (rows: ChangeRow[], edge: boolean) => rows.filter(r => isEdge(r) === edge).length;
    const removes = removed.length ? `, removes ${[n(removed, false) ? count(n(removed, false), 'node') : '', n(removed, true) ? count(n(removed, true), 'edge') : ''].filter(Boolean).join(' and ')}` : '';
    return `Merging adds ${count(n(added, false), 'node')} and ${count(n(added, true), 'edge')} to ${baseName}${removes}, and keeps anything added there since the branch began.`;
  }
  if (status === 'implemented') return 'This branch is merged.';
  if (status === 'submitted') return 'Waiting for the owner to review.';
  return '';
}

function mount(id: string, labelledBy: string, inner: string): { dialog: HTMLDialogElement; error: HTMLElement } {
  const dialog = document.createElement('dialog');
  dialog.id = id;
  dialog.className = 'branch-dialog';
  dialog.setAttribute('aria-labelledby', labelledBy);
  dialog.innerHTML = inner;
  // The canvas owns global shortcuts, so typing and button keys must stop here.
  dialog.onkeydown = event => event.stopPropagation();
  const guardKeys = (event: KeyboardEvent) => {
    if (dialog.open && !event.composedPath().includes(dialog)) event.stopImmediatePropagation();
  };
  window.addEventListener('keydown', guardKeys, true);
  dialog.onclose = () => {
    window.removeEventListener('keydown', guardKeys, true);
    dialog.remove();
  };
  document.body.append(dialog);
  return { dialog, error: dialog.querySelector<HTMLElement>('[role="alert"]')! };
}

/** Runs a reducer-backed action with the 15 s socket guard; resolves true on success, false after showing the refusal. */
async function attempt(run: () => Promise<void>, error: HTMLElement): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The database did not answer in 15 seconds. Check your connection and try again.')), 15_000); }),
    ]);
    return true;
  } catch (err) {
    error.textContent = err instanceof Error ? err.message : String(err);
    error.hidden = false;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function openBranchCreate(opts: { baseName: string; counts: string; suggested: string; create(name: string): Promise<void> }): void {
  if (document.getElementById('branch-create')) return;
  const { dialog, error } = mount('branch-create', 'branch-create-title', `
    <form>
      <h2 id="branch-create-title">New branch</h2>
      <p class="branch-sub">A copy of the board you can edit and submit for review. The board itself stays as it is until you merge.</p>
      <label for="branch-create-name">Name</label>
      <input id="branch-create-name" maxlength="100" required autocomplete="off" spellcheck="false" />
      <div class="branch-from"><i class="branch-dot" data-status="base" aria-hidden="true"></i>from <b>${escapeHtml(opts.baseName)}</b> · ${escapeHtml(opts.counts)}</div>
      <p role="alert" hidden></p>
      <div class="branch-dialog-actions">
        <button type="button" class="ctl">Cancel</button>
        <span class="grow"></span>
        <button type="submit" class="btn-primary">Create branch</button>
      </div>
    </form>`);
  const input = dialog.querySelector<HTMLInputElement>('input')!;
  const cancel = dialog.querySelector<HTMLButtonElement>('[type="button"]')!;
  const save = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  let busy = false;
  const sync = () => {
    input.disabled = cancel.disabled = busy;
    save.disabled = busy || !input.value.trim();
    save.textContent = busy ? 'Creating…' : 'Create branch';
  };
  input.value = opts.suggested;
  input.oninput = sync;
  cancel.onclick = () => dialog.close();
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  dialog.querySelector('form')!.onsubmit = async event => {
    event.preventDefault();
    const name = input.value.trim();
    if (busy || !name) return;
    busy = true; error.hidden = true; sync();
    const ok = await attempt(() => opts.create(name), error);
    busy = false; sync();
    if (ok) dialog.close();
  };
  sync();
  dialog.showModal();
  input.focus();
  input.select();
}

export function openBranchReview(opts: {
  name: string; baseName: string; status: BranchStatus; baseIsFact: boolean; changes: ChangeRow[];
  actions: readonly BranchAction[]; run(action: BranchAction): Promise<void>; submittedBy?: string;
}): void {
  if (document.getElementById('branch-review')) return;
  const at = STEP_INDEX[opts.status];
  const names = ['Draft', 'In review', opts.status === 'rejected' ? 'Rejected' : 'Accepted', 'Merged'];
  const steps = names.map((label, i) => `<span class="branch-step${i < at ? ' done' : i === at ? ' now' : ''}"><i aria-hidden="true"></i>${label}</span>`).join('<span class="branch-step-line" aria-hidden="true"></span>');
  const rows = opts.changes.map(c => `<li class="branch-change"><span class="branch-sign ${c.sign === '+' ? 'plus' : c.sign === '−' ? 'minus' : 'tilde'}">${c.sign}</span><span class="branch-change-title"><b>${escapeHtml(c.title)}</b> <i>${escapeHtml(c.detail)}</i></span><span class="branch-change-meta">${escapeHtml(c.meta)}</span></li>`).join('');
  const primary = opts.actions.find(a => a !== 'reject');
  const buttons = opts.actions.map(a => `<button type="button" class="${a === 'reject' ? 'ctl btn-danger' : 'btn-primary'}" data-action="${a}">${ACTION_LABELS[a]}</button>`).join('');
  const { dialog, error } = mount('branch-review', 'branch-review-title', `
    <div class="branch-review-body">
      <h2 id="branch-review-title"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="6" r="1.8"/><path d="M4 5.3v5.4M12 7.8c0 2.6-2.4 3.3-5 3.7"/></svg><span class="branch-review-name">${escapeHtml(opts.name)}</span></h2>
      <p class="branch-sub">Branch of ${escapeHtml(opts.baseName)}${opts.submittedBy ? ` · submitted by ${escapeHtml(opts.submittedBy)}` : ''}</p>
      <div class="branch-steps">${steps}</div>
      ${opts.changes.length ? `<ul class="branch-changes">${rows}</ul>` : '<p class="branch-empty">No changes yet.</p>'}
      <p class="branch-note">${escapeHtml(guidance(primary, opts.status, opts.baseName, opts.changes))}</p>
      <p role="alert" hidden></p>
      <div class="branch-dialog-actions">
        <button type="button" class="ctl" data-action="cancel">Cancel</button>
        <span class="grow"></span>
        ${buttons}
      </div>
    </div>`);
  const all = [...dialog.querySelectorAll<HTMLButtonElement>('button[data-action]')];
  let busy = false;
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  for (const b of all) {
    b.onclick = async () => {
      const action = b.dataset.action as BranchAction | 'cancel';
      if (action === 'cancel') { dialog.close(); return; }
      if (busy) return;
      busy = true; error.hidden = true;
      for (const x of all) x.disabled = true;
      const ok = await attempt(() => opts.run(action), error);
      busy = false;
      for (const x of all) x.disabled = false;
      if (ok) dialog.close();
    };
  }
  dialog.showModal();
  (all.find(b => b.dataset.action === primary) ?? all[0])?.focus();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
