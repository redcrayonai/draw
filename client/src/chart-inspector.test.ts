import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type Mock } from 'vitest';
import type { Chart, CodeRef, Node } from './module_bindings/types';
import type { RefSummary } from './refs';
import type { InspectorActions, InspectorModel } from './chrome';
import type { ChartPatch } from './ops';
import { CHART_CONTRACTS, CHART_TYPES, parseChart } from '../../module/src/chart-contracts';
import { GRID_MAX_ROWS, VALIDATE_MS, resetChartDraft } from './chart-inspector';

// The CODE section highlights snippets through shiki; a plain block is enough here.
vi.mock('./highlight', async importOriginal => {
  const real = await importOriginal<typeof import('./highlight')>();
  return {
    ...real,
    highlightSnippet: async (code: string) => {
      const d = document.createElement('div');
      d.className = 'code-block';
      d.textContent = code;
      return d;
    },
  };
});

type Chrome = typeof import('./chrome');
let chrome: Chrome;

beforeAll(async () => {
  // chrome.ts dereferences these in its module body.
  document.body.innerHTML = `
    <div id="error-strip" hidden><span id="error-text"></span><button id="error-dismiss"></button></div>
    <button id="participants-label"><span id="participant-chips"></span></button>
    <div id="presence-pop" hidden></div>
    <aside id="inspector" hidden tabindex="0"></aside>`;
  chrome = await import('./chrome');
});

const TS = 'time,p50,p99\n10:00,12,40\n10:05,13,42\n10:10,11,39';

function mkNode(id: number, over: Partial<Node> = {}): Node {
  return {
    id: BigInt(id), boardId: 1n, label: `node-${id}`, sublabel: `sub-${id}`, x: 0, y: 0, w: 160, h: 80,
    token: 'ink', focal: false, kind: 'service', doc: '', hidden: false, imported: false,
    shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '', ...over,
  };
}

const chartNode = mkNode(1, { kind: 'chart', label: 'p99 latency', sublabel: 'checkout', w: 352, h: 224 });

function mkChart(over: Partial<Chart> = {}, at = 1n): Chart {
  return {
    nodeId: 1n, boardId: 1n, type: 'timeseries', csv: TS, options: '{}', source: 'agent: k6 run @ 4f2c1d0',
    updatedAt: { microsSinceUnixEpoch: at } as unknown as Chart['updatedAt'], ...over,
  };
}

/** The chart row the model hands out; tests swap it to play a remote update. */
let row: Chart | undefined;

function mkModel(over: Partial<InspectorModel> = {}): InspectorModel {
  return {
    nodes: [chartNode], edges: [], nodesById: new Map([[chartNode.id, chartNode]]), participants: [],
    refsByTarget: new Map(), session: null, expandedRef: null, editorScheme: 'vscode', deletedPaths: new Set(),
    refRow: () => undefined, chartRow: id => (id === chartNode.id ? row : undefined), ...over,
  };
}

type Actions = InspectorActions & {
  copyRef: Mock<(ref: RefSummary) => Promise<boolean>>;
  setChartData: Mock<(nodeId: bigint, patch: ChartPatch) => Promise<void>>;
};

function mkActions(): Actions {
  return {
    hideEdges: vi.fn(),
    hideNodes: vi.fn(),
    deleteEdges: vi.fn(),
    expandRef: vi.fn(),
    copyRef: vi.fn<(ref: RefSummary) => Promise<boolean>>().mockResolvedValue(true),
    setChartData: vi.fn<(nodeId: bigint, patch: ChartPatch) => Promise<void>>().mockResolvedValue(undefined),
  };
}

