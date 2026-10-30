import type { Node, Chart } from './module_bindings/types';
import type { ChartPatch } from './ops';
import {
  CHART_CONTRACTS,
  CHART_TYPES,
  MAX_SOURCE_CHARS,
  SAMPLE_SOURCE,
  isChartType,
  parseChart,
  type ChartType,
  type OptionSpec,
} from '../../module/src/chart-contracts';
import { csvToGrid, gridToCsv } from './chart-grid';

/**
 * The chart inspector form: TYPE, OPTIONS, DATA (CSV box and grid) and
 * SOURCE, all built from the chart's contract. No code here is per type.
 *
 * Edits go to one draft kept outside the DOM, so a panel rebuild never loses
 * typed text. The draft is checked with parseChart after a pause and saved
 * (actions.setChartData) on blur, Enter or paste, only when it is valid and
 * changed. A click on a choice (option button, toggle, type, row delete)
 * saves at once. An invalid draft shows its sentence; the canvas keeps the
 * last good chart.
 */

export interface ChartInspectorActions {
  setChartData: (nodeId: bigint, patch: ChartPatch) => Promise<void>;
}

/** Validation waits this long after the last keystroke. */
export const VALIDATE_MS = 150;
/** Above this many data rows the grid is read-only and the CSV box edits. */
export const GRID_MAX_ROWS = 50;

interface Fields {
  type: string;
  csv: string;
  options: string;
  source: string;
}

const FIELDS = ['type', 'csv', 'options', 'source'] as const;

interface Draft extends Fields {
  nodeId: bigint;
  /** updatedAt (micros) of the row the draft was taken from. */
  base: bigint;
  /** What the server holds, as far as this client knows: a save sends only
   *  the fields that differ from these. */
  saved: Fields;
  /** Saves whose server echoes must not replace newer local edits. */
  pending: number;
  /** The last check's sentence; '' while the draft is valid. */
  error: string;
  pasteOpen: boolean;
  /** Set by resetChartDraft: a blur or paste on the old form saves nothing. */
  dropped?: true;
}

let draft: Draft | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let heldSig = '';

/** Forget the draft (tests; board switch). */
export function resetChartDraft(): void {
  clearTimeout(timer);
  timer = undefined;
  if (draft !== null) {
    draft.dropped = true;
  }
  draft = null;
  heldSig = '';
}

/** True while a text field, number field or select of the chart form has
 *  focus and the draft holds something not yet saved. Focus alone holds
 *  nothing: a clean form takes a remote update (and focus comes back). */
function editing(d: Draft): boolean {
  const a = document.activeElement;
  return a instanceof HTMLElement && a.matches('input, textarea, select') && a.closest('.chart-form') !== null &&
    FIELDS.some(k => d[k] !== d.saved[k]);
}

/**
 * The chart's part of the inspector signature. A saved change (here or
 * anywhere) moves updatedAt and rebuilds the panel, except while a chart
 * field is being edited or saved: then the last value is held, so a remote update
 * never takes the field from under the typist. It lands once focus leaves.
 */
export function chartSignature(nodeId: bigint, row: Chart | undefined): string {
  if (draft?.nodeId === nodeId && (draft.pending > 0 || editing(draft))) {
    return heldSig;
  }
  heldSig = row === undefined ? 'chart:none' : `chart:${row.updatedAt.microsSinceUnixEpoch}`;
  return heldSig;
}

function fieldsOf(row: Chart): Fields {
  return { type: row.type, csv: row.csv, options: row.options, source: row.source };
}

/** The draft for this chart: kept across rebuilds, and replaced by a newer
 *  row only while no chart field is being edited (last write wins, as for labels). */
