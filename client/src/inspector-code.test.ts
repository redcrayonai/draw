import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type Mock } from 'vitest';
import type { Node, Edge, CodeRef, Session } from './module_bindings/types';
import type { RefSummary } from './refs';
import type { InspectorModel, InspectorActions } from './chrome';
import { buildNoteIndex, type NoteRow } from './change-notes-view';

vi.mock('./highlight', async importOriginal => {
  const real = await importOriginal<typeof import('./highlight')>();
  return {
    ...real,
    highlightSnippet: async (code: string, lang: string | null, theme: string, startLine: number) => {
      const d = document.createElement('div');
      d.className = 'code-block';
      d.dataset.lang = lang ?? 'plain';
      d.dataset.theme = theme;
      d.dataset.start = String(startLine);
      for (const l of code.split('\n')) {
        const row = document.createElement('div');
        row.className = 'code-line';
        row.textContent = l;
        d.append(row);
      }
      return d;
    },
  };
});

type Chrome = typeof import('./chrome');
let chrome: Chrome;

// Vitest stubs CSS imports (even ?raw) to '', so read the file itself; the
// specifier is a variable because the client ships no @types/node.
let styleCss = '';

beforeAll(async () => {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
    readFileSync(path: string, encoding: 'utf8'): string;
  };
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
  styleCss = readFileSync(`${cwd}/src/style.css`, 'utf8');
  // chrome.ts dereferences these in its module body.
  document.body.innerHTML = `
    <div id="error-strip" hidden><span id="error-text"></span><button id="error-dismiss"></button></div>
    <button id="participants-label"><span id="participant-chips"></span></button>
    <div id="presence-pop" hidden></div>
    <aside id="inspector" hidden tabindex="0"></aside>`;
  chrome = await import('./chrome');
});

function mkNode(id: number, over: Partial<Node> = {}): Node {
  return {
    id: BigInt(id), boardId: 1n, label: `node-${id}`, sublabel: `sub-${id}`, x: 0, y: 0, w: 160, h: 80,
    token: 'ink', focal: false, kind: 'service', doc: '', hidden: false, imported: false,
    shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '', ...over,
  };
}

function mkEdge(id: number, from: number, to: number, over: Partial<Edge> = {}): Edge {
  return {
    id: BigInt(id), boardId: 1n, fromNode: BigInt(from), toNode: BigInt(to), label: '', evidence: 'source:a.ts:1',
    evidenceSnippet: 'call();', evidenceStatus: 'ok', relation: '',
    color: '', strokeStyle: 'solid', hidden: false, imported: false, latencyMs: -1, latencySource: '', ...over,
  };
}

function mkRow(id: number, over: Partial<CodeRef> = {}): CodeRef {
  return {
    id: BigInt(id), boardId: 1n, targetKind: 'node', targetId: 1n, path: 'agent/src/limiter.ts',
    symbol: `sym${id}`, startLine: 10 * id, endLine: 10 * id + 4, blobSha: `${id}bcdef0`.padEnd(40, 'a'),
    snippet: `export function sym${id}() {}`, author: '', checkpoint: 1, status: 'ok', ...over,
  };
}

function summary(r: CodeRef): RefSummary {
  return { id: r.id, symbol: r.symbol, path: r.path, startLine: r.startLine, endLine: r.endLine, checkpoint: r.checkpoint, status: r.status };
}

function ts(ms: number): Session['updatedAt'] {
  return { toDate: () => new Date(ms) } as unknown as Session['updatedAt'];
}

function mkSession(): Session {
  return {
    id: 1n, boardId: 1n, repoRoot: '/Users/alan/repo', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
    checkpoint: 2, coverage: '{}', startedAt: ts(0), updatedAt: ts(0),
  };
}

function mkModel(rows: CodeRef[], over: Partial<InspectorModel> = {}): InspectorModel {
  const refsByTarget = new Map<string, RefSummary[]>();
  for (const r of rows) {
    const k = `${r.targetKind}:${r.targetId}`;
    refsByTarget.set(k, [...(refsByTarget.get(k) ?? []), summary(r)]);
  }
  const nodes = over.nodes ?? [mkNode(1), mkNode(2)];
  return {
    nodes, edges: [], nodesById: new Map(nodes.map(n => [n.id, n])), participants: [],
    refsByTarget, session: mkSession(), expandedRef: null, editorScheme: 'vscode', deletedPaths: new Set(),
    refRow: id => rows.find(r => r.id === id), ...over,
  };
}

function mkActions(): InspectorActions & {
  expandRef: Mock<(id: bigint) => void>;
  copyRef: Mock<(ref: RefSummary) => Promise<boolean>>;
} {
  return {
    hideEdges: vi.fn(),
    hideNodes: vi.fn(),
    deleteEdges: vi.fn(),
    expandRef: vi.fn<(id: bigint) => void>(),
    copyRef: vi.fn<(ref: RefSummary) => Promise<boolean>>().mockResolvedValue(true),
  };
}

describe('public example inspector', () => {
  it('removes mutation controls when access changes while retaining citation copying', () => {
    const edge = mkEdge(9, 1, 2);
    chrome.renderInspector([], [edge], mkModel([]), mkActions());
    expect([...document.querySelectorAll('#inspector .insp-actions button')].map(b => b.textContent)).toEqual(['copy citation', 'hide edge…', 'delete']);
    chrome.renderInspector([], [edge], mkModel([], { readOnly: true }), mkActions());
    expect([...document.querySelectorAll('#inspector .insp-actions button')].map(b => b.textContent)).toEqual(['copy citation']);
  });

  it('omits shared hide controls for single and multiple nodes and edges', () => {
    for (const [nodes, edges] of [
      [[mkNode(1)], []], [[mkNode(1), mkNode(2)], []], [[], [mkEdge(9, 1, 2), mkEdge(10, 2, 1)]],
    ] as [Node[], Edge[]][]) {
      chrome.renderInspector(nodes, edges, mkModel([], { readOnly: true }), mkActions());
      expect(document.querySelector('#inspector .insp-actions button')).toBeNull();
    }
  });
});

const insp = () => document.getElementById('inspector') as HTMLElement;
const tick = () => new Promise<void>(r => setTimeout(r, 0));
/** Let a clipboard promise settle (microtasks only, so fake timers stay put). */
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};
/** Replace navigator.clipboard for one test (jsdom has none). */
function stubClipboard(writeText: (text: string) => Promise<void>): Mock<(text: string) => Promise<void>> {
  const fn = vi.fn(writeText);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: fn } });
  return fn;
}
const key = (k: string) => insp().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

function mutations(target: Element, fn: () => void): MutationRecord[] {
  const mo = new MutationObserver(() => {});
  mo.observe(target, { attributes: true, childList: true, characterData: true, subtree: true });
  fn();
  const recs = mo.takeRecords();
  mo.disconnect();
  return recs;
}

