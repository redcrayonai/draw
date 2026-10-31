import { describe, it, expect } from 'vitest';
import { withBoard, reducerRejection, flowRejection, startSessionRejection, labelFit, labelFitHint, labelTextWidth, LABEL_FIT } from './results';

describe('tool result texts name the board (spec §3.2, F14)', () => {
  it('appends board=<name> to a success text', () => {
    expect(withBoard('committed id=41', 'feat/x')).toBe('committed id=41 board=feat/x');
    expect(withBoard('committed id=7 a.ts:1-3 (clamped from 90)', 'Demo')).toBe('committed id=7 a.ts:1-3 (clamped from 90) board=Demo');
    expect(withBoard('committed', undefined)).toBe('committed');
  });
  it('appends board=<name> to a server rejection, never to the exact connection texts', () => {
    expect(reducerRejection('evidence rule: nope', 'Demo')).toBe('REJECTED by server: evidence rule: nope board=Demo');
    expect(reducerRejection('not connected (reconnecting)', 'Demo')).toBe('REJECTED: not connected (reconnecting)');
    expect(reducerRejection('reducer timed out (reconnecting)', 'Demo')).toBe('REJECTED: reducer timed out (reconnecting)');
  });
  it('appends board=<name> to a session-tool rejection when a board is active', () => {
    expect(flowRejection('the active board has no session; call start_session first', 'Demo')).toBe(
      'REJECTED: the active board has no session; call start_session first board=Demo'
    );
    expect(flowRejection('ambiguous: x', undefined)).toBe('REJECTED: ambiguous: x');
    expect(flowRejection('reducer timed out (reconnecting)', 'feat/x')).toBe('REJECTED: reducer timed out (reconnecting)');
    expect(flowRejection('not connected (reconnecting)', 'feat/x')).toBe('REJECTED: not connected (reconnecting)');
  });

  it('start_session refusal text (G25): says the active board is unchanged instead of a trailing board=', () => {
    expect(startSessionRejection("session board 'feat/x' belongs to /old; start_session from that checkout or choose another name", 'Demo')).toBe(
      "REJECTED: session board 'feat/x' belongs to /old; start_session from that checkout or choose another name. Active board unchanged: Demo; do not draw until start_session succeeds."
    );
    expect(startSessionRejection('session name must be one short line, e.g. the git branch', undefined)).toBe(
      'REJECTED: session name must be one short line, e.g. the git branch. Active board unchanged: none; do not draw until start_session succeeds.'
    );
    // a message that already ends a sentence does not get a second period
    expect(startSessionRejection('git unavailable or not a repo: git rev-parse in /x: fatal: no.', 'feat/y')).toBe(
      'REJECTED: git unavailable or not a repo: git rev-parse in /x: fatal: no. Active board unchanged: feat/y; do not draw until start_session succeeds.'
    );
    expect(startSessionRejection('not connected (reconnecting)', 'Demo')).toBe('REJECTED: not connected (reconnecting)');
    expect(startSessionRejection('reducer timed out (reconnecting)', 'Demo')).toBe('REJECTED: reducer timed out (reconnecting)');
  });
});