let acts: Actions;
const insp = () => document.getElementById('inspector') as HTMLElement;
const render = (model = mkModel(), node = chartNode) => chrome.renderInspector([node], [], model, acts);
const q = <T extends HTMLElement = HTMLInputElement>(act: string) => insp().querySelector<T>(`[data-act="${act}"]`);
const typeInto = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  field.focus();
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
};
const enter = (target: HTMLElement) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
const draftError = () => insp().querySelector<HTMLElement>('[data-role="draft-error"]')!;
const typeError = () => insp().querySelector<HTMLElement>('[data-role="type-error"]')!;
/** parseChart's sentence for this input, or '' when it parses. */
const sentence = (type: string, csv: string, options = '{}') => {
  const r = parseChart(type, csv, options);
  return r.ok ? '' : r.error;
};
/** Let a rejected save settle (microtasks only; fake timers stay put). */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  (document.activeElement as HTMLElement | null)?.blur();
  vi.useFakeTimers();
  chrome.resetInspectorMemo();
  resetChartDraft();
  document.documentElement.dataset.theme = 'dark';
  row = mkChart();
  acts = mkActions();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chart inspector layout', () => {
  it('shows CHART, the title, the type chip, the four sections and the source', () => {
    expect(sentence('timeseries', TS)).toBe('');
    render();
    expect(insp().hidden).toBe(false);
    expect([...insp().querySelectorAll('.eyebrow')].map(e => e.textContent)).toEqual(['CHART', 'TYPE', 'OPTIONS', 'DATA', 'SOURCE']);
    expect(insp().querySelector('.insp-title')!.textContent).toBe('p99 latency');
    expect([...insp().querySelectorAll('.insp-chip')].map(c => c.textContent)).toEqual(['timeseries']);
    expect(insp().querySelector('.insp-provtext')!.textContent).toBe('source: agent: k6 run @ 4f2c1d0');
    expect(q('chart-source')!.value).toBe('agent: k6 run @ 4f2c1d0');
    expect(draftError().hidden).toBe(true);
    expect(typeError().hidden).toBe(true);
    expect(insp().querySelector('.insp-actions')!.textContent).toBe('hide node…');
  });

  it('a public example shows the data with every control disabled and no actions', () => {
    render(mkModel({ readOnly: true }));
    const view = insp().querySelector<HTMLFieldSetElement>('fieldset.chart-view-only')!;
    expect(view.disabled).toBe(true);
    expect(view.querySelector('.chart-form')).not.toBeNull();
    expect(q('chart-source')!.value).toBe('agent: k6 run @ 4f2c1d0');
    expect(insp().querySelector('.insp-actions')).toBeNull();
  });

  it('a chart whose row has not loaded shows a note and no form', () => {
    row = undefined;
    render();
    expect(insp().querySelector('.chart-form')).toBeNull();
    expect(insp().textContent).toContain('chart data has not loaded yet');
    expect([...insp().querySelectorAll('.insp-chip')].map(c => c.textContent)).toEqual(['chart']);
  });

  it('the type list is the eight contracts, in order, by title', () => {
    render();
    const sel = q<HTMLSelectElement>('chart-type')!;
    expect([...sel.options].map(o => o.value)).toEqual([...CHART_TYPES]);
    expect([...sel.options].map(o => o.textContent)).toEqual(CHART_TYPES.map(t => CHART_CONTRACTS[t].title));
    expect(sel.value).toBe('timeseries');
    expect(sel.getAttribute('aria-label')).toBe('chart type');
  });

  it('sample data says so in the provenance line and under the source field', () => {
    row = mkChart({ source: 'sample' });
    render();
    expect(insp().querySelector('.insp-provtext')!.textContent).toBe('sample data · edit it to use your own');
    expect(insp().textContent).toContain('sample data: your first data edit replaces this source with your name');
  });

  it("the provenance glyph follows the chart's source, not the board", () => {
    const glyph = () => [...insp().querySelector('.insp-glyph')!.classList].filter(c => c !== 'insp-glyph');
    const session = { repoRoot: '/repo' } as unknown as InspectorModel['session'];
    for (const [source, who] of [['human:alan', 'human'], ['agent: k6 run @ 4f2c1d0', 'agent'], ['sample', 'sample'], ['  HUMAN:bo', 'human'], ['  Agent: bench', 'agent']]) {
      for (const model of [mkModel(), mkModel({ session })]) {
        chrome.resetInspectorMemo();
        row = mkChart({ source });
        render(model);
        expect(glyph(), `${source} ${model.session ? 'session' : 'board'}`).toEqual([who]);
      }
    }
  });

  it('a source with no human: or agent: prefix gets the neutral glyph, not the agent one', () => {
    for (const source of ['k6 on staging', 'grafana export', 'npm run bench @ 4f2c1d0']) {
      chrome.resetInspectorMemo();
      row = mkChart({ source });
      render();
      expect([...insp().querySelector('.insp-glyph')!.classList], source).toEqual(['insp-glyph', 'sample']);
      expect(insp().querySelector('.insp-provtext')!.textContent).toBe(`source: ${source}`);
    }
  });

  it("shows the node's doc like any other node", () => {
    const withDoc = { ...chartNode, doc: 'p99 measured with k6 against staging' };
    chrome.renderInspector([withDoc], [], mkModel({ nodes: [withDoc], nodesById: new Map([[withDoc.id, withDoc]]) }), acts);
    expect([...insp().querySelectorAll('.eyebrow')].map(e => e.textContent)).toEqual(['CHART', 'TYPE', 'OPTIONS', 'DATA', 'SOURCE', 'DOC']);
    expect(insp().querySelector('.insp-body')!.textContent).toBe('p99 measured with k6 against staging');
  });
});

describe('switching the type', () => {
  it('a type the data does not fit shows the parser sentence and saves nothing', () => {
    render();
    const sel = q<HTMLSelectElement>('chart-type')!;
    sel.value = 'waterfall';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const want = sentence('waterfall', TS);
    expect(want).not.toBe('');
    expect(typeError().hidden).toBe(false);
    expect(typeError().textContent).toBe(want);
    expect(sel.value).toBe('timeseries');
    expect(acts.setChartData).not.toHaveBeenCalled();
  });

  it('a type that fits saves at once and keeps only the options the new type knows', () => {
    const csv = 'route,p99\n/cart,388\n/checkout,412';
    row = mkChart({ type: 'bars', csv, options: '{"layout":"grouped","unit":"ms"}' });
    expect(sentence('bars', csv, row.options)).toBe('');
    expect(sentence('toplist', csv, '{"unit":"ms"}')).toBe('');
    render();
    const sel = q<HTMLSelectElement>('chart-type')!;
    sel.value = 'toplist';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { type: 'toplist', options: '{"unit":"ms"}' });
    expect(typeError().hidden).toBe(true);
    expect(q('chart-opt-limit')).not.toBeNull();
    expect(q('chart-opt-layout-grouped')).toBeNull();
  });
});