beforeEach(() => {
  chrome.resetInspectorMemo();
  document.documentElement.dataset.theme = 'dark';
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('inspector CODE section', () => {
  it('a range change with the same start line and file sha shows the new snippet, not the cached one', async () => {
    const first = mkRow(1, { startLine: 10, endLine: 10, snippet: 'export function sym1() {}' });
    chrome.renderInspector([mkNode(1)], [], mkModel([first]), mkActions());
    await settle();
    const longer = { ...first, endLine: 12, snippet: 'export function sym1() {\n  return 1;\n}' };
    chrome.renderInspector([mkNode(1)], [], mkModel([longer]), mkActions());
    const lines = [...insp().querySelectorAll('.insp-code .code-text')].map(t => t.textContent);
    expect(lines).toEqual(['export function sym1() {', '  return 1;', '}']);
  });

  it('keeps keyboard focus after expanding a ref through a real rerender', () => {
    const nodes = [mkNode(1)];
    const m = mkModel([mkRow(1), mkRow(2)], { nodes });
    const actions = mkActions();
    actions.expandRef.mockImplementation(id => {
      m.expandedRef = id;
      chrome.renderInspector(nodes, [], m, actions);
    });
    chrome.renderInspector(nodes, [], m, actions);
    const second = insp().querySelectorAll<HTMLButtonElement>('.insp-ref-row')[1];
    second.focus();
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.activeElement?.closest('.insp-ref')?.getAttribute('data-ref-id')).toBe('2');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    expect(actions.copyRef).toHaveBeenCalledWith(expect.objectContaining({ id: 2n }));
  });
  it('renders eyebrow, rows, first ref expanded with snippet and meta line', async () => {
    const rows = [mkRow(1), mkRow(2)];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    await tick();
    const eyebrows = [...insp().querySelectorAll('.eyebrow')].map(e => e.textContent);
    expect(eyebrows).toContain('code · 2 refs');
    const items = [...insp().querySelectorAll<HTMLElement>('.insp-ref')];
    expect(items.map(i => i.dataset.refId)).toEqual(['1', '2']);
    expect(items[0].classList.contains('on')).toBe(true);
    expect(items[1].classList.contains('on')).toBe(false);
    expect(items[0].querySelector('.insp-ref-sym')!.textContent).toBe('sym1');
    expect(items[0].querySelector('.insp-ref-loc')!.textContent).toBe('agent/src/limiter.ts:10–14');
    expect(items[0].querySelector('.insp-ref-row')!.getAttribute('aria-expanded')).toBe('true');
    expect(items[1].querySelector('.insp-ref-row')!.getAttribute('aria-expanded')).toBe('false');
    const code = items[0].querySelector<HTMLElement>('.insp-code .code-block')!;
    expect(code.textContent).toBe('export function sym1() {}');
    expect(code.dataset.lang).toBe('typescript');
    expect(code.dataset.theme).toBe('dark');
    expect(code.dataset.start).toBe('10');
    expect(items[0].querySelector('.insp-ref-foot')!.textContent).toBe('current as of 1bcdef0 · checkpoint 1');
    const open = items[0].querySelector<HTMLAnchorElement>('a[data-act=open]')!;
    expect(open.getAttribute('href')).toBe('vscode://file/Users/alan/repo/agent/src/limiter.ts:10');
    expect(open.textContent).toBe('open in editor');
    expect(open.title).toBe('Open in VS Code · o · ⌥-click copies the link');
    expect(items[1].querySelector('.insp-ref-body')).toBeNull();
  });

  it('puts the meta line, any status note and the actions above the snippet, under the row', () => {
    const rows = [mkRow(1), mkRow(2, { status: 'stale' }), mkRow(3, { path: 'gone.ts', status: 'stale' })];
    const m = mkModel(rows, { deletedPaths: new Set(['gone.ts']) });
    chrome.renderInspector([mkNode(1)], [], m, mkActions());
    const on = () => insp().querySelector<HTMLElement>('.insp-ref.on')!;
    const parts = () => [...on().querySelectorAll(':scope > .insp-ref-body > .insp-ref-inner > *')].map(c => c.classList[0]);
    // The body follows its row header directly, and the snippet comes last.
    expect([...on().children].map(c => c.classList[0])).toEqual(['insp-ref-row', 'insp-ref-body']);
    expect(parts()).toEqual(['insp-ref-foot', 'insp-ref-ctls', 'insp-code']);
    const order = () =>
      [...on().querySelectorAll('.insp-ref-foot, [data-act=copy], [data-act=open], .insp-code')].map(
        el => (el as HTMLElement).dataset.act ?? el.classList[0]
      );
    expect(order()).toEqual(['insp-ref-foot', 'copy', 'open', 'insp-code']);
    // Stale: the two-line note sits between the meta line and the actions.
    chrome.renderInspector([mkNode(1)], [], { ...m, expandedRef: 2n }, mkActions());
    expect(parts()).toEqual(['insp-ref-foot', 'insp-ref-note', 'insp-ref-ctls', 'insp-code']);
    expect(on().querySelectorAll('.insp-ref-inner > .insp-ref-note .insp-ref-note-line')).toHaveLength(2);
    // Deleted: same place; the unavailable note stands in the actions row.
    chrome.renderInspector([mkNode(1)], [], { ...m, expandedRef: 3n }, mkActions());
    expect(parts()).toEqual(['insp-ref-foot', 'insp-ref-note', 'insp-ref-ctls', 'insp-code']);
    expect(on().querySelector('.insp-ref-ctls > .insp-ref-note')!.textContent).toBe('open in editor unavailable · file deleted');
    // The body's bottom spacing is the snippet's margin now, not the actions'.
    expect(styleCss).toMatch(/\.insp-ref-foot\s*{[^}]*margin-top:\s*0;/);
    expect(styleCss).toMatch(/\.insp-code\s*{[^}]*margin:\s*var\(--space-3\) 0;/);
  });

  it('renders no CODE section for a target without refs', () => {
    chrome.renderInspector([mkNode(2)], [], mkModel([mkRow(1)]), mkActions());
    expect(insp().querySelector('.insp-refs')).toBeNull();
    expect([...insp().querySelectorAll('.eyebrow')].map(e => e.textContent)).toEqual(['NODE']);
  });

  it('renders the CODE section for an edge target', () => {
    const rows = [mkRow(5, { targetKind: 'edge', targetId: 9n })];
    chrome.renderInspector([], [mkEdge(9, 1, 2)], mkModel(rows), mkActions());
    expect([...insp().querySelectorAll('.eyebrow')].map(e => e.textContent)).toContain('code · 1 ref');
  });

  it('shows nothing for a hidden target, even when a stale selection still names it', () => {
    // Refs exist on node 1 and on edge 9, but both rows are hidden. main.ts
    // selects from visible rows only; if a stale selection slips through, the
    // inspector must still show nothing rather than resurrect the hidden row.
    const rows = [mkRow(1), mkRow(5, { targetKind: 'edge', targetId: 9n })];
    const hiddenNode = mkNode(1, { hidden: true });
    const m = mkModel(rows, { nodes: [hiddenNode, mkNode(2)] });
    chrome.renderInspector([hiddenNode], [], m, mkActions());
    expect(insp().hidden).toBe(true);
    expect(insp().children).toHaveLength(0);
    expect(insp().querySelector('.insp-refs')).toBeNull();
    chrome.renderInspector([], [mkEdge(9, 1, 2, { hidden: true })], m, mkActions());
    expect(insp().hidden).toBe(true);
    expect(insp().querySelector('.insp-refs')).toBeNull();
    // A visible target next to a hidden one renders only the visible target.
    chrome.renderInspector([hiddenNode, mkNode(2)], [], m, mkActions());
    expect(insp().hidden).toBe(false);
    expect(insp().querySelector('.insp-title')!.textContent).toBe('node-2');
    expect(insp().querySelector('.insp-refs')).toBeNull();
  });

  it('memoises on a signature: identical input keeps the DOM, a line shift rebuilds it', () => {
    const rows = [mkRow(1)];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    const title = insp().querySelector('.insp-title')!;
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    expect(insp().querySelector('.insp-title')).toBe(title);
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1, { startLine: 12, endLine: 16 })]), mkActions());
    expect(insp().querySelector('.insp-title')).not.toBe(title);
    expect(insp().querySelector('.insp-ref-loc')!.textContent).toBe('agent/src/limiter.ts:12–16');
  });

  it('footer says not yet checkpointed until the session reaches the ref\'s checkpoint (F19)', () => {
    // New refs are stamped session.checkpoint + 1.
    const rows = [mkRow(1, { checkpoint: 3 })];
    const at = (checkpoint: number) => mkModel(rows, { session: { ...mkSession(), checkpoint } });
    chrome.renderInspector([mkNode(1)], [], at(2), mkActions());
    expect(insp().querySelector('.insp-ref-asof')!.textContent).toBe('current as of 1bcdef0 · not yet checkpointed');
    chrome.renderInspector([mkNode(1)], [], at(3), mkActions());
    expect(insp().querySelector('.insp-ref-asof')!.textContent).toBe('current as of 1bcdef0 · checkpoint 3');
  });

  it('only an ok ref on an existing file says current; a one-line range reads as one number', () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1, { status: 'stale', startLine: 7, endLine: 7 })]), mkActions());
    expect(insp().querySelector('.insp-ref-asof')!.textContent).toBe('as of 1bcdef0 · checkpoint 1');
    expect(insp().querySelector('.insp-ref-loc')!.textContent).toBe('agent/src/limiter.ts:7');
  });

  it('mark_checkpoint that changes nothing rendered produces zero mutation records (F10)', async () => {
    // Refs stamped at checkpoint 1 and 2; the session moves 2 → 3 → 4. Every
    // ref is already checkpointed, so nothing the panel shows changes.
    const rows = [mkRow(1, { checkpoint: 1 }), mkRow(2, { checkpoint: 2 })];
    const at = (checkpoint: number) => mkModel(rows, { session: { ...mkSession(), checkpoint } });
    chrome.renderInspector([mkNode(1)], [], at(2), mkActions());
    await tick();
    for (const cp of [3, 4]) {
      const recs = mutations(insp(), () => chrome.renderInspector([mkNode(1)], [], at(cp), mkActions()));
      expect(recs).toHaveLength(0);
    }
  });

  it('skips the rebuild when only nodes moved: expanded ref, snippet and copied state survive', async () => {
    const rows = [mkRow(1), mkRow(2)];
    const actions = mkActions();
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { expandedRef: 2n }), actions);
    await tick();
    const on = insp().querySelector<HTMLElement>('.insp-ref.on')!;
    expect(on.dataset.refId).toBe('2');
    const block = on.querySelector('.insp-code .code-block')!;
    const copy = on.querySelector<HTMLButtonElement>('button[data-act=copy]')!;
    vi.useFakeTimers();
    copy.click();
    await settle(); // the label flips once the clipboard write resolves
    expect(copy.textContent).toBe('copied');
    // The agent drags an unrelated node and the selected node itself while
    // the reader has the snippet open. Positions are not rendered here, so
    // the signature is unchanged and replaceChildren (the only thing that
    // resets scroll and text selection) must not run.
    const moved = [mkNode(1, { x: 500, y: 900 }), mkNode(2, { x: 999, y: 999 })];
    const recs = mutations(insp(), () =>
      chrome.renderInspector([moved[0]], [], mkModel(rows, { expandedRef: 2n, nodes: moved }), actions)
    );
    expect(recs).toHaveLength(0);
    expect(insp().querySelector('.insp-ref.on')).toBe(on);
    expect(on.querySelector('.insp-code .code-block')).toBe(block);
    expect(copy.textContent).toBe('copied');
    vi.advanceTimersByTime(1200);
    expect(copy.textContent).toBe('copy ref');
  });

  it('honours expandedRef and keeps the expanded body across identical rerenders', async () => {
    const rows = [mkRow(1), mkRow(2)];
    const actions = mkActions();
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), actions);
    insp().querySelectorAll<HTMLButtonElement>('.insp-ref-row')[1].click();
    expect(actions.expandRef).toHaveBeenCalledWith(2n);
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { expandedRef: 2n }), actions);
    await tick();
    const on = insp().querySelector<HTMLElement>('.insp-ref.on')!;
    expect(on.dataset.refId).toBe('2');
    expect(on.querySelector('.insp-code .code-block')!.textContent).toBe('export function sym2() {}');
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { expandedRef: 2n }), actions);
    expect(insp().querySelector('.insp-ref.on')).toBe(on);
  });

  it('marks stale and ambiguous refs with a dashed chip and an explanation', () => {
    const rows = [mkRow(1, { status: 'stale' }), mkRow(2, { status: 'ambiguous' })];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    const item = insp().querySelector<HTMLElement>('.insp-ref.on')!;
    expect(item.classList.contains('stale')).toBe(true);
    expect(item.querySelector('.insp-chip.stale')!.textContent).toBe('stale');
    // P13: the cause and the caveat are two lines, never one string broken at ' · '.
    const lines = (note: Element) => [...note.querySelectorAll('.insp-ref-note-line')].map(l => l.textContent);
    expect(lines(item.querySelector('.insp-ref-note')!)).toEqual([
      'symbol not found at the last checkpoint',
      'lines are as last seen',
    ]);
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { expandedRef: 2n }), mkActions());
    expect(insp().querySelector('.insp-ref.on .insp-chip.ambiguous')).not.toBeNull();
    expect(lines(insp().querySelector('.insp-ref.on .insp-ref-note')!)).toEqual([
      'more than one match at the last checkpoint',
      'lines are as last seen',
    ]);
  });

  it('every ref row header carries its stale or ambiguous chip, collapsed or not (G12)', () => {
    const rows = [mkRow(1), mkRow(2, { status: 'stale' }), mkRow(3, { status: 'ambiguous' })];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    const chips = [...insp().querySelectorAll<HTMLElement>('.insp-ref-row')].map(r => r.querySelector('.insp-chip')?.textContent ?? null);
    expect(chips).toEqual([null, 'stale', 'ambiguous']);
    // collapsed rows: the chip is in the header, which is all they show
    expect(insp().querySelector('.insp-ref:not(.on) .insp-ref-row .insp-chip.stale')).not.toBeNull();
    // one chip per ref: the expanded body does not repeat it
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { expandedRef: 2n }), mkActions());
    expect(insp().querySelectorAll('.insp-ref.on .insp-chip')).toHaveLength(1);
  });

  it('omits the editor link when the path or root is not linkable', () => {
    const rows = [mkRow(1, { path: 'a:b.ts' })];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    expect(insp().querySelector('a[data-act=open]')).toBeNull();
    expect(insp().querySelector('.insp-ref-ctls .insp-ref-note')!.textContent).toMatch(/not linkable/);
  });

  it('copy ref flips to copied for 1.2 s', async () => {
    vi.useFakeTimers();
    const rows = [mkRow(1)];
    const actions = mkActions();
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), actions);
    const copy = insp().querySelector<HTMLButtonElement>('button[data-act=copy]')!;
    copy.click();
    expect(actions.copyRef).toHaveBeenCalledWith(summary(rows[0]));
    await settle(); // the label flips once the clipboard write resolves
    expect(copy.textContent).toBe('copied');
    expect(copy.classList.contains('copied')).toBe(true);
    vi.advanceTimersByTime(1199);
    expect(copy.textContent).toBe('copied');
    vi.advanceTimersByTime(1);
    expect(copy.textContent).toBe('copy ref');
  });

  describe('copy feedback (G28)', () => {
    afterEach(() => {
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    });
    const live = () => document.querySelector('[aria-live=polite]');

    it('copyRef resolving false shows copy failed', async () => {
      vi.useFakeTimers();
      const actions = mkActions();
      actions.copyRef.mockResolvedValue(false);
      chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), actions);
      const copy = insp().querySelector<HTMLButtonElement>('button[data-act=copy]')!;
      copy.click();
      await settle();
      expect(copy.textContent).toBe('copy failed');
      expect(copy.classList.contains('copied')).toBe(false);
      expect(copy.classList.contains('copy-failed')).toBe(true);
      expect(live()!.textContent).toBe('copy failed');
      vi.advanceTimersByTime(1200);
      expect(copy.textContent).toBe('copy ref');
      expect(copy.classList.contains('copy-failed')).toBe(false);
    });

    it('a second identical result is announced again (the region text changes)', async () => {
      chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
      const copy = insp().querySelector<HTMLButtonElement>('button[data-act=copy]')!;
      copy.click();
      await settle();
      const first = live()!.textContent;
      copy.click();
      await settle();
      expect(live()!.textContent).not.toBe(first);
      expect(live()!.textContent!.trim()).toBe('copied');
    });

    it('a successful copy is announced', async () => {
      chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
      insp().querySelector<HTMLButtonElement>('button[data-act=copy]')!.click();
      await settle();
      expect(live()!.textContent).toBe('copied');
    });

    it('altKey click calls writeText(href), does not navigate, label flips', async () => {
      vi.useFakeTimers();
      const writeText = stubClipboard(async () => {});
      chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
      const open = insp().querySelector<HTMLAnchorElement>('a[data-act=open]')!;
      const evt = new MouseEvent('click', { altKey: true, bubbles: true, cancelable: true });
      open.dispatchEvent(evt);
      expect(evt.defaultPrevented).toBe(true); // no navigation
      expect(writeText).toHaveBeenCalledWith('vscode://file/Users/alan/repo/agent/src/limiter.ts:10');
      await settle();
      expect(open.textContent).toBe('link copied');
      expect(live()!.textContent).toBe('link copied');
      vi.advanceTimersByTime(1200);
      expect(open.textContent).toBe('open in editor');
    });

    it('altKey click with a rejected write says copy failed', async () => {
      stubClipboard(async () => {
        throw new Error('denied');
      });
      chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
      const open = insp().querySelector<HTMLAnchorElement>('a[data-act=open]')!;
      open.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true, cancelable: true }));
      await settle();
      expect(open.textContent).toBe('copy failed');
    });

    it('copy citation is guarded and gives feedback', async () => {
      stubClipboard(async () => {
        throw new Error('denied');
      });
      chrome.renderInspector([], [mkEdge(9, 1, 2)], mkModel([]), mkActions());
      const cite = [...insp().querySelectorAll<HTMLButtonElement>('.insp-actions button')].find(b => b.textContent === 'copy citation')!;
      cite.click();
      await settle();
      expect(cite.textContent).toBe('copy failed');
    });

    it('copyText: true on success; false with no clipboard, a throw or a rejection', async () => {
      expect(await chrome.copyText('x')).toBe(false); // jsdom: no navigator.clipboard
      const ok = stubClipboard(async () => {});
      expect(await chrome.copyText('a:1-2')).toBe(true);
      expect(ok).toHaveBeenCalledWith('a:1-2');
      stubClipboard(() => {
        throw new Error('insecure origin');
      });
      expect(await chrome.copyText('x')).toBe(false);
      stubClipboard(() => Promise.reject(new Error('denied')));
      expect(await chrome.copyText('x')).toBe(false);
    });

    it('title says VS Code, Cursor or Zed', () => {
      for (const [scheme, label] of [['vscode', 'VS Code'], ['cursor', 'Cursor'], ['zed', 'Zed']]) {
        chrome.resetInspectorMemo();
        chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)], { editorScheme: scheme }), mkActions());
        expect(insp().querySelector<HTMLAnchorElement>('a[data-act=open]')!.title).toBe(
          `Open in ${label} · o · ⌥-click copies the link`
        );
      }
    });
  });

  it('keyboard: ↑ ↓ move focus, Enter expands, c copies, o opens', () => {
    const rows = [mkRow(1), mkRow(2), mkRow(3)];
    const actions = mkActions();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), actions);
    const focused = () => insp().querySelector<HTMLElement>('.insp-ref-row.focus')!.parentElement!.dataset.refId;
    expect(focused()).toBe('1');
    key('ArrowDown');
    expect(focused()).toBe('2');
    key('ArrowDown');
    key('ArrowDown');
    expect(focused()).toBe('3');
    key('ArrowUp');
    expect(focused()).toBe('2');
    key('Enter');
    expect(actions.expandRef).toHaveBeenCalledWith(2n);
    key('c');
    expect(actions.copyRef).toHaveBeenCalledWith(summary(rows[0]));
    key('o');
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('keyboard: Enter and arrows on a focused control are left to the control', () => {
    const rows = [mkRow(1), mkRow(2)];
    const actions = mkActions();
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), actions);
    const focused = () => insp().querySelector<HTMLElement>('.insp-ref-row.focus')!.parentElement!.dataset.refId;
    const controls = [
      ...insp().querySelectorAll<HTMLElement>('.insp-actions button, button[data-act=copy], a[data-act=open]'),
    ];
    expect(controls.length).toBeGreaterThanOrEqual(3);
    for (const el of controls) {
      for (const k of ['Enter', 'ArrowDown', 'ArrowUp']) {
        const evt = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
        el.dispatchEvent(evt);
        expect(evt.defaultPrevented).toBe(false);
      }
    }
    expect(actions.expandRef).not.toHaveBeenCalled();
    expect(focused()).toBe('1');
  });

  it('keyboard: Enter and arrows on a Tab-focused ref row act on that row', () => {
    const rows = [mkRow(1), mkRow(2), mkRow(3)];
    const actions = mkActions();
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), actions);
    const rowEls = () => [...insp().querySelectorAll<HTMLButtonElement>('.insp-ref-row')];
    const focused = () => insp().querySelector<HTMLElement>('.insp-ref-row.focus')!.parentElement!.dataset.refId;
    expect(focused()).toBe('1');
    // Enter on row 3 (DOM focus) expands row 3, not the .focus row 1.
    rowEls()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(actions.expandRef).toHaveBeenCalledTimes(1);
    expect(actions.expandRef).toHaveBeenCalledWith(3n);
    expect(focused()).toBe('3');
    // ArrowUp from row 2 moves the highlight and DOM focus to row 1.
    rowEls()[1].focus();
    rowEls()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(focused()).toBe('1');
    expect(document.activeElement).toBe(rowEls()[0]);
  });

  it('keyboard: Enter on a ref row keeps DOM focus when expandRef really rebuilds the panel (F7)', () => {
    const rows = [mkRow(1), mkRow(2), mkRow(3)];
    let model = mkModel(rows);
    const actions: InspectorActions = {
      ...mkActions(),
      // What main.ts does: set expandedRef and rerender, which changes the
      // signature and rebuilds the panel with replaceChildren.
      expandRef: (id: bigint) => {
        model = { ...model, expandedRef: id };
        chrome.renderInspector([mkNode(1)], [], model, actions);
      },
    };
    chrome.renderInspector([mkNode(1)], [], model, actions);
    const rowFor = (id: string) =>
      insp().querySelector<HTMLButtonElement>(`.insp-ref[data-ref-id="${id}"] > .insp-ref-row`)!;
    const before = rowFor('2');
    before.focus();
    before.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    // The panel was rebuilt (row 2 is now expanded) ...
    expect(insp().querySelector<HTMLElement>('.insp-ref.on')!.dataset.refId).toBe('2');
    expect(rowFor('2')).not.toBe(before);
    // ... and focus followed the row instead of dropping to <body>.
    expect(document.activeElement).toBe(rowFor('2'));
    // The list keys still work from there.
    rowFor('2').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(rowFor('3'));

    // A click on a row rebuilds the same way and keeps focus on that row.
    rowFor('3').focus();
    rowFor('3').click();
    expect(insp().querySelector<HTMLElement>('.insp-ref.on')!.dataset.refId).toBe('3');
    expect(document.activeElement).toBe(rowFor('3'));

    // An agent write that changes the signature while a control has focus
    // keeps focus inside the panel too.
    insp().querySelector<HTMLButtonElement>('button[data-act=copy]')!.focus();
    model = mkModel([mkRow(1), mkRow(2), mkRow(3, { startLine: 31, endLine: 35 })], { expandedRef: 3n });
    chrome.renderInspector([mkNode(1)], [], model, actions);
    expect(insp().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(insp().querySelector('button[data-act=copy]'));
  });

  it('does not pull focus into the panel on a rebuild when focus was elsewhere (F7)', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
    outside.focus();
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1, { startLine: 12, endLine: 16 })]), mkActions());
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('action buttons act on the current rows when the memo kept the DOM', () => {
    // Restyle and reconnect (to a same-named node) are not rendered, so the
    // signature is unchanged and the DOM is kept; the buttons must still hand
    // the current row to ops, which snapshots color, style and endpoints for undo.
    const nodes = [mkNode(1), mkNode(2), mkNode(3, { label: 'node-2', sublabel: 'sub-2' })];
    const m = (over: Partial<InspectorModel> = {}) =>
      mkModel([], { nodes, nodesById: new Map(nodes.map(n => [n.id, n])), ...over });
    const actions = mkActions();
    chrome.renderInspector([], [mkEdge(9, 1, 2)], m(), actions);
    const title = insp().querySelector('.insp-title')!;
    const restyled = mkEdge(9, 1, 3, { color: 'red', strokeStyle: 'dashed' });
    chrome.renderInspector([], [restyled], m(), actions);
    expect(insp().querySelector('.insp-title')).toBe(title);
    const button = (text: string) =>
      [...insp().querySelectorAll<HTMLButtonElement>('.insp-actions button')].find(b => b.textContent === text)!;
    button('delete').click();
    expect(actions.deleteEdges).toHaveBeenCalledWith([restyled]);
    button('hide edge…').click();
    expect(actions.hideEdges).toHaveBeenCalledWith([restyled]);

    // Same for a node (hide) and for multi-selections.
    chrome.renderInspector([mkNode(1)], [], m(), actions);
    const recolored = mkNode(1, { color: 'blue', x: 40 });
    chrome.renderInspector([recolored], [], m(), actions);
    button('hide node…').click();
    expect(actions.hideNodes).toHaveBeenLastCalledWith([recolored]);

    chrome.renderInspector([], [mkEdge(9, 1, 2), mkEdge(10, 2, 1)], m(), actions);
    const both = [restyled, mkEdge(10, 2, 1, { color: 'green' })];
    chrome.renderInspector([], both, m(), actions);
    button('hide as set…').click();
    expect(actions.hideEdges).toHaveBeenLastCalledWith(both);

    chrome.renderInspector([mkNode(1), mkNode(2)], [], m(), actions);
    const twoNodes = [recolored, mkNode(2, { color: 'blue' })];
    chrome.renderInspector(twoNodes, [], m(), actions);
    button('hide as set…').click();
    expect(actions.hideNodes).toHaveBeenLastCalledWith(twoNodes);
  });

  it('CODE refs use the disclosure pattern, not a listbox (G31)', () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1), mkRow(2)]), mkActions());
    expect(insp().querySelector('[role=listbox], [role=option], [aria-selected]')).toBeNull();
    const list = insp().querySelector<HTMLElement>('.insp-refs')!;
    expect(list.tagName).toBe('UL');
    expect(list.getAttribute('aria-label')).toBe('code refs');
    const items = [...list.children] as HTMLElement[];
    expect(items.map(i => i.tagName)).toEqual(['LI', 'LI']);
    const [open, closed] = items.map(i => i.querySelector<HTMLButtonElement>(':scope > button.insp-ref-row')!);
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(closed.getAttribute('aria-expanded')).toBe('false');
    // P5: a chevron closes each row's header line (CSS turns it right when closed).
    for (const row of [open, closed]) {
      const disc = row.querySelector('.insp-ref-head')!.lastElementChild!;
      expect(disc.classList.contains('disc')).toBe(true);
      expect(disc.getAttribute('aria-hidden')).toBe('true');
      expect(disc.getAttribute('viewBox')).toBe('0 0 16 16');
    }
    expect(styleCss).toMatch(/\[aria-expanded='false'\] \.disc\s*{[^}]*rotate\(-90deg\)/);
    // The expanded body is a labelled region next to its button, not inside it.
    const body = items[0].querySelector<HTMLElement>(':scope > .insp-ref-body')!;
    expect(body.id).toBe('insp-ref-body-1');
    expect(open.getAttribute('aria-controls')).toBe('insp-ref-body-1');
    expect(body.getAttribute('role')).toBe('region');
    expect(body.getAttribute('aria-labelledby')).toBe(open.id);
    expect(document.getElementById(open.id)).toBe(open);
    // A collapsed row controls nothing that exists.
    expect(closed.hasAttribute('aria-controls')).toBe(false);
  });

  it('roving tabindex: one Tab stop in the list; arrows from the panel move DOM focus (G31)', () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1), mkRow(2), mkRow(3)]), mkActions());
    const rows = () => [...insp().querySelectorAll<HTMLButtonElement>('.insp-ref-row')];
    expect(rows().map(r => r.tabIndex)).toEqual([0, -1, -1]);
    insp().focus();
    key('ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows().map(r => r.tabIndex)).toEqual([-1, 0, -1]);
    rows()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(rows()[2]);
    expect(rows().map(r => r.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('a focused ref row draws one ring, not the inset plus the outline (G31)', () => {
    // The inset .focus ring is for the keyboard cursor when the row itself is
    // not showing the global :focus-visible outline.
    expect(styleCss).toMatch(/\.insp-ref-row\.focus:not\(:focus-visible\)\s*\{/);
    expect(styleCss).not.toMatch(/\.insp-ref-row\.focus\s*\{/);
  });

  it('the inspector widens only while a CODE body is open, and never on a narrow sheet (P3)', () => {
    const wide = styleCss.match(/@media \(min-width: 721px\)\s*{\s*#inspector:has\(\.insp-ref-body\)\s*{([^}]*)}/);
    expect(wide).not.toBeNull();
    // 384 px at 1024 (inspector left 624, rail right 248), 440 px from 1440 up.
    expect(wide![1]).toMatch(/width:\s*clamp\(320px, calc\(100vw - 232px - 3 \* var\(--space-4\) - 360px\), 440px\)/);
    // Below 1280 px the wide panel reaches over the centred dock, so it stops above it.
    expect(styleCss).toMatch(/@media \(min-width: 721px\) and \(max-width: 1279px\)\s*{\s*#inspector:has\(\.insp-ref-body\)\s*{[^}]*var\(--dock-h\)/);
    // The base panel stays 320 px.
    expect(styleCss).toMatch(/#inspector {[^}]*width: 320px;/);
    // Tighter code rows: gutter and text share an 8 px gap and 8 px sides.
    expect(styleCss).toMatch(/\.code-line {[^}]*gap: var\(--space-2\);[^}]*padding: 0 var\(--space-2\);/);
  });

  it('deleted-path ref shows deleted note and no link (G34)', () => {
    const rows = [mkRow(1, { path: 'importer/src/board-stats.ts', status: 'stale' }), mkRow(2)];
    const m = mkModel(rows, { deletedPaths: new Set(['importer/src/board-stats.ts']) });
    chrome.renderInspector([mkNode(1)], [], m, mkActions());
    const on = insp().querySelector<HTMLElement>('.insp-ref.on')!;
    expect(on.querySelector('a[data-act=open]')).toBeNull();
    const notes = [...on.querySelectorAll('.insp-ref-note')].map(n => n.textContent);
    const status = [...on.querySelectorAll('.insp-ref-note-line')].map(n => n.textContent);
    expect(status).toEqual(['file deleted since the session started', 'lines are as last seen']);
    expect(notes).toContain('open in editor unavailable · file deleted');
    // P13: the header names the state the note and the rail name: deleted, not stale.
    expect(on.querySelector('.insp-ref-row .insp-chip')!.textContent).toBe('deleted');
    expect(on.querySelector('.insp-ref-row .insp-chip')!.classList.contains('deleted')).toBe(true);
    expect(on.classList.contains('deleted')).toBe(true);
    expect(notes.some(n => /symbol not found/.test(n ?? ''))).toBe(false);
    // A ref on a live file in the same panel keeps its link.
    chrome.renderInspector([mkNode(1)], [], { ...m, expandedRef: 2n }, mkActions());
    expect(insp().querySelector('.insp-ref.on a[data-act=open]')).not.toBeNull();
  });

  it('a coverage change that deletes the open ref\'s file rebuilds the panel (G34)', () => {
    const rows = [mkRow(1)];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { deletedPaths: new Set() }), mkActions());
    expect(insp().querySelector('a[data-act=open]')).not.toBeNull();
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { deletedPaths: new Set(['agent/src/limiter.ts']) }), mkActions());
    expect(insp().querySelector('a[data-act=open]')).toBeNull();
    // Deleting an unrelated file changes nothing rendered: no rebuild.
    const title = insp().querySelector('.insp-title')!;
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { deletedPaths: new Set(['agent/src/limiter.ts', 'x.ts']) }), mkActions());
    expect(insp().querySelector('.insp-title')).toBe(title);
  });

  it('selection inside .code-block survives an add_code_ref on the same node (G33)', async () => {
    const rows = [mkRow(1, { snippet: 'export function sym1() {\n  return 42;\n}' })];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    await tick();
    const block = insp().querySelector<HTMLElement>('.insp-ref.on .code-block')!;
    const line = block.querySelectorAll('.code-line')[1].firstChild!; // "  return 42;"
    const sel = window.getSelection()!;
    sel.setBaseAndExtent(line, 2, line, 11);
    expect(sel.toString()).toBe('return 42');
    // The agent adds a second ref to the node: the signature changes and the
    // panel rebuilds, but the open body is the same and must be kept.
    const title = insp().querySelector('.insp-title')!;
    chrome.renderInspector([mkNode(1)], [], mkModel([...rows, mkRow(2)]), mkActions());
    expect(insp().querySelector('.insp-title')).not.toBe(title); // it did rebuild
    expect(insp().querySelectorAll('.insp-ref')).toHaveLength(2);
    expect(insp().querySelector('.insp-ref.on .code-block')).toBe(block);
    expect(block.isConnected).toBe(true);
    expect(sel.toString()).toBe('return 42');
    expect(sel.anchorNode).toBe(line);
    sel.removeAllRanges();
  });

  it('a body whose content changed is rebuilt, not reused (G33)', async () => {
    const rows = [mkRow(1)];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    await tick();
    const body = insp().querySelector('.insp-ref-body')!;
    // Re-anchor: new lines, new sha.
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1, { startLine: 12, endLine: 16, blobSha: 'f'.repeat(40) })]), mkActions());
    expect(insp().querySelector('.insp-ref-body')).not.toBe(body);
    const body2 = insp().querySelector('.insp-ref-body')!;
    // Status flip on the open ref: its note changes (the chip sits in the row header since G12).
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1, { startLine: 12, endLine: 16, blobSha: 'f'.repeat(40), status: 'stale' })]), mkActions());
    expect(insp().querySelector('.insp-ref-body')).not.toBe(body2);
    expect(insp().querySelector('.insp-ref-body .insp-ref-note')!.textContent).toMatch(/symbol not found/);
    expect(insp().querySelector('.insp-ref.on .insp-ref-row .insp-chip.stale')).not.toBeNull();
  });

  // P15: the expand runs on grid-template-rows (0fr → 1fr), not height.
  describe('expand animation (G27a, P15)', () => {
    // jsdom has neither matchMedia nor requestAnimationFrame: stub both.
    const motion = (reduce: boolean) => {
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce'), media: q }));
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    };
    const transitionEnd = (target: Element, propertyName: string) => {
      const evt = new Event('transitionend', { bubbles: true });
      Object.defineProperty(evt, 'propertyName', { value: propertyName });
      target.dispatchEvent(evt);
    };
    const body = () => insp().querySelector<HTMLElement>('.insp-ref-body')!;
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('reduced motion: the body opens without the animation classes', () => {
      motion(true);
      chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
      expect(body().classList.contains('opening')).toBe(false);
      expect(body().classList.contains('entering')).toBe(false);
      expect(body().style.height).toBe('');
    });

    it('content sits in one inner wrapper, the grid row that animates', () => {
      motion(true);
      chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
      expect([...body().children].map(c => c.className)).toEqual(['insp-ref-inner']);
      expect(body().querySelector(':scope > .insp-ref-inner > .insp-code')).not.toBeNull();
    });

    it('grows from 0fr on the next frame; released on the body\'s own grid-template-rows transitionend', () => {
      let frame: FrameRequestCallback | null = null;
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }));
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        frame = cb;
        return 1;
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
      expect(body().classList.contains('entering')).toBe(true); // collapsed at 0fr
      expect(body().classList.contains('opening')).toBe(true);
      frame!(0);
      expect(body().classList.contains('entering')).toBe(false); // transitions to 1fr
      // A child's transition bubbles up: it must not end the expand early.
      transitionEnd(body().querySelector('button[data-act=copy]')!, 'grid-template-rows');
      expect(body().classList.contains('opening')).toBe(true);
      // Another property on the body itself does not either.
      transitionEnd(body(), 'height');
      expect(body().classList.contains('opening')).toBe(true);
      transitionEnd(body(), 'grid-template-rows');
      expect(body().classList.contains('opening')).toBe(false);
      expect(body().style.height).toBe('');
    });

    it('released by a 300 ms fallback when no transitionend arrives', () => {
      motion(false);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
      vi.advanceTimersByTime(299);
      expect(body().classList.contains('opening')).toBe(true);
      vi.advanceTimersByTime(1);
      expect(body().classList.contains('opening')).toBe(false);
      expect(body().classList.contains('entering')).toBe(false);
    });

    it('the stylesheet animates grid rows, not height, on an exponential ease-out', () => {
      expect(styleCss).not.toMatch(/transition:\s*height/);
      expect(styleCss).toMatch(/--ease-out:\s*cubic-bezier\(0\.16, 1, 0\.3, 1\)/);
      expect(styleCss).toMatch(/\.insp-ref-body\s*{[^}]*transition:\s*grid-template-rows 200ms var\(--ease-out\)/);
    });
  });

  it('long symbol and long path: row does not overflow (G3)', () => {
    // The stylesheet decides the layout; jsdom cascades it into getComputedStyle.
    const sheet = document.createElement('style');
    sheet.textContent = styleCss;
    document.head.append(sheet);
    try {
      const symbol = 'formatCheckpointCoverageSummaryForCompanionRail';
      expect(symbol).toHaveLength(47);
      const path = 'client/src/module_bindings/code_ref_table.ts';
      chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1, { symbol, path, startLine: 38, endLine: 42 })]), mkActions());
      const row = insp().querySelector<HTMLElement>('.insp-ref-row')!;
      const sym = row.querySelector<HTMLElement>('.insp-ref-sym')!;
      const loc = row.querySelector<HTMLElement>('.insp-ref-loc')!;
      // Stacked: symbol on one line, location on the next.
      expect(getComputedStyle(row).flexDirection).toBe('column');
      expect(getComputedStyle(row).alignItems).toBe('stretch');
      // The symbol never breaks mid-word: one line, ellipsis at the end.
      expect(getComputedStyle(sym).whiteSpace).toBe('nowrap');
      expect(getComputedStyle(sym).overflow).toBe('hidden');
      expect(getComputedStyle(sym).textOverflow).toBe('ellipsis');
      expect(getComputedStyle(sym).minWidth).toBe('0px');
      expect(getComputedStyle(sym).overflowWrap).not.toBe('anywhere');
      // The location keeps its tail (basename and range): start ellipsis via
      // rtl, with the text isolated in <bdi> so it still reads left to right.
      expect(getComputedStyle(loc).whiteSpace).toBe('nowrap');
      expect(getComputedStyle(loc).overflow).toBe('hidden');
      expect(getComputedStyle(loc).textOverflow).toBe('ellipsis');
      expect(getComputedStyle(loc).direction).toBe('rtl');
      expect(getComputedStyle(loc).overflowWrap).not.toBe('anywhere');
      const bdi = loc.querySelector('bdi')!;
      expect(bdi.textContent).toBe(`${path}:38–42`);
      expect(loc.textContent).toBe(`${path}:38–42`);
      // The full strings stay reachable when truncated.
      expect(sym.title).toBe(symbol);
      expect(loc.title).toBe(`${path}:38–42`);
    } finally {
      sheet.remove();
    }
  });

  it('stops propagation only for the keys it handles', () => {
    const rows = [mkRow(1)];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    const seen: string[] = [];
    const listener = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', listener);
    key('ArrowDown');
    key('Delete');
    window.removeEventListener('keydown', listener);
    expect(seen).toEqual(['Delete']);
  });
});

