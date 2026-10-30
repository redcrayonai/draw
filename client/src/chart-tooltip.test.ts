import { describe, it, expect, beforeEach } from 'vitest';
import { bindChartTooltip } from './chart-tooltip';

let host: HTMLElement;
let svg: SVGSVGElement;
let on = true;
let unbind: () => void = () => {};

beforeEach(() => {
  unbind();
  document.body.innerHTML = `
    <main id="canvas-wrap">
      <svg id="board"><g id="world">
        <g class="node node-chart" data-id="1">
          <rect class="node-rect" width="352" height="224"></rect>
          <g class="chart-plot" transform="translate(16 56)">
            <rect class="chart-hit" x="0" y="4" width="20" height="80" data-x="10" data-tip="10:05&#10;checkout 135 ms"></rect>
            <rect class="chart-hit rows" x="20" y="4" width="20" height="80" data-x="30"
              data-tip="10:10&#10;checkout: 180 ms&#10;&lt;img src=x onerror=alert(1)&gt;: —"
              data-tip-head="10:10"
              data-tip-rows='[{"slot":1,"name":"checkout","value":"180 ms","y":20},{"slot":2,"name":"&lt;img src=x onerror=alert(1)&gt;","value":"—"},{"name":"total","value":"180 ms"}]'></rect>
            <rect class="series-1" x="40" y="10" width="8" height="40" data-tip="us-east 1,284"></rect>
            <text class="chart-faint" x="0" y="120">10:00</text>
          </g>
        </g>
      </g></svg>
    </main>`;
  host = document.getElementById('canvas-wrap')!;
  svg = document.getElementById('board') as unknown as SVGSVGElement;
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
  on = true;
  unbind = bindChartTooltip(svg, host, () => on);
});

const tip = () => document.getElementById('chart-tip') as HTMLDivElement;
const hit = () => svg.querySelector('.chart-hit')!;
const bar = () => svg.querySelector('rect.series-1')!;
const xhair = () => svg.querySelector('.chart-plot > g.chart-xhair > line');
const rowsHit = () => svg.querySelector('.chart-hit.rows')!;
function move(target: Element, x: number, y: number, buttons = 0): void {
  target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, buttons }));
}