function syncDraft(nodeId: bigint, row: Chart): Draft {
  const at = row.updatedAt.microsSinceUnixEpoch;
  if (draft !== null && draft.nodeId === nodeId) {
    if (draft.base === at || draft.pending > 0 || editing(draft)) {
      return draft;
    }
    // The echo of this client's own save is not a remote update: keep what
    // was typed since. The server may fill in the source (your name for '',
    // or for new numbers under someone else's source); take it unless the
    // draft has its own.
    const s = draft.saved;
    if (row.type === s.type && row.csv === s.csv && row.options === s.options) {
      if (draft.source === s.source) {
        draft.source = row.source;
      }
      draft.saved = fieldsOf(row);
      draft.base = at;
      return draft;
    }
  }
  const pasteOpen = draft !== null && draft.nodeId === nodeId && draft.pasteOpen;
  clearTimeout(timer);
  const f = fieldsOf(row);
  draft = { nodeId, base: at, ...f, saved: f, pending: 0, error: '', pasteOpen };
  return draft;
}

/** The sentence that keeps this draft from saving, or ''. */
function check(d: Fields): string {
  const r = parseChart(d.type, d.csv, d.options);
  if (!r.ok) {
    return r.error;
  }
  return d.source.length > MAX_SOURCE_CHARS ? `source is ${d.source.length} characters; the limit is ${MAX_SOURCE_CHARS}` : '';
}

function readOptions(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json.trim() === '' ? '{}' : json);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `json` with one option set, or removed (back to its default) when `value` is undefined. */
function withOption(json: string, name: string, value: unknown): string {
  const o = readOptions(json);
  if (value === undefined) {
    delete o[name];
  } else {
    o[name] = value;
  }
  return JSON.stringify(o);
}