/** A 60-line ref: taller than the snippet box's 20-row cap. */
const longRow = (id: number, over: Partial<CodeRef> = {}) =>
  mkRow(id, {
    startLine: 100,
    endLine: 159,
    snippet: Array.from({ length: 60 }, (_, i) => `  line${i}();`).join('\n'),
    ...over,
  });

describe('snippet first paint and scroll (F9)', () => {
  /** Fake layout: content height follows the rendered rows; scrollTop clamps
   *  on every write and on `layout()` (what syncChrome's offsetWidth read does). */
  function fakeScroll(el: HTMLElement) {
    let top = 0;
    const max = () => Math.max(0, el.querySelectorAll('.code-line').length * 20 + 100 - 200);
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.min(Math.max(0, v), max());
      },
    });
    return {
      layout: () => {
        top = Math.min(top, max());
      },
      restore: () => {
        delete (el as unknown as Record<string, unknown>).scrollTop;
      },
    };
  }

  it('paints the snippet rows synchronously on a cold cache', () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([longRow(1)]), mkActions());
    // No await: the rows exist before the highlighter resolves.
    const rows = insp().querySelectorAll('.insp-code .code-line');
    expect(rows).toHaveLength(60);
    expect(rows[0].querySelector('.code-gutter')!.textContent).toBe('100');
  });

  it('highlights snippets with the light code palette under neo-brutalism', async () => {
    document.documentElement.dataset.theme = 'brutal';
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
    await tick();
    expect(insp().querySelector<HTMLElement>('.insp-code .code-block')!.dataset.theme).toBe('light');
  });

  it('paints the highlighted block synchronously from the cache on a rebuild', async () => {
    const rows = [longRow(1)];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    await tick();
    expect(insp().querySelector<HTMLElement>('.insp-code .code-block')!.dataset.theme).toBe('dark');
    // A rebuild for an unrelated rendered field (the label) re-creates the slot.
    chrome.renderInspector([mkNode(1, { label: 'renamed' })], [], mkModel(rows), mkActions());
    const block = insp().querySelector<HTMLElement>('.insp-code .code-block')!;
    expect(block.dataset.theme).toBe('dark'); // the cached highlighted block, not a placeholder
    expect(insp().querySelector('.insp-code')!.hasAttribute('aria-busy')).toBe(false);
  });

  it('keeps the reader scrolled to the bottom of a long snippet across rebuilds', async () => {
    const fake = fakeScroll(insp());
    try {
      chrome.renderInspector([mkNode(1)], [], mkModel([longRow(1)]), mkActions());
      await tick();
      insp().scrollTop = 10_000;
      const bottom = insp().scrollTop;
      expect(bottom).toBeGreaterThan(1000);
      // Theme switch: cold cache for the new theme.
      document.documentElement.dataset.theme = 'light';
      chrome.renderInspector([mkNode(1)], [], mkModel([longRow(1)]), mkActions());
      fake.layout();
      expect(insp().scrollTop).toBe(bottom);
      await tick();
      fake.layout();
      expect(insp().scrollTop).toBe(bottom);
      // Re-anchor that shifts the ref's lines (new sha, new range).
      const shifted = longRow(1, { startLine: 104, endLine: 163, blobSha: 'f'.repeat(40) });
      chrome.renderInspector([mkNode(1)], [], mkModel([shifted]), mkActions());
      fake.layout();
      expect(insp().scrollTop).toBe(bottom);
      // Selecting a different target does not carry the scroll over.
      chrome.renderInspector([mkNode(2)], [], mkModel([shifted]), mkActions());
      fake.layout();
      expect(insp().scrollTop).toBe(0);
    } finally {
      fake.restore();
    }
  });
});

