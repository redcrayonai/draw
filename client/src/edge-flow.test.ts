import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActivity } from './activity';
import { edgeFlow, MAX_IN_FLIGHT, spawnMs } from './edge-flow';

const NS = 'http://www.w3.org/2000/svg';
let frames: FrameRequestCallback[] = [];
let wall = 0;
const tick = (now: number) => {
  const run = frames;
  frames = [];
  run.forEach(f => f(now));
};

/** A world with the render.ts layers and one 120-unit straight edge per id. */
function world(...ids: bigint[]): SVGGElement {
  const w = document.createElementNS(NS, 'g') as SVGGElement;
  const edges = document.createElementNS(NS, 'g');
  edges.setAttribute('class', 'layer-edges');
  for (const id of ids) {
    const hit = document.createElementNS(NS, 'path') as SVGPathElement;
    hit.setAttribute('class', 'edge-hit');
    hit.setAttribute('d', 'M0 0 H120');
    hit.dataset.edgeId = String(id);
    Object.assign(hit, { getTotalLength: () => 120, getPointAtLength: (d: number) => ({ x: d, y: 0 }) });
    edges.append(hit);
  }
  w.append(edges, document.createElementNS(NS, 'g'));
  document.body.append(w);
  return w;
}
const dots = (w: SVGGElement) => [...w.querySelectorAll('.layer-flow circle')];

beforeEach(() => {
  frames = [];
  wall = 1_000_000;
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('spawnMs', () => {
  it('is 1000/rps clamped to [80, 2000] ms', () => {
    expect(spawnMs(5)).toBe(200);
    expect(spawnMs(100)).toBe(80);
    expect(spawnMs(0.1)).toBe(2000);
  });
});

describe('edgeFlow', () => {
  it('spawns at the rate, moves at one speed source to target, and caps dots in flight', () => {
    const w = world(11n);
    setActivity([{ edgeId: 11n, rps: 100, errRate: 0, observedAt: wall }]);
    edgeFlow(w).sync();
    tick(0);
    expect(dots(w)).toHaveLength(1);
    expect(dots(w)[0].getAttribute('r')).toBe('2');
    for (let t = 80; t <= 480; t += 80) tick(t);
    // 0.12 units/ms whatever the rate: the first dot is 57.6 units along, one every 80 ms behind it.
    expect(dots(w).map(c => c.getAttribute('cx'))).toEqual(['57.6', '48.0', '38.4', '28.8', '19.2', '9.6', '0.0']);
    // 13 spawns by 960 ms, none landed yet (120 units take 1000 ms): the cap holds 12.
    for (let t = 560; t <= 960; t += 80) tick(t);
    expect(dots(w)).toHaveLength(MAX_IN_FLIGHT);
    expect(w.querySelector('.layer-edges + .layer-flow')).not.toBeNull();
  });

  it('marks errRate of the dots as errors', () => {
    const w = world(12n);
    setActivity([{ edgeId: 12n, rps: 10, errRate: 0.25, observedAt: wall }]);
    edgeFlow(w).sync();
    for (let t = 0; t < 800; t += 100) tick(t);
    expect(dots(w).map(c => c.getAttribute('class'))).toEqual(['flow-dot', 'flow-dot', 'flow-dot', 'flow-dot err', 'flow-dot', 'flow-dot', 'flow-dot', 'flow-dot err']);
  });

  it('lets dots land once the edge goes idle, then leaves it static and stops the loop', () => {
    const w = world(13n, 14n);
    setActivity([{ edgeId: 13n, rps: 2, errRate: 0, observedAt: wall }]);
    edgeFlow(w).sync();
    tick(0);
    wall += 10_000;
    tick(500);
    expect(dots(w)).toHaveLength(1);
    tick(1000);
    expect(dots(w)).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  it('adds no layer to the world until a dot exists', () => {
    const w = world(16n);
    edgeFlow(w).sync();
    tick(0);
    expect(w.querySelector('.layer-flow')).toBeNull();
    expect(frames).toHaveLength(0);
  });

  it('runs a dots or threat motion without activity at a steady rate, its speed scaling every dot', () => {
    const w = world(17n, 18n, 19n);
    const motions = new Map([[17n, { motion: 'dots', speed: 'fast' }], [18n, { motion: 'threat', speed: 'slow' }], [19n, { motion: 'dash', speed: 'normal' }]]);
    edgeFlow(w, id => motions.get(id)).sync();
    tick(0);
    tick(250);
    const at = (id: bigint) => dots(w).filter(c => c.getAttribute('cy') === '0.0' && c.getAttribute('cx') !== '0.0').map(c => [c.getAttribute('class'), c.getAttribute('cx')]);
    // one dot each for dots and threat (dash draws in CSS); fast is 2x, slow 0.5x the 0.12 units/ms
    expect(dots(w)).toHaveLength(2);
    expect(at(0n)).toEqual([['flow-dot', '60.0'], ['flow-dot threat', '15.0']]);
    // steady 3 rps: the next dot at 333 ms
    tick(340);
    expect(dots(w)).toHaveLength(4);
  });

  it('draws nothing under reduced motion or in a hidden tab', () => {
    const w = world(15n);
    setActivity([{ edgeId: 15n, rps: 10, errRate: 0, observedAt: wall }]);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const flow = edgeFlow(w);
    flow.sync();
    expect(frames).toHaveLength(0);
    expect(w.querySelector('.layer-flow')).toBeNull();

    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    flow.sync();
    tick(0);
    expect(dots(w)).toHaveLength(1);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames).toHaveLength(0);
    expect(dots(w)).toHaveLength(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    tick(0);
    expect(dots(w)).toHaveLength(1);
  });
});