describe('switching the type from the keyboard', () => {
  const arrowTo = (sel: HTMLSelectElement, type: string) => {
    sel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    sel.value = type; // Windows/Linux: an arrow moves the closed select and fires change
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('arrows only preview; a type that does not fit names why and the next arrow moves on; blur commits', () => {
    expect(sentence('bars', TS)).toBe('');
    expect(sentence('toplist', TS)).not.toBe('');
    expect(sentence('table', TS)).toBe('');
    render();
    const sel = q<HTMLSelectElement>('chart-type')!;
    sel.focus();
    arrowTo(sel, 'bars');
    expect(acts.setChartData).not.toHaveBeenCalled();
    arrowTo(sel, 'toplist');
    expect(typeError().hidden).toBe(false);
    expect(typeError().textContent).toBe(sentence('toplist', TS));
    expect(sel.value).toBe('toplist'); // not snapped back: the next arrow reaches the later types
    for (const t of ['pie', 'treemap', 'table']) arrowTo(sel, t);
    expect(typeError().hidden).toBe(true);
    expect(acts.setChartData).not.toHaveBeenCalled();
    sel.blur();
    expect(acts.setChartData).toHaveBeenCalledTimes(1);
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { type: 'table' });
  });

  it('Enter commits the previewed type; a previewed type that does not fit is refused and the select goes back', () => {
    render();
    const sel = q<HTMLSelectElement>('chart-type')!;
    sel.focus();
    arrowTo(sel, 'waterfall');
    enter(sel);
    expect(acts.setChartData).not.toHaveBeenCalled();
    expect(sel.value).toBe('timeseries');
    expect(typeError().textContent).toBe(sentence('waterfall', TS));
    arrowTo(sel, 'bars');
    enter(sel);
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { type: 'bars' });
  });

  it('a pointer choice still saves at once', () => {
    render();
    const sel = q<HTMLSelectElement>('chart-type')!;
    sel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    sel.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    sel.value = 'bars';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { type: 'bars' });
  });
});

describe('options from the contract', () => {
  it('an enum is a segmented control with aria-pressed that saves on click', () => {
    render();
    expect(q('chart-opt-style-line')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('chart-opt-style-area')!.getAttribute('aria-pressed')).toBe('false');
    q<HTMLButtonElement>('chart-opt-style-area')!.click();
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { options: '{"style":"area"}' });
    expect(q('chart-opt-style-area')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('chart-opt-style-line')!.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(q('chart-opt-style-area'));
  });

  it('a boolean is a toggle with aria-pressed that saves on click', () => {
    const csv = 'region,requests\nus,50\neu,30\nap,20';
    row = mkChart({ type: 'pie', csv });
    expect(sentence('pie', csv)).toBe('');
    render();
    const toggle = q<HTMLButtonElement>('chart-opt-donut')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toBe('on');
    toggle.click();
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { options: '{"donut":false}' });
    expect(q('chart-opt-donut')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('a string option waits for Enter, not each keystroke', () => {
    render();
    const unit = q('chart-opt-unit')!;
    typeInto(unit, 'ms');
    vi.advanceTimersByTime(VALIDATE_MS);
    expect(acts.setChartData).not.toHaveBeenCalled();
    enter(unit);
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { options: '{"unit":"ms"}' });
  });

  it('an integer out of range shows the sentence and does not save; a good value saves on blur', () => {
    const csv = 'route,p99\n/cart,388\n/checkout,412';
    row = mkChart({ type: 'toplist', csv });
    render();
    const limit = q('chart-opt-limit')!;
    const spec = CHART_CONTRACTS.toplist.options.find(o => o.name === 'limit')!;
    expect([limit.type, limit.min, limit.max]).toEqual(['number', String(spec.min), String(spec.max)]);
    typeInto(limit, '30');
    vi.advanceTimersByTime(VALIDATE_MS);
    const want = sentence('toplist', csv, '{"limit":30}');
    expect(want).not.toBe('');
    expect(draftError().textContent).toBe(want);
    limit.blur();
    expect(acts.setChartData).not.toHaveBeenCalled();
    typeInto(limit, '5');
    limit.blur();
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { options: '{"limit":5}' });
    expect(draftError().hidden).toBe(true);
  });

  it('a number field holding text the browser cannot read is refused, not saved as the default', () => {
    const csv = 'route,p99\n/cart,388\n/checkout,412';
    row = mkChart({ type: 'toplist', csv, options: '{"limit":5}' });
    render();
    const limit = q('chart-opt-limit')!;
    // A browser reports '1e' in a number field as value '' with validity.badInput (jsdom does not).
    Object.defineProperty(limit, 'validity', { value: { badInput: true } });
    typeInto(limit, '');
    limit.blur();
    expect(draftError().textContent).toBe(sentence('toplist', csv, '{"limit":null}'));
    expect(acts.setChartData).not.toHaveBeenCalled();
  });

  it('thresholds take JSON text; text that is not valid is refused with the parser sentence', () => {
    const csv = 'host,cpu\nweb-1,93\nweb-2,41';
    row = mkChart({ type: 'table', csv });
    render();
    const th = q('chart-opt-thresholds')!;
    expect(th.value).toBe('[]');
    const good = '[{"column":"cpu","warn":80,"crit":90,"direction":"above"}]';
    typeInto(th, good);
    enter(th);
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { options: `{"thresholds":${good}}` });
    typeInto(th, '[{"column":');
    enter(th);
    expect(draftError().textContent).toBe(sentence('table', csv, JSON.stringify({ thresholds: '[{"column":' })));
    expect(draftError().hidden).toBe(false);
    expect(acts.setChartData).toHaveBeenCalledTimes(1);
  });
});