describe('snippet box: capped, scrolls on its own, fades while rows are hidden', () => {
  const box = () => insp().querySelector<HTMLElement>('.insp-ref.on .insp-code')!;
  const scroller = () => insp().querySelector<HTMLElement>('.insp-ref.on .insp-code-scroll')!;

  /** jsdom has no ResizeObserver: record each one and fire it by hand. */
  class FakeResizeObserver {
    static all: FakeResizeObserver[] = [];
    targets = new Set<Element>();
    constructor(private readonly cb: ResizeObserverCallback) {
      FakeResizeObserver.all.push(this);
    }
    observe(t: Element) {
      this.targets.add(t);
    }
    unobserve(t: Element) {
      this.targets.delete(t);
    }
    disconnect() {
      this.targets.clear();
    }
    static fire(t: Element) {
      for (const ro of FakeResizeObserver.all.filter(o => o.targets.has(t))) {
        ro.cb([], ro as unknown as ResizeObserver);
      }
    }
    static watching(t: Element) {
      return FakeResizeObserver.all.some(o => o.targets.has(t));
    }
  }

  /** jsdom has no layout: give one scroller a content and a box height. */
  function layoutScroller(el: HTMLElement, content: number, visible: number) {
    let top = 0;
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => content },
      clientHeight: { configurable: true, get: () => visible },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (v: number) => {
          top = Math.min(Math.max(0, v), Math.max(0, content - visible));
        },
      },
    });
  }

  /**
   * Scroll offsets that behave as Chrome's do (checked in the browser): kept
   * per element, and lost when the element leaves the document, even when it
   * moves straight into another parent (renderCodeSection moves a kept body).
   */
  function chromeScrollTops(): () => void {
    const tops = new WeakMap<Element, number>();
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0;
      },
      set(this: HTMLElement, v: number) {
        tops.set(this, v);
      },
    });
    const append = Element.prototype.append;
    vi.spyOn(Element.prototype, 'append').mockImplementation(function (this: Element, ...nodes: Parameters<Element['append']>) {
      for (const n of nodes) {
        if (n instanceof Element && n.isConnected) {
          for (const el of [n, ...n.querySelectorAll('*')]) {
            tops.delete(el);
          }
        }
      }
      append.apply(this, nodes);
    });
    return () => {
      if (own !== undefined) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', own);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop;
      }
    };
  }

  beforeEach(() => {
    FakeResizeObserver.all = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the block sits in a focusable, labelled scroller inside the bordered box', () => {
    const row = mkRow(1, { symbol: 'visibleStale', startLine: 115, endLine: 137 });
    chrome.renderInspector([mkNode(1)], [], mkModel([row]), mkActions());
    const s = scroller();
    expect(s.parentElement).toBe(box());
    expect(s.querySelector(':scope > .code-block')).not.toBeNull();
    expect(s.tabIndex).toBe(0);
    expect(s.getAttribute('role')).toBe('region');
    expect(s.getAttribute('aria-label')).toBe('visibleStale snippet, lines 115–137');
    // Focused, it keeps the keys that scroll it; the panel's c and o still act.
    for (const k of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ']) {
      const evt = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      s.dispatchEvent(evt);
      expect(evt.defaultPrevented).toBe(false);
    }
    const c = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true });
    s.dispatchEvent(c);
    expect(c.defaultPrevented).toBe(true);
  });

  it('the stylesheet caps the box at 20 rows of the code line height, with the themed thin scrollbar', () => {
    // One font for the rows and the scroller, so 20lh is 20 code rows.
    expect(styleCss).toMatch(/--code-font:\s*400 12px\/1\.6 var\(--mono\);/);
    expect(styleCss).toMatch(/\.code-block\s*{[^}]*font:\s*var\(--code-font\);/);
    // The scrollbar list shares the selector; the scroller's own rule holds the cap.
    const rules = [...styleCss.matchAll(/\.insp-code-scroll\s*{([^}]*)}/g)].map(r => r[1]).filter(r => /max-height/.test(r));
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule).toMatch(/font:\s*var\(--code-font\);/);
    expect(rule).toMatch(/max-height:\s*calc\(20lh \+ 2 \* var\(--space-2\)\);/);
    expect(rule).toMatch(/overflow-y:\s*auto;/);
    // The slot's padding moved inside the scroller, so it scrolls with the rows.
    expect(rule).toMatch(/padding:\s*var\(--space-2\) 0;/);
    expect(styleCss).not.toMatch(/\.insp-code\s*{[^}]*padding:/);
    expect(styleCss).toMatch(/\.tb-popover,\s*\.insp-code-scroll\s*{\s*scrollbar-width:\s*thin;/);
  });

  it('fades the bottom edge only while the snippet overflows and lines are hidden below', () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([longRow(1)]), mkActions());
    const s = scroller();
    expect(FakeResizeObserver.watching(s)).toBe(true);
    expect(FakeResizeObserver.watching(s.querySelector('.code-block')!)).toBe(true);
    expect(box().classList.contains('more')).toBe(false); // nothing measured yet
    layoutScroller(s, 1168, 400);
    FakeResizeObserver.fire(s);
    expect(box().classList.contains('more')).toBe(true);
    // Scrolled to the end: nothing left below, no fade.
    s.scrollTop = 768;
    s.dispatchEvent(new Event('scroll'));
    expect(box().classList.contains('more')).toBe(false);
    s.scrollTop = 700;
    s.dispatchEvent(new Event('scroll'));
    expect(box().classList.contains('more')).toBe(true);
    // An unchanged answer writes nothing (F10).
    expect(mutations(insp(), () => s.dispatchEvent(new Event('scroll')))).toHaveLength(0);

    // A snippet that fits its box never fades.
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
    layoutScroller(scroller(), 35, 35);
    FakeResizeObserver.fire(scroller());
    expect(box().classList.contains('more')).toBe(false);
  });

  it('re-measures when the coloured block replaces the plain one', async () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([longRow(1)]), mkActions());
    const plain = scroller().querySelector<HTMLElement>('.code-block')!;
    expect(plain.dataset.theme).toBeUndefined(); // the synchronous plain rows
    await tick();
    const coloured = scroller().querySelector<HTMLElement>('.code-block')!;
    expect(coloured.dataset.theme).toBe('dark');
    expect(FakeResizeObserver.watching(coloured)).toBe(true);
    expect(FakeResizeObserver.watching(plain)).toBe(false);
  });

  it('the fade sits over the box, ignores the pointer and animates only without reduced motion', () => {
    expect(styleCss).toMatch(/\.insp-code\s*{[^}]*position:\s*relative;/);
    const after = styleCss.match(/\.insp-code::after\s*{([^}]*)}/)![1];
    expect(after).toMatch(/position:\s*absolute;/);
    expect(after).toMatch(/background:\s*linear-gradient\(transparent, var\(--inset\)\);/);
    expect(after).toMatch(/opacity:\s*0;/);
    expect(after).toMatch(/pointer-events:\s*none;/);
    expect(after).not.toMatch(/transition/);
    expect(styleCss).toMatch(/\.insp-code\.more::after\s*{\s*opacity:\s*1;\s*}/);
    expect(styleCss).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*{\s*\.insp-code::after\s*{\s*transition:\s*opacity var\(--dur\) var\(--ease\);\s*}\s*}/
    );
  });

  it('a rebuild on the same target keeps the snippet scrolled where the reader left it (G33)', async () => {
    const restore = chromeScrollTops();
    try {
      const rows = [longRow(1)];
      chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
      await tick();
      scroller().scrollTop = 240;
      // add_code_ref on the same node: the open body is kept and moved across.
      const kept = scroller();
      chrome.renderInspector([mkNode(1)], [], mkModel([...rows, mkRow(2)]), mkActions());
      expect(scroller()).toBe(kept);
      expect(scroller().scrollTop).toBe(240);
      // Theme flip: the body is rebuilt, the offset carried over.
      document.documentElement.dataset.theme = 'light';
      chrome.renderInspector([mkNode(1)], [], mkModel([...rows, mkRow(2)]), mkActions());
      expect(scroller()).not.toBe(kept);
      expect(scroller().scrollTop).toBe(240);
      // Another ref opened, or another target: the new snippet starts at the top.
      chrome.renderInspector([mkNode(1)], [], mkModel([...rows, mkRow(2)], { expandedRef: 2n }), mkActions());
      expect(scroller().scrollTop).toBe(0);
      chrome.renderInspector([mkNode(1)], [], mkModel([...rows, mkRow(2)]), mkActions());
      scroller().scrollTop = 120;
      chrome.renderInspector([mkNode(2)], [], mkModel([longRow(1, { targetId: 2n })]), mkActions());
      expect(scroller().scrollTop).toBe(0);
    } finally {
      restore();
    }
  });

  it('a rebuild keeps keyboard focus on the snippet the reader was scrolling (F7)', () => {
    const rows = [longRow(1)];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    scroller().focus();
    chrome.renderInspector([mkNode(1)], [], mkModel([longRow(1, { startLine: 104, endLine: 163 }), mkRow(2)]), mkActions());
    expect(document.activeElement).toBe(scroller());
  });
});