describe('labelFit / labelFitHint — the client node layout (client/src/node-layout.ts), estimated (G23)', () => {
  const node = (over: Partial<Parameters<typeof labelFit>[0]>) => ({ label: '', sublabel: '', w: 160, h: 80, size: '', shape: '', kind: 'service', ...over });
  const TWO = 'alpha beta gamma delta'; // 171.7 px at 15 px: 2 rows from w=128 (alpha beta / gamma delta), 3 at w=120

  it('label+sublabel at fs 15 needs h=48 for one line and 68 for two', () => {
    expect(labelFit(node({ label: 'API', sublabel: 'api/' })).needH).toBe(48);
    expect(labelFit(node({ label: TWO, sublabel: 'x', w: 128 })).needH).toBe(68);
  });

  it('label alone at fs 15 needs h=28 for one line and 48 for two', () => {
    expect(labelFit(node({ label: 'API' })).needH).toBe(28);
    expect(labelFit(node({ label: TWO, w: 128 })).needH).toBe(48);
  });

  it('line height is round(1.25 × font size): size l (18 px, 23 px rows) label alone needs h=52 for two lines', () => {
    expect(labelFit(node({ label: TWO, size: 'l', w: 160 })).needH).toBe(52); // 6 + 0.94·18 + 23 + 6
  });

  it('a node with code refs reserves its badge row: label+sublabel needs h=72 for one line', () => {
    expect(labelFit(node({ label: 'API', sublabel: 'api/', hasRefs: true })).needH).toBe(72); // 6 + 35.8 + 19 + 8
    expect(labelFitHint(node({ label: 'API', sublabel: 'api/', h: 56, hasRefs: true }))).toBe(' (needs h=72 to show label and sublabel)');
  });

  it('an ellipse anchors its badge 4 px higher (h − 14): with code refs, label+sublabel needs h=76, a rect 72', () => {
    expect(labelFit(node({ label: 'API', sublabel: 'api/', hasRefs: true, shape: 'ellipse', w: 240 })).needH).toBe(76); // 6 + 35.8 + 23 + 8
    expect(labelFit(node({ label: 'API', sublabel: 'api/', hasRefs: true, shape: 'pill', w: 240 })).needH).toBe(72);
    // h=72: room for the block in a rect, not in an ellipse (the sublabel is dropped there)
    expect(labelFitHint(node({ label: 'API', sublabel: 'api/', hasRefs: true, w: 240, h: 72 }))).toBe('');
    expect(labelFitHint(node({ label: 'API', sublabel: 'api/', hasRefs: true, shape: 'ellipse', w: 240, h: 72 }))).toBe(' (needs h=76 to show label and sublabel)');
  });

  it('whitespace is collapsed and trimmed before the one-line check, as in the client', () => {
    // 'alpha beta' is 75.2 px: it fits one 76 px row (w=108); the raw padded form (93.4 px) would not
    for (const [w, h] of [[108, 48], [108, 80], [100, 48], [160, 64]]) {
      expect(labelFit(node({ label: '  alpha   beta  ', sublabel: 'x', w, h })), `w=${w} h=${h}`).toEqual(labelFit(node({ label: 'alpha beta', sublabel: 'x', w, h })));
    }
    expect(labelFit(node({ label: '  alpha   beta  ', sublabel: 'x', w: 108, h: 48 })).labelCut).toBe(false);
  });

  it('rect rows have w − 32: the label wraps greedily to 2 rows and is cut after that', () => {
    expect(labelFit(node({ label: TWO, w: 128 }))).toMatchObject({ lines: 2, labelCut: false });
    expect(labelFit(node({ label: TWO, w: 120 }))).toMatchObject({ lines: 3, labelCut: true, labelW: 128 });
    // one 20-char word: 7 characters per row at w=100, so 3 rows; 10 per row from w=124
    expect(labelFit(node({ label: 'x'.repeat(20), w: 100 }))).toMatchObject({ lines: 3, labelCut: true, labelW: 124 });
  });

  it('ellipse and pill rows narrow with the curve: what fits a rect is cut in an ellipse of the same box', () => {
    const box = { label: 'session flows', sublabel: 'x', w: 132, h: 48 };
    expect(labelFit(node(box)).labelCut).toBe(false);
    expect(labelFit(node({ ...box, shape: 'ellipse' })).labelCut).toBe(true);
    expect(labelFit(node({ ...box, shape: 'pill' })).labelCut).toBe(true);
  });

  it('a short box keeps the sublabel and cuts the label to one line; the hint names both ways out', () => {
    // h=64 has no room for 2 rows + sublabel, so the label is ellipsized on one row
    expect(labelFit(node({ label: TWO, sublabel: 'x', w: 128, h: 64 }))).toMatchObject({ labelCut: true, labelW: 204, needH: 68 });
    expect(labelFitHint(node({ label: TWO, sublabel: 'x', w: 128, h: 64 }))).toBe(
      ' (label wraps to 2 lines; cut off below w=204 — widen to 204 to show it in full) (needs h=68 to show label and sublabel)'
    );
  });

  it('the sublabel: Geist Mono at 0.6 em on one row of w − 32', () => {
    expect(labelFit(node({ label: 'API', sublabel: 'agent/src/session.ts' }))).toMatchObject({ sublabelCut: true, sublabelW: 176 }); // 144 + 32
    expect(labelFitHint(node({ label: 'API', sublabel: 'agent/src/session.ts' }))).toBe(' (sublabel cut off below w=176)');
    expect(labelFit(node({ label: 'API', sublabel: 'agent/src/session.ts', w: 176 })).sublabelCut).toBe(false);
  });

  it('no hint when all fits, and none for notes, boundaries and charts', () => {
    expect(labelFitHint(node({ label: 'API', sublabel: 'api/' }))).toBe('');
    expect(labelFitHint(node({ label: 'x'.repeat(80), kind: 'note', w: 64, h: 48 }))).toBe('');
    expect(labelFitHint(node({ label: 'x'.repeat(80), kind: 'boundary', w: 64, h: 48 }))).toBe('');
    expect(labelFitHint(node({ label: 'x'.repeat(80), kind: 'chart', w: 64, h: 48 }))).toBe('');
  });

  it('label widths are Geist 500 advances: within 4 % above what Chromium measures for real labels', () => {
    // canvas measureText, '500 15px Geist', labels from the qa-visual-1 board and a few identifiers
    const measured: Record<string, number> = {
      'agent process': 99.6, 'MCP server': 81.6, 'session flows': 95.6, 'SpacetimeDB': 96.3, inspector: 66.5, snippet: 52.9,
      'symbol resolver': 111.1, 'board stats CLI': 106.2, 'local editor': 78.6, 'editor links': 77.9, markCheckpointFlow: 150.1,
      'API gateway': 86.9, 'result texts and the companion checkpoint summary formatter': 437.8,
    };
    for (const [label, px] of Object.entries(measured)) {
      const est = labelTextWidth(label, 15);
      expect(est, label).toBeGreaterThanOrEqual(px - 0.5);
      expect(est, label).toBeLessThanOrEqual(px * 1.04);
    }
  });
});