describe('the data grid', () => {
  it('shows the header as editable series names and every row', () => {
    render();
    expect(insp().querySelectorAll('.chart-data-grid tr')).toHaveLength(4);
    expect(q('chart-cell-0-2')!.value).toBe('p99');
    expect(q('chart-cell-3-1')!.value).toBe('11');
    expect(q('chart-cell-0-1')!.getAttribute('aria-label')).toBe('column 2 name');
    expect(q('chart-cell-1-1')!.getAttribute('aria-label')).toBe('p50, row 1');
  });

  it('an invalid cell waits 150 ms, shows the sentence, and is never saved', () => {
    render();
    const cell = q('chart-cell-2-2')!;
    typeInto(cell, '42ms');
    vi.advanceTimersByTime(VALIDATE_MS - 1);
    expect(draftError().hidden).toBe(true);
    vi.advanceTimersByTime(1);
    const bad = 'time,p50,p99\n10:00,12,40\n10:05,13,42ms\n10:10,11,39';
    expect(sentence('timeseries', bad)).not.toBe('');
    expect(draftError().textContent).toBe(sentence('timeseries', bad));
    expect(q<HTMLTextAreaElement>('chart-csv')!.value).toBe(bad);
    enter(cell);
    cell.blur();
    expect(acts.setChartData).not.toHaveBeenCalled();
  });

  it('Enter saves a valid cell and moves down the column; the blur that follows sends nothing more', () => {
    render();
    const cell = q('chart-cell-1-2')!;
    typeInto(cell, '41');
    enter(cell);
    expect(acts.setChartData).toHaveBeenCalledTimes(1);
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { csv: 'time,p50,p99\n10:00,12,41\n10:05,13,42\n10:10,11,39' });
    expect(document.activeElement).toBe(q('chart-cell-2-2'));
    q('chart-cell-2-2')!.blur();
    expect(acts.setChartData).toHaveBeenCalledTimes(1);
  });

  it('blur saves a renamed series', () => {
    render();
    const head = q('chart-cell-0-1')!;
    typeInto(head, 'median');
    head.blur();
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { csv: 'time,median,p99\n10:00,12,40\n10:05,13,42\n10:10,11,39' });
  });

  it('+ row adds an empty row, focuses it and saves nothing', () => {
    render();
    q<HTMLButtonElement>('chart-add-row')!.click();
    expect(insp().querySelectorAll('.chart-data-grid tr')).toHaveLength(5);
    expect(document.activeElement).toBe(q('chart-cell-4-0'));
    // The draft holds the CSV as parseCsv reads it, so the blank record the
    // new row would add is not in it (BUG3) and the draft stays valid.
    const csv = q<HTMLTextAreaElement>('chart-csv')!.value;
    expect(csv).toBe(TS);
    expect(draftError().textContent).toBe(sentence('timeseries', csv));
    expect(acts.setChartData).not.toHaveBeenCalled();
  });

  it('BUG3: the blur after + row saves nothing and keeps the empty row', () => {
    render();
    q<HTMLButtonElement>('chart-add-row')!.click();
    q('chart-cell-4-0')!.blur();
    expect(acts.setChartData).not.toHaveBeenCalled();
    expect(insp().querySelectorAll('.chart-data-grid tr')).toHaveLength(5);
    // the row counts once it holds something
    typeInto(q('chart-cell-4-0')!, '10:15');
    typeInto(q('chart-cell-4-1')!, '14');
    typeInto(q('chart-cell-4-2')!, '44');
    q('chart-cell-4-2')!.blur();
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { csv: `${TS}\n10:15,14,44` });
  });

  it('adding a blank row to sample CSV preserves its trailing newline and source', () => {
    const csv = CHART_CONTRACTS.timeseries.example;
    row = mkChart({ csv, source: 'sample' });
    render();
    const rows = insp().querySelectorAll('.chart-data-grid tr').length;
    q<HTMLButtonElement>('chart-add-row')!.click();
    (document.activeElement as HTMLElement).blur();
    expect(acts.setChartData).not.toHaveBeenCalled();
    expect(q<HTMLTextAreaElement>('chart-csv')!.value).toBe(csv);
    expect(q('chart-source')!.value).toBe('sample');
    expect(insp().querySelectorAll('.chart-data-grid tr')).toHaveLength(rows + 1);
    typeInto(q('chart-source')!, 'human:alice');
    q('chart-source')!.blur();
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { source: 'human:alice' });
  });

  it('BUG3: a blank new row is left out of a save another field triggers', () => {
    render();
    q<HTMLButtonElement>('chart-add-row')!.click();
    typeInto(q('chart-source')!, 'human:alice');
    q('chart-source')!.blur();
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { source: 'human:alice' });
    // The echo reads as this client's own save: the CSV box and the grid still
    // agree, and nothing stored a line the paint would drop.
    row = mkChart({ source: 'human:alice' }, 2n);
    chrome.resetInspectorMemo();
    render();
    expect(q<HTMLTextAreaElement>('chart-csv')!.value).toBe(TS);
    expect(q('chart-source')!.value).toBe('human:alice');
  });

  it('BUG3: emptying every cell of a row keeps the CSV as typed, so the error names it', () => {
    render();
    for (const c of [0, 1, 2]) typeInto(q(`chart-cell-2-${c}`)!, '');
    vi.advanceTimersByTime(VALIDATE_MS);
    expect(q<HTMLTextAreaElement>('chart-csv')!.value).toBe('time,p50,p99\n10:00,12,40\n,,\n10:10,11,39');
    expect(draftError().textContent).toBe('row 3 is blank; delete it or fill it in');
    q('chart-cell-2-0')!.blur();
    expect(acts.setChartData).not.toHaveBeenCalled();
  });

  it('+ series adds a named column, focuses its name and saves nothing until blur', () => {
    render();
    q<HTMLButtonElement>('chart-add-series')!.click();
    const head = q('chart-cell-0-3')!;
    expect(head.value).toBe('series 3');
    expect(document.activeElement).toBe(head);
    expect(q<HTMLTextAreaElement>('chart-csv')!.value)
      .toBe('time,p50,p99,series 3\n10:00,12,40,\n10:05,13,42,\n10:10,11,39,');
    expect(acts.setChartData).not.toHaveBeenCalled();
  });

  it('a row delete saves at once', () => {
    render();
    const del = q<HTMLButtonElement>('chart-del-1')!;
    expect(del.getAttribute('aria-label')).toBe('delete row 1');
    del.click();
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { csv: 'time,p50,p99\n10:05,13,42\n10:10,11,39' });
    expect(insp().querySelectorAll('.chart-data-grid tr')).toHaveLength(3);
  });

  it('a row delete keeps focus in the grid: the next row, or the row above when it was the last', () => {
    render();
    q<HTMLButtonElement>('chart-del-2')!.focus();
    q<HTMLButtonElement>('chart-del-2')!.click();
    expect(document.activeElement).toBe(q('chart-del-2')); // row 3 moved up
    q<HTMLButtonElement>('chart-del-2')!.click();
    expect(document.activeElement).toBe(q('chart-del-1'));
    // the echo rebuild keeps it there
    row = mkChart({ csv: 'time,p50,p99\n10:00,12,40' }, 2n);
    render();
    expect(document.activeElement).toBe(q('chart-del-1'));
  });

  it('× buttons are out of the tab order; Alt+Backspace in a cell deletes its row and keeps the column', () => {
    row = mkChart({ csv: `${TS}\n10:15,10,38` });
    render();
    expect(q('chart-del-1')!.tabIndex).toBe(-1);
    expect(q('chart-cell-1-1')!.getAttribute('aria-description')).toBe('Alt+Backspace deletes this row');
    expect(q('chart-cell-0-1')!.hasAttribute('aria-description')).toBe(false);
    const altBackspace = (cell: HTMLElement) => {
      cell.focus();
      const evt = new KeyboardEvent('keydown', { key: 'Backspace', altKey: true, bubbles: true, cancelable: true });
      cell.dispatchEvent(evt);
      return evt;
    };
    expect(altBackspace(q('chart-cell-1-1')!).defaultPrevented).toBe(true);
    expect(acts.setChartData).toHaveBeenLastCalledWith(1n, { csv: 'time,p50,p99\n10:05,13,42\n10:10,11,39\n10:15,10,38' });
    expect(document.activeElement).toBe(q('chart-cell-1-1'));
    expect(q('chart-cell-1-1')!.value).toBe('13');
    altBackspace(q('chart-cell-3-2')!); // the last row: focus goes up
    expect(acts.setChartData).toHaveBeenLastCalledWith(1n, { csv: 'time,p50,p99\n10:05,13,42\n10:10,11,39' });
    expect(document.activeElement).toBe(q('chart-cell-2-2'));
    // the header row is not a data row
    altBackspace(q('chart-cell-0-1')!);
    expect(acts.setChartData).toHaveBeenCalledTimes(2);
  });

  it('a paste in the CSV box saves the pasted text once it lands, and refills the grid', () => {
    const pasted = 'time\tp50\tp99\n10:00\t12\t40\n10:05\t13\t44';
    expect(sentence('timeseries', pasted)).toBe('');
    render();
    const ta = q<HTMLTextAreaElement>('chart-csv')!;
    ta.closest('details')!.open = true;
    ta.focus();
    ta.value = pasted; // jsdom has no ClipboardEvent: the value is what a paste leaves
    ta.dispatchEvent(new Event('paste', { bubbles: true }));
    expect(acts.setChartData).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { csv: pasted });
    expect(q('chart-cell-2-2')!.value).toBe('44');
  });

  it('typing in the CSV box refills the grid after the pause and saves on blur', () => {
    render();
    const ta = q<HTMLTextAreaElement>('chart-csv')!;
    const next = 'time,p50,p99\n10:00,12,40\n10:05,13,42\n10:10,11,38';
    typeInto(ta, next);
    expect(q('chart-cell-3-2')!.value).toBe('39');
    vi.advanceTimersByTime(VALIDATE_MS);
    expect(q('chart-cell-3-2')!.value).toBe('38');
    expect(acts.setChartData).not.toHaveBeenCalled();
    ta.blur();
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { csv: next });
  });

  it('a blur inside the pause still refills the grid', () => {
    render();
    const ta = q<HTMLTextAreaElement>('chart-csv')!;
    const next = 'time,p50,p99\n10:00,12,40\n10:05,13,42\n10:10,11,38';
    typeInto(ta, next);
    ta.blur(); // saves at once
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { csv: next });
    vi.advanceTimersByTime(VALIDATE_MS);
    expect(q('chart-cell-3-2')!.value).toBe('38');
  });

  it('Tab from the CSV box inside the pause lands on a fresh grid; a cell edit keeps the CSV box edit', () => {
    render();
    const ta = q<HTMLTextAreaElement>('chart-csv')!;
    const next = 'time,p50,p99\n10:00,12,40\n10:05,13,42\n10:10,11,38';
    typeInto(ta, next);
    ta.blur();
    q('chart-cell-0-0')!.focus(); // where Tab lands
    expect(document.activeElement).toBe(q('chart-cell-0-0'));
    expect(q('chart-cell-3-2')!.value).toBe('38');
    row = mkChart({ csv: next }, 2n); // the echo, held while a cell has focus
    render();
    const cell = q('chart-cell-1-1')!;
    typeInto(cell, '15');
    cell.blur();
    expect(acts.setChartData).toHaveBeenLastCalledWith(1n, { csv: 'time,p50,p99\n10:00,15,40\n10:05,13,42\n10:10,11,38' });
  });

  it('style.css: the grid fills its bordered scroller, so row hairlines span the box', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, encoding: 'utf8'): string };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const start = css.indexOf('\n.chart-data-grid {');
    expect(start).toBeGreaterThan(0);
    expect(css.slice(start, css.indexOf('}', start))).toMatch(/width:\s*100%/);
  });

  it('above 50 rows the grid is read-only and "edit as text" opens the CSV box', () => {
    const lines = Array.from({ length: GRID_MAX_ROWS + 10 }, (_, i) => `${1760000000000 + i * 60000},${i}`);
    const csv = ['time,rps', ...lines].join('\n');
    expect(sentence('timeseries', csv)).toBe('');
    row = mkChart({ csv });
    render();
    // only the first 50 rows are drawn; the rest are a count
    expect(insp().querySelectorAll('.chart-data-grid tr')).toHaveLength(GRID_MAX_ROWS + 1);
    expect(insp().querySelectorAll('.chart-data-grid input')).toHaveLength(0);
    expect(q('chart-add-row')).toBeNull();
    expect(insp().querySelector('.chart-data-grid-note')!.textContent).toBe('+10 more rows — edit as text');
    // a typing pause that leaves the CSV as it was does not draw the grid again
    const table = insp().querySelector('.chart-data-grid');
    typeInto(q<HTMLTextAreaElement>('chart-csv')!, csv);
    vi.advanceTimersByTime(VALIDATE_MS);
    expect(insp().querySelector('.chart-data-grid')).toBe(table);
    q<HTMLButtonElement>('chart-edit-text')!.click();
    const ta = q<HTMLTextAreaElement>('chart-csv')!;
    expect(ta.closest('details')!.open).toBe(true);
    expect(document.activeElement).toBe(ta);
  });
});

