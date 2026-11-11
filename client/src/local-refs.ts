import type { LocalBoard, LocalEdge, LocalNode, LocalOperation } from '../../shared/local';

export function mountLocalRefs(container: HTMLElement, read: () => LocalBoard | undefined, selected: () => LocalNode | LocalEdge | undefined, mutate: (ops: LocalOperation[], revision?: number) => Promise<void>, call: (input: unknown) => Promise<unknown>, report: (text: string) => void) {
  const section = document.createElement('section');
  section.innerHTML = `<h2>Code references</h2><form><label>Repository path<input name="path" required placeholder="src/server.ts"></label><label>First line<input name="start" type="number" min="1" value="1" required></label><label>Last line<input name="end" type="number" min="1" value="1" required></label><button>Attach reference</button></form><div data-refs></div><pre data-code tabindex="0"></pre>`;
  container.insertBefore(section, container.querySelector('h2:nth-of-type(2)'));
  const form = section.querySelector('form')!;
  const run = (task: () => Promise<unknown>) => { void task().catch(error => report(error.message)); };
  form.onsubmit = event => {
    event.preventDefault(); const item = selected(), board = read(); if (!item || !board) return;
    const values = new FormData(form);
    const ref = { path: String(values.get('path')), start: Number(values.get('start')), end: Number(values.get('end')) };
    run(async () => {
      await call({ action: 'read_code', board: board.slug, ref });
      await mutate([{ type: 'x' in item ? 'node.put' : 'edge.put', id: item.id, patch: { refs: [...item.refs, ref] } }], board.revision);
      form.reset();
    });
  };
  let selectedId: string | undefined;
  return () => {
    const item = selected(), board = read(); section.hidden = !item;
    if (selectedId !== item?.id) { section.querySelector('[data-code]')!.textContent = ''; selectedId = item?.id; }
    const list = section.querySelector('[data-refs]')!; list.replaceChildren();
    for (const [index, ref] of (item?.refs ?? []).entries()) {
      const open = document.createElement('button'); open.textContent = `${ref.path}:${ref.start}–${ref.end}`;
      open.onclick = () => run(async () => { const source = await call({ action: 'read_code', board: board!.slug, ref }) as { text: string }; section.querySelector('[data-code]')!.textContent = source.text; });
      const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove reference ${ref.path}`);
      remove.onclick = () => run(() => mutate([{ type: 'x' in item! ? 'node.put' : 'edge.put', id: item!.id, patch: { refs: item!.refs.filter((_, i) => i !== index) } }], board!.revision));
      list.append(open, remove);
    }
  };
}
