// The walk-through player: one clock drives the steps of the open telling; main.ts supplies
// the board (live nodes, edges) and paints what the player decides (view, camera, bar).
import { EmbedClock } from './embed-clock';
import { reducedMotion } from './route-play';
import { stepAt, stepStart, stepView, tellingMs, type StepView, type Telling } from './telling';
import type { TellingBarModel } from './telling-bar';

const ENDING = 'That is the whole walk-through.';
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'; // the crayon draw-in's easing

export interface TellingPlayerDeps {
  tellings(): Telling[];
  liveNodes(): ReadonlySet<bigint>;
  setView(view: StepView | null): void;
  fly(nodeIds: bigint[]): void;
  drawIn(edgeIds: bigint[]): void;
  paintBar(m: TellingBarModel | null): void;
  edges(): { id: bigint; fromNode: bigint; toNode: bigint }[];
  reduced(): boolean;
}

export interface TellingPlayer {
  open(audience?: number): void;
  close(): void;
  refresh(): void;
  key(e: KeyboardEvent): boolean;
  setBlocked(blocked: boolean): void;
  readonly isOpen: boolean;
}

export function createTellingPlayer(deps: TellingPlayerDeps): TellingPlayer {
  let t: Telling | null = null;
  let clock: EmbedClock | null = null;
  let idx = 0;
  let at = -1; // 0..steps.length-1 a step, steps.length the ending
  let shown = new Set<bigint>(); // edges already drawn in during this run

  const paintBar = () => {
    if (!t || !clock) return;
    const s = t.steps[at];
    deps.paintBar({
      audiences: deps.tellings().map(x => x.audience), active: idx,
      at, count: t.steps.length,
      title: s ? s.title : t.title, body: s ? s.body : ENDING, source: s ? s.source : '',
      playing: clock.playing, reduced: deps.reduced(),
      onPlay: play, onPause: () => clock?.pause(), onReplay: replay,
      onNext: () => go(at + 1), onBack: () => go(at - 1),
      onAudience: i => start(i, true), // like open: step 1, playing unless reduced
      onExit: close,
    });
  };

  const show = (i: number) => {
    at = i;
    const view = stepView(t!, i, deps.liveNodes());
    deps.setView(view);
    paintBar(); // before fly: the camera frames the step clear of the bar
    if (view.frame.length > 0) deps.fly(view.frame);
    const on = new Set([...view.lit, ...view.seen]);
    const fresh = deps.edges().filter(e => !shown.has(e.id) && on.has(e.fromNode) && on.has(e.toNode)).map(e => e.id);
    for (const id of fresh) shown.add(id);
    if (fresh.length > 0) deps.drawIn(fresh);
  };

  const start = (i: number, autoplay: boolean) => {
    const list = deps.tellings();
    const next = list[i] ?? list[0];
    if (!next) return;
    const old = clock;
    clock = null; // the old clock's callbacks see it is no longer current
    old?.destroy();
    t = next;
    idx = list.indexOf(next);
    shown = new Set();
    at = -1;
    const c: EmbedClock = new EmbedClock(
      tellingMs(next),
      ms => { if (clock === c && stepAt(next, ms) !== at) show(stepAt(next, ms)); },
      () => { if (clock === c) paintBar(); },
    );
    clock = c;
    c.seek(0);
    if (autoplay && !deps.reduced()) c.play();
  };

  const play = () => { if (!deps.reduced()) clock?.play(); };

  const replay = () => {
    if (!t || !clock) return;
    shown = new Set();
    if (deps.reduced()) clock.seek(0);
    else clock.replay();
  };

  /** Next/Back: a playing clock keeps playing from the new step's start. */
  const go = (i: number) => {
    if (!t || !clock || i < 0 || i > t.steps.length) return;
    clock.seek(stepStart(t, i));
  };

  function close(): void {
    if (!t) return;
    const old = clock;
    clock = null;
    t = null;
    old?.destroy();
    deps.setView(null);
    deps.paintBar(null);
  }

  return {
    open(audience = 0) {
      if (!t) start(audience, true);
    },
    close,
    refresh() {
      if (!t || !clock) return;
      const list = deps.tellings();
      const i = list.findIndex(x => x.id === t!.id);
      if (i < 0) { close(); return; }
      const row = list[i];
      if (row.title !== t.title || JSON.stringify(row.steps) !== JSON.stringify(t.steps)) { start(i, clock.playing); return; }
      t = row;
      idx = i;
      deps.setView(stepView(row, at, deps.liveNodes())); // a deleted node drops out of the step
      paintBar();
    },
    key(e) {
      if (!t || !clock) return false;
      switch (e.key) {
        case 'ArrowRight': go(at + 1); return true;
        case 'ArrowLeft': go(at - 1); return true;
        case ' ':
          if (clock.playing) clock.pause();
          else if (at === t.steps.length) replay();
          else play();
          return true;
        case 'Escape': close(); return true;
      }
      return false;
    },
    setBlocked(blocked) { clock?.setBlocked(blocked); },
    get isOpen() { return t !== null; },
  };
}

/**
 * Where a keydown goes while the canvas is up: 'player' tries player.key, 'stop' keeps Space/Enter
 * on a walk-through bar button (its own click, and the editor never sees it), 'pass' leaves it alone.
 */
export function tellingKeyRoute(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>,
  open: boolean,
): 'player' | 'stop' | 'pass' {
  if (!open || e.metaKey || e.ctrlKey || e.altKey) return 'pass';
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return 'pass';
  if ((e.key === ' ' || e.key === 'Enter') && target?.closest('button')) return target.closest('#telling-bar') ? 'stop' : 'pass';
  return 'player';
}

/** Stroke draw-on for newly shown edges, like the crayon's draw-in; leaves no inline style behind. */
export function drawEdgesIn(world: SVGGElement, edgeIds: bigint[]): void {
  if (reducedMotion()) return;
  for (const id of edgeIds) {
    const path = world.querySelector(`path.edge-hit[data-edge-id="${id}"]`)?.parentElement?.querySelector<SVGPathElement>('path.edge-line');
    if (!path || typeof path.animate !== 'function' || typeof path.getTotalLength !== 'function') continue;
    const len = path.getTotalLength();
    if (!(len > 0)) continue;
    path.animate([
      { strokeDasharray: `${len} ${len}`, strokeDashoffset: len },
      { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 },
    ], { duration: 600, easing: EASE });
  }
}