describe('the source field', () => {
  it('saves on Enter; empty asks the server for your name; over 200 characters is refused', () => {
    render();
    const src = q('chart-source')!;
    expect(src.getAttribute('aria-label')).toBe('chart data source');
    typeInto(src, 'prometheus: checkout p99');
    enter(src);
    expect(acts.setChartData).toHaveBeenLastCalledWith(1n, { source: 'prometheus: checkout p99' });
    typeInto(src, '');
    enter(src);
    expect(acts.setChartData).toHaveBeenLastCalledWith(1n, { source: '' });
    typeInto(src, 'x'.repeat(201));
    vi.advanceTimersByTime(VALIDATE_MS);
    expect(draftError().textContent).toBe('source is 201 characters; the limit is 200');
    enter(src);
    expect(acts.setChartData).toHaveBeenCalledTimes(2);
  });
});

describe('saving', () => {
  it('a rejected save shows the server sentence and tries again on the next blur', async () => {
    const msg = "timeseries allows at most 5 series; got 7 — fold the smallest into 'other' or split into two charts";
    acts.setChartData.mockRejectedValueOnce(new Error(msg));
    render();
    const cell = q('chart-cell-1-1')!;
    typeInto(cell, '15');
    cell.blur();
    await settle();
    expect(draftError().textContent).toBe(msg);
    expect(draftError().hidden).toBe(false);
    cell.focus();
    cell.blur();
    expect(acts.setChartData).toHaveBeenCalledTimes(2);
    expect(acts.setChartData.mock.calls[1]).toEqual([1n, { csv: 'time,p50,p99\n10:00,15,40\n10:05,13,42\n10:10,11,39' }]);
  });
});