describe('theme change', () => {
  it('setTheme dispatches redcrayon:theme after setting the attribute', () => {
    document.documentElement.dataset.theme = 'dark';
    let seen: string | undefined;
    const listener = () => {
      seen = document.documentElement.dataset.theme;
    };
    window.addEventListener('redcrayon:theme', listener);
    chrome.setTheme('light');
    window.removeEventListener('redcrayon:theme', listener);
    expect(seen).toBe('light');
    document.documentElement.dataset.theme = 'dark';
  });

  it('a theme flip rebuilds the inspector and re-highlights the open snippet', async () => {
    const rows = [mkRow(1)];
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    await tick();
    const before = insp().querySelector<HTMLElement>('.insp-code .code-block')!;
    expect(before.dataset.theme).toBe('dark');
    document.documentElement.dataset.theme = 'light';
    chrome.renderInspector([mkNode(1)], [], mkModel(rows), mkActions());
    await tick();
    const after = insp().querySelector<HTMLElement>('.insp-code .code-block')!;
    expect(after).not.toBe(before);
    expect(after.dataset.theme).toBe('light');
  });
});

describe('names lead with the label (G37)', () => {
  it('edge titles use node labels; the paths go in the title and a mono line', () => {
    const nodes = [mkNode(1, { label: 'session flows', sublabel: 'agent/src/session.ts' }), mkNode(2, { label: 'SpacetimeDB', sublabel: '' }), mkNode(3, { label: 'resolver', sublabel: 'agent/src/resolver.ts' })];
    const m = mkModel([], { nodes, nodesById: new Map(nodes.map(n => [n.id, n])) });
    chrome.renderInspector([], [mkEdge(9, 1, 2)], m, mkActions());
    const title = insp().querySelector<HTMLElement>('.insp-title')!;
    expect(title.textContent).toBe('session flows → SpacetimeDB');
    expect(title.title).toBe('agent/src/session.ts → SpacetimeDB');
    // the mono path line only when both ends have a path
    expect(insp().querySelector('.insp-edge-paths')).toBeNull();
    chrome.renderInspector([], [mkEdge(10, 1, 3)], m, mkActions());
    expect(insp().querySelector('.insp-title')!.textContent).toBe('session flows → resolver');
    // P18: one line per end; a break may fall only after a '/'.
    const lines = [...insp().querySelectorAll('.insp-edge-paths .insp-edge-path')];
    expect(lines.map(l => l.textContent)).toEqual(['agent/src/session.ts', '→ agent/src/resolver.ts']);
    expect(lines.map(l => l.innerHTML)).toEqual([
      'agent/<wbr>src/<wbr>session.ts',
      '→ agent/<wbr>src/<wbr>resolver.ts',
    ]);
    expect(styleCss).toMatch(/\.insp-edge-path\s*{[^}]*overflow-wrap:\s*break-word/);
    // multi-edge rows too
    chrome.renderInspector([], [mkEdge(9, 1, 2), mkEdge(10, 1, 3)], m, mkActions());
    expect([...insp().querySelectorAll('.insp-item-edge')].map(e => e.textContent).sort()).toEqual([
      'session flows → SpacetimeDB',
      'session flows → resolver',
    ]);
  });

  it('presence says selecting <label>, with the path in the title', () => {
    const n = mkNode(4, { label: 'editor links', sublabel: 'client/src/editor-link.ts' });
    const id = { toHexString: () => 'aa' };
    const p = { identity: id, displayName: 'alan', kind: 'human', connections: 1, connectedAt: { toDate: () => new Date() } };
    chrome.renderPresencePop([p as never], [{ identity: id, boardId: 1n, nodeIds: [4n] } as never], new Map([[4n, n]]));
    const status = document.querySelector<HTMLElement>('#presence-pop .pp-status')!;
    expect(status.textContent).toMatch(/selecting editor links$/);
    expect(status.title).toBe('client/src/editor-link.ts');
  });
});

