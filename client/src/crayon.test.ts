import html from '../index.html?raw';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Crayon, loopPath, mountCrayon, NO_LISTENER } from './crayon';
import { showError, showNotice } from './chrome';

vi.mock('./chrome', () => ({ showError: vi.fn(), showNotice: vi.fn() }));

/** Every coordinate pair in a path, as the bounding box of its points. */
function bbox(d: string) {
  const n = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
  const xs = n.filter((_, i) => i % 2 === 0);
  const ys = n.filter((_, i) => i % 2 === 1);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe('loopPath', () => {
  const r = { x: 100, y: 60, w: 160, h: 80 };

  it('is the same path for the same seed and a different one for another seed', () => {
    expect(loopPath(r, 7)).toBe(loopPath(r, 7));
    expect(loopPath(r, 7)).not.toBe(loopPath(r, 8));
    expect(loopPath(r, 7).startsWith('M')).toBe(true);
  });

  it('goes around the rect with about 10 px to spare on every side', () => {
    for (const seed of [1, 2, 3, 99, 123456]) {
      const b = bbox(loopPath(r, seed));
      expect(b.minX).toBeLessThanOrEqual(r.x - 10);
      expect(b.minY).toBeLessThanOrEqual(r.y - 10);
      expect(b.maxX).toBeGreaterThanOrEqual(r.x + r.w + 10);
      expect(b.maxY).toBeGreaterThanOrEqual(r.y + r.h + 10);
    }
  });
});

describe('Crayon drafts', () => {
  it('a second toggle removes the circle; numbers follow the order that is left', () => {
    const c = new Crayon();
    c.toggle(1n);
    c.toggle(2n);
    c.toggle(3n);
    c.toggle(1n);
    expect(c.drafts().map(d => d.nodeId)).toEqual([2n, 3n]);
    c.toggle(1n);
    expect(c.drafts().map(d => d.nodeId)).toEqual([2n, 3n, 1n]);
  });

  it('refuses a 21st circle and says why; a circle still comes off at 20', () => {
    vi.mocked(showError).mockClear();
    const changed = vi.fn();
    const c = new Crayon(changed);
    for (let i = 1n; i <= 20n; i++) c.toggle(i);
    changed.mockClear();
    c.toggle(21n);
    expect(c.drafts()).toHaveLength(20);
    expect(showError).toHaveBeenCalledWith('20 marks at most in one round; send these first');
    expect(changed).not.toHaveBeenCalled();
    c.toggle(5n);
    expect(c.drafts()).toHaveLength(19);
    expect(c.drafts().some(d => d.nodeId === 5n)).toBe(false);
  });

  it('undo removes the last circle; drafts carry their notes; clear empties', () => {
    const changed = vi.fn();
    const c = new Crayon(changed);
    c.toggle(4n);
    c.toggle(5n);
    c.setNote(4n, 'split auth out');
    c.undo();
    expect(c.drafts()).toEqual([{ nodeId: 4n, note: 'split auth out' }]);
    c.clear();
    expect(c.drafts()).toEqual([]);
    expect(changed).toHaveBeenCalled();
  });
});

describe('Send pill', () => {
  beforeEach(() => {
    document.body.innerHTML = html;
    vi.mocked(showError).mockClear();
    vi.mocked(showNotice).mockClear();
  });

  const mount = (send: (ids: bigint[], notes: string[]) => Promise<void>, listening = true) => {
    const ui = mountCrayon({
      wrap: document.getElementById('canvas-wrap')!,
      world: document.getElementById('world') as unknown as SVGGElement,
      viewport: { scale: 1, worldToScreen: (x, y) => ({ x, y }) },
      rectOf: id => ({ x: Number(id) * 200, y: 0, w: 160, h: 80 }),
      label: id => `node ${id}`,
      exists: () => true,
      send,
      listening: () => listening,
    });
    const pill = document.getElementById('mark-send') as HTMLButtonElement;
    return { ...ui, pill };
  };

  it('says how many marks it sends and hides with none', () => {
    const { crayon, pill } = mount(vi.fn());
    expect(pill.hidden).toBe(true);
    crayon.toggle(1n);
    expect(pill.hidden).toBe(false);
    expect(pill.textContent?.trim()).toBe('Send 1 mark');
    crayon.toggle(2n);
    expect(pill.textContent?.trim()).toBe('Send 2 marks');
    crayon.clear();
    expect(pill.hidden).toBe(true);
  });

  it('sends the batch once while pending, then clears', async () => {
    let done!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { done = resolve; }));
    const { crayon, pill } = mount(send);
    crayon.toggle(1n);
    crayon.toggle(2n);
    crayon.setNote(2n, '  go through worker ');
    pill.click();
    pill.click();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([1n, 2n], ['', 'go through worker']);
    done();
    await new Promise(r => setTimeout(r, 0));
    expect(crayon.drafts()).toEqual([]);
    expect(pill.hidden).toBe(true);
  });

  it('after a Send with no agent listening, says to ask the agent; with one listening, says nothing', async () => {
    const quiet = mount(vi.fn(() => Promise.resolve()), false);
    quiet.crayon.toggle(1n);
    quiet.pill.click();
    await new Promise(r => setTimeout(r, 0));
    expect(showNotice).toHaveBeenCalledWith(NO_LISTENER);
    vi.mocked(showNotice).mockClear();
    document.body.innerHTML = html;
    const heard = mount(vi.fn(() => Promise.resolve()), true);
    heard.crayon.toggle(1n);
    heard.pill.click();
    await new Promise(r => setTimeout(r, 0));
    expect(showNotice).not.toHaveBeenCalled();
  });

  it('keeps the drafts and says why when the send fails', async () => {
    const send = vi.fn(() => Promise.reject(new Error('mark rule: send 1 to 20 marks')));
    const { crayon, pill } = mount(send);
    crayon.toggle(1n);
    pill.click();
    await new Promise(r => setTimeout(r, 0));
    expect(showError).toHaveBeenCalledWith('mark rule: send 1 to 20 marks');
    expect(crayon.drafts().map(d => d.nodeId)).toEqual([1n]);
    pill.click();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('loops and the note bubble', () => {
  beforeEach(() => { document.body.innerHTML = html; });

  const mount = (send: (ids: bigint[], notes: string[]) => Promise<void> = vi.fn()) => {
    const world = document.getElementById('world') as unknown as SVGGElement;
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.id = 'crayon';
    world.append(layer);
    const ui = mountCrayon({
      wrap: document.getElementById('canvas-wrap')!,
      world,
      viewport: { scale: 1, worldToScreen: (x, y) => ({ x, y }) },
      rectOf: id => (id === 9n ? undefined : { x: Number(id) * 200, y: 0, w: 160, h: 80 }),
      label: id => `node ${id}`,
      exists: id => id !== 8n,
      send,
      listening: () => true,
    });
    return { ...ui, layer };
  };

  it('draws one numbered red loop per draft in the #crayon layer', () => {
    const { crayon, layer } = mount();
    crayon.toggle(1n);
    crayon.toggle(2n);
    const marks = [...layer.querySelectorAll('.mark')];
    expect(marks.map(m => m.getAttribute('data-node-id'))).toEqual(['1', '2']);
    expect(marks.map(m => m.querySelector('.mark-chip text')?.textContent)).toEqual(['1', '2']);
    expect(marks[0].querySelector('path.mark-loop')?.getAttribute('d')).toBe(loopPath({ x: 200, y: 0, w: 160, h: 80 }, 1));
    crayon.toggle(1n);
    expect([...layer.querySelectorAll('.mark-chip text')].map(t => t.textContent)).toEqual(['1']);
  });

  it('drops a draft whose node left the board, and draws none for a node not on screen', () => {
    const { crayon, layer, sync } = mount();
    crayon.toggle(8n);
    crayon.toggle(9n);
    sync();
    expect(crayon.drafts().map(d => d.nodeId)).toEqual([9n]);
    expect(layer.querySelectorAll('.mark')).toHaveLength(0);
  });

  it('a circle drawn while a Send is in flight stays a draft with its note, and does not fly', async () => {
    let done!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { done = resolve; }));
    const { crayon, layer } = mount(send);
    crayon.toggle(1n);
    crayon.toggle(2n);
    (document.getElementById('mark-send') as HTMLButtonElement).click();
    crayon.toggle(3n);
    const input = document.querySelector<HTMLTextAreaElement>('.mark-note textarea')!;
    input.value = 'drawn after Send';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const late = layer.querySelector('[data-node-id="3"]')!;
    done();
    await new Promise(r => setTimeout(r, 0));
    expect(send).toHaveBeenCalledWith([1n, 2n], ['', '']);
    expect(crayon.drafts()).toEqual([{ nodeId: 3n, note: 'drawn after Send' }]);
    expect([...layer.querySelectorAll('.mark')]).toEqual([late]);
    expect(late.querySelector('.mark-chip text')?.textContent).toBe('1');
    const pill = document.getElementById('mark-send') as HTMLButtonElement;
    expect([pill.hidden, pill.disabled, pill.textContent?.trim()]).toEqual([false, false, 'Send 1 mark']);
  });

  it('un-circling a sent node and circling it again during the Send keeps the new draft and its note, unflown', async () => {
    let done!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { done = resolve; }));
    const { crayon, layer } = mount(send);
    crayon.toggle(1n);
    crayon.toggle(2n);
    (document.getElementById('mark-send') as HTMLButtonElement).click();
    crayon.toggle(1n);
    crayon.toggle(1n);
    const input = document.querySelector<HTMLTextAreaElement>('.mark-note textarea')!;
    input.value = 'second thoughts';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const again = layer.querySelector('[data-node-id="1"]')!;
    done();
    await new Promise(r => setTimeout(r, 0));
    expect(crayon.drafts()).toEqual([{ nodeId: 1n, note: 'second thoughts' }]);
    expect([...layer.querySelectorAll('.mark')]).toEqual([again]);
  });

  it('opens a note bubble with the cursor in it; typing sets the note; Esc keeps the circle', () => {
    const { crayon } = mount();
    crayon.toggle(2n);
    const bubble = document.querySelector<HTMLElement>('.mark-note')!;
    const input = bubble.querySelector('textarea')!;
    expect(bubble.hidden).toBe(false);
    expect(bubble.textContent).toContain('1 · node 2');
    expect(document.activeElement).toBe(input);
    input.value = 'too much in one box';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bubble.hidden).toBe(true);
    expect(crayon.drafts()).toEqual([{ nodeId: 2n, note: 'too much in one box' }]);
  });

  it('Enter during an IME composition keeps the note open; Enter after it finishes', () => {
    const { crayon } = mount();
    crayon.toggle(2n);
    const bubble = document.querySelector<HTMLElement>('.mark-note')!;
    const input = bubble.querySelector('textarea')!;
    const composing = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
    input.dispatchEvent(composing);
    expect(bubble.hidden).toBe(false);
    expect(composing.defaultPrevented).toBe(false);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(bubble.hidden).toBe(true);
  });

  it('a selected mark opens its bubble with its note, keys left on the canvas, and a glow on its loop', () => {
    const { crayon, layer } = mount();
    crayon.toggle(1n);
    crayon.toggle(2n);
    crayon.setNote(2n, 'why two queues?');
    (document.activeElement as HTMLElement).blur();
    crayon.select(2n);
    const bubble = document.querySelector<HTMLElement>('.mark-note')!;
    expect(bubble.hidden).toBe(false);
    expect(bubble.textContent).toContain('2 · node 2');
    expect(bubble.querySelector('textarea')!.value).toBe('why two queues?');
    expect(document.activeElement).not.toBe(bubble.querySelector('textarea'));
    expect(layer.querySelector('[data-node-id="2"]')!.classList.contains('selected')).toBe(true);
    expect(layer.querySelector('[data-node-id="1"]')!.classList.contains('selected')).toBe(false);
    crayon.select(null);
    expect(bubble.hidden).toBe(true);
    expect(layer.querySelector('.mark.selected')).toBeNull();
  });

  it('only the stroke twin and chip are hit targets: the loop has a .mark-hit path with the same d', () => {
    const { crayon, layer } = mount();
    crayon.toggle(1n);
    const g = layer.querySelector('.mark')!;
    expect(g.querySelector('.mark-hit')!.getAttribute('d')).toBe(g.querySelector('.mark-loop')!.getAttribute('d'));
  });

  it('the bubble\'s remove button takes that draft away; the rest renumber', () => {
    const { crayon, layer } = mount();
    crayon.toggle(1n);
    crayon.toggle(2n);
    crayon.toggle(3n);
    crayon.select(2n);
    const remove = document.querySelector<HTMLButtonElement>('.mark-note-remove')!;
    expect(remove.getAttribute('aria-label')).toBe('Remove mark 2');
    remove.click();
    expect(crayon.drafts().map(d => d.nodeId)).toEqual([1n, 3n]);
    expect(document.querySelector<HTMLElement>('.mark-note')!.hidden).toBe(true);
    expect([...layer.querySelectorAll('.mark-chip text')].map(t => t.textContent)).toEqual(['1', '2']);
    // With the crayon's own bubble (just drawn, cursor in the note) it works the same.
    crayon.toggle(4n);
    expect(remove.getAttribute('aria-label')).toBe('Remove mark 3');
    remove.click();
    expect(crayon.drafts().map(d => d.nodeId)).toEqual([1n, 3n]);
  });
});