describe('remote updates and focus', () => {
  const remote = 'time,p50,p99\n10:00,99,40\n10:05,13,42\n10:10,11,39';

  it('an earlier save echo cannot replace later queued edits or the next CSV save', async () => {
    const complete: Array<() => void> = [];
    acts.setChartData.mockImplementation(() => new Promise<void>(resolve => complete.push(resolve)));
    render();
    typeInto(q('chart-cell-1-1')!, '15');
    enter(q('chart-cell-1-1')!);
    typeInto(q('chart-cell-2-1')!, '14');
    enter(q('chart-cell-2-1')!);
    row = mkChart({ csv: acts.setChartData.mock.calls[0][1].csv }, 2n);
    complete[0]();
    await settle();
    render();
    expect(q('chart-cell-2-1')!.value).toBe('14');
    typeInto(q('chart-cell-3-1')!, '17');
    enter(q('chart-cell-3-1')!);
    const csv = 'time,p50,p99\n10:00,15,40\n10:05,14,42\n10:10,17,39';
    expect(acts.setChartData.mock.calls[2]).toEqual([1n, { csv }]);
    row = mkChart({ csv: acts.setChartData.mock.calls[1][1].csv }, 3n);
    complete[1]();
    await settle();
    render();
    expect(q('chart-cell-3-1')!.value).toBe('17');
    row = mkChart({ csv, source: 'human:me' }, 4n);
    complete[2]();
    await settle();
    render();
    expect(q('chart-source')!.value).toBe('human:me');
    row = mkChart({ csv: remote, source: 'agent: new' }, 5n);
    render();
    expect(q('chart-cell-1-1')!.value).toBe('99');
  });

  it('a data save echo keeps a Source edit that is still pending', async () => {
    const complete: Array<() => void> = [];
    acts.setChartData.mockImplementation(() => new Promise<void>(resolve => complete.push(resolve)));
    row = mkChart({ source: 'sample' });
    render();
    typeInto(q('chart-cell-1-1')!, '15');
    enter(q('chart-cell-1-1')!);
    typeInto(q('chart-source')!, 'human:me — spreadsheet');
    q('chart-source')!.blur();
    row = mkChart({ csv: acts.setChartData.mock.calls[0][1].csv, source: 'human:me' }, 2n);
    complete[0]();
    await settle();
    render();
    expect(q('chart-source')!.value).toBe('human:me — spreadsheet');
    row = mkChart({ csv: row.csv, source: 'human:me — spreadsheet' }, 3n);
    complete[1]();
    await settle();
    render();
    expect(q('chart-source')!.value).toBe('human:me — spreadsheet');
  });

  it('typing never rebuilds the panel; a remote update waits until no field has focus', async () => {
    render();
    const cell = q('chart-cell-1-1')!;
    typeInto(cell, '15');
    row = mkChart({ csv: remote }, 2n);
    render();
    expect(q('chart-cell-1-1')).toBe(cell);
    expect(cell.value).toBe('15');
    expect(document.activeElement).toBe(cell);
    cell.blur(); // saves the local edit; the server keeps the last write
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { csv: 'time,p50,p99\n10:00,15,40\n10:05,13,42\n10:10,11,39' });
    await settle();
    render();
    expect(q('chart-cell-1-1')).not.toBe(cell);
    expect(q('chart-cell-1-1')!.value).toBe('99');
  });

  it('a focused cell with nothing typed takes a remote update; focus stays and the next save builds on it', () => {
    render();
    q('chart-cell-3-1')!.focus();
    row = mkChart({ csv: remote, source: 'agent: new' }, 2n);
    render();
    expect(q('chart-cell-1-1')!.value).toBe('99');
    expect(q('chart-source')!.value).toBe('agent: new');
    expect(document.activeElement).toBe(q('chart-cell-3-1'));
    const cell = q('chart-cell-2-2')!;
    typeInto(cell, '50');
    enter(cell);
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { csv: 'time,p50,p99\n10:00,99,40\n10:05,13,50\n10:10,11,39' });
  });

  it('a blur from a field the rebuild removed saves nothing; the draft and focus carry over', () => {
    render();
    const cell = q('chart-cell-1-1')!;
    typeInto(cell, '15');
    const renamed = { ...chartNode, label: 'p99 latency (ms)' };
    chrome.renderInspector([renamed], [], mkModel({ nodes: [renamed], nodesById: new Map([[renamed.id, renamed]]) }), acts);
    cell.dispatchEvent(new FocusEvent('blur')); // Chrome fires it on the removed field
    expect(acts.setChartData).not.toHaveBeenCalled();
    expect(q('chart-cell-1-1')!.value).toBe('15');
    expect(document.activeElement).toBe(q('chart-cell-1-1'));
  });

  it('a rebuild for another reason keeps the draft and gives focus back to the same cell', () => {
    render();
    typeInto(q('chart-cell-1-1')!, '15');
    const renamed = { ...chartNode, label: 'p99 latency (ms)' };
    chrome.renderInspector([renamed], [], mkModel({ nodes: [renamed], nodesById: new Map([[renamed.id, renamed]]) }), acts);
    expect(insp().querySelector('.insp-title')!.textContent).toBe('p99 latency (ms)');
    const again = q('chart-cell-1-1')!;
    expect(again.value).toBe('15');
    expect(document.activeElement).toBe(again);
  });

  it('with no field focused, the same row keeps the panel and a newer row replaces it', () => {
    render();
    const before = q('chart-cell-1-1')!;
    render();
    expect(q('chart-cell-1-1')).toBe(before);
    row = mkChart({ csv: remote }, 2n);
    render();
    expect(q('chart-cell-1-1')).not.toBe(before);
    expect(q('chart-cell-1-1')!.value).toBe('99');
  });

  it('the echo of this client\'s own save keeps the unsaved edit typed after it', async () => {
    render();
    const first = q('chart-cell-1-1')!;
    typeInto(first, '15');
    enter(first); // saves; focus moves to cell 2-1
    const saved = 'time,p50,p99\n10:00,15,40\n10:05,13,42\n10:10,11,39';
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { csv: saved });
    await settle();
    row = mkChart({ csv: saved }, 2n); // the echo, held while a cell has focus
    render();
    const next = q('chart-cell-2-1')!;
    expect(document.activeElement).toBe(next);
    typeInto(next, 'abc');
    next.blur(); // invalid: not saved
    render();
    expect(q('chart-cell-2-1')!.value).toBe('abc');
    expect(q('chart-cell-1-1')!.value).toBe('15');
    expect(draftError().hidden).toBe(false);
    expect(draftError().textContent).toBe(sentence('timeseries', 'time,p50,p99\n10:00,15,40\n10:05,abc,42\n10:10,11,39'));
    expect(acts.setChartData).toHaveBeenCalledTimes(1);
    row = mkChart({ csv: remote }, 3n); // a remote write still wins once no field has focus
    render();
    expect(q('chart-cell-2-1')!.value).toBe('13');
    expect(q('chart-cell-1-1')!.value).toBe('99');
  });

  it('the echo of the first edit on sample data brings the server\'s source and keeps the draft', async () => {
    row = mkChart({ source: 'sample' });
    render();
    const first = q('chart-cell-1-1')!;
    typeInto(first, '15');
    enter(first);
    await settle();
    const saved = 'time,p50,p99\n10:00,15,40\n10:05,13,42\n10:10,11,39';
    row = mkChart({ csv: saved, source: 'Alan Lee' }, 2n); // the server put the editor's name in
    render();
    const next = q('chart-cell-2-1')!;
    typeInto(next, 'abc');
    next.blur();
    render();
    expect(q('chart-cell-2-1')!.value).toBe('abc');
    expect(q('chart-source')!.value).toBe('Alan Lee');
    expect(insp().textContent).not.toContain('sample data: your first data edit');
    expect(acts.setChartData).toHaveBeenCalledTimes(1);
  });

  it('an unsaved draft survives a rebuild; resetChartDraft (board switch) drops it', () => {
    render();
    const cell = q('chart-cell-1-1')!;
    typeInto(cell, 'abc');
    cell.blur(); // invalid: not saved
    expect(acts.setChartData).not.toHaveBeenCalled();
    chrome.resetInspectorMemo();
    render();
    expect(q('chart-cell-1-1')!.value).toBe('abc');
    resetChartDraft();
    chrome.resetInspectorMemo();
    render();
    expect(q('chart-cell-1-1')!.value).toBe('12');
  });
});