describe('stale edge source citations', () => {
  it('refreshes the selected edge after a checkpoint marks its citation stale', () => {
    const edge = mkEdge(9, 1, 2);
    const model = mkModel([]);
    const actions = mkActions();
    chrome.renderInspector([], [edge], model, actions);
    expect(insp().querySelector('.insp-chip.stale')).toBeNull();

    chrome.renderInspector([], [{ ...edge, evidenceStatus: 'stale' }], model, actions);
    expect(insp().querySelector('.insp-chip.stale')!.textContent).toBe('stale source');
    expect(insp().querySelector('.insp-cite')!.textContent).toBe('a.ts:1');
    expect(insp().querySelector('.insp-ref-note')!.textContent).toContain('could not be re-anchored');
    expect(insp().querySelector('.insp-provtext')!.textContent).toBe('cited by agent');

    chrome.renderInspector([], [{ ...edge, evidenceSnippet: '', evidenceStatus: '' }], model, actions);
    expect(insp().querySelector('.insp-chip.stale')!.textContent).toBe('stale source');
    expect(insp().querySelector('.insp-ref-note')!.textContent).toContain('no captured source line');
  });

  it('lists stale source citations separately in a multiple edge selection', () => {
    const edges = [mkEdge(9, 1, 2), mkEdge(10, 2, 1, { evidenceStatus: 'stale' })];
    chrome.renderInspector([], edges, mkModel([]), mkActions());
    expect(insp().querySelector('.insp-sum')!.textContent).toBe('1 source · 1 stale source');
    const stale = insp().querySelector('.insp-item')!;
    expect(stale.querySelector('.insp-item-cls')!.textContent).toBe('stale source');
    expect(stale.querySelector('.insp-item-at')!.textContent).toBe('a.ts:1');
  });
});

