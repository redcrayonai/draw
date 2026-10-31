/**
 * Red crayon review (spec 2026-10-19, D1–D4, D13): the person circles nodes,
 * notes each, and sends the whole batch in one reducer call. Drafts live only
 * here, in the browser; nothing reaches an agent until Send.
 */
import { el, type Rect } from './render';
import { showError, showNotice } from './chrome';
import { reducedMotion } from './route-play';
import { peekPosition } from './threat-peek';
import { chromeInsets } from './viewport';
import { MARK_NOTE_MAX, MARKS_PER_SEND_MAX } from '../../module/src/marks';

/** Room between a node and its circle, world px. */
const PAD = 10;
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const TAU = Math.PI * 2;

/** mulberry32: a tiny seeded generator, so one node always gets the same loop. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The loop's centre and half-axes: a squarish ellipse wide enough to clear the node. */
function frame(r: Rect): { cx: number; cy: number; a: number; b: number } {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, a: (r.w / 2 + PAD) * 1.1, b: (r.h / 2 + PAD) * 1.15 };
}

const fmt = (p: [number, number]) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;

/** A hand-drawn loop around the rect: starts top-left, overshoots its start, wobbles by seed. */
export function loopPath(r: Rect, seed: number): string {
  const rand = rng(seed);
  const { cx, cy, a, b } = frame(r);
  const start = -2.2 + rand() * 0.6;
  const turns = 1.08 + rand() * 0.06;
  const p1 = rand() * TAU;
  const p2 = rand() * TAU;
  const n = Math.round(28 * turns);
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const th = start + t * turns * TAU;
    // Never inside the frame, so the padding holds; the drift keeps the two ends apart.
    const k = 1 + 0.02 * (1 + Math.sin(2 * th + p1)) + 0.015 * (1 + Math.sin(3 * th + p2)) + 0.05 * t;
    const c = Math.cos(th);
    const s = Math.sin(th);
    pts.push([cx + a * k * Math.sign(c) * Math.sqrt(Math.abs(c)), cy + b * k * Math.sign(s) * Math.sqrt(Math.abs(s))]);
  }
  // Quadratic segments through the midpoints: smooth, and no point leaves the hull.
  let d = `M${fmt(pts[0])}`;
  for (let i = 1; i < n; i++) {
    const mid: [number, number] = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
    d += ` Q${fmt(pts[i])} ${fmt(mid)}`;
  }
  return `${d} L${fmt(pts[n])}`;
}

export interface Draft { nodeId: bigint; note: string }

/** The drafts: one per circled node, in the order they were made (numbered from 1). */
export class Crayon {
  private list: Draft[] = [];
  /** The mark picked with the select tool (its bubble open), or null. */
  selected: bigint | null = null;
  constructor(private onChange: () => void = () => {}) {}

  /** Every change goes through here: a selected draft that left is no longer selected. */
  private changed(): void {
    if (this.selected !== null && !this.list.some(d => d.nodeId === this.selected)) this.selected = null;
    this.onChange();
  }

  toggle(nodeId: bigint): void {
    const i = this.list.findIndex(d => d.nodeId === nodeId);
    if (i >= 0) this.list.splice(i, 1);
    else if (this.list.length >= MARKS_PER_SEND_MAX) {
      showError(`${MARKS_PER_SEND_MAX} marks at most in one round; send these first`);
      return;
    } else this.list.push({ nodeId, note: '' });
    this.selected = null; // the crayon draws; it does not select
    this.changed();
  }

  select(nodeId: bigint | null): void {
    if (nodeId !== null && !this.list.some(d => d.nodeId === nodeId)) return;
    if (this.selected === nodeId) return;
    this.selected = nodeId;
    this.onChange();
  }

  setNote(nodeId: bigint, note: string): void {
    const d = this.list.find(x => x.nodeId === nodeId);
    if (d) d.note = note;
  }

  undo(): void {
    if (this.list.pop()) this.changed();
  }

  drafts(): Draft[] {
    return this.list.map(d => ({ ...d }));
  }

  /** The live draft objects, for telling a sent draft from a later one on the same node. */
  live(): readonly Draft[] {
    return [...this.list];
  }

  clear(): void {
    if (this.list.length === 0) return;
    this.list = [];
    this.changed();
  }

  /** Drop these nodes' drafts; the rest keep their notes and renumber. */
  remove(nodeIds: bigint[]): void {
    const gone = new Set(nodeIds);
    this.drop(d => gone.has(d.nodeId));
  }

  /** Drop these exact draft objects (a sent batch): a newer draft on the same node stays. */
  removeSent(sent: readonly Draft[]): void {
    this.drop(d => sent.includes(d));
  }

  private drop(gone: (d: Draft) => boolean): void {
    const left = this.list.filter(d => !gone(d));
    if (left.length === this.list.length) return;
    this.list = left;
    this.changed();
  }
}