describe('labelFit width search (G23 review)', () => {
  const node = (label: string, w = 160, shape = '', size = '') => ({ label, sublabel: '', w, h: 80, size, shape, kind: 'service' });
  // A linear search over the same layout, kept here as the reference for the binary search.
  const linearLabelW = (label: string, shape: string, size: string) => {
    let w = LABEL_FIT.minW;
    while (labelFit(node(label, w, shape, size)).labelCut) w += 4;
    return w;
  };
  const words = ['a', 'io', 'api', 'store', 'session', 'markCheckpointFlow', 'x'.repeat(37), 'é', 'module_bindings', 'SpacetimeDB'];
  let seed = 7;
  const rnd = (k: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
  const fixtures = [
    '', 'API', 'alpha beta gamma delta', 'x'.repeat(20), 'Session companion flows: start_session, add_code_ref and mark_checkpoint',
    ...Array.from({ length: 40 }, () => Array.from({ length: 1 + rnd(14) }, () => words[rnd(words.length)]).join(rnd(5) === 0 ? '  ' : ' ')),
  ];
  // Give each fixture its own timeout; the full matrix can exceed five seconds on CI.
  const cases = fixtures.map((label, index) => ({ label, index }));

  it.each(cases)('labelW matches a linear search for every size and shape (fixture $index)', ({ label }) => {
    for (const [shape, size] of [['', 's'], ['', ''], ['', 'l'], ['ellipse', ''], ['pill', '']]) {
      expect(labelFit(node(label, 160, shape, size)).labelW, `${shape}/${size} ${label}`).toBe(linearLabelW(label, shape, size));
    }
  });

  it.each(cases)('once the label shows in full, a wider box never cuts it (fixture $index)', ({ label }) => {
    for (const shape of ['', 'ellipse', 'pill']) {
      let shown = false;
      for (let w = LABEL_FIT.minW; w <= 1400; w += 4) {
        const cut = labelFit(node(label, w, shape)).labelCut;
        if (shown) expect(cut, `${shape} ${label} at w=${w}`).toBe(false);
        shown = shown || !cut;
      }
    }
  });

  it('finds the first width that shows a 30k-character label in full', () => {
    const label = Array.from({ length: 3751 }, (_, i) => `word${i % 10}xx`).join(' ').slice(0, 30_000);
    // Keep the normal test timeout as the regression guard, rather than a CPU-dependent microbenchmark.
    const fit = labelFit(node(label));
    expect(fit.labelCut).toBe(true);
    expect(labelFit(node(label, fit.labelW)).labelCut).toBe(false);
    expect(labelFit(node(label, fit.labelW - 4)).labelCut).toBe(true);
  });
});