describe('provenance footer (G10)', () => {
  const prov = () => {
    const p = insp().querySelector<HTMLElement>('.insp-prov')!;
    return {
      text: p.querySelector('.insp-provtext')!.textContent,
      glyph: p.querySelector('.insp-glyph')!.classList.contains('agent') ? 'agent' : 'human',
    };
  };

  it('session node with refs footer: drawn by agent · N code refs', () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1), mkRow(2), mkRow(3)]), mkActions());
    expect(prov()).toEqual({ text: 'drawn by agent · 3 code refs', glyph: 'agent' });
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)]), mkActions());
    expect(prov()).toEqual({ text: 'drawn by agent · 1 code ref', glyph: 'agent' });
  });

  it('a session node without refs is drawn by agent; a node with refs but no session is too', () => {
    chrome.renderInspector([mkNode(2)], [], mkModel([mkRow(1)]), mkActions());
    expect(prov()).toEqual({ text: 'drawn by agent', glyph: 'agent' });
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)], { session: null }), mkActions());
    expect(prov()).toEqual({ text: 'drawn by agent · 1 code ref', glyph: 'agent' });
  });

  it('keeps placed by hand only with no session and no refs; imported stays imported', () => {
    chrome.renderInspector([mkNode(2)], [], mkModel([], { session: null }), mkActions());
    expect(prov()).toEqual({ text: 'placed by hand · no evidence', glyph: 'human' });
    chrome.renderInspector([mkNode(2, { imported: true })], [], mkModel([]), mkActions());
    expect(prov()).toEqual({ text: 'imported from repo', glyph: 'agent' });
  });

  it('source edge footer: cited by agent, never "verified"; the path stays in CITED AT alone', () => {
    chrome.renderInspector([], [mkEdge(9, 1, 2, { evidence: 'source:agent/src/session.ts:238' })], mkModel([]), mkActions());
    expect(prov()).toEqual({ text: 'cited by agent', glyph: 'agent' });
    expect(prov().text).not.toMatch(/verified|human/);
    // the citation shows once, in the CITED AT block above the footer
    expect(insp().querySelector('.insp-cite')!.textContent).toBe('agent/src/session.ts:238');
    expect(insp().textContent!.split('agent/src/session.ts:238')).toHaveLength(2);
  });

  it('edge footers switch on the evidence class', () => {
    const footer = (over: Partial<Edge>) => {
      chrome.renderInspector([], [mkEdge(9, 1, 2, over)], mkModel([]), mkActions());
      return prov();
    };
    expect(footer({ evidence: 'human:alan' })).toEqual({ text: 'asserted by alan', glyph: 'human' });
    expect(footer({ evidence: 'import', imported: true })).toEqual({ text: 'cited by agent · verified on import', glyph: 'agent' });
    expect(footer({ evidence: 'test-import', imported: true })).toEqual({ text: 'cited by agent · verified on import', glyph: 'agent' });
    expect(footer({ evidence: 'import', imported: false })).toEqual({ text: 'cited by agent · import', glyph: 'agent' });
    expect(footer({ evidence: '' })).toEqual({ text: 'asserted on canvas · unverified', glyph: 'human' });
  });
});