// Review Focus 3: a remote write while a human types.
describe('a remote write while a human types', () => {
  const remote = 'time,p50,p99\n10:00,99,40\n10:05,13,42\n10:10,11,39';
  const typed = 'time,p50,p99\n10:00,12,40\n10:05,13,42\n10:10,11,37';
  const nothingSelected = () => chrome.renderInspector([], [], mkModel({ nodes: [], nodesById: new Map() }), acts);
  // Chrome fires blur on a focused field that leaves the DOM; jsdom does not, so the tests fire it.
  const blurOnRemove = (field: HTMLElement) => field.dispatchEvent(new FocusEvent('blur'));

  it('an agent update while the paste box has focus keeps the typed CSV, even through a rebuild', () => {
    render();
    const ta = q<HTMLTextAreaElement>('chart-csv')!;
    ta.closest('details')!.open = true;
    typeInto(ta, typed);
    row = mkChart({ csv: remote }, 2n);
    render();
    expect(q('chart-csv')).toBe(ta);
    // A rebuild for another reason (a label edit) lands at the same time.
    const renamed = { ...chartNode, label: 'p99 latency (ms)' };
    chrome.renderInspector([renamed], [], mkModel({ nodes: [renamed], nodesById: new Map([[renamed.id, renamed]]) }), acts);
    const again = q<HTMLTextAreaElement>('chart-csv')!;
    expect(again).not.toBe(ta);
    expect(again.value).toBe(typed);
    expect(document.activeElement).toBe(again);
    expect(q('chart-cell-1-1')!.value).toBe('12');
    expect(q('chart-cell-3-2')!.value).toBe('37');
    again.blur();
    expect(acts.setChartData).toHaveBeenCalledWith(1n, { csv: typed });
  });

  it('a chart deleted by a collaborator mid-draft is never saved', () => {
    render();
    const cell = q('chart-cell-1-1')!;
    typeInto(cell, '15'); // valid, not yet saved
    const ta = q<HTMLTextAreaElement>('chart-csv')!;
    ta.dispatchEvent(new Event('paste', { bubbles: true })); // its save waits a tick
    row = undefined; // deleting the node deletes its chart row in the same transaction
    nothingSelected();
    blurOnRemove(cell);
    vi.advanceTimersByTime(VALIDATE_MS);
    expect(acts.setChartData).not.toHaveBeenCalled();
  });

  it('a board switch drops a dirty draft: nothing is saved and the stored row comes back', () => {
    render();
    const cell = q('chart-cell-1-1')!;
    typeInto(cell, '15'); // valid, not yet saved
    resetChartDraft(); // main.ts switchBoard
    nothingSelected();
    blurOnRemove(cell);
    vi.advanceTimersByTime(VALIDATE_MS);
    expect(acts.setChartData).not.toHaveBeenCalled();
    render(); // back on the board with the chart selected
    expect(q('chart-cell-1-1')!.value).toBe('12');
    expect(draftError().hidden).toBe(true);
  });
});

