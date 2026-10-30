export function openBoardRename(name: string, rename: (name: string) => Promise<void>): void {
  if (document.getElementById('board-rename')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'board-rename';
  dialog.setAttribute('aria-labelledby', 'board-rename-title');
  dialog.innerHTML = `
    <form>
      <h2 id="board-rename-title">Rename board</h2>
      <label for="board-rename-name">Board name</label>
      <input id="board-rename-name" maxlength="100" required autocomplete="off" />
      <p role="alert" hidden></p>
      <div class="board-rename-actions">
        <button type="button" class="ctl">Cancel</button>
        <button type="submit" class="btn-primary">Rename</button>
      </div>
    </form>`;
  const input = dialog.querySelector('input')!;
  const cancel = dialog.querySelector<HTMLButtonElement>('[type="button"]')!;
  const save = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const error = dialog.querySelector<HTMLParagraphElement>('[role="alert"]')!;
  let busy = false;
  const sync = () => {
    input.disabled = cancel.disabled = busy;
    save.disabled = busy || !input.value.trim() || input.value.trim() === name;
    save.textContent = busy ? 'Saving…' : 'Rename';
  };
  input.value = name;
  input.oninput = sync;
  cancel.onclick = () => dialog.close();
  // Chrome can target the body during Tab wraparound, outside the dialog's handler.
  const guardKeys = (event: KeyboardEvent) => {
    if (dialog.open && !event.composedPath().includes(dialog)) event.stopImmediatePropagation();
  };
  window.addEventListener('keydown', guardKeys, true);
  dialog.onclose = () => {
    window.removeEventListener('keydown', guardKeys, true);
    dialog.remove();
  };
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  // The canvas owns global shortcuts, so typing and button keys must stop here.
  dialog.onkeydown = event => event.stopPropagation();
  dialog.querySelector('form')!.onsubmit = async event => {
    event.preventDefault();
    const next = input.value.trim();
    if (busy || !next || next === name) return;
    busy = true;
    error.hidden = true;
    sync();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A reducer promise can stay pending when its socket closes mid-call.
      await Promise.race([
        rename(next),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('The database did not answer in 15 seconds. Check your connection and try again.')), 15_000);
        }),
      ]);
      dialog.close();
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
      error.hidden = false;
    } finally {
      clearTimeout(timer);
      busy = false;
      sync();
    }
  };
  sync();
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  input.select();
}
