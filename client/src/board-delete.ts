/**
 * ⌘K "Delete this board" (RC-568): the owner confirms in a modal built like
 * board-rename.ts. Focus starts on cancel and Esc cancels, so a stray Enter
 * deletes nothing; delete stays disabled until the board's name is typed, as
 * on the dashboard. After the delete, `done` leaves the dead board; a refusal
 * goes to `report` (the canvas error toast).
 */
export function openBoardDelete(name: string, remove: () => Promise<void>, done: () => void, report: (err: unknown) => void): void {
  if (document.getElementById('board-delete')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'board-delete';
  dialog.setAttribute('aria-labelledby', 'board-delete-prompt');
  dialog.innerHTML = `
    <p id="board-delete-prompt"></p>
    <input type="text" autocomplete="off" spellcheck="false" aria-label="Board name to confirm deletion" />
    <div class="board-rename-actions">
      <button type="button" class="ctl">cancel</button>
      <button type="button" class="btn-primary" disabled>delete</button>
    </div>`;
  // textContent: a board name is anyone's text.
  dialog.querySelector('p')!.textContent = `Delete "${name}" and everything on it, including its code refs? This cannot be undone. Type the board name to confirm.`;
  const typed = dialog.querySelector('input')!;
  typed.placeholder = name;
  const [cancel, confirm] = dialog.querySelectorAll('button');
  const matches = () => typed.value.trim() === name.trim();
  typed.oninput = () => { if (!busy) confirm.disabled = !matches(); };
  let busy = false;
  const close = () => {
    // Release focus first: Linux Chrome keeps it on the closed dialog's button until the close
    // event, and an element in a closed dialog can no longer be blurred, so a quick ⌘K lost it.
    if (dialog.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    dialog.close();
    // close() restores focus synchronously; release a hidden palette before the next shortcut.
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest<HTMLElement>('#palette')?.hidden) active.blur();
  };
  cancel.onclick = close;
  // Chrome can target the body during Tab wraparound, outside the dialog's handler.
  const guardKeys = (event: KeyboardEvent) => {
    if (dialog.open && !event.composedPath().includes(dialog)) event.stopImmediatePropagation();
  };
  window.addEventListener('keydown', guardKeys, true);
  dialog.onclose = () => {
    window.removeEventListener('keydown', guardKeys, true);
    // Native close events arrive later; keep focus if the person already reopened the palette.
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest<HTMLElement>('#palette')?.hidden) active.blur();
    dialog.remove();
  };
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  // The canvas owns global shortcuts, so keys must stop here; Esc is handled here too, as jsdom has no native one.
  dialog.onkeydown = event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) close();
    }
  };
  confirm.onclick = async () => {
    if (busy || !matches()) return;
    busy = cancel.disabled = confirm.disabled = typed.disabled = true;
    confirm.textContent = 'deleting…';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A reducer promise can stay pending when its socket closes mid-call.
      await Promise.race([
        remove(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('The database did not answer in 15 seconds. Check your connection and try again.')), 15_000);
        }),
      ]);
      busy = false;
      close();
      done();
    } catch (err) {
      busy = false;
      close();
      report(err);
    } finally {
      clearTimeout(timer);
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
}