describe('change notes in the node inspector (spec 2026-10-16)', () => {
  const noteRow = (o: Partial<NoteRow> = {}): NoteRow => ({
    id: 7n, boardId: 1n, anchorId: 1n, refId: 1n, kind: 'migration', severity: 'destructive', title: 'Migration 0042', summary: 'Drops name.',
    steps: '[]', schema: '', subjects: '[{"table":"customers","column":"name"}]',
    readers: '[{"refId":"2","subject":0,"status":"stale","checkpoint":1}]', reviewedBy: '', reviewedAt: { microsSinceUnixEpoch: 0n }, ...o,
  });
  const rows = [mkRow(1, { path: 'migrations/0042.sql', snippet: 'ALTER TABLE customers DROP COLUMN name;' }), mkRow(2, { targetId: 2n, snippet: 'row.name' })];
  const notes = (o: Partial<NoteRow> = {}) =>
    buildNoteIndex([noteRow(o)], new Map(rows.map(r => [r.id, r])), [mkEdge(9, 2, 1)]).byAnchor;

  it('shows the change block on the anchor, above CODE, and only there', () => {
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { changeNotes: notes() }), mkActions());
    const block = insp().querySelector('.cn-note');
    expect(block).not.toBeNull();
    const eyebrows = [...insp().querySelectorAll(':scope > .eyebrow')].map(e => e.textContent);
    expect(eyebrows.indexOf('CHANGE')).toBeGreaterThanOrEqual(0);
    chrome.renderInspector([mkNode(2)], [], mkModel(rows, { changeNotes: notes() }), mkActions());
    expect(insp().querySelector('.cn-note')).toBeNull();
  });

  it('the review button follows canReview and calls markReviewed; a status change repaints', () => {
    const markReviewed = vi.fn();
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { changeNotes: notes(), canReview: true }), { ...mkActions(), markReviewed });
    insp().querySelector<HTMLButtonElement>('.cn-review')!.click();
    expect(markReviewed).toHaveBeenCalledWith(7n, true);
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { changeNotes: notes(), canReview: false }), mkActions());
    expect(insp().querySelector('.cn-review')).toBeNull();
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { changeNotes: notes({ readers: '[{"refId":"2","subject":0,"status":"updated","checkpoint":2}]' }) }), mkActions());
    expect(insp().querySelector('.cn-reader.updated')).not.toBeNull();
  });

  it('ask agent to fix copies the prompt', async () => {
    const write = stubClipboard(async () => {});
    chrome.renderInspector([mkNode(1)], [], mkModel(rows, { changeNotes: notes() }), { ...mkActions(), copyFixPrompt: chrome.copyText });
    insp().querySelector<HTMLButtonElement>('.cn-reader.stale button')!.click();
    await settle();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Migration 0042 changes customers.name'));
  });
});

describe('GitHub links instead of stored code (RC-690)', () => {
  const HEAD = 'c'.repeat(40);
  const remote = (over: Partial<NonNullable<InspectorModel['remote']>> = {}) => ({
    remoteUrl: 'https://github.com/o/r', pushedHead: HEAD, dirtyPaths: [] as string[], ...over,
  });
  const noText = () => mkRow(1, { snippet: '' });
  const links = () => [...insp().querySelectorAll<HTMLAnchorElement>('.insp-ref-ctls a')];

  it('the "not stored" note links the privacy policy only when the build names one', () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([noText()], { remote: remote() }), mkActions());
    expect(insp().querySelector('a[data-act=privacy]')).toBeNull();
    chrome.renderInspector([mkNode(1)], [], mkModel([noText()], { remote: remote(), privacyUrl: 'https://example.com/privacy' }), mkActions());
    const a = insp().querySelector<HTMLAnchorElement>('.insp-ref-inner a[data-act=privacy]')!;
    expect(a.textContent).toBe('Privacy policy');
    expect(a.getAttribute('href')).toBe('https://example.com/privacy');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('a ref without text shows no code block, says so, and links to GitHub at the pushed commit', () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([noText()], { remote: remote() }), mkActions());
    expect(insp().querySelector('.insp-code')).toBeNull();
    expect(insp().querySelector('.insp-ref-inner')!.textContent).toContain('No code stored for this reference.');
    const gh = insp().querySelector<HTMLAnchorElement>('a[data-act=github]')!;
    expect(gh.textContent).toBe('open on GitHub');
    expect(gh.getAttribute('href')).toBe(`https://github.com/o/r/blob/${HEAD}/agent/src/limiter.ts#L10-L14`);
    expect(gh.getAttribute('rel')).toBe('noopener noreferrer');
    expect(gh.getAttribute('target')).toBe('_blank');
    expect(insp().textContent).not.toContain('not pushed yet');
    expect(links().map(a => a.textContent)).toEqual(['open in editor', 'open on GitHub']);
  });

  it('a dirty path or an unpushed head says not pushed yet and keeps open in editor', () => {
    for (const r of [remote({ dirtyPaths: ['agent/src/limiter.ts'] }), remote({ pushedHead: '' })]) {
      chrome.resetInspectorMemo();
      chrome.renderInspector([mkNode(1)], [], mkModel([noText()], { remote: r }), mkActions());
      expect(insp().querySelector('a[data-act=github]')).toBeNull();
      expect(insp().querySelector('.insp-ref-ctls')!.textContent).toContain('not pushed yet');
      expect(links().map(a => a.textContent)).toEqual(['open in editor']);
    }
  });

  it('a different dirty path does not hide the link', () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([noText()], { remote: remote({ dirtyPaths: ['other.ts'] }) }), mkActions());
    expect(insp().querySelector('a[data-act=github]')).not.toBeNull();
  });

  it('shows neither a link nor not pushed yet without a remote row or on another host', () => {
    for (const r of [null, undefined, remote({ remoteUrl: 'git@gitlab.com:o/r.git' })]) {
      chrome.resetInspectorMemo();
      chrome.renderInspector([mkNode(1)], [], mkModel([noText()], { remote: r }), mkActions());
      expect(insp().querySelector('a[data-act=github]')).toBeNull();
      expect(insp().textContent).not.toContain('not pushed yet');
      expect(insp().textContent).toContain('No code stored for this reference.');
    }
  });

  it('a deleted file has no GitHub link', () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([noText()], { remote: remote(), deletedPaths: new Set(['agent/src/limiter.ts']) }), mkActions());
    expect(insp().querySelector('a[data-act=github]')).toBeNull();
  });

  it('a ref with text keeps its code block and gains the link', async () => {
    chrome.renderInspector([mkNode(1)], [], mkModel([mkRow(1)], { remote: remote() }), mkActions());
    await tick();
    expect(insp().querySelector('.insp-code .code-block')!.textContent).toBe('export function sym1() {}');
    expect(insp().textContent).not.toContain('No code stored for this reference.');
    expect(insp().querySelector('a[data-act=github]')!.textContent).toBe('open on GitHub');
  });

  it('a ref newer than the last checkpoint says not pushed yet; the link appears once the checkpoint catches up', () => {
    const row = mkRow(1, { snippet: '', checkpoint: 3 });
    const at = (checkpoint: number) => mkModel([row], { remote: remote(), session: { ...mkSession(), checkpoint } });
    chrome.renderInspector([mkNode(1)], [], at(2), mkActions());
    expect(insp().querySelector('a[data-act=github]')).toBeNull();
    expect(insp().querySelector('.insp-ref-ctls')!.textContent).toContain('not pushed yet');
    expect(links().map(a => a.textContent)).toEqual(['open in editor']);
    chrome.renderInspector([mkNode(1)], [], at(3), mkActions());
    expect(insp().querySelector('a[data-act=github]')!.textContent).toBe('open on GitHub');
    expect(insp().textContent).not.toContain('not pushed yet');
  });

  it('rebuilds when the snippet empties or the remote row changes', () => {
    const row = mkRow(1);
    const title = () => insp().querySelector('.insp-title');
    const first = (m: InspectorModel) => { chrome.renderInspector([mkNode(1)], [], m, mkActions()); return title(); };
    const base = first(mkModel([row], { remote: remote() }));
    expect(first(mkModel([row], { remote: remote() }))).toBe(base);
    const purged = first(mkModel([{ ...row, snippet: '' }], { remote: remote() }));
    expect(purged).not.toBe(base);
    const moved = first(mkModel([{ ...row, snippet: '' }], { remote: remote({ pushedHead: 'd'.repeat(40) }) }));
    expect(moved).not.toBe(purged);
    const dirty = first(mkModel([{ ...row, snippet: '' }], { remote: remote({ pushedHead: 'd'.repeat(40), dirtyPaths: [row.path] }) }));
    expect(dirty).not.toBe(moved);
    expect(insp().textContent).toContain('not pushed yet');
  });
});