describe('keys inside the panel', () => {
  const codeRow: CodeRef = {
    id: 7n, boardId: 1n, targetKind: 'node', targetId: 1n, path: 'bench/k6.js', symbol: 'run', startLine: 1, endLine: 4,
    blobSha: 'a'.repeat(40), snippet: 'export default function run() {}', author: '', checkpoint: 1, status: 'ok',
  };
  const summary: RefSummary = { id: 7n, symbol: 'run', path: 'bench/k6.js', startLine: 1, endLine: 4, checkpoint: 1, status: 'ok' };

  it('c, o and the arrows typed in a chart field stay text', () => {
    render(mkModel({ refsByTarget: new Map([['node:1', [summary]]]), refRow: id => (id === 7n ? codeRow : undefined) }));
    expect(insp().querySelector('[data-act="copy"]')).not.toBeNull();
    const src = q('chart-source')!;
    src.focus();
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    try {
      for (const key of ['c', 'o', 'ArrowDown']) {
        const evt = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        src.dispatchEvent(evt);
        expect(evt.defaultPrevented).toBe(false);
      }
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
    expect(acts.copyRef).not.toHaveBeenCalled();
    expect(onWindow).not.toHaveBeenCalled();
  });

  it('any text field in the panel keeps c (the chrome guard, not only the chart form)', () => {
    const svc = mkNode(2);
    chrome.renderInspector(
      [svc],
      [],
      mkModel({
        nodes: [svc], nodesById: new Map([[svc.id, svc]]),
        refsByTarget: new Map([['node:2', [summary]]]), refRow: id => (id === 7n ? codeRow : undefined),
      }),
      acts
    );
    expect(insp().querySelector('[data-act="copy"]')).not.toBeNull();
    const extra = document.createElement('input');
    insp().append(extra);
    extra.focus();
    const evt = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true });
    extra.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(acts.copyRef).not.toHaveBeenCalled();
  });
});
