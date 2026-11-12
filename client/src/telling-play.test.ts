import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTellingPlayer, tellingKeyRoute, type TellingPlayerDeps } from './telling-play';
import { stepMs, tellingMs, type StepView, type Telling } from './telling';
import type { TellingBarModel } from './telling-bar';

const step = (nodes: string[], title: string) => ({ nodes, frame: [], title, body: 'short', source: '' });
const devs: Telling = { id: 1n, audience: 'Developers', title: 'A request', steps: [step(['1'], 'Gateway'), step(['2'], 'Service'), step(['3'], 'Store')] };
const ops: Telling = { id: 2n, audience: 'Operators', title: 'On call', steps: [step(['3'], 'Paged'), step(['1'], 'Fixed')] };

let frame: FrameRequestCallback | undefined;
let now = 0;
const tick = (ms: number) => { now += ms; const cb = frame; frame = undefined; cb?.(now); };

function setup(over: Partial<TellingPlayerDeps> = {}) {
  const views: (StepView | null)[] = [];
  const bars: (TellingBarModel | null)[] = [];
  const flown: bigint[][] = [];
  const drawn: bigint[][] = [];
  const log: string[] = [];
  const state = { tellings: [devs, ops], reduced: false };
  const player = createTellingPlayer({
    tellings: () => state.tellings,
    liveNodes: () => new Set([1n, 2n, 3n, 4n]),
    setView: v => { log.push('setView'); views.push(v); },
    fly: ids => { log.push('fly'); flown.push(ids); },
    drawIn: ids => { log.push('drawIn'); drawn.push(ids); },
    paintBar: m => { log.push('paintBar'); bars.push(m); },
    edges: () => [{ id: 10n, fromNode: 1n, toNode: 2n }, { id: 11n, fromNode: 2n, toNode: 3n }, { id: 12n, fromNode: 1n, toNode: 4n }],
    reduced: () => state.reduced,
    ...over,
  });
  const bar = () => bars[bars.length - 1];
  return { player, views, bars, flown, drawn, state, bar, log };
}

const key = (k: string) => ({ key: k }) as KeyboardEvent;