describe('chart hover readout', () => {
  it('is one hidden screen-space tooltip in the canvas wrap', () => {
    expect(host.querySelectorAll('#chart-tip')).toHaveLength(1);
    expect(tip().getAttribute('role')).toBe('tooltip');
    // a hover readout is not announced on every move; the inspector grid holds every value
    expect(tip().hasAttribute('aria-live')).toBe(false);
    expect(tip().hidden).toBe(true);
  });

  it('shows the data-tip of the mark under the pointer, beside the pointer', () => {
    move(bar(), 100, 50);
    expect(tip().hidden).toBe(false);
    expect(tip().textContent).toBe('us-east 1,284');
    expect([tip().style.left, tip().style.top]).toEqual(['112px', '62px']);
  });

  it('flips to the other side of the pointer near the canvas edge', () => {
    Object.defineProperty(tip(), 'offsetWidth', { configurable: true, value: 120 });
    Object.defineProperty(tip(), 'offsetHeight', { configurable: true, value: 40 });
    move(bar(), 750, 580);
    expect([tip().style.left, tip().style.top]).toEqual([`${750 - 12 - 120}px`, `${580 - 12 - 40}px`]);
  });

  it('draws a crosshair over a timeseries hit column, inside that plot only', () => {
    move(hit(), 30, 90);
    expect(tip().textContent).toBe('10:05\ncheckout 135 ms');
    const line = xhair()!;
    expect(['x1', 'x2', 'y1', 'y2'].map(a => line.getAttribute(a))).toEqual(['10', '10', '4', '84']);
    move(hit(), 32, 91);
    expect(svg.querySelectorAll('.chart-xhair')).toHaveLength(1);
    move(bar(), 100, 50);
    expect(xhair()).toBeNull();
    expect(tip().textContent).toBe('us-east 1,284');
  });

  it('hides off the marks, on leave, on pointerdown, on wheel and on a key', () => {
    const shown = () => {
      move(hit(), 30, 90);
      expect(tip().hidden).toBe(false);
    };
    shown();
    move(svg.querySelector('text.chart-faint')!, 20, 170);
    expect(tip().hidden).toBe(true);
    expect(xhair()).toBeNull();
    for (const evt of [
      new PointerEvent('pointerleave'),
      new PointerEvent('pointerdown', { bubbles: true }),
      new WheelEvent('wheel', { bubbles: true }),
    ]) {
      shown();
      svg.dispatchEvent(evt);
      expect(tip().hidden, evt.type).toBe(true);
      expect(xhair(), evt.type).toBeNull();
    }
    shown();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '=' }));
    expect(tip().hidden).toBe(true);
  });

  it('a tap shows the readout of the mark it landed on, and the lifted finger leaving keeps it', () => {
    const touch = (target: Element, type: string, x: number, y: number) =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType: 'touch' }));
    touch(bar(), 'pointerdown', 100, 50);
    // A pan captures the lift on the svg: the press's mark still counts.
    touch(svg, 'pointerup', 102, 51);
    touch(svg, 'pointerleave', 102, 51);
    expect(tip().hidden).toBe(false);
    expect(tip().textContent).toBe('us-east 1,284');
    touch(bar(), 'pointerdown', 100, 50);
    expect(tip().hidden).toBe(true);
    touch(svg, 'pointerup', 160, 50);
    expect(tip().hidden).toBe(true);
    // A pan away and back is no tap either.
    touch(bar(), 'pointerdown', 100, 50);
    touch(svg, 'pointermove', 150, 50);
    touch(svg, 'pointerup', 101, 50);
    expect(tip().hidden).toBe(true);
  });

  it('never shows during a drag, or outside select mode', () => {
    move(bar(), 100, 50, 1);
    expect(tip().hidden).toBe(true);
    on = false;
    move(bar(), 100, 50);
    expect(tip().hidden).toBe(true);
    move(hit(), 30, 90);
    expect(xhair()).toBeNull();
    on = true;
    move(bar(), 100, 50);
    expect(tip().hidden).toBe(false);
  });

  it('unbinding removes the readout and the crosshair and stops listening', () => {
    move(hit(), 30, 90);
    unbind();
    expect(document.getElementById('chart-tip')).toBeNull();
    expect(xhair()).toBeNull();
    move(hit(), 30, 90);
    expect(document.getElementById('chart-tip')).toBeNull();
    expect(xhair()).toBeNull();
    unbind = () => {};
  });

  it('style.css: pointer-transparent, never animated, wraps on \\n', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const start = css.indexOf('\n#chart-tip {');
    const rule = start < 0 ? '' : css.slice(start, css.indexOf('}', start));
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/white-space:\s*pre-line/);
    // reduced motion holds trivially: the readout never transitions
    expect(rule).not.toMatch(/transition|animation/);
    expect(css).toContain('#chart-tip[hidden] {');
  });

  it('I3: a structured readout renders a muted header, then a swatch, name and bold value per row, from text only', () => {
    move(rowsHit(), 30, 90);
    expect(tip().querySelector('.chart-tip-head')!.textContent).toBe('10:10');
    const rows = [...tip().querySelectorAll('.chart-tip-row')];
    expect(rows).toHaveLength(3);
    expect(rows.map(r => [r.querySelector('.chart-tip-name')!.textContent, r.querySelector('.chart-tip-value')!.textContent])).toEqual([
      ['checkout', '180 ms'], ['<img src=x onerror=alert(1)>', '—'], ['total', '180 ms'],
    ]);
    // the swatch takes the series class, never an inline colour; the total row has none
    expect(rows.map(r => r.querySelector('.chart-tip-swatch')!.getAttribute('class'))).toEqual([
      'chart-tip-swatch series-1', 'chart-tip-swatch series-2', 'chart-tip-swatch chart-tip-none',
    ]);
    expect(tip().querySelector('img')).toBeNull();
    expect(tip().innerHTML).not.toMatch(/style=/);
    // the plain data-tip stays on the mark for assistive tech and tests
    expect(rowsHit().getAttribute('data-tip')).toContain('checkout: 180 ms');
    // back to a plain mark: plain text again
    move(bar(), 100, 50);
    expect(tip().querySelector('.chart-tip-row')).toBeNull();
    expect(tip().textContent).toBe('us-east 1,284');
  });

  it('I3: a timeseries crosshair puts a ringed dot on each series with a point there', () => {
    move(rowsHit(), 30, 90);
    const dots = [...svg.querySelectorAll('.chart-plot > g.chart-xhair > circle')];
    expect(dots.map(c => [c.getAttribute('class'), c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('r'), c.getAttribute('stroke-width')])).toEqual([
      ['chart-dot chart-ring series-1', '30', '20', '4', '2'],
    ]);
    // another column moves the crosshair and its dots; there is only ever one
    move(hit(), 30, 90);
    expect(svg.querySelectorAll('.chart-xhair')).toHaveLength(1);
    expect(svg.querySelectorAll('.chart-xhair circle')).toHaveLength(0);
  });

  it('I3: Export SVG strips the crosshair and its dots with the rest of the hover chrome', async () => {
    // chrome.ts binds its presence popover at import; give it one, as the inspector tests do.
    document.body.insertAdjacentHTML('beforeend', '<div id="presence-pop" hidden></div>');
    const { exportSvgMarkup } = await import('./chrome');
    move(rowsHit(), 30, 90);
    expect(svg.querySelectorAll('.chart-xhair circle')).toHaveLength(1);
    const out = new DOMParser().parseFromString(exportSvgMarkup(svg), 'image/svg+xml');
    expect(out.querySelector('.chart-xhair, .chart-hit, circle')).toBeNull();
  });

  it('style.css: the structured readout is laid out by class, values bold and tabular', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const rule = (sel: string) => {
      const start = css.indexOf(`\n${sel} {`);
      return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
    };
    expect(rule('#chart-tip .chart-tip-head')).toMatch(/color:\s*var\(--muted\)/);
    expect(rule('#chart-tip .chart-tip-swatch')).toMatch(/background:\s*currentColor/);
    expect(rule('#chart-tip .chart-tip-value')).toMatch(/font-weight:\s*600/);
    expect(rule('#chart-tip .chart-tip-value')).toMatch(/text-align:\s*right/);
  });
});