/** The options a type switch keeps: those the new contract also has. */
function optionsFor(type: ChartType, json: string): string {
  const known = new Set(CHART_CONTRACTS[type].options.map(o => o.name));
  const o = readOptions(json);
  for (const k of Object.keys(o)) {
    if (!known.has(k)) {
      delete o[k];
    }
  }
  return JSON.stringify(o);
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className !== '') {
    e.className = className;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

function button(text: string, act: string, onClick: () => void, label?: string): HTMLButtonElement {
  const b = h('button', 'ctl', text);
  b.type = 'button';
  b.dataset.act = act;
  if (label !== undefined) {
    b.setAttribute('aria-label', label);
  }
  b.addEventListener('click', onClick);
  return b;
}

function section(title: string): HTMLElement[] {
  return [h('div', 'insp-divider'), h('div', 'eyebrow', title)];
}

export function renderChartSections(n: Node, row: Chart | undefined, actions: ChartInspectorActions): HTMLElement[] {
  if (row === undefined) {
    return [h('div', 'insp-divider'), h('div', 'insp-ref-note', 'chart data has not loaded yet')];
  }
  const d = syncDraft(n.id, row);
  d.error = check(d);
  const form = h('div', 'chart-form');
  // Typed keys stay in the field: the panel's c / o / arrows, the canvas
  // keys and the window shortcuts (⌘K, ⇧T, ⌥⇧H, ⌘↵) never see them.
  form.addEventListener('keydown', evt => {
    if (evt.target instanceof Element && evt.target.closest('input, textarea, select') !== null) {
      evt.stopPropagation();
    }
  });

  const typeError = h('div', 'chart-form-error');
  typeError.dataset.role = 'type-error';
  typeError.setAttribute('role', 'status');
  typeError.hidden = true;
  const draftError = h('div', 'chart-form-error');
  draftError.dataset.role = 'draft-error';
  draftError.setAttribute('role', 'status');
  const showError = () => {
    draftError.textContent = d.error;
    draftError.hidden = d.error === '';
  };
  const validateNow = () => {
    clearTimeout(timer);
    d.error = check(d);
    showError();
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      d.error = check(d);
      showError();
    }, VALIDATE_MS);
  };
  const save = async (): Promise<void> => {
    if (d.dropped) {
      return;
    }
    validateNow();
    if (d.error !== '') {
      return;
    }
    const patch: ChartPatch = {};
    for (const k of FIELDS) {
      if (d[k] !== d.saved[k]) {
        patch[k] = d[k];
      }
    }
    if (Object.keys(patch).length === 0) {
      return;
    }
    const before = d.saved;
    // Marked saved before the await: Enter and the blur that follows it
    // must not send the same edit twice.
    d.saved = { type: d.type, csv: d.csv, options: d.options, source: d.source };
    d.pending++;
    try {
      await actions.setChartData(d.nodeId, patch);
    } catch (err) {
      d.saved = before;
      d.error = (err as Error).message;
      showError();
    } finally {
      d.pending--;
    }
  };
  /** Save on blur, unless a rebuild took the field out of the panel (Chrome
   *  blurs a removed field): the draft and focus carry over to the new one. */
  const saveOnBlur = (el: HTMLElement) => el.addEventListener('blur', () => {
    if (el.isConnected) {
      void save();
    }
  });
  /** A one-line field that saves on blur and Enter. */
  const field = (act: string, label: string, value: string): HTMLInputElement => {
    const inp = h('input', '');
    inp.dataset.act = act;
    inp.setAttribute('aria-label', label);
    inp.spellcheck = false;
    inp.value = value;
    saveOnBlur(inp);
    inp.addEventListener('keydown', evt => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        void save();
      }
    });
    return inp;
  };

  /* TYPE */
  const select = h('select', '');
  select.dataset.act = 'chart-type';
  select.setAttribute('aria-label', 'chart type');
  for (const t of CHART_TYPES) {
    const o = h('option', '', CHART_CONTRACTS[t].title);
    o.value = t;
    select.append(o);
  }
  select.value = d.type;
  /** The sentence that keeps the data out of `type`, or ''. */
  const typeFits = (type: string): string => {
    if (!isChartType(type)) {
      return `unknown chart type '${type}'`;
    }
    const r = parseChart(type, d.csv, optionsFor(type, d.options));
    return r.ok ? '' : r.error;
  };
  const showTypeError = (error: string) => {
    typeError.textContent = error;
    typeError.hidden = error === '';
  };
  // Checked against the new contract first: data that does not fit leaves
  // the draft and the stored chart as they were.
  const commitType = () => {
    const next = select.value;
    if (next === d.type) {
      return;
    }
    const error = typeFits(next);
    showTypeError(error);
    if (error !== '' || !isChartType(next)) {
      select.value = d.type;
      return;
    }
    d.type = next;
    d.options = optionsFor(next, d.options);
    paintOptions();
    void save();
  };
  // Windows and Linux fire change on every arrow over a closed select, so a
  // keyboard change only previews (the sentence, if the data does not fit)
  // and commits on blur or Enter; the next arrow can still move past a type
  // that does not fit. A pointer choice commits at once.
  let keyed = false;
  select.addEventListener('keydown', evt => {
    keyed = true;
    if (evt.key === 'Enter') {
      evt.preventDefault();
      commitType();
    }
  });
  select.addEventListener('pointerdown', () => {
    keyed = false;
  });
  select.addEventListener('change', () => {
    if (keyed) {
      showTypeError(select.value === d.type ? '' : typeFits(select.value));
    } else {
      commitType();
    }
  });
  select.addEventListener('blur', () => {
    if (select.isConnected) {
      commitType();
    }
  });

  /* OPTIONS */
  const opts = h('div', 'chart-options');
  const optionRow = (spec: OptionSpec, cur: unknown): HTMLElement => {
    const wrap = h('div', 'chart-field');
    const label = h('span', 'chart-opt-label', spec.name);
    label.title = spec.note;
    wrap.append(label);
    const act = `chart-opt-${spec.name}`;
    // A click is a choice and saves at once; typing waits for blur or Enter.
    const choose = (value: unknown, focusAct: string) => {
      d.options = withOption(d.options, spec.name, value);
      paintOptions(focusAct);
      void save();
    };
    const typed = (value: unknown) => {
      d.options = withOption(d.options, spec.name, value);
      later();
    };
    if (spec.kind === 'enum') {
      const seg = h('div', 'tb-seg chart-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', spec.name);
      for (const v of spec.values ?? []) {
        const b = h('button', '', v);
        b.type = 'button';
        b.dataset.act = `${act}-${v}`;
        b.classList.toggle('on', cur === v);
        b.setAttribute('aria-pressed', String(cur === v));
        b.addEventListener('click', () => choose(v, `${act}-${v}`));
        seg.append(b);
      }
      wrap.append(seg);
    } else if (spec.kind === 'boolean') {
      const on = cur === true;
      const b = button(on ? 'on' : 'off', act, () => choose(!on, act), spec.name);
      b.classList.add('chart-toggle');
      b.setAttribute('aria-pressed', String(on));
      wrap.append(b);
    } else if (spec.kind === 'integer') {
      const inp = field(act, spec.name, String(cur));
      inp.type = 'number';
      inp.step = '1';
      if (spec.min !== undefined) {
        inp.min = String(spec.min);
      }
      if (spec.max !== undefined) {
        inp.max = String(spec.max);
      }
      // Text the browser cannot read as a number ('1e') reads as '': NaN
      // (stored as null) keeps the parser sentence instead of the default.
      inp.addEventListener('input', () =>
        typed(inp.validity.badInput ? NaN : inp.value.trim() === '' ? undefined : Number(inp.value))
      );
      wrap.append(inp);
    } else if (spec.kind === 'thresholds') {
      // ponytail: one JSON text field, not a row editor. parseChart names any
      // mistake in a sentence; build a row editor if people edit these often.
      const inp = field(act, spec.name, typeof cur === 'string' ? cur : JSON.stringify(cur));
      inp.placeholder = '[{"column":"cpu","warn":80,"crit":90,"direction":"above"}]';
      inp.addEventListener('input', () => {
        if (inp.value.trim() === '') {
          typed(undefined);
          return;
        }
        let value: unknown = inp.value; // not JSON: parseChart says what is wrong
        try {
          value = JSON.parse(inp.value);
        } catch {
          // keep the text as typed
        }
        typed(value);
      });
      wrap.append(inp);
    } else {
      const inp = field(act, spec.name, String(cur));
      inp.addEventListener('input', () => typed(inp.value === '' ? undefined : inp.value));
      wrap.append(inp);
    }
    return wrap;
  };
  const paintOptions = (focusAct?: string) => {
    const specs = isChartType(d.type) ? CHART_CONTRACTS[d.type].options : [];
    const values = readOptions(d.options);
    opts.replaceChildren(...specs.map(spec => optionRow(spec, spec.name in values ? values[spec.name] : spec.default)));
    if (specs.length === 0) {
      opts.append(h('div', 'insp-ref-note', 'this chart type has no options'));
    }
    if (focusAct !== undefined) {
      opts.querySelector<HTMLElement>(`[data-act="${focusAct}"]`)?.focus();
    }
  };

  /* DATA: the CSV box */
  const details = h('details', 'chart-paste');
  details.open = d.pasteOpen;
  details.addEventListener('toggle', () => {
    d.pasteOpen = details.open;
  });
  const ta = h('textarea', '');
  ta.dataset.act = 'chart-csv';
  ta.setAttribute('aria-label', 'chart data as CSV');
  ta.rows = 6;
  ta.spellcheck = false;
  ta.value = d.csv;
  ta.addEventListener('input', () => {
    d.csv = ta.value;
    later();
    // Its own timer: the save on blur clears the check's timer, not this one.
    clearTimeout(refillTimer);
    refillTimer = setTimeout(refillGrid, VALIDATE_MS);
  });
  saveOnBlur(ta);
  ta.addEventListener('paste', () => {
    // The pasted text is in the field only after this event, so read the
    // field a tick later. That covers every paste source; clipboardData
    // is not needed.
    setTimeout(() => {
      d.csv = ta.value;
      refillGrid();
      void save();
    }, 0);
  });
  details.append(h('summary', '', 'Paste CSV'), ta);

  /* DATA: the grid */
  const gridHost = h('div', 'chart-data-grid-host');
  let grid: string[][] = [];
  /** The CSV the grid was last drawn from. */
  let gridCsv = '';
  /** Set while the grid lags a CSV box edit. */
  let refillTimer: ReturnType<typeof setTimeout> | undefined;
  /** Draws the grid again from the draft's CSV; a focused cell keeps focus. */
  const refillGrid = () => {
    clearTimeout(refillTimer);
    refillTimer = undefined;
    if (d.csv === gridCsv) {
      return;
    }
    const a = document.activeElement;
    const act = a instanceof HTMLElement && gridHost.contains(a) ? a.dataset.act : undefined;
    paintGrid(true);
    if (act !== undefined) {
      gridHost.querySelector<HTMLElement>(`[data-act="${act}"]`)?.focus();
    }
  };
  // Tab from the CSV box can land here before the refill: refill first, so
  // no cell edit is made on the old grid (it would undo the CSV box edit).
  gridHost.addEventListener('focusin', () => {
    if (refillTimer !== undefined) {
      refillGrid();
    }
  });
  /** The grid into the draft, as the parser reads it back: a '+ row' leaves a
   *  trailing blank record that parseCsv drops, and storing it would cost a
   *  save and a line the next paint removes. The grid keeps the row to type
   *  in; the draft takes it once it holds something. A CSV that does not
   *  parse at all is kept as typed, so check() can name what is wrong. */
  const syncCsv = () => {
    const csv = gridToCsv(grid);
    const parsed = csvToGrid(csv);
    const next = parsed.length > 0 ? gridToCsv(parsed) : csv;
    // A blank placeholder changes no data: preserve the original formatting,
    // including the sample CSV's trailing newline, and avoid a needless save.
    if (next !== gridToCsv(csvToGrid(d.csv))) {
      d.csv = next;
    }
    gridCsv = d.csv;
    ta.value = d.csv;
  };
  const focusCell = (r: number, c: number) =>
    gridHost.querySelector<HTMLInputElement>(`[data-act="chart-cell-${r}-${c}"]`)?.focus();
  const cellInput = (r: number, c: number): HTMLInputElement => {
    const inp = h('input', '');
    inp.dataset.act = `chart-cell-${r}-${c}`;
    inp.setAttribute('aria-label', r === 0 ? `column ${c + 1} name` : `${grid[0][c] || `column ${c + 1}`}, row ${r}`);
    inp.spellcheck = false;
    inp.value = grid[r][c] ?? '';
    if (r > 0) {
      inp.setAttribute('aria-description', 'Alt+Backspace deletes this row');
    }
    inp.addEventListener('input', () => {
      grid[r][c] = inp.value;
      syncCsv();
      later();
    });
    saveOnBlur(inp);
    inp.addEventListener('keydown', evt => {
      if (evt.key === 'Backspace' && evt.altKey && r > 0) {
        evt.preventDefault();
        deleteRow(r, `chart-cell-{r}-${c}`);
        return;
      }
      if (evt.key !== 'Enter') {
        return;
      }
      // Enter saves and moves down the column, as in a spreadsheet; Tab is native.
      evt.preventDefault();
      void save();
      focusCell(r + 1, c);
    });
    return inp;
  };
  /** Delete data row `r`, then focus the same control (`act`, with `{r}`
   *  for the row) on the row that moved up, else the row above, so focus
   *  never drops to <body> where Delete would remove the chart. */
  const deleteRow = (r: number, act: string) => {
    grid.splice(r, 1);
    syncCsv();
    paintGrid(false);
    const at = Math.min(r, grid.length - 1);
    const target = at > 0 ? gridHost.querySelector<HTMLElement>(`[data-act="${act.replace('{r}', String(at))}"]`) : null;
    (target ?? gridHost.querySelector<HTMLElement>('[data-act="chart-add-row"]'))?.focus();
    void save();
  };
  const paintGrid = (parse: boolean) => {
    if (parse) {
      grid = csvToGrid(d.csv);
      gridCsv = d.csv;
    }
    gridHost.replaceChildren();
    if (grid.length === 0) {
      gridHost.append(h('div', 'insp-ref-note', 'fix the CSV text to edit it as a grid'));
      return;
    }
    const readOnly = grid.length - 1 > GRID_MAX_ROWS;
    const table = h('table', readOnly ? 'chart-data-grid read-only' : 'chart-data-grid');
    const width = grid[0].length;
    // Read-only shows the first rows only; the CSV box holds the rest.
    grid.slice(0, GRID_MAX_ROWS + 1).forEach((cells, r) => {
      const tr = h('tr', '');
      for (let c = 0; c < width; c++) {
        const cell = h(r === 0 ? 'th' : 'td', '');
        if (r === 0) {
          cell.setAttribute('scope', 'col');
        }
        if (readOnly) {
          cell.textContent = cells[c] ?? '';
        } else {
          cell.append(cellInput(r, c));
        }
        tr.append(cell);
      }
      if (!readOnly) {
        const end = h(r === 0 ? 'th' : 'td', '');
        if (r > 0) {
          // Out of the Tab order, so Tab runs cell to cell and Enter (which
          // commits a cell) never lands here; Alt+Backspace in a cell deletes.
          const del = button('×', `chart-del-${r}`, () => deleteRow(r, 'chart-del-{r}'), `delete row ${r}`);
          del.tabIndex = -1;
          end.append(del);
        }
        tr.append(end);
      }
      table.append(tr);
    });
    const scroller = h('div', 'chart-data-grid-wrap');
    if (readOnly) {
      // No inputs to tab into: the scroller itself takes focus, so keys scroll it.
      scroller.tabIndex = 0;
      scroller.setAttribute('role', 'region');
      scroller.setAttribute('aria-label', 'chart data, read-only');
    }
    scroller.append(table);
    gridHost.append(scroller);
    if (readOnly) {
      const note = h('div', 'chart-data-grid-note', `+${grid.length - 1 - GRID_MAX_ROWS} more rows — `);
      note.append(button('edit as text', 'chart-edit-text', () => {
        details.open = true;
        d.pasteOpen = true;
        ta.focus();
      }));
      gridHost.append(note);
      return;
    }
    const tools = h('div', 'chart-data-grid-actions');
    tools.append(
      // New cells are empty, so these never save; the next blur or Enter does.
      button('+ row', 'chart-add-row', () => {
        grid.push(grid[0].map(() => ''));
        syncCsv();
        paintGrid(false);
        focusCell(grid.length - 1, 0);
        validateNow();
      }),
      button('+ series', 'chart-add-series', () => {
        grid[0].push(`series ${grid[0].length}`);
        for (let r = 1; r < grid.length; r++) {
          grid[r].push('');
        }
        syncCsv();
        paintGrid(false);
        focusCell(0, grid[0].length - 1);
        validateNow();
      })
    );
    gridHost.append(tools);
  };

  /* SOURCE */
  const source = field('chart-source', 'chart data source', d.source);
  source.placeholder = 'empty: your name';
  source.addEventListener('input', () => {
    d.source = source.value;
    later();
  });
  const sourceNote = d.saved.source === SAMPLE_SOURCE
    ? [h('div', 'insp-ref-note', 'sample data: your first data edit replaces this source with your name')]
    : [];

  form.append(
    ...section('TYPE'), select, typeError,
    ...section('OPTIONS'), opts,
    ...section('DATA'), draftError, details, gridHost,
    ...section('SOURCE'), source, ...sourceNote
  );
  paintOptions();
  paintGrid(true);
  showError();
  return [form];
}
