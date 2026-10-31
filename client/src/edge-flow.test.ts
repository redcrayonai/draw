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
