// Owner's share control in the header: #act-share opens #share-pop.
import { copyText, dismissible, flashLabel } from './chrome';
import { newShareToken, shareHref } from '../../shared/share-link';

/**
 * threats, code: the sensitive layers the link also carries; a new link has
 * neither. counts: how many of each the board holds, shown beside the boxes.
 */
export interface ShareState { mode: '' | 'view' | 'edit'; token: string; threats: boolean; code: boolean; counts?: { threats: number; code: number } }
export interface ShareDeps {
  base: string;
  db: string;
  /** this build's own database, which links leave unnamed */
  home?: string;
  setLink(mode: 'view' | 'edit', token: string): Promise<void>;
  stopLink(): Promise<void>;
  setIncludes(threats: boolean, code: boolean): Promise<void>;
}

const OFF_HINT = 'Only people with access can open this board. Turn on to get a link anyone can open.';
const ON_HINT = {
  view: 'Anyone with the link can view. Turning this off ends access for everyone.',
  edit: 'Anyone with the link can view. Signed-in people can edit. Turning this off ends access for everyone.',
};

/** Wire the popover once; call the result with the owner's state, or null to hide it. */
export function setupShare(deps: ShareDeps): (state: ShareState | null) => void {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const btn = el<HTMLButtonElement>('act-share'), pop = el('share-pop'), on = el<HTMLInputElement>('share-on');
  const detail = el('share-detail'), url = el<HTMLInputElement>('share-url'), copy = el<HTMLButtonElement>('share-copy');
  const hint = el('share-hint'), error = el('share-error');
  const threats = el<HTMLInputElement>('share-threats'), code = el<HTMLInputElement>('share-code'), codeNote = el('share-code-note');
  // The header's exposure chip (renderExposure) is a second way in; optional in pages without it.
  const chip = document.getElementById('exposure-chip');
  // Owners export from the popover (#share-export), so the header keeps one filled button.
  const exportBtn = document.getElementById('act-export');
  let state: ShareState | null = null;
  let opener: HTMLElement = btn;

  const setOpen = (open: boolean): void => {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    chip?.setAttribute('aria-expanded', String(open));
    if (!open) pop.classList.remove('from-exposure');
  };
  const paint = (): void => {
    if (exportBtn) exportBtn.hidden = state !== null;
    if (state === null) {
      btn.hidden = true;
      setOpen(false);
      return;
    }
    const shared = state.mode !== '';
    btn.hidden = false;
    btn.textContent = shared ? 'Shared' : 'Share';
    btn.classList.toggle('shared', shared);
    on.checked = shared;
    detail.hidden = !shared;
    hint.textContent = state.mode === '' ? OFF_HINT : ON_HINT[state.mode];
    for (const b of pop.querySelectorAll<HTMLElement>('[data-share-mode]')) b.setAttribute('aria-pressed', String(b.dataset.shareMode === state.mode));
    url.value = shared ? shareHref(deps.base, deps.db, state.token, deps.home) : '';
    threats.checked = state.threats;
    // An edit link always carries code (the module's linkIncludes): undo of an edit writes it back.
    code.checked = state.code || state.mode === 'edit';
    code.disabled = state.mode === 'edit';
    codeNote.hidden = state.mode !== 'edit';
    for (const [box, n] of [[threats, state.counts?.threats], [code, state.counts?.code]] as const) {
      const count = box.closest('label')?.querySelector('.share-count');
      if (count) count.textContent = n ? String(n) : '';
    }
  };
  const run = async (action: () => Promise<void>): Promise<void> => {
    error.hidden = true;
    for (const c of [on, threats, code]) c.disabled = true;
    try {
      await action();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
      error.hidden = false;
      paint(); // put the switch back to what the module holds
    } finally {
      on.disabled = threats.disabled = false;
      code.disabled = state?.mode === 'edit';
    }
  };

  btn.addEventListener('click', () => {
    opener = btn;
    setOpen(pop.hidden);
  });
  // From the chip: open on what the link carries (or on the switch when no link is on); a second press closes.
  chip?.addEventListener('click', () => {
    if (state === null) return;
    if (!pop.hidden) return setOpen(false);
    opener = chip;
    setOpen(true);
    pop.classList.add('from-exposure');
    (state.mode === '' ? on : threats).focus();
  });
  on.addEventListener('change', () => void run(() => (on.checked ? deps.setLink('view', newShareToken()) : deps.stopLink())));
  pop.addEventListener('click', evt => {
    const b = (evt.target as Element).closest<HTMLElement>('[data-share-mode]');
    const mode = b?.dataset.shareMode as 'view' | 'edit' | undefined;
    if (mode && state?.mode && mode !== state.mode) void run(() => deps.setLink(mode, newShareToken()));
  });
  // On an edit link the Code box is locked on: send the stored choice, so going back to view keeps it.
  for (const c of [threats, code]) c.addEventListener('change', () => void run(() => deps.setIncludes(threats.checked, state?.mode === 'edit' ? state.code : code.checked)));
  copy.addEventListener('click', async () => flashLabel(copy, await copyText(url.value), 'Copy', 'Copied ✓'));
  dismissible(pop, btn, () => {
    setOpen(false);
    return opener;
  }, [chip]);

  return next => {
    state = next;
    paint();
  };
}