export interface CrayonView {
  wrap: HTMLElement;
  world: SVGGElement;
  viewport: { scale: number; worldToScreen(x: number, y: number): { x: number; y: number } };
  /** Where a visible node is drawn (world px); undefined draws no loop. */
  rectOf(id: bigint): Rect | undefined;
  label(id: bigint): string;
  /** False once the node left the board: its draft is dropped. */
  exists(id: bigint): boolean;
  send(nodeIds: bigint[], notes: string[]): Promise<void>;
  /** An agent waits on this board's marks right now. */
  listening(): boolean;
}

export const NO_LISTENER = 'Sent. No agent is listening — ask your agent to review your marks.';

/** Loops in the world's #crayon layer, the note bubble and the Send pill (#mark-send). */
export function mountCrayon(view: CrayonView): { crayon: Crayon; sync: () => void; place: () => void } {
  const pill = document.getElementById('mark-send') as HTMLButtonElement;
  const pillLabel = pill.querySelector('.mark-send-label') ?? pill;
  const bubble = document.createElement('div');
  bubble.className = 'mark-note';
  bubble.hidden = true;
  const head = document.createElement('div');
  head.className = 'mark-note-head';
  const who = document.createElement('div');
  who.className = 'mark-note-who';
  const trash = document.createElement('button');
  trash.type = 'button';
  trash.className = 'mark-note-remove';
  trash.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.6 9.5h6.8L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>';
  head.append(who, trash);
  const input = document.createElement('textarea');
  input.rows = 2;
  input.maxLength = MARK_NOTE_MAX;
  input.placeholder = 'Add a note (optional)';
  bubble.append(head, input);
  view.wrap.append(bubble);

  const loops = new Map<bigint, SVGGElement>();
  let seen = new Set<bigint>();
  let noteFor: bigint | null = null;
  /** The selection the bubble last showed. */
  let picked: bigint | null = null;
  let sending = false;

  const crayon = new Crayon(() => {
    const drafts = crayon.drafts();
    const added = drafts.find(d => !seen.has(d.nodeId));
    seen = new Set(drafts.map(d => d.nodeId));
    if (noteFor !== null && !seen.has(noteFor)) closeNote();
    sync();
    if (crayon.selected !== picked) {
      picked = crayon.selected;
      if (picked === null) closeNote();
      else openNote(picked, false); // the keys stay with the canvas: Delete removes, Esc lets go
    }
    if (added) openNote(added.nodeId);
  });

  /** Closing the bubble lets go of a selected mark too. */
  const closeNote = () => {
    noteFor = null;
    bubble.hidden = true;
    if (document.activeElement === input) input.blur();
    crayon.select(null);
  };
  const openNote = (id: bigint, focus = true) => {
    const drafts = crayon.drafts();
    const i = drafts.findIndex(d => d.nodeId === id);
    if (i < 0) return;
    noteFor = id;
    who.textContent = `${i + 1} · ${view.label(id)}`;
    input.value = drafts[i].note;
    input.setAttribute('aria-label', `Note for mark ${i + 1}`);
    trash.setAttribute('aria-label', `Remove mark ${i + 1}`);
    trash.title = 'Remove mark';
    bubble.hidden = false;
    place();
    if (focus && noteFor === id) input.focus();
  };
  // mousedown would blur the note first, and the blur closes the bubble under the click.
  trash.addEventListener('mousedown', evt => evt.preventDefault());
  trash.addEventListener('click', () => { if (noteFor !== null) crayon.remove([noteFor]); });
  input.addEventListener('input', () => {
    if (noteFor !== null) crayon.setNote(noteFor, input.value);
  });
  input.addEventListener('keydown', evt => {
    if (evt.isComposing) return; // an IME's Enter commits its conversion, not the note
    // Esc keeps the circle with whatever note it has; Enter finishes (⇧Enter is a new line).
    if (evt.key === 'Escape' || (evt.key === 'Enter' && !evt.shiftKey)) {
      evt.preventDefault();
      evt.stopPropagation();
      closeNote();
    }
  });
  input.addEventListener('blur', () => { if (noteFor !== null) closeNote(); });
  // A press on the canvas finishes the note (the crayon's pointerdown keeps focus where it is).
  view.world.closest('svg')?.addEventListener('pointerdown', () => { if (noteFor !== null) closeNote(); }, true);

  /** Under the circle, placed like the threat peek; follows pan and zoom. */
  const place = () => {
    if (noteFor === null) return;
    const r = view.rectOf(noteFor);
    if (!r) { closeNote(); return; }
    const { cx, cy, a, b } = frame(r);
    const tl = view.viewport.worldToScreen(cx - a * 1.1, cy - b * 1.1);
    const br = view.viewport.worldToScreen(cx + a * 1.1, cy + b * 1.1);
    const ins = chromeInsets(view.wrap);
    const at = peekPosition({ x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }, [], { w: bubble.offsetWidth, h: bubble.offsetHeight },
      { left: ins.left + 12, top: ins.top + 12, right: view.wrap.clientWidth - ins.right - 12, bottom: view.wrap.clientHeight - ins.bottom - 12 });
    bubble.style.left = `${at.x}px`;
    bubble.style.top = `${at.y}px`;
  };

  const drawIn = (g: SVGGElement) => {
    const path = g.querySelector('path')!;
    if (reducedMotion() || typeof path.animate !== 'function' || typeof path.getTotalLength !== 'function') return;
    const len = path.getTotalLength();
    path.animate([
      { strokeDasharray: `${len} ${len}`, strokeDashoffset: len },
      { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 },
    ], { duration: 300, easing: EASE });
    g.querySelector('.mark-chip')?.animate([{ opacity: 0, offset: 0 }], { duration: 200, delay: 220, fill: 'backwards', easing: EASE });
  };

  /** Redraw from the drafts: rerender calls it, so a loop follows a dragged or gliding node. */
  const sync = () => {
    const drafts = crayon.drafts();
    const gone = drafts.find(d => !view.exists(d.nodeId));
    if (gone) { crayon.remove([gone.nodeId]); return; } // the remove syncs again
    const layer = view.world.querySelector('#crayon');
    const keep = new Set<bigint>();
    drafts.forEach((d, i) => {
      const r = view.rectOf(d.nodeId);
      if (!r || !layer) return;
      keep.add(d.nodeId);
      const path = loopPath(r, Number(d.nodeId % 0x100000000n));
      let g = loops.get(d.nodeId);
      const fresh = g === undefined;
      if (g === undefined) {
        g = el('g', { class: 'mark', 'data-node-id': String(d.nodeId) });
        const chip = el('g', { class: 'mark-chip' });
        chip.append(el('circle', { r: '9' }), el('text', {}));
        // The fat transparent twin takes select-tool clicks on the stroke; inside the loop stays the node's.
        g.append(el('path', { class: 'mark-loop' }), el('path', { class: 'mark-hit' }), chip);
        layer.append(g);
        loops.set(d.nodeId, g);
      }
      for (const p of g.querySelectorAll('path')) if (p.getAttribute('d') !== path) p.setAttribute('d', path);
      g.classList.toggle('selected', crayon.selected === d.nodeId);
      // The number sits on the loop's top-right shoulder.
      const { cx, cy, a, b } = frame(r);
      const at = `translate(${(cx + a * 0.88).toFixed(1)} ${(cy - b * 0.88).toFixed(1)})`;
      const chip = g.querySelector('.mark-chip')!;
      if (chip.getAttribute('transform') !== at) chip.setAttribute('transform', at);
      const num = chip.querySelector('text')!;
      if (num.textContent !== String(i + 1)) num.textContent = String(i + 1);
      if (fresh) drawIn(g);
    });
    for (const [id, g] of loops) {
      if (!keep.has(id)) { g.remove(); loops.delete(id); }
    }
    pill.hidden = drafts.length === 0;
    const text = `Send ${drafts.length} mark${drafts.length === 1 ? '' : 's'}`;
    if (pillLabel.textContent !== text) pillLabel.textContent = text;
    place();
  };

  /** D4: each sent loop fades and drifts into the Review button, staggered; reduced motion fades in place. */
  const fly = (sent: bigint[]) => {
    const target = document.getElementById('act-review')?.getBoundingClientRect();
    const box = view.world.closest('svg')?.getBoundingClientRect();
    const drift = !reducedMotion() && target !== undefined && box !== undefined;
    let i = 0;
    for (const id of sent) {
      const g = loops.get(id);
      if (g === undefined) continue;
      loops.delete(id);
      const r = view.rectOf(id);
      if (typeof g.animate !== 'function') { g.remove(); continue; }
      let to: Keyframe = { opacity: 0 };
      let from: Keyframe = { opacity: 1 };
      if (drift && r) {
        const { cx, cy } = frame(r);
        const c = view.viewport.worldToScreen(cx, cy);
        const dx = (target.left + target.width / 2 - box.left - c.x) / view.viewport.scale;
        const dy = (target.top + target.height / 2 - box.top - c.y) / view.viewport.scale;
        g.style.transformBox = 'fill-box';
        g.style.transformOrigin = 'center';
        from = { opacity: 1, transform: 'translate(0px, 0px) scale(1)' };
        to = { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.3)` };
      }
      g.animate([from, to], { duration: 400, delay: 40 * i++, easing: EASE, fill: 'forwards' }).onfinish = () => g.remove();
    }
  };

  pill.addEventListener('click', () => {
    const drafts = crayon.live();
    if (sending || drafts.length === 0) return;
    sending = true;
    pill.disabled = true;
    // Only these draft objects fly and leave: circles drawn (or re-drawn on a sent node) while it is in flight stay drafts.
    view.send(drafts.map(d => d.nodeId), drafts.map(d => d.note.trim()))
      .then(
        () => {
          fly(drafts.filter(d => crayon.live().includes(d)).map(d => d.nodeId));
          crayon.removeSent(drafts);
          if (!view.listening()) showNotice(NO_LISTENER);
        },
        (err: unknown) => showError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => {
        sending = false;
        pill.disabled = false;
      });
  });

  return { crayon, sync, place };
}