beforeEach(() => {
  now = 0;
  frame = undefined;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('telling player', () => {
  it('opens at step 1, playing, and flies to its frame', () => {
    const { player, views, flown, drawn, bar } = setup();
    player.open();
    expect(player.isOpen).toBe(true);
    expect([...views[views.length - 1]!.lit]).toEqual([1n]);
    expect(flown).toEqual([[1n]]);
    expect(drawn).toEqual([]);
    expect(bar()).toMatchObject({ at: 0, count: 3, title: 'Gateway', playing: true, audiences: ['Developers', 'Operators'], active: 0 });
  });

  it('advances on the clock and draws in exactly the edges whose ends are now shown', () => {
    const { player, drawn, bar, log } = setup();
    player.open();
    expect(log.indexOf('paintBar')).toBeLessThan(log.indexOf('fly')); // the bar is up before the camera frames step 1
    log.length = 0;
    tick(stepMs(devs.steps[0]));
    expect(bar()).toMatchObject({ at: 1, title: 'Service' });
    expect(drawn).toEqual([[10n]]);
    expect(log).toEqual(['setView', 'paintBar', 'fly', 'drawIn']);
  });

  it('goes back without drawing again, and forward again without redrawing', () => {
    const { player, drawn, bar } = setup();
    player.open();
    tick(stepMs(devs.steps[0]));
    expect(player.key(key('ArrowLeft'))).toBe(true);
    expect(bar()).toMatchObject({ at: 0, title: 'Gateway', playing: true });
    expect(player.key(key('ArrowRight'))).toBe(true);
    expect(bar()!.at).toBe(1);
    expect(drawn).toEqual([[10n]]);
  });

  it('shows the ending and stops after the last step', () => {
    const { player, bar } = setup();
    player.open();
    tick(tellingMs(devs) + 50);
    expect(bar()).toMatchObject({ at: 3, count: 3, playing: false, title: 'A request', body: 'That is the whole walk-through.', source: '' });
    expect(frame).toBeUndefined();
    player.key(key('ArrowRight'));
    expect(bar()!.at).toBe(3);
    player.key(key('ArrowLeft'));
    expect(bar()!.at).toBe(2);
  });

  it('switching audience restarts the other telling at step 1', () => {
    const { player, bar } = setup();
    player.open();
    tick(stepMs(devs.steps[0]));
    bar()!.onAudience(1);
    expect(bar()).toMatchObject({ active: 1, at: 0, count: 2, title: 'Paged', playing: true });
  });

  it('under reduced motion stays on step 1 but Next still works', () => {
    const { player, state, bar } = setup();
    state.reduced = true;
    player.open();
    tick(20000);
    expect(bar()).toMatchObject({ at: 0, playing: false, reduced: true });
    bar()!.onNext();
    expect(bar()).toMatchObject({ at: 1, playing: false });
    player.key(key(' '));
    expect(bar()!.playing).toBe(false);
  });

  it('restarts at step 1 when the open telling changes', () => {
    const { player, state, bar } = setup();
    player.open();
    tick(stepMs(devs.steps[0]));
    state.tellings = [{ ...devs, steps: [step(['2'], 'New first'), ...devs.steps] }, ops];
    player.refresh();
    expect(bar()).toMatchObject({ at: 0, count: 4, title: 'New first' });
  });

  it('restarts at step 1 when only the title changes', () => {
    const { player, state, bar } = setup();
    player.open();
    tick(stepMs(devs.steps[0]));
    state.tellings = [{ ...devs, title: 'A request, retold' }, ops];
    player.refresh();
    expect(bar()).toMatchObject({ at: 0, title: 'Gateway' });
  });

  it('a restart in a hidden tab stays blocked until the tab shows again', () => {
    const { player, state, bar } = setup();
    player.open();
    player.setBlocked(true);
    state.tellings = [{ ...devs, steps: [step(['2'], 'New first'), ...devs.steps] }, ops];
    player.refresh();
    now += 60000; // hidden: no frames run
    player.setBlocked(false);
    tick(10);
    expect(bar()).toMatchObject({ at: 0, title: 'New first', playing: true });
  });

  it('keeps the step on an unrelated refresh', () => {
    const { player, bar } = setup();
    player.open();
    tick(stepMs(devs.steps[0]));
    player.refresh();
    expect(bar()!.at).toBe(1);
  });

  it('closes when the open telling vanishes', () => {
    const { player, state, views, bar } = setup();
    player.open();
    state.tellings = [ops];
    player.refresh();
    expect(views[views.length - 1]).toBeNull();
    expect(bar()).toBeNull();
    expect(player.isOpen).toBe(false);
  });

  it('Escape closes, and keys do nothing once closed', () => {
    const { player, views, bar } = setup();
    player.open();
    expect(player.key(key('Escape'))).toBe(true);
    expect(player.isOpen).toBe(false);
    expect(views[views.length - 1]).toBeNull();
    expect(bar()).toBeNull();
    expect(frame).toBeUndefined();
    expect(player.key(key('ArrowRight'))).toBe(false);
  });

  it('Space pauses, plays, and replays at the ending', () => {
    const { player, bar, drawn } = setup();
    player.open();
    player.key(key(' '));
    expect(bar()!.playing).toBe(false);
    player.key(key(' '));
    expect(bar()!.playing).toBe(true);
    tick(tellingMs(devs) + 50);
    expect(bar()!.at).toBe(3);
    drawn.length = 0;
    player.key(key(' '));
    expect(bar()).toMatchObject({ at: 0, playing: true });
    tick(stepMs(devs.steps[0]));
    expect(drawn).toEqual([[10n]]); // replay draws edges in again
  });
});

describe('walk-through key routing', () => {
  const ev = (target: Element, key = ' ') => ({ key, metaKey: false, ctrlKey: false, altKey: false, target });
  beforeEach(() => {
    document.body.innerHTML = '<div id="telling-bar"><button id="bar-btn">Pause</button></div><button id="other">Export</button><input id="field"><div id="canvas"></div>';
  });
  const $ = (id: string) => document.getElementById(id)!;

  it('leaves typing alone', () => expect(tellingKeyRoute(ev($('field')), true)).toBe('pass'));
  it('keeps Space and Enter on a bar button, but routes its arrows', () => {
    expect(tellingKeyRoute(ev($('bar-btn')), true)).toBe('stop');
    expect(tellingKeyRoute(ev($('bar-btn'), 'Enter'), true)).toBe('stop');
    expect(tellingKeyRoute(ev($('bar-btn'), 'ArrowRight'), true)).toBe('player');
  });
  it('does not touch Space on a button outside the bar', () => expect(tellingKeyRoute(ev($('other')), true)).toBe('pass'));
  it('routes Space elsewhere to the player, only while open and without modifiers', () => {
    expect(tellingKeyRoute(ev($('canvas')), true)).toBe('player');
    expect(tellingKeyRoute(ev($('canvas')), false)).toBe('pass');
    expect(tellingKeyRoute({ ...ev($('canvas'), 'k'), metaKey: true }, true)).toBe('pass');
  });
});
