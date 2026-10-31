import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Node, Edge, Chart } from './module_bindings/types';
import { renderBoard, focusOf, ghostEdges, renderedText, renderedEdgeAnchor, evidenceClass, hasMachineEvidence, borderPoint, nodeRect, contentBounds, BADGE_FADE_MS, BADGE_CHAR_PX, type RenderState, type RefBadge, edgeText, flowSeconds } from './render';
import { routeEdges } from './edge-route';
import { CHART_CONTRACTS, parseChart } from '../../module/src/chart-contracts';
import { textWidth } from './node-text';
import type { CodeRef } from './module_bindings/types';
import { buildRefsIndex, buildBadgeTitles, badgeFor, buildEdgeBadges, edgeBadgeFor, type BadgeTitle } from './refs';
import { layoutNodeText } from './node-layout';
import { samplePlacement } from './library';
import { buildNoteIndex, type NoteRow } from './change-notes-view';
import { schemaCardHeight } from '../../module/src/change-notes';
import { blastRadius } from './blast';
import { loadLogos } from './node-icons';

function mkNode(id: number, over: Partial<Node> = {}): Node {
  return {
    id: BigInt(id),
    boardId: 1n,
    label: `node-${id}`,
    sublabel: `sub-${id}`,
    x: id * 300,
    y: 100,
    w: 160,
    h: 80,
    token: 'ink',
    focal: false,
    kind: 'service',
    doc: '',
    hidden: false,
    imported: false,
    shape: 'rect',
    color: '',
    strokeStyle: 'solid',
    size: 'm', sourceKey: '',
    ...over,
  };
}

function mkEdge(id: number, from: number, to: number, label = ''): Edge {
  return {
    id: BigInt(id),
    boardId: 1n,
    fromNode: BigInt(from),
    toNode: BigInt(to),
    label,
    latencyMs: -1,
    latencySource: '',
    evidence: '',
    evidenceSnippet: '',
    evidenceStatus: '', relation: '',
    color: '',
    strokeStyle: 'solid',
    hidden: false,
    imported: false,
  };
}

function mkState(over: Partial<RenderState> = {}): RenderState {
  return {
    selection: new Set(),
    selectedEdges: new Set(),
    overrides: new Map(),
    handles: new Set(),
    edgeTarget: null,
    ghosts: new Set(),
    ghostEdges: new Set(),
    ghostSetNames: new Map(),
    overlay: false,
    codeOverlay: false,
    refsByNode: new Map(),
    scale: 1,
    ...over,
  };
}

describe('source evidence status', () => {
  it('counts only anchored source citations as source evidence', () => {
    expect(evidenceClass('source:a.ts:2', 'ok')).toBe('source');
    expect(evidenceClass('source:a.ts:2', 'stale')).toBe('stale');
    expect(evidenceClass('source:a.ts:2')).toBe('stale');
    expect(evidenceClass('import')).toBe('import');
    expect(evidenceClass('test-import')).toBe('test');
    expect(evidenceClass('human:alan')).toBe('human');
    expect(evidenceClass('')).toBe('none');
  });

  it('offers the evidence overlay only when an edge carries machine evidence', () => {
    expect(hasMachineEvidence([])).toBe(false);
    expect(hasMachineEvidence([{ evidence: 'human:alan' }, { evidence: '' }])).toBe(false);
    for (const evidence of ['import', 'test-import', 'source:a.ts:2', 'agent:claude']) {
      expect(hasMachineEvidence([{ evidence: 'human:alan' }, { evidence }])).toBe(true);
    }
    expect(hasMachineEvidence([{ evidence: 'source:a.ts:2', evidenceStatus: 'ok' }])).toBe(true);
  });

  it('patches a styled source edge to a stale overlay without rebuilding it', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2)];
    const edge = { ...mkEdge(10, 1, 2), evidence: 'source:a.ts:2', evidenceSnippet: 'call();', evidenceStatus: 'ok', relation: '', color: 'red', strokeStyle: 'dashed' };
    const state = mkState({ overlay: true });
    renderBoard(world, nodes, [edge], state);
    const line = world.querySelector('.edge-line')!;
    expect(line.classList.contains('ev-source')).toBe(true);

    const stale = { ...edge, evidenceStatus: 'stale' };
    renderBoard(world, nodes, [stale], state);
    expect(world.querySelector('.edge-line')).toBe(line);
    expect(line.classList.contains('ev-stale')).toBe(true);
    expect(line.getAttribute('marker-end')).toBe('url(#mk-muted)');
    expect(world.querySelector('.edge > title')!.textContent).toBe('Stale source citation · a.ts:2');
    expect(mutations(world, () => renderBoard(world, nodes, [stale], state))).toHaveLength(0);

    renderBoard(world, nodes, [{ ...edge, evidence: 'source:a.ts:8' }], state);
    expect(line.classList.contains('ev-source')).toBe(true);
    expect(world.querySelector('.edge > title')!.textContent).not.toContain('Stale');
  });
});

function mkWorld(): SVGGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const world = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.append(world);
  document.body.append(svg);
  return world;
}

function mutations(target: Element, fn: () => void): MutationRecord[] {
  const mo = new MutationObserver(() => {});
  mo.observe(target, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  fn();
  const recs = mo.takeRecords();
  mo.disconnect();
  return recs;
}

describe('edge arrowheads', () => {
  it('keeps a padded open head independent of evidence and selection line weights', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1), mkNode(2)], [mkEdge(10, 1, 2)], mkState());
    const markers = [...world.querySelectorAll('marker')];
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(marker.getAttribute('markerUnits')).toBe('userSpaceOnUse');
      expect(Number(marker.getAttribute('markerWidth'))).toBeGreaterThanOrEqual(12);
      expect(Number(marker.getAttribute('markerHeight'))).toBeGreaterThanOrEqual(12);
      expect(marker.getAttribute('refX')).toBe('10');
      expect(marker.getAttribute('refY')).toBe('6');
      const path = marker.querySelector('path')!;
      expect(path.classList.contains('edge-arrowhead')).toBe(true);
      expect(path.getAttribute('d')).toBe('M2,2 L10,6 L2,10');
    }
  });

  it('uses the selection head for a selected edge and restores the evidence head after deselection', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2)];
    // An edge with a colour of its own keeps it while selected (RC-688, 'hand-set edge style' below).
    const edges = [{ ...mkEdge(10, 1, 2), evidence: 'import' }];
    renderBoard(world, nodes, edges, mkState({ overlay: true, selectedEdges: new Set([10n]) }));
    const line = world.querySelector('.edge-line')!;
    expect(line.getAttribute('marker-end')).toBe('url(#mk-sel)');
    expect(world.querySelector('marker[id="mk-sel"] path')?.classList.contains('mk-sel')).toBe(true);

    renderBoard(world, nodes, edges, mkState({ overlay: true }));
    expect(world.querySelector('.edge-line')).toBe(line);
    expect(line.getAttribute('marker-end')).toBe('url(#mk-ink-heavy)');
    expect(mutations(world, () => renderBoard(world, nodes, edges, mkState({ overlay: true })))).toHaveLength(0);
  });
});

describe('route waypoint markers', () => {
  it('numbers waypoints and keeps the current marker separate from selection and evidence edges', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2)];
    const edge = { ...mkEdge(10, 1, 2, 'evidence'), evidence: 'source:src/a.ts:1', evidenceStatus: 'ok' };
    const route = new Map([[1n, { number: 1, status: 'current' as const }], [2n, { number: 2, status: 'pending' as const }]]);
    const state = mkState({ routeByNode: route, selection: new Set([2n]), overlay: true });
    renderBoard(world, nodes, [edge], state);
    expect([...world.querySelectorAll('.node-route-number')].map(e => e.textContent)).toEqual(['1', '2']);
    expect(world.querySelector('[data-id="1"] .node-route-current')!.textContent).toBe('current');
    expect(world.querySelector('[data-id="2"] .node-route-current')).toBeNull();
    expect(world.querySelectorAll('.edge')).toHaveLength(1);
    expect(world.querySelector('.edge-line')!.classList.contains('ev-source')).toBe(true);
    expect(world.querySelector('[data-id="1"] .node-label')!.textContent).toBe('node-1');
    expect(world.querySelector('[data-id="1"]')!.classList.contains('focal')).toBe(false);
    expect(mutations(world, () => renderBoard(world, nodes, [edge], state))).toHaveLength(0);
    const current = world.querySelector('.node-route-current');
    renderBoard(world, nodes, [edge], { ...state, selection: new Set() });
    expect(world.querySelector('.node-route-current')).toBe(current);
  });

  it('updates route status and numbering without rebuilding node or edge DOM and removes cleared routes', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2)];
    const edges = [mkEdge(10, 1, 2)];
    renderBoard(world, nodes, edges, mkState({ routeByNode: new Map([[1n, { number: 1, status: 'current' }]]) }));
    const node = world.querySelector('[data-id="1"]');
    const line = world.querySelector('.edge-line');
    const routeByNode = new Map([[1n, { number: 1, status: 'done' as const }], [2n, { number: 2, status: 'current' as const }]]);
    renderBoard(world, nodes, edges, mkState({ routeByNode, scale: 0.4 }));
    expect(world.querySelector('[data-id="1"]')).toBe(node);
    expect(world.querySelector('.edge-line')).toBe(line);
    expect(world.querySelector('[data-id="1"] .node-route-current')).toBeNull();
    expect(world.querySelector('[data-id="2"] .node-route-current')).not.toBeNull();
    expect(mutations(world, () => renderBoard(world, nodes, edges, mkState({ routeByNode, scale: 0.4 })))).toHaveLength(0);
    renderBoard(world, nodes, edges, mkState());
    expect(world.querySelectorAll('.node-route')).toHaveLength(0);
  });
});

const layer = (world: SVGGElement, cls: string) =>
  world.querySelector(`:scope > g.${cls}`) as SVGGElement;

describe('renderBoard keyed patching', () => {
  it('keeps long file paths inside the stored node and centres labels on it (G2)', () => {
    const world = mkWorld();
    const n = mkNode(1, { w: 160, sublabel: 'agent/src/session.test.ts' });
    renderBoard(world, [n], [], mkState());
    const rect = nodeRect(n, new Map());
    expect(rect.w).toBe(n.w);
    expect(Number(world.querySelector('.node-rect')!.getAttribute('width'))).toBe(rect.w);
    // jsdom measures 0.65 em per character: the 25-char path keeps its file name
    const sub = world.querySelector('.node-sublabel')!.textContent!;
    expect(sub.startsWith('…')).toBe(true);
    expect(sub.endsWith('session.test.ts')).toBe(true);
    expect([...sub].length * 12 * 0.65).toBeLessThanOrEqual(n.w - 32);
    for (const cls of ['node-label', 'node-sublabel']) {
      const text = world.querySelector(`.${cls}`)!;
      expect(text.getAttribute('text-anchor')).toBe('middle');
      expect(Number(text.getAttribute('x'))).toBe(rect.w / 2);
    }
    expect(contentBounds([n])!.maxX).toBe(n.x + rect.w);
  });

  it('builds fixed layer structure on first render', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1)], [], mkState());
    const tags = [...world.children].map(
      c => c.tagName + (c.getAttribute('class') ? `.${c.getAttribute('class')}` : '') + (c.id ? `#${c.id}` : '')
    );
    expect(tags).toEqual([
      'defs',
      'g.layer-containers',
      'g.layer-edges',
      'g.layer-anchors',
      'g.layer-nodes',
      'g.layer-edge-labels',
      'g.layer-outlines',
      'g.layer-edge-handles',
      'g.layer-resize-handles',
      'g#crayon',
      'g#transient',
      'g#presence',
    ]);
    const g = layer(world, 'layer-nodes').children[0] as SVGGElement;
    expect(g.dataset.id).toBe('1');
    expect(g.getAttribute('class')).toBe('node node-service');
    expect(g.getAttribute('transform')).toBe('translate(300 100)');
    const rect = g.querySelector('.node-rect')!;
    expect(rect.getAttribute('width')).toBe('160');
    expect(rect.getAttribute('height')).toBe('80');
    const label = g.querySelector('.node-label') as SVGTextElement;
    expect(label.textContent).toBe('node-1');
    expect(label.dataset.field).toBe('label');
    expect(label.getAttribute('class')).toBe('node-label token-ink');
    // Inline-edit routing in interactions.ts matches on closest('text').
    expect(label.tagName).toBe('text');
    const sublabel = g.querySelector('.node-sublabel') as SVGTextElement;
    expect(sublabel.textContent).toBe('sub-1');
    expect(sublabel.dataset.field).toBe('sublabel');
    expect(sublabel.tagName).toBe('text');
  });

  it('preserves #transient and #presence contents across patching renders', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2)];
    renderBoard(world, nodes, [mkEdge(10, 1, 2)], mkState());
    const transient = world.querySelector('#transient')!;
    const presence = world.querySelector('#presence')!;
    const marquee = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    transient.append(marquee);
    const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    presence.append(cursor);
    // Attribute patch, structural insert, and structural remove.
    renderBoard(
      world,
      nodes,
      [mkEdge(10, 1, 2)],
      mkState({ overrides: new Map([[1n, { x: 900, y: 900 }]]) })
    );
    renderBoard(world, [...nodes, mkNode(3)], [mkEdge(10, 1, 2)], mkState());
    renderBoard(world, nodes, [], mkState());
    expect(world.querySelector('#transient')).toBe(transient);
    expect(world.querySelector('#presence')).toBe(presence);
    expect([...transient.children]).toEqual([marquee]);
    expect([...presence.children]).toEqual([cursor]);
  });

  it('is a no-op on identical input', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2)];
    const edges = [mkEdge(10, 1, 2, 'calls')];
    renderBoard(world, nodes, edges, mkState());
    const recs = mutations(world, () => renderBoard(world, nodes, edges, mkState()));
    expect(recs).toHaveLength(0);
  });

  it('fades in only the nodes and edges a live render adds', () => {
    const animate = vi.fn();
    Element.prototype.animate = animate as never;
    try {
      const world = mkWorld();
      renderBoard(world, [mkNode(1)], [], mkState({ enter: false }));
      expect(animate).not.toHaveBeenCalled();
      renderBoard(world, [mkNode(1), mkNode(2)], [mkEdge(10, 1, 2, 'calls')], mkState({ enter: true }));
      const faded = animate.mock.contexts as Element[];
      expect(faded.map(e => e.getAttribute('data-id') ?? e.getAttribute('class'))).toEqual(['2', 'edge', 'edge-labels']);
      // Offset 0: the fade starts transparent and ends at the CSS opacity, never the reverse.
      for (const [frames] of animate.mock.calls) expect(frames).toEqual([{ opacity: 0, offset: 0 }]);
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate;
    }
  });

  it('keeps element identity and writes only transforms during a drag', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2), mkNode(3)];
    const edges = [mkEdge(10, 1, 2), mkEdge(11, 2, 3)];
    renderBoard(world, nodes, edges, mkState());
    const g1 = world.querySelector('[data-id="1"]')!;
    const lines = [...world.querySelectorAll('.edge-line')];

    const recs = mutations(world, () =>
      renderBoard(
        world,
        nodes,
        edges,
        mkState({ overrides: new Map([[1n, { x: 320, y: 140 }]]) })
      )
    );

    expect(world.querySelector('[data-id="1"]')).toBe(g1);
    expect(g1.getAttribute('transform')).toBe('translate(320 140)');
    // 1 transform write + the path `d` on the visible line and its clickable
    // hit twin, on the single touched edge.
    expect(recs.filter(r => r.type === 'childList')).toHaveLength(0);
    expect(recs).toHaveLength(3);
    expect([...world.querySelectorAll('.edge-line')]).toEqual(lines);
  });

  it('recomputes endpoints identically to the geometric baseline', () => {
    const world = mkWorld();
    const a = mkNode(1, { x: 0, y: 0 });
    const b = mkNode(2, { x: 400, y: 240 });
    renderBoard(world, [a, b], [mkEdge(10, 1, 2)], mkState());
    const rects = new Map([[1n, { x: 0, y: 0, w: 160, h: 80 }], [2n, { x: 400, y: 240, w: 160, h: 80 }]]);
    const route = routeEdges([{ id: 10n, from: 1n, to: 2n }], rects, new Map()).get(10n)!;
    const line = world.querySelector('.edge-line')!;
    expect(line.tagName).toBe('path');
    expect(line.getAttribute('d')).toBe(route.d);
    expect(world.querySelector('.edge-hit')!.getAttribute('d')).toBe(route.d);
    // leaves a's right side at its middle, enters b's left side at its middle
    expect(route.d.startsWith('M160,40 ')).toBe(true);
    expect(route.d.endsWith(' L400,280')).toBe(true);
  });

  it('borderPoint matches hand-computed geometry', () => {
    const rect = { x: 0, y: 0, w: 160, h: 80 };
    // Horizontal approach: exits through the right border at center height.
    expect(borderPoint({ x: 480, y: 40 }, rect)).toEqual({ x: 160, y: 40 });
    // Diagonal approach where the vertical face clips first: dy dominates.
    expect(borderPoint({ x: 240, y: 200 }, rect)).toEqual({ x: 120, y: 80 });
    // Degenerate: from the center, returns the center.
    expect(borderPoint({ x: 80, y: 40 }, rect)).toEqual({ x: 80, y: 40 });
  });

  it('patches label text in place', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1)], [], mkState());
    const label = world.querySelector('.node-label')!;
    renderBoard(world, [mkNode(1, { label: 'renamed' })], [], mkState());
    expect(world.querySelector('.node-label')).toBe(label);
    expect(label.textContent).toBe('renamed');
  });

  it('removes stale nodes and their DOM, and drops edges to missing nodes', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1), mkNode(2)], [mkEdge(10, 1, 2)], mkState());
    expect(world.querySelectorAll('.edge-line')).toHaveLength(1);
    renderBoard(world, [mkNode(1)], [mkEdge(10, 1, 2)], mkState());
    expect(world.querySelector('[data-id="2"]')).toBeNull();
    expect(world.querySelectorAll('.edge-line')).toHaveLength(0);
    // Node 2 returns: edge comes back too.
    renderBoard(world, [mkNode(1), mkNode(2)], [mkEdge(10, 1, 2)], mkState());
    expect(world.querySelectorAll('.edge-line')).toHaveLength(1);
  });

  it('classifies containers into the layer below edges', () => {
    const world = mkWorld();
    const big = mkNode(1, { x: 0, y: 0, w: 800, h: 600 });
    const small = mkNode(2, { x: 100, y: 100 });
    renderBoard(world, [big, small], [], mkState());
    expect(layer(world, 'layer-containers').children[0]).toBe(
      world.querySelector('[data-id="1"]')
    );
    expect(layer(world, 'layer-nodes').children[0]).toBe(world.querySelector('[data-id="2"]'));
    // Move the small node out: container demotes to the nodes layer.
    renderBoard(
      world,
      [big, small],
      [],
      mkState({ overrides: new Map([[2n, { x: 2000, y: 2000 }]]) })
    );
    expect(layer(world, 'layer-containers').children).toHaveLength(0);
    expect(layer(world, 'layer-nodes').children).toHaveLength(2);
  });

  it('paints larger nodes first within a layer', () => {
    const world = mkWorld();
    const nodes = [
      mkNode(1, { x: 0, y: 0, w: 100, h: 100 }),
      mkNode(2, { x: 500, y: 0, w: 300, h: 300 }),
    ];
    renderBoard(world, nodes, [], mkState());
    const order = [...layer(world, 'layer-nodes').children].map(c => (c as SVGGElement).dataset.id);
    expect(order).toEqual(['2', '1']);
  });

  it('builds selection overlay with handles and resize squares, keyed contracts intact', () => {
    const world = mkWorld();
    const nodes = [mkNode(1)];
    renderBoard(
      world,
      nodes,
      [],
      mkState({ selection: new Set([1n]), handles: new Set([1n]), scale: 2 })
    );
    const outlineG = layer(world, 'layer-outlines').children[0] as SVGGElement;
    const handleG = layer(world, 'layer-edge-handles').children[0] as SVGGElement;
    const resizeG = layer(world, 'layer-resize-handles').children[0] as SVGGElement;
    expect(outlineG.getAttribute('transform')).toBe('translate(300 100)');
    expect(handleG.getAttribute('transform')).toBe('translate(300 100)');
    expect(resizeG.getAttribute('transform')).toBe('translate(300 100)');
    expect(outlineG.querySelectorAll('.selection-outline')).toHaveLength(1);
    const circles = [...handleG.querySelectorAll('.edge-handle')] as SVGCircleElement[];
    expect(circles).toHaveLength(4);
    expect(circles[0].dataset.nodeId).toBe('1');
    expect(circles[0].getAttribute('r')).toBe(String(5 / 2));
    const squares = [...resizeG.querySelectorAll('.resize-handle')] as SVGRectElement[];
    expect(squares.map(s => s.dataset.corner)).toEqual(['nw', 'ne', 'sw', 'se']);
    expect(squares[0].dataset.nodeId).toBe('1');

    // Drag: overlay groups move via transform, contents untouched.
    const outline = outlineG.querySelector('.selection-outline')!;
    renderBoard(
      world,
      nodes,
      [],
      mkState({
        selection: new Set([1n]),
        handles: new Set([1n]),
        scale: 2,
        overrides: new Map([[1n, { x: 500, y: 500 }]]),
      })
    );
    expect(outlineG.getAttribute('transform')).toBe('translate(500 500)');
    expect(resizeG.getAttribute('transform')).toBe('translate(500 500)');
    expect(outlineG.querySelector('.selection-outline')).toBe(outline);

    // Deselect: all overlay chrome removed.
    renderBoard(world, nodes, [], mkState());
    expect(layer(world, 'layer-outlines').children).toHaveLength(0);
    expect(layer(world, 'layer-edge-handles').children).toHaveLength(0);
    expect(layer(world, 'layer-resize-handles').children).toHaveLength(0);
  });

  it('shows hover handles without selection artifacts', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1)], [], mkState({ handles: new Set([1n]) }));
    expect(world.querySelectorAll('.edge-handle')).toHaveLength(4);
    expect(world.querySelectorAll('.selection-outline')).toHaveLength(0);
    expect(world.querySelectorAll('.resize-handle')).toHaveLength(0);
  });

  it('paints every resize handle above every edge handle (three-pass stacking)', () => {
    const world = mkWorld();
    // Two abutting selected nodes: A's se corner coincides with B's west midpoint.
    const a = mkNode(1, { x: 0, y: 0 });
    const b = mkNode(2, { x: 160, y: 40 });
    renderBoard(
      world,
      [a, b],
      [],
      mkState({ selection: new Set([1n, 2n]), handles: new Set([1n, 2n]) })
    );
    const aResize = world.querySelector('.resize-handle[data-corner="se"]')!;
    const bHandle = [...world.querySelectorAll('.edge-handle')].find(
      c => (c as SVGCircleElement).dataset.nodeId === '2'
    )!;
    // A's resize square must paint after (above) B's edge handle circle:
    // querySelectorAll returns document order.
    const chrome = [...world.querySelectorAll('.edge-handle, .resize-handle')];
    expect(chrome.indexOf(aResize)).toBeGreaterThan(chrome.indexOf(bHandle));
  });

  it('recomputes endpoints when an edge is retargeted between stationary nodes', () => {
    const world = mkWorld();
    const a = mkNode(1, { x: 0, y: 0 });
    const b = mkNode(2, { x: 400, y: 0 });
    const c = mkNode(3, { x: 400, y: 400 });
    renderBoard(world, [a, b, c], [mkEdge(10, 1, 2, 'calls')], mkState());
    const line = world.querySelector('.edge-line')!;
    const before = line.getAttribute('d');
    renderBoard(world, [a, b, c], [mkEdge(10, 1, 3, 'calls')], mkState());
    expect(world.querySelector('.edge-line')).toBe(line);
    expect(line.getAttribute('d')).not.toBe(before);
    // now leaves a's bottom and enters c's top
    expect(line.getAttribute('d')!.startsWith('M80,80 ')).toBe(true);
    expect(line.getAttribute('d')!.endsWith(' L480,400')).toBe(true);
    const label = world.querySelector('.edge-label')!;
    expect(Number(label.getAttribute('y'))).toBeGreaterThan(100);
  });

  it('keeps edge paint order equal to input order across a hide/unhide cycle', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2), mkNode(3)];
    const e1 = mkEdge(10, 1, 2);
    const e2 = mkEdge(11, 2, 3);
    renderBoard(world, nodes, [e1, e2], mkState());
    // Hide node 1: e1 dropped. Restore: e1 recreated, must return to first place.
    renderBoard(world, [mkNode(2), mkNode(3)], [e1, e2], mkState());
    renderBoard(world, nodes, [e1, e2], mkState());
    const order = [...layer(world, 'layer-edges').children].map(g =>
      (g.querySelector('.edge-line') as SVGPathElement).getAttribute('d')
    );
    // First child must be e1, leaving node 1's right border (x 300 + 160).
    expect(order[0]).toMatch(/^M460,/);
    expect(order[1]).toMatch(/^M760,/);
  });

  it('toggles ghost and edge-target classes in place', () => {
    const world = mkWorld();
    const nodes = [mkNode(1)];
    renderBoard(world, nodes, [], mkState({ ghosts: new Set([1n]) }));
    const g = world.querySelector('[data-id="1"]')!;
    expect(g.getAttribute('class')).toBe('node node-service ghost');
    renderBoard(world, nodes, [], mkState({ edgeTarget: 1n }));
    expect(world.querySelector('[data-id="1"]')).toBe(g);
    expect(g.getAttribute('class')).toBe('node node-service edge-target');
    renderBoard(world, nodes, [], mkState());
    expect(g.getAttribute('class')).toBe('node node-service');
  });

  it('adds, patches, and removes edge labels', () => {
    const world = mkWorld();
    // Horizontal pair at y=100: borders at x=160..400, centers at y=140.
    const nodes = [mkNode(1, { x: 0, y: 100 }), mkNode(2, { x: 400, y: 100 })];
    renderBoard(world, nodes, [mkEdge(10, 1, 2)], mkState());
    expect(world.querySelectorAll('.edge-label')).toHaveLength(0);
    // Label added to an existing unmoved edge sits at the exact midpoint,
    // its box centred on the line (the paper backing hides the line under it).
    renderBoard(world, nodes, [mkEdge(10, 1, 2, 'calls')], mkState());
    const label = world.querySelector('.edge-label')!;
    expect(label.textContent).toBe('calls');
    expect(Number(label.getAttribute('x'))).toBeCloseTo((160 + 400) / 2);
    const bg = world.querySelector('.edge-label-bg')!;
    expect(Number(bg.getAttribute('y')) + 9).toBeCloseTo(140);
    expect(Number(label.getAttribute('y'))).toBeCloseTo(140 - 9 + 13);
    renderBoard(world, nodes, [mkEdge(10, 1, 2, 'reads')], mkState());
    expect(world.querySelector('.edge-label')).toBe(label);
    expect(label.textContent).toBe('reads');
    renderBoard(world, nodes, [mkEdge(10, 1, 2)], mkState());
    expect(world.querySelectorAll('.edge-label')).toHaveLength(0);
  });

  it('a label longer than its visible segment paints over the end nodes, never under them (P17)', () => {
    const world = mkWorld();
    // borders at x=160..250: 90 px of visible path, 'starts sessions' needs ~118
    const near = [mkNode(1, { x: 0, y: 100 }), mkNode(2, { x: 250, y: 100 })];
    renderBoard(world, near, [mkEdge(10, 1, 2, 'starts sessions')], mkState());
    const label = world.querySelector('.edge-label')!;
    const labels = layer(world, 'layer-edge-labels');
    // label, its background and hit box sit in the layer after the nodes ...
    expect(labels.contains(label)).toBe(true);
    expect(labels.contains(world.querySelector('.edge-label-bg'))).toBe(true);
    expect(labels.querySelector('[data-edge-id="10"]')).not.toBeNull();
    const order = [...world.children];
    expect(order.indexOf(labels)).toBeGreaterThan(order.indexOf(layer(world, 'layer-nodes')));
    // ... while the line stays under them
    expect(layer(world, 'layer-edges').contains(world.querySelector('.edge-line'))).toBe(true);
    // keyed: identical input writes nothing; removing the edge removes its label
    expect(mutations(world, () => renderBoard(world, near, [mkEdge(10, 1, 2, 'starts sessions')], mkState()))).toHaveLength(0);
    renderBoard(world, near, [], mkState());
    expect(labels.children).toHaveLength(0);
    expect(world.querySelectorAll('.edge-label')).toHaveLength(0);
  });

  it('keeps label paint order equal to edge order', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2), mkNode(3)];
    const e1 = mkEdge(10, 1, 2, 'a');
    const e2 = mkEdge(11, 2, 3, 'b');
    renderBoard(world, nodes, [e1, e2], mkState());
    renderBoard(world, [mkNode(2), mkNode(3)], [e1, e2], mkState());
    renderBoard(world, nodes, [e1, e2], mkState());
    const texts = [...layer(world, 'layer-edge-labels').querySelectorAll('.edge-label')].map(t => t.textContent);
    expect(texts).toEqual(['a', 'b']);
  });

  it('marks ghost edges via class only', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2)];
    const edges = [mkEdge(10, 1, 2)];
    renderBoard(world, nodes, edges, mkState());
    const line = world.querySelector('.edge-line')!;
    renderBoard(world, nodes, edges, mkState({ ghostEdges: new Set([10n]) }));
    expect(line.getAttribute('class')).toBe('edge-line ev-none ghost');
    renderBoard(world, nodes, edges, mkState());
    expect(line.getAttribute('class')).toBe('edge-line ev-none');
  });

  it('reorders a layer when an area changes (resize), not during moves', () => {
    const world = mkWorld();
    const n1 = mkNode(1, { x: 0, y: 0, w: 300, h: 300 });
    const n2 = mkNode(2, { x: 500, y: 0, w: 100, h: 100 });
    renderBoard(world, [n1, n2], [], mkState());
    let order = [...layer(world, 'layer-nodes').children].map(c => (c as SVGGElement).dataset.id);
    expect(order).toEqual(['1', '2']);
    // n2 grows past n1 (as a committed row, i.e. after resize lands)
    renderBoard(world, [n1, mkNode(2, { x: 500, y: 0, w: 400, h: 400 })], [], mkState());
    order = [...layer(world, 'layer-nodes').children].map(c => (c as SVGGElement).dataset.id);
    expect(order).toEqual(['2', '1']);
  });
});

describe('renderedEdgeAnchor (G35)', () => {
  // Horizontal pair at y=100: the path runs 160 → 400 along y 140.
  const a = mkNode(1, { x: 0, y: 100, label: 'a', sublabel: '' });
  const b = mkNode(2, { x: 400, y: 100, label: 'b', sublabel: '' });
  const box = (el: Element) => ({ x: Number(el.getAttribute('x')), y: Number(el.getAttribute('y')), w: Number(el.getAttribute('width')), h: 18 });

  // The run under the code overlay (G51): label plus ' · N refs', or the
  // count alone, or the label with the count on its own row under the line.
  const draw = (nodes: Node[], label: string, count = 0) => {
    const world = mkWorld();
    renderBoard(world, nodes, [mkEdge(9, 1, 2, label)], mkState(count === 0 ? {} : {
      codeOverlay: true,
      refsByEdge: new Map([[9n, { key: `${count}`, count, title: 'buildEditorHref' }]]),
    }));
    const boxes = [...world.querySelectorAll('.edge-label-bg')].map(box);
    const x = Math.min(...boxes.map(r => r.x));
    const y = Math.min(...boxes.map(r => r.y));
    const union = { x, y, w: Math.max(...boxes.map(r => r.x + r.w)) - x, h: Math.max(...boxes.map(r => r.y + r.h)) - y };
    return { world, union, anchor: renderedEdgeAnchor(world, 9n)! };
  };
  const same = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => {
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(a[k], k).toBeCloseTo(b[k], 9);
  };

  it('a labelled edge anchors at the drawn label box, centred on the path midpoint', () => {
    const { world, anchor } = draw([a, b], 'calls');
    expect(anchor).toEqual(box(world.querySelector('.edge-label-bg')!));
    expect(anchor.x + anchor.w / 2).toBe(280);
    expect(anchor.y + anchor.h / 2).toBe(140);
  });

  it('an unlabelled edge anchors at the midpoint of its longest segment', () => {
    expect(draw([a, b], '').anchor).toEqual({ x: 280, y: 140, w: 0, h: 0 });
  });

  it('an edge that is not drawn has no anchor', () => {
    const world = mkWorld();
    renderBoard(world, [a], [mkEdge(9, 1, 2, 'calls')], mkState());
    expect(renderedEdgeAnchor(world, 9n)).toBeNull();
    expect(renderedEdgeAnchor(world, 99n)).toBeNull();
    expect(renderedEdgeAnchor(mkWorld(), 9n)).toBeNull();
  });

  it('a ref suffix lengthens the anchor to the drawn run', () => {
    const { union, anchor } = draw([a, b], 'calls', 1);
    same(anchor, union);
    expect(anchor.w).toBeCloseTo('calls · 1 ref'.length * 7.3 + 8, 5);
    expect(anchor.x + anchor.w / 2).toBeCloseTo(280, 5);
  });

  it('an unlabelled edge with refs anchors at its "N refs" box, not the bare midpoint', () => {
    const { union, anchor } = draw([a, b], '', 2);
    same(anchor, union);
    expect(anchor.y).toBe(140 - 9);
  });

  it('a run longer than the path anchors at the label and the count row under it', () => {
    const near = mkNode(2, { x: 250, y: 100, label: 'b', sublabel: '' });
    const { union, anchor } = draw([a, near], 'builds href', 1);
    same(anchor, union);
    expect(anchor.h).toBe(36);
  });
});

describe('routed edges', () => {
  it('fans several outgoing edges out along one side, one port each', () => {
    const world = mkWorld();
    const src = mkNode(1, { x: 0, y: 400 });
    // targets above, level with and below the source, all to its right
    const targets = [mkNode(2, { x: 600, y: 0 }), mkNode(3, { x: 600, y: 400 }), mkNode(4, { x: 600, y: 800 })];
    renderBoard(world, [src, ...targets], [mkEdge(10, 1, 2), mkEdge(11, 1, 3), mkEdge(12, 1, 4)], mkState());
    const lines = [...world.querySelectorAll('path.edge-line')];
    expect(lines).toHaveLength(3);
    const starts = lines.map(l => /^M([-\d.]+),([-\d.]+)/.exec(l.getAttribute('d')!)!.slice(1).map(Number));
    for (const [x, y] of starts) {
      expect(x).toBe(160);
      expect(y).toBeGreaterThan(400);
      expect(y).toBeLessThan(480);
    }
    expect(new Set(starts.map(([, y]) => y)).size).toBe(3);
  });

  it('keeps two labels apart when their segments share a midpoint', () => {
    const world = mkWorld();
    // Two Z routes whose vertical runs lie on x 280, both centred at y 200.
    const nodes = [
      mkNode(1, { x: 0, y: 0 }),
      mkNode(2, { x: 400, y: 320 }),
      mkNode(3, { x: 0, y: 320 }),
      mkNode(4, { x: 400, y: 0 }),
    ];
    renderBoard(world, nodes, [mkEdge(10, 1, 2, 'calls'), mkEdge(11, 3, 4, 'reads')], mkState());
    const [p, q] = [...world.querySelectorAll('.edge-label-bg')].map(bg => ({
      x: Number(bg.getAttribute('x')), y: Number(bg.getAttribute('y')), w: Number(bg.getAttribute('width')), h: 18,
    }));
    const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
    expect(overlap).toBe(false);
    // the first keeps the shared midpoint
    expect(p.y + 9).toBe(200);
  });
});

describe('borderPoint shape awareness', () => {
  const rect = { x: 0, y: 0, w: 200, h: 100 };

  it('meets a rectangle on its bounding box', () => {
    // straight right of centre: lands on the right edge
    const p = borderPoint({ x: 500, y: 50 }, rect, 'rect');
    expect(p).toEqual({ x: 200, y: 50 });
  });

  it('meets an ellipse on the curve, not the box corner', () => {
    // 45 degrees out from centre. The box solution would be the corner
    // (200, 100); the ellipse must be strictly inside it.
    const p = borderPoint({ x: 1100, y: 550 }, rect, 'ellipse');
    expect(p.x).toBeLessThan(200);
    expect(p.y).toBeLessThan(100);
    // and it must satisfy the ellipse equation at the centre (100, 50)
    const nx = (p.x - 100) / 100;
    const ny = (p.y - 50) / 50;
    expect(nx * nx + ny * ny).toBeCloseTo(1, 6);
  });

  it('still reaches the extremes of an ellipse', () => {
    const right = borderPoint({ x: 900, y: 50 }, rect, 'ellipse');
    expect(right.x).toBeCloseTo(200, 6);
    expect(right.y).toBeCloseTo(50, 6);
    const bottom = borderPoint({ x: 100, y: 900 }, rect, 'ellipse');
    expect(bottom.x).toBeCloseTo(100, 6);
    expect(bottom.y).toBeCloseTo(100, 6);
  });

  it('defaults to rectangular behaviour when no shape is given', () => {
    expect(borderPoint({ x: 500, y: 50 }, rect)).toEqual(
      borderPoint({ x: 500, y: 50 }, rect, 'rect')
    );
  });

  it('returns the centre for a degenerate ray', () => {
    expect(borderPoint({ x: 100, y: 50 }, rect, 'ellipse')).toEqual({ x: 100, y: 50 });
  });
});

describe('code overlay badge (keyed contract)', () => {
  const badge = (count: number, first = 'Limiter.allow', w = 160) => ({
    key: `${count}|${w}|80|${first}`,
    count,
    first,
    title: `${first} · agent/src/limiter.ts:10–24`,
  });
  const three = () => [mkNode(1), mkNode(2), mkNode(3)];
  const edges = () => [mkEdge(10, 1, 2), mkEdge(11, 2, 3)];
  const on = (count = 3) => mkState({ codeOverlay: true, refsByNode: new Map([[2n, badge(count)]]) });

  it('adds the badge only under the node with refs; besides the root class only its text block moves', () => {
    const world = mkWorld();
    renderBoard(world, three(), edges(), mkState());
    const g2 = world.querySelector('[data-id="2"]')!;
    const recs = mutations(world, () => renderBoard(world, three(), edges(), on()));
    const childList = recs.filter(r => r.type === 'childList');
    expect(childList).toHaveLength(1);
    expect(childList[0].target).toBe(g2);
    // G36: the label block keeps 8 px clear of the badge row, so node 2's
    // label and sublabel baselines move up; nothing else changes.
    const attrs = recs.filter(r => r.type === 'attributes');
    expect(attrs[0].target).toBe(world);
    for (const r of attrs.slice(1)) {
      expect(g2.contains(r.target)).toBe(true);
      expect((r.target as Element).matches('.node-label, .node-sublabel')).toBe(true);
      expect(r.attributeName).toBe('y');
    }
    expect(world.classList.contains('code')).toBe(true);
    const refs = world.querySelectorAll('.node-refs');
    expect(refs).toHaveLength(1);
    expect(g2.contains(refs[0])).toBe(true);
    // G5: the group takes hover so its <title> (the full ref list) shows.
    expect(refs[0].getAttribute('pointer-events')).toBeNull();
    expect(refs[0].querySelector('text')!.getAttribute('pointer-events')).toBeNull();
    expect(refs[0].querySelector('title')!.textContent).toBe('Limiter.allow · agent/src/limiter.ts:10–24');
    const text = refs[0].querySelector('text')!;
    expect(text.textContent).toBe('3 refs');
    expect(text.getAttribute('class')).toBe('node-refs-text');
    expect(text.getAttribute('x')).toBe('150');
    expect(text.getAttribute('y')).toBe('70');
  });

  it('fades the badge out then removes it; rects and edges untouched, the text block recentres', () => {
    vi.useFakeTimers();
    try {
      const world = mkWorld();
      renderBoard(world, three(), edges(), on());
      const g2 = world.querySelector('[data-id="2"]')!;
      const recs = mutations(world, () => renderBoard(world, three(), edges(), mkState()));
      for (const r of recs) {
        expect(r.target === world || g2.contains(r.target)).toBe(true);
        const el = r.target as Element;
        expect(el.matches?.('.node-rect, .edge-line, .edge-hit') ?? false).toBe(false);
        // G36: with the badge gone the label block returns to the centre
        if (el.matches?.('.node-label, .node-sublabel')) {
          expect(r.attributeName).toBe('y');
        }
      }
      expect(world.querySelector('.node-refs')!.classList.contains('leaving')).toBe(true);
      expect(world.classList.contains('code')).toBe(false);
      vi.advanceTimersByTime(BADGE_FADE_MS);
      expect(world.querySelector('.node-refs')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a drag transform-only with the overlay on', () => {
    const world = mkWorld();
    renderBoard(world, three(), edges(), on());
    const refsG = world.querySelector('.node-refs')!;
    const recs = mutations(world, () =>
      renderBoard(
        world,
        three(),
        edges(),
        mkState({
          codeOverlay: true,
          refsByNode: new Map([[2n, badge(3)]]),
          overrides: new Map([[1n, { x: 320, y: 140 }]]),
        })
      )
    );
    expect(recs.filter(r => r.type === 'childList')).toHaveLength(0);
    expect(recs).toHaveLength(3);
    expect(world.querySelector('.node-refs')).toBe(refsG);
  });

  it('is a no-op on identical input with the overlay on', () => {
    const world = mkWorld();
    renderBoard(world, three(), edges(), on());
    const recs = mutations(world, () => renderBoard(world, three(), edges(), on()));
    expect(recs).toHaveLength(0);
  });

  it('shows the first symbol on nodes at least 200 px wide, singular for one ref', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2, { w: 240 })];
    renderBoard(
      world,
      nodes,
      [],
      mkState({ codeOverlay: true, refsByNode: new Map([[1n, badge(1)], [2n, badge(3, 'Limiter.allow', 240)]]) })
    );
    const texts = new Map(
      [...world.querySelectorAll<SVGGElement>('.node')].map(g => [g.dataset.id, g.querySelector('.node-refs-text')!.textContent])
    );
    expect(texts.get('1')).toBe('1 ref');
    expect(texts.get('2')).toBe('3 refs · Limiter.allow');
  });

  it('rebuilds the badge when the key changes and survives a kind change', () => {
    const world = mkWorld();
    renderBoard(world, three(), edges(), on(3));
    const first = world.querySelector('.node-refs')!;
    renderBoard(world, three(), edges(), on(4));
    const second = world.querySelector('.node-refs')!;
    expect(second).not.toBe(first);
    expect(world.querySelectorAll('.node-refs')).toHaveLength(1);
    expect(second.querySelector('text')!.textContent).toBe('4 refs');
    // Kind change rebuilds the inner DOM: the badge must come back, exactly once.
    renderBoard(world, [mkNode(1), mkNode(2, { kind: 'note' }), mkNode(3)], edges(), on(4));
    const after = world.querySelectorAll('.node-refs');
    expect(after).toHaveLength(1);
    expect(world.querySelector('[data-id="2"]')!.contains(after[0])).toBe(true);
  });
});

describe('code overlay badge hover (G5)', () => {
  it('the badge text is hit-testable so the <title> tooltip can show; ghosts stay inert', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const rule = (sel: string) => {
      const at = css.indexOf(`\n${sel} {`);
      return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
    };
    expect(rule('.node-refs-text')).toMatch(/pointer-events:\s*visiblePainted/);
    expect(rule('.node-refs-text')).toMatch(/cursor:\s*default/);
    expect(rule('.node.ghost .node-refs-text')).toMatch(/pointer-events:\s*none/);
  });
});

describe('code overlay badge title follows the refs (F12)', () => {
  function mkRef(id: number, over: Partial<CodeRef> = {}): CodeRef {
    return {
      id: BigInt(id), boardId: 1n, targetKind: 'node', targetId: 2n, path: 'agent/src/limiter.ts',
      symbol: 'Limiter.allow', startLine: 10, endLine: 24, blobSha: 'a'.repeat(40), snippet: 'allow() {}',
      author: '', checkpoint: 1, status: 'ok', ...over,
    };
  }
  // What main.ts does: titles once per table change, the key per frame.
  let titles: Map<bigint, BadgeTitle> = new Map();
  function stateFor(rows: CodeRef[]): RenderState {
    const index = buildRefsIndex(rows, 1n);
    titles = buildBadgeTitles(index, titles);
    const refs = index.get('node:2')!;
    return mkState({ codeOverlay: true, refsByNode: new Map([[2n, badgeFor(refs, 160, 80, titles.get(2n)!)]]) });
  }
  const nodes = () => [mkNode(1), mkNode(2), mkNode(3)];
  const title = (world: SVGGElement) => world.querySelector('.node-refs title')!.textContent;

  it('updates the <title> when a checkpoint shifts the range (same count, same first symbol)', () => {
    titles = new Map();
    const world = mkWorld();
    renderBoard(world, nodes(), [], stateFor([mkRef(1), mkRef(2, { symbol: 'Limiter.reset', startLine: 30, endLine: 34 })]));
    expect(title(world)).toBe('Limiter.allow · agent/src/limiter.ts:10–24\nLimiter.reset · agent/src/limiter.ts:30–34');
    renderBoard(world, nodes(), [], stateFor([mkRef(1, { startLine: 14, endLine: 28 }), mkRef(2, { symbol: 'Limiter.reset', startLine: 30, endLine: 34 })]));
    expect(title(world)).toBe('Limiter.allow · agent/src/limiter.ts:14–28\nLimiter.reset · agent/src/limiter.ts:30–34');
    expect(world.querySelectorAll('.node-refs')).toHaveLength(1);
  });

  it('updates the <title> on remove B + add C (the skill\'s replace flow)', () => {
    titles = new Map();
    const world = mkWorld();
    renderBoard(world, nodes(), [], stateFor([mkRef(1), mkRef(2, { symbol: 'Limiter.reset' })]));
    renderBoard(world, nodes(), [], stateFor([mkRef(1), mkRef(3, { symbol: 'Limiter.refill' })]));
    expect(title(world)).toContain('Limiter.refill');
    expect(title(world)).not.toContain('Limiter.reset');
  });

  it('status-only change repaints badge (G12)', () => {
    titles = new Map();
    const world = mkWorld();
    const wide = () => [mkNode(1), mkNode(2, { w: 320 }), mkNode(3)];
    const at = (rows: CodeRef[]) => {
      const index = buildRefsIndex(rows, 1n);
      titles = buildBadgeTitles(index, titles);
      return mkState({ codeOverlay: true, refsByNode: new Map([[2n, badgeFor(index.get('node:2')!, 320, 80, titles.get(2n)!)]]) });
    };
    const rows = [mkRef(1, { symbol: 'boardLink' }), mkRef(2, { symbol: 'Limiter.reset' })];
    renderBoard(world, wide(), [], at(rows));
    const before = world.querySelector('.node-refs')!;
    expect(before.querySelector('text')!.textContent).toBe('2 refs · boardLink');
    renderBoard(world, wide(), [], at([{ ...rows[0], status: 'stale' }, rows[1]]));
    const after = world.querySelector('.node-refs')!;
    expect(after).not.toBe(before);
    expect(world.querySelectorAll('.node-refs')).toHaveLength(1);
    // The symbol slot moves to the first ok ref; the status rides at the end, muted.
    expect(after.querySelector('text')!.textContent).toBe('2 refs · Limiter.reset · 1 stale');
    const status = after.querySelector('tspan.node-refs-status')!;
    expect(status.textContent).toBe(' · 1 stale');
    expect(after.querySelector('title')!.textContent).toContain('boardLink · agent/src/limiter.ts:10–24 (stale)');
  });

  it('a narrow node still shows the status after the count (G12)', () => {
    titles = new Map();
    const world = mkWorld();
    renderBoard(world, nodes(), [], stateFor([mkRef(1, { status: 'ambiguous' })]));
    expect(world.querySelector('.node-refs text')!.textContent).toBe('1 ref · 1 ambiguous');
  });

  it('identical refs on the next table change keep the badge (zero mutation records)', () => {
    titles = new Map();
    const world = mkWorld();
    const rows = [mkRef(1)];
    renderBoard(world, nodes(), [], stateFor(rows));
    const recs = mutations(world, () => renderBoard(world, nodes(), [], stateFor(rows.map(r => ({ ...r })))));
    expect(recs).toHaveLength(0);
  });
});

describe('code overlay badge stays inside the node (F20)', () => {
  const badge = (count: number, first: string, w: number, h = 80) => ({
    key: `${count}|${w}|${h}|${first}|0`,
    count,
    first,
    title: first,
  });

  /** Is the point inside the node outline (rect corners are rx 10)? */
  function inside(shape: string, w: number, h: number, px: number, py: number): boolean {
    if (px < 0 || py < 0 || px > w || py > h) {
      return false;
    }
    if (shape === 'ellipse') {
      return ((px - w / 2) / (w / 2)) ** 2 + ((py - h / 2) / (h / 2)) ** 2 <= 1;
    }
    const r = shape === 'pill' ? h / 2 : 10;
    const cx = Math.min(Math.max(px, r), w - r);
    const cy = Math.min(Math.max(py, r), h - r);
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  }

  function textBox(world: SVGGElement, id: number) {
    const t = world.querySelector(`[data-id="${id}"] .node-refs-text`)!;
    const x = Number(t.getAttribute('x'));
    const y = Number(t.getAttribute('y'));
    const len = [...t.textContent!].length;
    return { text: t.textContent!, x, y, left: x - len * BADGE_CHAR_PX, top: y - 9, bottom: y + 3 };
  }

  const LONG = 'ConnectionManager.scheduleReconnect';
  const cases: Array<[string, number, number, string]> = [
    ['rect', 200, 80, LONG],
    ['rect', 240, 80, 'aVeryLongTopLevelFunctionNameWithoutAnyDots'],
    ['rect', 160, 80, LONG],
    ['ellipse', 160, 80, LONG],
    ['ellipse', 240, 120, LONG],
    ['pill', 200, 80, LONG],
    ['pill', 280, 48, 'Limiter.allow'],
    ['pill', 200, 200, LONG],
  ];

  it.each(cases)('%s %ix%i: the badge text box lies inside the outline', (shape, w, h, first) => {
    const world = mkWorld();
    const node = mkNode(1, { shape, w, h });
    // The outline is the stored rect (G2).
    const r = nodeRect(node, new Map());
    renderBoard(
      world,
      [node],
      [],
      mkState({ codeOverlay: true, refsByNode: new Map([[1n, badge(12, first, r.w, r.h)]]) })
    );
    const b = textBox(world, 1);
    for (const [px, py] of [
      [b.left, b.top],
      [b.x, b.top],
      [b.left, b.bottom],
      [b.x, b.bottom],
    ]) {
      expect(inside(shape, r.w, r.h, px, py), `${b.text} corner (${px}, ${py})`).toBe(true);
    }
    expect(b.text.startsWith('12 refs')).toBe(true);
  });

  it('shortens a long dotted symbol to its member name, else drops it; a needle is never cut (G36)', () => {
    const world = mkWorld();
    const nodes = [mkNode(1, { w: 200 }), mkNode(2, { w: 240 }), mkNode(3, { w: 200, h: 200, shape: 'pill' })];
    renderBoard(
      world,
      nodes,
      [],
      mkState({
        codeOverlay: true,
        refsByNode: new Map([
          [1n, badge(1, LONG, 200)],
          [2n, badge(3, 'aVeryLongTopLevelFunctionNameWithoutAnyDots', 240)],
          // a 200×200 pill is a circle: no room left for any symbol text
          [3n, badge(3, 'aVeryLongTopLevelFunctionNameWithoutAnyDots', 200, 200)],
        ]),
      })
    );
    expect(textBox(world, 1).text).toBe('1 ref · …scheduleReconnect');
    expect(textBox(world, 2).text).toBe('3 refs');
    expect(textBox(world, 3).text).toBe('3 refs');
  });

  it('a shape change re-anchors the badge', () => {
    const world = mkWorld();
    const st = mkState({ codeOverlay: true, refsByNode: new Map([[1n, badge(3, 'Limiter.allow', 160)]]) });
    renderBoard(world, [mkNode(1)], [], st);
    expect(textBox(world, 1).x).toBe(150);
    renderBoard(world, [mkNode(1, { shape: 'ellipse' })], [], st);
    expect(world.querySelectorAll('.node-refs')).toHaveLength(1);
    expect(textBox(world, 1).x).toBeLessThan(150);
    expect(inside('ellipse', 160, 80, textBox(world, 1).x, textBox(world, 1).bottom)).toBe(true);
  });
});


describe('badge needle (G36)', () => {
  const badge = (count: number, first: string, w: number, h: number) => ({ key: `${count}|${w}|${h}|${first}|0`, count, first, title: first });

  it('ellipse with 12-char symbol → "1 ref"', () => {
    const world = mkWorld();
    const n = mkNode(1, { shape: 'ellipse', w: 208, h: 80, label: 'symbol resolver', sublabel: 'agent/src/resolver.ts' });
    renderBoard(world, [n], [], mkState({ codeOverlay: true, refsByNode: new Map([[1n, badge(1, 'isResolvable', 208, 80)]]) }));
    expect(world.querySelector('[data-id="1"] .node-refs-text')!.textContent).toBe('1 ref');
    expect(world.querySelector('[data-id="1"] .node-refs title')!.textContent).toBe('isResolvable');
  });

  it('a needle that does not fit is never cut: the badge falls back to the count', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { w: 240 })], [], mkState({
      codeOverlay: true,
      refsByNode: new Map([[1n, badge(3, 'aVeryLongTopLevelFunctionNameWithoutAnyDots', 240, 80)]]),
    }));
    expect(world.querySelector('.node-refs-text')!.textContent).toBe('3 refs');
  });
});

describe('node geometry: drawn = stored (G2)', () => {
  const LONG = 'result texts and the companion checkpoint summary formatter';
  const rectOf = (world: SVGGElement, id: number) => {
    const g = world.querySelector(`[data-id="${id}"]`)!;
    const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform')!)!;
    const r = g.querySelector('.node-rect')!;
    return { x: Number(m[1]), y: Number(m[2]), w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height')) };
  };

  it('a 59-char label never widens past stored w and wraps to 2 lines', () => {
    expect(LONG).toHaveLength(59);
    const world = mkWorld();
    const n = mkNode(1, { x: 600, y: 32, w: 280, h: 80, label: LONG, sublabel: 'agent/src/results.ts' });
    renderBoard(world, [n], [], mkState());
    expect(rectOf(world, 1)).toEqual({ x: 600, y: 32, w: 280, h: 80 });
    const label = world.querySelector('[data-id="1"] .node-label')!;
    const lines = [...label.querySelectorAll('tspan')];
    expect(lines).toHaveLength(2);
    // jsdom has no canvas: textWidth falls back to 0.65 em per character
    for (const line of lines) {
      expect(Number(line.getAttribute('x'))).toBe(140);
      expect([...line.textContent!].length * 15 * 0.65).toBeLessThanOrEqual(280 - 32);
    }
    expect(lines[1].textContent!.endsWith('…')).toBe(true);
    // what the ellipsis cut stays readable on hover
    expect(world.querySelector('[data-id="1"] > title')!.textContent).toContain(LONG);
    expect(world.querySelector('[data-id="1"] .node-sublabel')!.textContent).toBe('agent/src/results.ts');
  });

  it('a 48-px node is drawn 48 px tall, and a label that fits stays one plain line with no <title>', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { w: 160, h: 48, label: 'MCP server', sublabel: '' })], [], mkState());
    expect(rectOf(world, 1).h).toBe(48);
    const label = world.querySelector('[data-id="1"] .node-label')!;
    expect(label.querySelectorAll('tspan')).toHaveLength(0);
    expect(label.textContent).toBe('MCP server');
    expect(world.querySelector('[data-id="1"] > title')).toBeNull();
  });

  it('a member never renders outside its boundary rect', () => {
    const world = mkWorld();
    const boundary = mkNode(1, { kind: 'boundary', x: 0, y: 0, w: 920, h: 336, label: 'agent process' });
    const member = mkNode(2, { x: 600, y: 32, w: 280, h: 80, label: LONG, sublabel: 'agent/src/results.ts' });
    renderBoard(world, [boundary, member], [], mkState());
    const b = rectOf(world, 1);
    const m = rectOf(world, 2);
    expect(m.x + m.w).toBeLessThanOrEqual(b.x + b.w);
    expect(m.y + m.h).toBeLessThanOrEqual(b.y + b.h);
    // nodeRect (selection, fit, edges, readout) agrees with the drawn rect
    expect(nodeRect(member, new Map())).toEqual(m);
  });

  it('readout equals stored size: nodeRect is the stored rect, overrides aside', () => {
    const n = mkNode(1, { w: 160, h: 48, label: LONG, sublabel: 'a/very/long/path/to/some/file/in/the/repo.ts' });
    expect(nodeRect(n, new Map())).toEqual({ x: n.x, y: n.y, w: 160, h: 48 });
    expect(nodeRect(n, new Map([[1n, { x: 8, y: 12, w: 64, h: 48 }]]))).toEqual({ x: 8, y: 12, w: 64, h: 48 });
    expect(contentBounds([n])).toEqual({ minX: n.x, minY: n.y, maxX: n.x + 160, maxY: n.y + 48 });
  });

  it('a sublabel too long for the row is ellipsized, and the <title> carries it', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { w: 160, h: 80, label: 'svc', sublabel: 'importer/src/board-stats-and-more.ts' })], [], mkState());
    const sub = world.querySelector('[data-id="1"] .node-sublabel')!.textContent!;
    // a path keeps its tail, the file name being the part that identifies it
    expect(sub.startsWith('…')).toBe(true);
    expect('importer/src/board-stats-and-more.ts'.endsWith(sub.slice(1))).toBe(true);
    expect([...sub].length * 12 * 0.65).toBeLessThanOrEqual(160 - 32);
    expect(world.querySelector('[data-id="1"] > title')!.textContent).toBe('svc\nimporter/src/board-stats-and-more.ts');
  });

  it('a short node shows the label alone; the dropped sublabel moves into the <title>', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { w: 200, h: 32, label: 'cache', sublabel: 'src/cache.ts' })], [], mkState());
    expect(world.querySelector('[data-id="1"] .node-sublabel')!.textContent).toBe('');
    expect(world.querySelector('[data-id="1"] .node-label')!.textContent).toBe('cache');
    expect(world.querySelector('[data-id="1"] > title')!.textContent).toBe('cache\nsrc/cache.ts');
  });

  it('a 2-line label on an ellipse fits the curve at each row', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { shape: 'ellipse', w: 208, h: 80, label: LONG, sublabel: '' })], [], mkState());
    const label = world.querySelector('[data-id="1"] .node-label')!;
    const y0 = Number(label.getAttribute('y'));
    const lines = [...label.querySelectorAll('tspan')];
    expect(lines).toHaveLength(2);
    lines.forEach((line, i) => {
      const half = ([...line.textContent!].length * 15 * 0.65) / 2;
      const base = y0 + i * Number(lines[1].getAttribute('dy'));
      for (const y of [base - 11, base + 3]) {
        expect(((half) / 104) ** 2 + ((y - 40) / 40) ** 2).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe('vertical centring (G9)', () => {
  const labelY = (world: SVGGElement) => Number(world.querySelector('[data-id="1"] .node-label')!.getAttribute('y'));

  it('label-only node: label y ≈ rect centre; adding a sublabel moves it', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { h: 80, label: 'New node', sublabel: '' })], [], mkState());
    // the cap height (≈0.7 em) is centred: baseline at h/2 + 0.35 × 15
    expect(labelY(world)).toBeCloseTo(40 + 0.35 * 15, 1);
    renderBoard(world, [mkNode(1, { h: 80, label: 'New node', sublabel: 'src/new.ts' })], [], mkState());
    expect(labelY(world)).toBeCloseTo(40 - 9, 1);
    expect(Number(world.querySelector('[data-id="1"] .node-sublabel')!.getAttribute('y'))).toBeCloseTo(40 + 13, 1);
    renderBoard(world, [mkNode(1, { h: 80, label: 'New node', sublabel: '' })], [], mkState());
    expect(labelY(world)).toBeCloseTo(40 + 0.35 * 15, 1);
  });

  it('a two-line label is centred as a block', () => {
    const world = mkWorld();
    const label = 'result texts and the companion checkpoint summary formatter';
    renderBoard(world, [mkNode(1, { w: 280, h: 96, label, sublabel: '' })], [], mkState());
    const dy = Number(world.querySelector('[data-id="1"] .node-label tspan + tspan')!.getAttribute('dy'));
    const top = labelY(world) - 0.7 * 15;
    const bottom = labelY(world) + dy;
    expect((top + bottom) / 2).toBeCloseTo(48, 0);
  });

  it('in dense zoom the sublabel hides and the label centres', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { h: 80, label: 'svc', sublabel: 'src/svc.ts' })], [], mkState({ scale: 0.5 }));
    expect(labelY(world)).toBeCloseTo(40 + 0.35 * 15, 1);
    renderBoard(world, [mkNode(1, { h: 80, label: 'svc', sublabel: 'src/svc.ts' })], [], mkState({ scale: 1 }));
    expect(labelY(world)).toBeCloseTo(40 - 9, 1);
  });
});

describe('badge row (G36)', () => {
  const badge = (count: number, first: string, w: number, h: number) => ({ key: `${count}|${w}|${h}|${first}|0`, count, first, title: first });

  it.each([
    ['rect', 160, 80],
    ['rect', 280, 80],
    ['ellipse', 208, 80],
    ['pill', 248, 80],
    ['rect', 160, 64],
  ])('%s %ix%i: the text block ends at least 8 px above the badge', (shape, w, h) => {
    const world = mkWorld();
    const n = mkNode(1, { shape, w, h, label: 'result texts and the companion checkpoint summary formatter', sublabel: 'agent/src/results.ts' });
    renderBoard(world, [n], [], mkState({ codeOverlay: true, refsByNode: new Map([[1n, badge(3, 'boardLink', w, h)]]) }));
    expect(Number(world.querySelector('[data-id="1"] .node-rect')!.getAttribute('height'))).toBe(h);
    const badgeTop = Number(world.querySelector('.node-refs-text')!.getAttribute('y')) - 9;
    const label = world.querySelector('[data-id="1"] .node-label')!;
    const sub = world.querySelector('[data-id="1"] .node-sublabel')!;
    const lines = Math.max(1, label.querySelectorAll('tspan').length);
    const lh = lines > 1 ? Number(label.querySelector('tspan + tspan')!.getAttribute('dy')) : 0;
    const bottom = sub.textContent
      ? Number(sub.getAttribute('y')) + 3
      : Number(label.getAttribute('y')) + (lines - 1) * lh + 0.22 * 15;
    expect(bottom).toBeLessThanOrEqual(badgeTop - 8 + 1e-9);
    expect(Number(label.getAttribute('y')) - 0.72 * 15).toBeGreaterThanOrEqual(0);
  });

  it('a 32-px node: the label stays centred and the badge shows its count alone, clear of it', () => {
    const world = mkWorld();
    const n = mkNode(1, { w: 240, h: 32, label: 'resolver', sublabel: 'agent/src/resolver.ts' });
    const refs = { ...badge(3, 'isResolvable', 240, 32), stale: 1 };
    renderBoard(world, [n], [], mkState({ codeOverlay: true, refsByNode: new Map([[1n, refs]]) }));
    const text = world.querySelector('.node-refs-text')!;
    // too short to lift the label above the badge row: the symbol (and the
    // status) go, the <title> keeps them
    expect(text.textContent).toBe('3 refs');
    expect(world.querySelector('.node-refs-status')).toBeNull();
    expect(world.querySelector('.node-refs title')!.textContent).toBe('isResolvable');
    const label = world.querySelector('[data-id="1"] .node-label')!;
    expect(label.textContent).toBe('resolver');
    const y = Number(label.getAttribute('y'));
    expect(y).toBeCloseTo(16 + 0.35 * 15, 5);
    // the label and the count share the row, never the same pixels
    const labelRight = 120 + ([...label.textContent!].length * 15 * 0.65) / 2;
    expect(labelRight).toBeLessThanOrEqual(Number(text.getAttribute('x')) - '3 refs'.length * BADGE_CHAR_PX);
    // identical input: nothing written
    expect(mutations(world, () => renderBoard(world, [n], [], mkState({ codeOverlay: true, refsByNode: new Map([[1n, refs]]) })))).toHaveLength(0);
  });

  it('a 44-px node: the label lifts to end 8 px above the badge, which keeps its symbol', () => {
    const world = mkWorld();
    const n = mkNode(1, { w: 240, h: 44, label: 'resolver', sublabel: 'agent/src/resolver.ts' });
    renderBoard(world, [n], [], mkState({ codeOverlay: true, refsByNode: new Map([[1n, badge(3, 'isResolvable', 240, 44)]]) }));
    const text = world.querySelector('.node-refs-text')!;
    expect(text.textContent).toBe('3 refs · isResolvable');
    const badgeTop = Number(text.getAttribute('y')) - 9;
    const y = Number(world.querySelector('[data-id="1"] .node-label')!.getAttribute('y'));
    expect(y + 0.22 * 15).toBeCloseTo(badgeTop - 8, 5);
    expect(y - 0.72 * 15).toBeGreaterThanOrEqual(2);
    // a size-l label no longer clears the outline there: the badge drops to
    // its count although the badge key (count, w, h, symbol) is unchanged
    renderBoard(world, [{ ...n, size: 'l' }], [], mkState({ codeOverlay: true, refsByNode: new Map([[1n, badge(3, 'isResolvable', 240, 44)]]) }));
    expect(world.querySelector('.node-refs-text')!.textContent).toBe('3 refs');
    expect(world.querySelectorAll('.node-refs')).toHaveLength(1);
  });

  it('on an 80-px node the badge leaves room for one label line; the cut label keeps its <title>', () => {
    const world = mkWorld();
    const label = 'result texts and the companion checkpoint summary formatter';
    const n = mkNode(1, { w: 280, h: 80, label, sublabel: 'agent/src/results.ts' });
    renderBoard(world, [n], [], mkState({ codeOverlay: true, refsByNode: new Map([[1n, badge(3, 'boardLink', 280, 80)]]) }));
    const el = world.querySelector('[data-id="1"] .node-label')!;
    expect(el.querySelectorAll('tspan')).toHaveLength(0);
    expect(el.textContent!.endsWith('…')).toBe(true);
    expect(world.querySelector('[data-id="1"] > title')!.textContent).toContain(label);
    expect(world.querySelector('[data-id="1"] .node-sublabel')!.textContent).toBe('agent/src/results.ts');
  });
});

describe('ellipsis at a word (G2)', () => {
  it('a cut label ends at the last whole word when one is near the cut', () => {
    const world = mkWorld();
    const label = 'result texts and the companion checkpoint summary formatter';
    const n = mkNode(1, { w: 280, h: 80, label, sublabel: 'agent/src/results.ts' });
    renderBoard(world, [n], [], mkState({ codeOverlay: true, refsByNode: new Map([[1n, { key: 'k', count: 3, first: 'boardLink', title: 'boardLink' }]]) }));
    const text = world.querySelector('[data-id="1"] .node-label')!.textContent!;
    expect(text).toMatch(/^result texts and the\S*…$/);
    expect(label.startsWith(text.slice(0, -1))).toBe(true);
    expect(label[text.length - 1]).toBe(' ');
  });
});

describe('whitespace in a label (G23)', () => {
  it('a padded, double-spaced label lays out as its single-spaced form at every width check', () => {
    const fit = (label: string, w: number, h: number) => {
      const t = layoutNodeText({ label, sublabel: 'x', size: 'm', shape: 'rect' }, w, h, null);
      return { ...t, title: '' };
    };
    // jsdom measures 0.65 em per character: 'alpha beta' (97.5 px) fits the
    // 100 px row of w=132; the raw '  alpha   beta  ' (156 px) would not
    for (const [w, h] of [[132, 48], [132, 80], [100, 48], [160, 64]]) {
      expect(fit('  alpha   beta  ', w, h), `w=${w} h=${h}`).toEqual(fit('alpha beta', w, h));
    }
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { w: 132, h: 48, label: '  alpha   beta  ', sublabel: 'x' })], [], mkState());
    expect(world.querySelector('[data-id="1"] .node-label')!.textContent).toBe('alpha beta');
    expect(world.querySelector('[data-id="1"] > title')).toBeNull();
  });
});

describe("sublabel ellipsis keeps a path's file name (G2)", () => {
  it.each([
    ['agent/src/snippet.test.ts', 200, '…/src/snippet.test.ts'],
    ['agent/src/snippet.test.ts', 176, '…/snippet.test.ts'],
    ['agent/src/session.ts', 200, 'agent/src/session.ts'],
    // text with spaces is not a path: it ends at a word
    ['vscode:// cursor:// zed:// and some more schemes', 200, 'vscode:// cursor://…'],
  ])('%s in %i px → %s', (sublabel, w, expected) => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { w, sublabel })], [], mkState());
    expect(world.querySelector('[data-id="1"] .node-sublabel')!.textContent).toBe(expected);
  });

  const sub = (sublabel: string, w: number) => layoutNodeText({ label: 'n', sublabel, size: 'm', shape: 'rect' }, w, 80, null).sub;

  it.each([
    ['x'.repeat(3000) + '/src/session.ts', 200, '…/src/session.ts'],
    ['dir/' + 'y'.repeat(3000), 200, '…' + 'y'.repeat(20)],
    ['ab/'.repeat(400) + 'session.ts', 200, '…/ab/ab/ab/session.ts'],
    ['ab/'.repeat(400) + 'session.ts', 2000, '…' + '/ab'.repeat(80) + '/session.ts'],
  ])('a long path keeps the same tail: %#', (sublabel, w, expected) => {
    expect(sub(sublabel, w)).toBe(expected);
  });

  // Only a tail is ever shown, so the cost must not grow with the square of the length (U20).
  it('lays out a 48 KB path sublabel quickly', () => {
    const start = performance.now();
    expect(sub('ab/'.repeat(16000), 160)).toBe('…/ab/ab/ab/ab/');
    expect(performance.now() - start).toBeLessThan(200);
  });

  // The module has no width cap, so a huge node must not reopen the quadratic loop.
  it('lays out a 48 KB path sublabel quickly in a very wide node', () => {
    const start = performance.now();
    expect(sub('ab/'.repeat(16000), 200_000)).toBe('…' + '/ab'.repeat(170) + '/');
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('edge ref suffix under the code overlay (G51)', () => {
  // Horizontal pair at y=100: borders at x=160..560, centres at y=140.
  const nodes = () => [mkNode(1, { x: 0, y: 100 }), mkNode(2, { x: 560, y: 100 })];
  const refs = (count: number, rev = 0) => ({
    key: `${count}|0|0|buildEditorHref|${rev}`,
    count,
    title: 'buildEditorHref · client/src/editor-link.ts:34–51',
  });
  const on = (count = 1, rev = 0) => mkState({ codeOverlay: true, refsByEdge: new Map([[10n, refs(count, rev)]]) });
  const suffix = (world: SVGGElement) => world.querySelector('.edge-refs');

  it('edge with refs shows suffix under overlay; none when off; identical input → zero mutations', () => {
    const world = mkWorld();
    renderBoard(world, nodes(), [mkEdge(10, 1, 2, 'builds href')], on(1));
    const g = suffix(world)!;
    expect(g).not.toBeNull();
    expect(g.querySelector('.edge-refs-text')!.textContent).toBe('· 1 ref');
    expect(g.querySelector('title')!.textContent).toBe('buildEditorHref · client/src/editor-link.ts:34–51');
    // the label itself is untouched; the pair reads as one centred run
    const label = world.querySelector('.edge-label')!;
    expect(label.textContent).toBe('builds href');
    const bg = world.querySelector('.edge-label-bg')!;
    const mid = (160 + 560) / 2;
    expect(Number(bg.getAttribute('x')) + Number(bg.getAttribute('width')) / 2).toBeCloseTo(mid);
    expect(Number(bg.getAttribute('width'))).toBeCloseTo(('builds href' + ' · 1 ref').length * 7.3 + 8);
    // clicks on the suffix still select the edge
    expect(g.getAttribute('data-edge-id')).toBe('10');
    // it sits above the label's hit box, so its <title> takes hover
    expect(g.parentElement!.lastElementChild).toBe(g);
    // never accent
    expect(g.outerHTML).not.toMatch(/accent/);

    const recs = mutations(world, () => renderBoard(world, nodes(), [mkEdge(10, 1, 2, 'builds href')], on(1)));
    expect(recs).toHaveLength(0);

    renderBoard(world, nodes(), [mkEdge(10, 1, 2, 'builds href')], mkState({ refsByEdge: new Map([[10n, refs(1)]]) }));
    expect(suffix(world)).toBeNull();
    expect(world.querySelector('.edge-label')).toBe(label);
    expect(Number(label.getAttribute('x'))).toBeCloseTo(mid);
  });

  it('edge badges are built once per table change; a plain rerender reuses the map and reads no ref', () => {
    const row = (id: number, targetId: bigint, status = 'ok'): CodeRef => ({
      id: BigInt(id), boardId: 1n, targetKind: 'edge', targetId, path: 'client/src/editor-link.ts',
      symbol: 'buildEditorHref', startLine: 34, endLine: 51, blobSha: 'a'.repeat(40), snippet: 'buildEditorHref',
      author: '', checkpoint: 1, status,
    });
    // What main.ts does on a code-ref table change: index, titles, badges.
    const index = buildRefsIndex([row(1, 10n), row(2, 10n, 'stale'), row(3, 11n), { ...row(4, 2n), targetKind: 'node' }], 1n);
    const titles = buildBadgeTitles(index, new Map(), 'edge');
    const badges = buildEdgeBadges(index, titles);
    // edges only: node 2's ref is a node badge, not an edge suffix
    expect([...badges.keys()]).toEqual([10n, 11n]);
    expect(badges.get(10n)).toEqual(edgeBadgeFor(index.get('edge:10')!, titles.get(10n)!));
    // From here on, any read of a ref list is per-ref work.
    let reads = 0;
    for (const [key, refs] of index) {
      index.set(key, new Proxy(refs, { get: (t, p, r) => { reads++; return Reflect.get(t, p, r); } }));
    }
    const world = mkWorld();
    const frame = () => mkState({ codeOverlay: true, refsByEdge: badges });
    const states = [frame(), frame(), frame()];
    for (const s of states) {
      renderBoard(world, nodes(), [mkEdge(10, 1, 2, 'builds href')], s);
    }
    expect(reads).toBe(0);
    expect(states.every(s => s.refsByEdge === badges)).toBe(true);
    expect(world.querySelector('.edge-refs-text')!.textContent).toBe('· 2 refs');
  });

  it('an unlabelled edge shows "N refs" alone, centred on the path', () => {
    const world = mkWorld();
    renderBoard(world, nodes(), [mkEdge(10, 1, 2)], on(2));
    const text = world.querySelector('.edge-refs-text')!;
    expect(text.textContent).toBe('2 refs');
    const bg = world.querySelector('.edge-label-bg')!;
    expect(Number(bg.getAttribute('x')) + Number(bg.getAttribute('width')) / 2).toBeCloseTo((160 + 560) / 2);
    renderBoard(world, nodes(), [mkEdge(10, 1, 2)], mkState());
    expect(world.querySelectorAll('.edge-refs, .edge-label, .edge-label-bg')).toHaveLength(0);
  });

  it('a new title revision rebuilds the suffix; a drag moves it with the label', () => {
    const world = mkWorld();
    renderBoard(world, nodes(), [mkEdge(10, 1, 2, 'opens')], on(1, 0));
    const first = suffix(world)!;
    renderBoard(world, nodes(), [mkEdge(10, 1, 2, 'opens')], on(1, 1));
    expect(suffix(world)).not.toBe(first);
    expect(world.querySelectorAll('.edge-refs')).toHaveLength(1);
    const text = world.querySelector('.edge-refs-text')!;
    const x = Number(text.getAttribute('x'));
    const moved = [mkNode(1, { x: 0, y: 100 }), mkNode(2, { x: 760, y: 100 })];
    renderBoard(world, moved, [mkEdge(10, 1, 2, 'opens')], on(1, 1));
    expect(world.querySelector('.edge-refs-text')).toBe(text);
    expect(Number(text.getAttribute('x'))).toBeCloseTo(x + 100);
  });

  it('a path too short for the run puts the count on its own row under the line', () => {
    const world = mkWorld();
    // borders at x=160..250: 90 px of path, less than the 'builds href · 1 ref' run
    const near = [mkNode(1, { x: 0, y: 100 }), mkNode(2, { x: 250, y: 100 })];
    renderBoard(world, near, [mkEdge(10, 1, 2, 'builds href')], on(1));
    const mid = (160 + 250) / 2;
    const label = world.querySelector('.edge-label')!;
    expect(Number(label.getAttribute('x'))).toBeCloseTo(mid);
    expect(Number(world.querySelector('.edge-label-bg')!.getAttribute('width'))).toBeCloseTo('builds href'.length * 7.3 + 8);
    const g = suffix(world)!;
    const text = g.querySelector('.edge-refs-text')!;
    expect(text.textContent).toBe('1 ref');
    // the label box is centred on the line (131–149); the count row sits right under it
    expect(Number(label.getAttribute('y'))).toBeCloseTo(131 + 13);
    expect(Number(text.getAttribute('y'))).toBeCloseTo(149 + 13);
    const bg = g.querySelector('.edge-label-bg')!;
    expect(Number(bg.getAttribute('x')) + Number(bg.getAttribute('width')) / 2).toBeCloseTo(mid);
    expect(Number(bg.getAttribute('y'))).toBeCloseTo(149);
    // identical input: nothing written
    expect(mutations(world, () => renderBoard(world, near, [mkEdge(10, 1, 2, 'builds href')], on(1)))).toHaveLength(0);
    // pulled apart, the count rejoins the label as a suffix
    renderBoard(world, nodes(), [mkEdge(10, 1, 2, 'builds href')], on(1));
    expect(suffix(world)).toBe(g);
    expect(text.textContent).toBe('· 1 ref');
    expect(g.querySelector('.edge-label-bg')).toBeNull();
  });

  it('below 60% zoom the suffix goes with the node badges, keyed out of the DOM (P1)', () => {
    const world = mkWorld();
    const dense = (s: number) => mkState({ codeOverlay: true, scale: s, refsByEdge: new Map([[10n, refs(1)]]) });
    renderBoard(world, nodes(), [mkEdge(10, 1, 2, 'builds href')], dense(0.55));
    expect(suffix(world)).toBeNull();
    // the label centres alone, as it does with the overlay off
    const bg = world.querySelector('.edge-label-bg')!;
    expect(Number(bg.getAttribute('width'))).toBeCloseTo('builds href'.length * 7.3 + 8);
    expect(mutations(world, () => renderBoard(world, nodes(), [mkEdge(10, 1, 2, 'builds href')], dense(0.55)))).toHaveLength(0);
    // back at 60% the suffix returns
    renderBoard(world, nodes(), [mkEdge(10, 1, 2, 'builds href')], dense(0.6));
    expect(suffix(world)!.querySelector('.edge-refs-text')!.textContent).toBe('· 1 ref');
  });

  it('the suffix takes hover and stays muted mono (CSS)', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const at = css.indexOf('\n.edge-refs-text {');
    const rule = at < 0 ? '' : css.slice(at, css.indexOf('}', at));
    expect(rule).toMatch(/font-family:\s*var\(--mono\)/);
    expect(rule).toMatch(/fill:\s*var\(--muted\)/);
    expect(rule).toMatch(/pointer-events:\s*visiblePainted/);
  });
});

describe('node outline names its shape', () => {
  it('writes data-shape, so a theme can style plain rects without guessing from rx', () => {
    const world = mkWorld();
    // a 20 px pill and a 20 px ellipse also get rx = 10, like a plain rect
    const nodes = [mkNode(1), mkNode(2, { shape: 'pill', h: 20 }), mkNode(3, { shape: 'ellipse', w: 20 })];
    renderBoard(world, nodes, [], mkState());
    const outlines = [...world.querySelectorAll('.node-rect')];
    expect(outlines.map(r => r.getAttribute('rx'))).toEqual(['10', '10', '10']);
    expect(outlines.map(r => r.getAttribute('data-shape'))).toEqual(['rect', 'pill', 'ellipse']);
    renderBoard(world, [mkNode(1, { shape: 'pill' }), nodes[1], nodes[2]], [], mkState());
    expect(world.querySelector('.node-rect')!.getAttribute('data-shape')).toBe('pill');
  });
});

describe('chart cards (kind chart)', () => {
  const at = (micros: number) => ({ microsSinceUnixEpoch: BigInt(micros) }) as unknown as Chart['updatedAt'];
  function mkChart(nodeId: number, over: Partial<Chart> = {}): Chart {
    return {
      nodeId: BigInt(nodeId),
      boardId: 1n,
      type: 'timeseries',
      csv: CHART_CONTRACTS.timeseries.example,
      options: '{}',
      source: 'agent: npm run bench @ abc1234',
      updatedAt: at(1000),
      ...over,
    };
  }
  const chartNode = (id: number, over: Partial<Node> = {}) =>
    mkNode(id, { kind: 'chart', label: 'p99 latency', sublabel: 'checkout · ms', w: 352, h: 224, ...over });
  const charts = (...rows: Chart[]) => new Map(rows.map(c => [c.nodeId, c]));
  const LONG = `agent: ${'npm run bench --filter checkout-latency-suite '.repeat(4)}@ abc1234`;
  /** The footnote as drawn: its text nodes, without the <title>. */
  const drawn = (t: Element) => [...t.childNodes].filter(c => c.nodeType === 3).map(c => c.textContent).join('');

  it('draws the card: rect, title, subtitle, type tag, plot and source footnote', () => {
    const world = mkWorld();
    renderBoard(world, [chartNode(1)], [], mkState({ charts: charts(mkChart(1)) }));
    const g = world.querySelector('[data-id="1"]')!;
    expect(g.getAttribute('class')).toBe('node node-chart');
    expect([...g.children].map(c => c.getAttribute('class'))).toEqual([
      'node-rect', 'chart-title', 'node-sublabel chart-subtitle', 'chart-tag-box', 'chart-tag', 'chart-plot', 'chart-source',
    ]);
    const rect = g.querySelector('.node-rect')!;
    expect([rect.getAttribute('width'), rect.getAttribute('height'), rect.getAttribute('data-shape')]).toEqual(['352', '224', 'rect']);
    const title = g.querySelector<SVGTextElement>('.chart-title')!;
    expect([title.textContent, title.dataset.field, title.getAttribute('x'), title.getAttribute('y')]).toEqual(['p99 latency', 'label', '16', '27']);
    const sub = g.querySelector<SVGTextElement>('.chart-subtitle')!;
    expect([sub.textContent, sub.dataset.field, sub.getAttribute('x')]).toEqual(['checkout · ms', 'sublabel', '16']);
    const tag = g.querySelector('.chart-tag')!;
    expect([tag.textContent, tag.getAttribute('x'), tag.getAttribute('text-anchor')]).toEqual(['timeseries', '330', 'end']);
    const plot = g.querySelector('.chart-plot')!;
    expect(plot.getAttribute('transform')).toBe('translate(16 56)');
    expect(plot.childElementCount).toBeGreaterThan(0);
    expect(plot.querySelector('.chart-empty')).toBeNull();
    const source = g.querySelector('.chart-source')!;
    expect([source.textContent, source.getAttribute('y')]).toEqual(['source: agent: npm run bench @ abc1234', '212']);
    expect(source.querySelector('title')).toBeNull();
  });

  it('the library waterfall sample shows every span, at the smallest grid height that does', () => {
    const { w, h, csv } = samplePlacement('waterfall');
    const row = mkChart(1, { type: 'waterfall', csv });
    const draw = (height: number) => {
      const world = mkWorld();
      renderBoard(world, [chartNode(1, { w, h: height })], [], mkState({ charts: charts(row) }));
      return world.querySelector('.chart-plot')!;
    };
    const full = draw(h);
    expect(full.querySelector('.chart-more')).toBeNull();
    expect(full.querySelectorAll('.chart-bar')).toHaveLength(7);
    expect(full.querySelector('.chart-legend')).not.toBeNull();
    expect(h % 4).toBe(0);
    expect(draw(h - 4).querySelector('.chart-more')).not.toBeNull();
  });

  it('the library kanban sample shows every card with its detail line, at the smallest grid height that does', () => {
    const { w, h, csv } = samplePlacement('kanban');
    const row = mkChart(1, { type: 'kanban', csv });
    const draw = (height: number) => {
      const world = mkWorld();
      renderBoard(world, [chartNode(1, { w, h: height })], [], mkState({ charts: charts(row) }));
      return world.querySelector('.chart-plot')!;
    };
    const full = draw(h);
    expect(full.querySelectorAll('.chart-card')).toHaveLength(7);
    expect(full.querySelectorAll('text.chart-label.chart-muted')).toHaveLength(7);
    expect(full.querySelectorAll('.chart-lane')).toHaveLength(2);
    expect(full.querySelector('.chart-more')).toBeNull();
    expect(h % 4).toBe(0);
    expect(draw(h - 4).querySelectorAll('text.chart-label.chart-muted')).toHaveLength(0);
  });

  it('an identical render writes nothing; a move or a selection never touches the plot', () => {
    const world = mkWorld();
    const nodes = [chartNode(1)];
    const rows = charts(mkChart(1));
    renderBoard(world, nodes, [], mkState({ charts: rows }));
    expect(mutations(world, () => renderBoard(world, nodes, [], mkState({ charts: rows })))).toHaveLength(0);
    const plot = world.querySelector('.chart-plot')!;
    const first = plot.firstElementChild;
    const recs = mutations(plot, () => {
      renderBoard(world, nodes, [], mkState({ charts: rows, overrides: new Map([[1n, { x: 420, y: 240 }]]) }));
      renderBoard(world, nodes, [], mkState({ charts: rows, selection: new Set([1n]), handles: new Set([1n]) }));
    });
    expect(recs).toHaveLength(0);
    expect(plot.firstElementChild).toBe(first);
    expect(world.querySelector('.selection-outline')).not.toBeNull();
  });

  it('rebuilds the plot when updatedAt, the size or the density changes, inside the same group', () => {
    const world = mkWorld();
    const nodes = [chartNode(1)];
    renderBoard(world, nodes, [], mkState({ charts: charts(mkChart(1)) }));
    const plot = world.querySelector('.chart-plot')!;
    let first = plot.firstElementChild;
    renderBoard(world, nodes, [], mkState({ charts: charts(mkChart(1, { updatedAt: at(2000) })) }));
    expect(plot.firstElementChild).not.toBe(first);
    first = plot.firstElementChild;
    renderBoard(world, nodes, [], mkState({ charts: charts(mkChart(1, { updatedAt: at(2000) })), overrides: new Map([[1n, { x: 300, y: 100, w: 400, h: 240 }]]) }));
    expect(plot.firstElementChild).not.toBe(first);
    first = plot.firstElementChild;
    renderBoard(world, nodes, [], mkState({ charts: charts(mkChart(1, { updatedAt: at(2000) })), scale: 0.5 }));
    expect(plot.firstElementChild).not.toBe(first);
    expect(world.querySelector('.chart-plot')).toBe(plot);
  });

  it('a chart without a row, or with data that does not parse, draws a quiet no data state', () => {
    const world = mkWorld();
    renderBoard(world, [chartNode(1)], [], mkState());
    const empty = world.querySelector('.chart-plot > .chart-empty')!;
    expect(empty.textContent).toBe('no data');
    expect(empty.querySelector('title')).toBeNull();
    expect(world.querySelector('.chart-tag')!.textContent).toBe('chart');
    expect(world.querySelector('.chart-source')!.textContent).toBe('');

    const bad = mkChart(1, { csv: 'time,checkout\n', updatedAt: at(2000) });
    const parsed = parseChart(bad.type, bad.csv, bad.options);
    expect(parsed.ok).toBe(false);
    renderBoard(world, [chartNode(1)], [], mkState({ charts: charts(bad) }));
    const failed = world.querySelector('.chart-plot > .chart-empty')!;
    expect(drawn(failed)).toBe('no data');
    expect(failed.querySelector('title')!.textContent).toBe(parsed.ok ? '' : parsed.error);

    renderBoard(world, [chartNode(1)], [], mkState({ charts: charts(mkChart(1, { updatedAt: at(3000) })) }));
    expect(world.querySelector('.chart-empty')).toBeNull();
  });

  it("M16: sample data replaces the footnote with a dashed 'sample data' pill", () => {
    const world = mkWorld();
    renderBoard(world, [chartNode(1)], [], mkState({ charts: charts(mkChart(1, { source: 'sample' })) }));
    const source = world.querySelector('.chart-source')!;
    expect(source.getAttribute('class')).toBe('chart-source chart-sample');
    expect(source.textContent).toBe('sample data');
    const pill = world.querySelector('rect.chart-sample-box')!;
    expect(pill.nextElementSibling).toBe(source);
    const w = textWidth('sample data', 10.5, true);
    expect([pill.getAttribute('x'), Number(pill.getAttribute('width')), pill.getAttribute('rx')]).toEqual(['16', w + 12, '5']);
    expect(source.getAttribute('x')).toBe('22');
    // the text sits inside the pill
    const top = Number(pill.getAttribute('y'));
    const base = Number(source.getAttribute('y'));
    expect(base).toBeGreaterThan(top + 10);
    expect(base).toBeLessThan(top + Number(pill.getAttribute('height')));
    renderBoard(world, [chartNode(1)], [], mkState({ charts: charts(mkChart(1, { source: 'human:Ada' })) }));
    expect(source.getAttribute('class')).toBe('chart-source');
    expect(source.textContent).toBe('source: human:Ada');
    expect(source.getAttribute('x')).toBe('16');
    expect(world.querySelector('rect.chart-sample-box')).toBeNull();
  });

  it('M1: the type tag is a hairline pill sized from the measured tag text', () => {
    const world = mkWorld();
    renderBoard(world, [chartNode(1)], [], mkState({ charts: charts(mkChart(1)) }));
    const pill = world.querySelector('rect.chart-tag-box')!;
    const tag = world.querySelector('text.chart-tag')!;
    const w = textWidth('timeseries', 10.5, true) + 12;
    expect(Number(pill.getAttribute('width'))).toBe(w);
    expect(Number(pill.getAttribute('x'))).toBeCloseTo(352 - 16 - w, 5);
    expect(pill.getAttribute('rx')).toBe('5');
    expect(Number(tag.getAttribute('x'))).toBe(352 - 16 - 6);
    const top = Number(pill.getAttribute('y'));
    expect(27).toBeGreaterThan(top + 9);
    expect(27).toBeLessThan(top + Number(pill.getAttribute('height')));
    // a narrower type re-sizes the pill
    renderBoard(world, [chartNode(1)], [], mkState({ charts: charts(mkChart(1, { type: 'pie', csv: CHART_CONTRACTS.pie.example, updatedAt: at(2000) })) }));
    expect(Number(pill.getAttribute('width'))).toBe(textWidth('pie', 10.5, true) + 12);
  });

  it('M14: a dense card gives the plot the full card height (no subtitle row, no footnote)', () => {
    const world = mkWorld();
    const nodes = [chartNode(1, { w: 704, h: 320 })];
    renderBoard(world, nodes, [], mkState({ charts: charts(mkChart(1)) }));
    const plot = world.querySelector('.chart-plot')!;
    expect(plot.getAttribute('transform')).toBe('translate(16 56)');
    const hitH = () => Math.max(...[...plot.querySelectorAll('rect.chart-hit')].map(r => Number(r.getAttribute('y')) + Number(r.getAttribute('height'))));
    renderBoard(world, nodes, [], mkState({ charts: charts(mkChart(1)), scale: 0.5 }));
    expect(plot.getAttribute('transform')).toBe('translate(16 40)');
    // the marks reach to 4 px above the plot's bottom, 16 px above the card's
    expect(hitH()).toBeCloseTo(320 - 40 - 16 - 4, 5);
    renderBoard(world, nodes, [], mkState({ charts: charts(mkChart(1)) }));
    expect(plot.getAttribute('transform')).toBe('translate(16 56)');
  });

  it('a long source is cut to the card, and a <title> holds all of it', () => {
    const world = mkWorld();
    renderBoard(world, [chartNode(1)], [], mkState({ charts: charts(mkChart(1, { source: LONG })) }));
    const source = world.querySelector('.chart-source')!;
    expect(source.querySelector('title')!.textContent).toBe(`source: ${LONG}`);
    expect(drawn(source).endsWith('…')).toBe(true);
    expect(textWidth(drawn(source), 11, true)).toBeLessThanOrEqual(352 - 32);
  });

  it('the footnote stops short of the code-ref badge, which shows its count alone', () => {
    const world = mkWorld();
    const badge: RefBadge = { key: 'k1', count: 3, first: 'Limiter.allow', title: 'src/limiter.ts' };
    renderBoard(world, [chartNode(1)], [], mkState({
      charts: charts(mkChart(1, { source: LONG })),
      codeOverlay: true,
      refsByNode: new Map([[1n, badge]]),
    }));
    expect(world.querySelector('.node-refs-text')!.textContent).toBe('3 refs');
    const source = world.querySelector('.chart-source')!;
    // the badge text ends at w - 10 and is '3 refs' wide; BADGE_GAP (8) between
    const right = 352 - 10 - '3 refs'.length * BADGE_CHAR_PX - 8;
    expect(textWidth(drawn(source), 11, true)).toBeLessThanOrEqual(right - 16);
  });

  it('title and subtitle ellipsize inside the card, the title clear of the type tag', () => {
    const world = mkWorld();
    const label = 'p99 latency for the checkout service across every region and every client';
    const sublabel = 'milliseconds, measured at the edge proxy for every request in the window';
    renderBoard(world, [chartNode(1, { label, sublabel, w: 224, h: 144 })], [], mkState({ charts: charts(mkChart(1)) }));
    const title = world.querySelector('.chart-title')!.textContent!;
    const sub = world.querySelector('.chart-subtitle')!.textContent!;
    expect(title.endsWith('…')).toBe(true);
    expect(sub.endsWith('…')).toBe(true);
    expect(textWidth(title, 13)).toBeLessThanOrEqual(224 - 32 - textWidth('timeseries', 10.5, true) - 12);
    expect(textWidth(sub, 11.5)).toBeLessThanOrEqual(224 - 32);
  });

  it('gives the inline editor the drawn title row', () => {
    const world = mkWorld();
    renderBoard(world, [chartNode(1)], [], mkState({ charts: charts(mkChart(1)) }));
    const t = renderedText(world, 1n)!;
    expect([t.lines, t.labelY, t.fontSize, t.subY, t.room, t.badgeCountOnly]).toEqual([['p99 latency'], 27, 13, 43, 320, true]);
  });

  it('style.css: series tokens per theme, mark paint through currentColor, and dense hides tag and footnote', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const block = (theme: string) => {
      const start = css.indexOf(`[data-swatch='${theme}'] {\n  --c-ink:`);
      return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
    };
    const light = ['#2a78d6', '#1baf7a', '#4a3aa7', '#e87ba4', '#eda100'];
    const want: Record<string, string[]> = { dark: ['#3987e5', '#199e70', '#9085e9', '#d55181', '#c98500'], light, brutal: light };
    for (const [theme, hexes] of Object.entries(want)) {
      for (const [i, hex] of hexes.entries()) {
        expect(block(theme), `${theme} --series-${i + 1}`).toContain(`--series-${i + 1}: ${hex};`);
      }
    }
    expect(block('dark')).toContain('--c-amber: #D29922;');
    expect(block('light')).toContain('--c-amber: #9A6700;');
    expect(block('brutal')).toContain('--c-amber: #B45309;');
    for (let i = 1; i <= 5; i++) {
      expect(css).toContain(`.series-${i} { color: var(--series-${i}); }`);
    }
    expect(css).not.toMatch(/--series-\d:\s*var\(--accent\)/);
    const rule = (sel: string) => {
      const start = css.indexOf(`\n${sel} {`);
      return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
    };
    expect(rule('#world.dense :is(.chart-tag, .chart-tag-box, .chart-source, .chart-sample-box)')).toMatch(/display:\s*none/);
    expect(rule('.chart-hit')).toMatch(/fill:\s*transparent/);
    expect(rule('.chart-xhair')).toMatch(/pointer-events:\s*none/);

    // Declarations of the first rule whose selector list names `sel` exactly.
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const decls = (sel: string) => {
      for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (m[1].split(',').map(x => x.trim()).includes(sel)) {
          return m[2];
        }
      }
      return '';
    };
    // Marks carry classes only (40-render-a "Class contract"); CSS paints them.
    expect(decls('.chart-line')).toMatch(/stroke:\s*currentColor/);
    expect(decls('.chart-line')).not.toMatch(/fill:/);
    for (const sel of ['.chart-area', '.chart-bar', '.chart-slice', '.chart-cell', '.chart-swatch', '.chart-point', '.chart-dot']) {
      expect(decls(sel), sel).toMatch(/fill:\s*currentColor/);
    }
    for (let i = 1; i <= 5; i++) {
      expect(decls(`.series-${i}`).trim(), `.series-${i} sets color only`).toBe(`color: var(--series-${i});`);
    }
    expect(decls('.chart-other')).toMatch(/color:\s*var\(--c-gray\)/);
    expect(decls('.chart-ring')).toMatch(/stroke:\s*var\(--panel\)/);
    expect(decls('.chart-spark')).toMatch(/stroke:\s*var\(--faint\)/);
    expect(decls('.chart-track')).toMatch(/fill:\s*var\(--border\)/);
    for (const sel of ['.chart-value', '.chart-center', '.chart-stat-value']) {
      expect(decls(sel), sel).toMatch(/font-weight:\s*600/);
    }
    expect(decls('.chart-mono')).toMatch(/font-family:\s*var\(--mono\)/);
    expect(decls('.chart-bar.chart-error')).toMatch(/stroke:\s*var\(--c-red\)/);
    expect(decls('.chart-glyph.chart-error')).toMatch(/fill:\s*var\(--c-red\)/);
    expect(decls('.chart-warn')).toMatch(/fill:\s*var\(--c-amber\)/);
    expect(decls('.chart-warn')).not.toMatch(/--series-/);
    // Treemap text: each theme names its label colour per fill (R3 emits on-series-N / on-other).
    expect(decls('.chart-on-fill')).toMatch(/fill:\s*#FFFFFF/);
    for (let n = 1; n <= 5; n++) {
      expect(decls(`.chart-on-fill.on-series-${n}`)).toMatch(new RegExp(`fill:\\s*var\\(--on-series-${n}\\)`));
    }
    expect(decls('.chart-on-fill.on-other')).toMatch(/fill:\s*var\(--on-other\)/);
    expect(css).not.toMatch(/data-theme='[\w-]+'\] \.chart-on-fill/);
    // white, with ink on the light amber; light and brutal also ink aqua and magenta, but
    // violet #4a3aa7 keeps white (ink would be about 2.2:1)
    const on = (theme: string) => [1, 2, 3, 4, 5].map(n => block(theme).match(new RegExp(`--on-series-${n}: (#\\w+);`))?.[1]);
    expect(on('dark')).toEqual(['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF', '#131313']);
    for (const theme of ['light', 'brutal']) {
      expect(on(theme), theme).toEqual(['#FFFFFF', '#131313', '#FFFFFF', '#131313', '#131313']);
    }
    // M1 / M16: the tag is a solid hairline pill, the sample tag a dashed one; brutal draws both 2 px black and square
    expect(decls('.chart-tag-box')).toMatch(/stroke:\s*var\(--border\)/);
    expect(decls('.chart-tag-box')).toMatch(/fill:\s*none/);
    expect(decls('.chart-sample-box')).toMatch(/stroke-dasharray/);
    expect(decls('.chart-source.chart-sample')).toMatch(/fill:\s*var\(--faint\)/);
    for (const sel of ['.chart-tag-box', '.chart-sample-box']) {
      const b = decls(`:root[data-theme='brutal'] ${sel}`);
      expect(b, sel).toMatch(/stroke-width:\s*2/);
      expect(b, sel).toMatch(/rx:\s*0/);
    }
  });
});

describe('neighbour focus (Task 4)', () => {
  const nodes = [mkNode(1), mkNode(2), mkNode(3), mkNode(4, { y: 600 })];
  const edges = [mkEdge(10, 1, 2, 'a-b'), mkEdge(11, 2, 3, 'b-c')];
  const edgeG = (world: SVGGElement, id: number) =>
    world.querySelector(`.edge-hit[data-edge-id="${id}"]`)!.parentElement!;
  const near = (e: Element) => e.classList.contains('focus-near');

  it('marks the focused node, its neighbours and their edges, and dims the rest', () => {
    const world = mkWorld();
    renderBoard(world, nodes, edges, mkState({ focus: { id: 2n, flow: false } }));
    const node = (id: number) => world.querySelector(`[data-id="${id}"]`)!;
    expect([1, 2, 3, 4].map(id => near(node(id)))).toEqual([true, true, true, false]);
    expect(world.classList.contains('focus-dim')).toBe(true);
    expect(near(edgeG(world, 10))).toBe(true);
    expect(near(edgeG(world, 11))).toBe(true);
    for (const labels of world.querySelectorAll('.layer-edge-labels .edge-labels')) expect(near(labels)).toBe(true);

    // identical focused render: zero mutations
    expect(mutations(world, () => renderBoard(world, nodes, edges, mkState({ focus: { id: 2n, flow: false } })))).toHaveLength(0);

    renderBoard(world, nodes, edges, mkState());
    expect(world.outerHTML).not.toMatch(/focus-/);
  });

  it('focus on an unrelated node leaves the other edges dimmed', () => {
    const world = mkWorld();
    renderBoard(world, nodes, edges, mkState({ focus: { id: 1n, flow: false } }));
    expect(near(edgeG(world, 10))).toBe(true);
    expect(near(edgeG(world, 11))).toBe(false);
    expect(near(world.querySelector('[data-id="3"]')!)).toBe(false);
  });

  it('flow: true adds focus-flow; flow: false does not', () => {
    const world = mkWorld();
    renderBoard(world, nodes, edges, mkState({ focus: { id: 2n, flow: true } }));
    expect(world.classList.contains('focus-flow')).toBe(true);
    renderBoard(world, nodes, edges, mkState({ focus: { id: 2n, flow: false } }));
    expect(world.classList.contains('focus-flow')).toBe(false);
    expect(world.classList.contains('focus-dim')).toBe(true);
  });


  it('focusOf: hover wins; flow whenever the focus is the sole selection', () => {
    expect(focusOf(null, new Set())).toBeNull();
    expect(focusOf(null, new Set([1n, 2n]))).toBeNull();
    expect(focusOf(null, new Set([2n]))).toEqual({ id: 2n, flow: true });
    // click leaves the pointer on the node: hovered + sole selection still flows
    expect(focusOf(2n, new Set([2n]))).toEqual({ id: 2n, flow: true });
    expect(focusOf(3n, new Set([2n]))).toEqual({ id: 3n, flow: false });
    expect(focusOf(2n, new Set([2n, 3n]))).toEqual({ id: 2n, flow: false });
  });

  it('style.css: dimming spares ghosts (they keep .node.ghost opacity) and boundaries', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    expect(css).toContain('#world.focus-dim .node:not(.focus-near):not(.node-boundary):not(.ghost),');
  });

  it('focus on a container (boundary with members and an edge) sets no focus classes', () => {
    const world = mkWorld();
    const boxed = [mkNode(9, { kind: 'boundary', x: 200, y: 0, w: 1000, h: 400 }), ...nodes];
    renderBoard(world, boxed, [...edges, mkEdge(12, 9, 4, 'box-d')], mkState({ focus: { id: 9n, flow: true } }));
    expect(world.outerHTML).not.toMatch(/focus-/);
    expect(world.classList.contains('focus-dim')).toBe(false);
  });

  it('a focus id that is not a rendered node sets no focus classes', () => {
    const world = mkWorld();
    renderBoard(world, nodes, edges, mkState({ focus: { id: 99n, flow: true } }));
    expect(world.outerHTML).not.toMatch(/focus-/);
  });
});

describe('kind grammar (Task 9)', () => {
  it('a datastore draws a cylinder rim only when its label sits clear of the top', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { kind: 'datastore', label: 'Postgres', sublabel: '' })], [], mkState());
    const rim = world.querySelector('[data-id="1"] path.node-rim');
    expect(rim).not.toBeNull();
    expect(rim!.getAttribute('d')).toBe('M0,6 Q80,18 160,6');
    // A short node with a label and a sublabel: the label reaches the top.
    renderBoard(world, [mkNode(1, { kind: 'datastore', label: 'Postgres', sublabel: 'primary', h: 48 })], [], mkState());
    expect(world.querySelector('[data-id="1"] path.node-rim')).toBeNull();
    expect(world.querySelector('[data-id="1"] .node-rule')).not.toBeNull();
  });

  it('an external node draws a corner arrow only when it is wide enough', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { kind: 'external', label: 'Stripe', w: 200 })], [], mkState());
    const glyph = world.querySelector('[data-id="1"] path.node-glyph');
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute('d')).toBe('M0,8 L8,0 M2,0 H8 V6');
    expect(glyph!.getAttribute('aria-hidden')).toBe('true');
    expect(glyph!.getAttribute('transform')).toBe('translate(184 8)');
    renderBoard(world, [mkNode(1, { kind: 'external', label: 'Stripe', w: 96 })], [], mkState());
    expect(world.querySelector('[data-id="1"] path.node-glyph')).toBeNull();
  });

  it('an external label too wide for the glyph drops it', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { kind: 'external', label: 'Stripe payments gateway', w: 200 })], [], mkState());
    // One line wide enough to reach under the glyph.
    const line = renderedText(world, 1n)!.lines[0];
    expect((200 - textWidth(line, 15)) / 2).toBeLessThan(28);
    expect(world.querySelector('[data-id="1"] path.node-glyph')).toBeNull();
  });

  it('a pill datastore draws no rim and an ellipse external no arrow', () => {
    const world = mkWorld();
    renderBoard(world, [
      mkNode(1, { kind: 'datastore', label: 'Postgres', sublabel: '', shape: 'pill' }),
      mkNode(2, { kind: 'external', label: 'Stripe', w: 200, shape: 'ellipse' }),
    ], [], mkState());
    expect(world.querySelector('[data-id="1"] path.node-rim')).toBeNull();
    expect(world.querySelector('[data-id="2"] path.node-glyph')).toBeNull();
  });

  it('re-rendering datastore, external and boundary nodes is a no-op', () => {
    const world = mkWorld();
    const nodes = [
      mkNode(1, { kind: 'datastore', label: 'Postgres' }),
      mkNode(2, { kind: 'external', label: 'Stripe', w: 200 }),
      mkNode(3, { kind: 'boundary', label: 'backend', w: 400, h: 240 }),
    ];
    renderBoard(world, nodes, [], mkState());
    expect(mutations(world, () => renderBoard(world, nodes, [], mkState()))).toHaveLength(0);
  });

  it('style.css tints a focal node with --accent-soft', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const at = css.indexOf('\n.node.focal .node-rect {');
    expect(at).toBeGreaterThan(0);
    expect(css.slice(at, css.indexOf('}', at))).toContain('var(--accent-soft)');
  });
});

describe('edgeText', () => {
  const edge = (label: string, latencyMs: number, latencySource: string) => ({ label, latencyMs, latencySource });
  it('appends latency by source: plain for prod, "local" for local, ~ for an estimate', () => {
    expect(edgeText(edge('sql', 38.4, 'prod'))).toBe('sql · 38ms');
    expect(edgeText(edge('grpc', 12.5, 'local'))).toBe('grpc · 13ms local');
    expect(edgeText(edge('', 4.25, 'estimate'))).toBe('~4.3ms');
  });
  it('is the label alone when latency is unknown', () => {
    expect(edgeText(edge('https', -1, ''))).toBe('https');
  });
});

describe('renderBoard edge latency', () => {
  const nodes = () => [mkNode(1), { ...mkNode(2), x: 600 }];
  const lat = (latencyMs: number, latencySource = 'prod', extra: Partial<Edge> = {}) => ({ ...mkEdge(10, 1, 2, 'sql'), latencyMs, latencySource, ...extra });
  const hit = (world: SVGGElement) => {
    const r = world.querySelector('.edge-labels rect[cursor="pointer"]')!;
    return [r.getAttribute('x'), r.getAttribute('width')];
  };

  it('is quiet by default: the label alone, numbers on selection, and no other label moves', () => {
    const world = mkWorld();
    renderBoard(world, nodes(), [lat(38, 'estimate')], mkState());
    expect(world.querySelector('.edge-label')!.textContent).toBe('sql');
    const before = hit(world);
    renderBoard(world, nodes(), [lat(38, 'estimate')], mkState({ selectedEdges: new Set([10n]) }));
    expect(world.querySelector('.edge-label')!.textContent).toBe('sql · ~38ms');
    expect(hit(world)).toEqual(before);
  });

  it('shows the numbers next to the focused node', () => {
    const world = mkWorld();
    renderBoard(world, nodes(), [lat(38)], mkState({ focus: { id: 1n, flow: false } }));
    expect(world.querySelector('.edge-label')!.textContent).toBe('sql · 38ms');
  });

  it('warms from 100 ms and runs hot from 400 ms, unless the edge is styled by hand or the overlay is on', () => {
    const world = mkWorld();
    const g = () => world.querySelector('.layer-edges .edge')!;
    renderBoard(world, nodes(), [lat(40)], mkState());
    expect([g().classList.contains('lat-warm'), g().classList.contains('lat-hot')]).toEqual([false, false]);
    renderBoard(world, nodes(), [lat(120)], mkState());
    expect(g().classList.contains('lat-warm')).toBe(true);
    renderBoard(world, nodes(), [lat(450)], mkState());
    expect([g().classList.contains('lat-warm'), g().classList.contains('lat-hot')]).toEqual([false, true]);
    renderBoard(world, nodes(), [lat(450, 'prod', { color: 'blue' })], mkState());
    expect(g().classList.contains('lat-hot')).toBe(false);
    renderBoard(world, nodes(), [lat(450)], mkState({ overlay: true }));
    expect(g().classList.contains('lat-hot')).toBe(false);
  });

  it('flows live edges by traffic, reverses against the arrow, reds on errors, and prefers live numbers', () => {
    const world = mkWorld();
    const g = () => world.querySelector<SVGGElement>('.layer-edges .edge')!;
    const live = new Map([[10n, { count: 41, errors: 2, p50: 12.4, p95: 40, rps: 41, reverse: true }]]);
    renderBoard(world, nodes(), [lat(450)], mkState({ live, selectedEdges: new Set([10n]) }));
    expect(['live', 'live-rev', 'lat-err', 'lat-hot'].map(c => g().classList.contains(c))).toEqual([true, true, true, false]);
    expect(g().style.getPropertyValue('--flow-dur')).toBe(`${flowSeconds(41).toFixed(2)}s`);
    expect(world.querySelector('.edge-label')!.textContent).toBe('sql · 12ms · 41/s · 2 err');
    renderBoard(world, nodes(), [lat(450)], mkState());
    expect(['live', 'lat-err'].map(c => g().classList.contains(c))).toEqual([false, false]);
    expect(g().style.getPropertyValue('--flow-dur')).toBe('');
  });

  it('flows faster the busier the edge, within bounds', () => {
    expect(flowSeconds(0)).toBe(2.4);
    expect(flowSeconds(9)).toBeCloseTo(1.8);
    expect(flowSeconds(1e6)).toBe(0.4);
  });
});

describe('change notes on the board (spec 2026-10-16, D5)', () => {
  const SCHEMA = JSON.stringify({
    table: 'customers',
    columns: [
      { name: 'id', type: 'uuid', change: null },
      { name: 'name', type: 'text', change: 'dropped' },
      { name: 'first_name', type: 'text', change: 'added' },
      { name: 'last_name', type: 'text', change: 'added' },
    ],
  });
  const noteRow = (o: Partial<NoteRow> = {}): NoteRow => ({
    id: 1n, boardId: 1n, anchorId: 4n, refId: 20n, kind: 'migration', severity: 'destructive', title: 'Migration 0042', summary: 's',
    steps: '[]', schema: SCHEMA, subjects: '[{"table":"customers","column":"name"}]',
    readers: JSON.stringify([{ refId: '21', subject: 0, status: 'updated', checkpoint: 1 }, { refId: '22', subject: 0, status: 'stale', checkpoint: 1 }]),
    reviewedBy: '', reviewedAt: { microsSinceUnixEpoch: 0n }, ...o,
  });
  const ref = (id: bigint, targetId: bigint, snippet: string): CodeRef =>
    ({ id, boardId: 1n, targetKind: 'node', targetId, path: `f${id}.ts`, symbol: 's', startLine: 1, endLine: 3, blobSha: 'x', snippet, author: '', checkpoint: 1, status: 'ok' }) as CodeRef;
  const refs = new Map<bigint, CodeRef>([
    [20n, ref(20n, 4n, 'DROP COLUMN name')], [21n, ref(21n, 2n, 'row.first_name')], [22n, ref(22n, 3n, 'row.name')],
  ]);
  const nodes = [mkNode(2), mkNode(3), mkNode(4, { kind: 'datastore', label: 'Postgres', w: 280, h: 184 })];
  const edges = [mkEdge(10, 2, 4), mkEdge(11, 3, 4)];
  const notes = (rows = [noteRow()], es = edges) => buildNoteIndex(rows, refs, es);

  it('renders the note tag and schema card on the anchor', () => {
    const world = mkWorld();
    renderBoard(world, nodes, edges, mkState({ notes: notes() }));
    const tags = world.querySelectorAll('.node-note-tag');
    expect(tags).toHaveLength(1);
    expect(tags[0].classList.contains('sev-destructive')).toBe(true);
    expect(tags[0].textContent).toBe('MIGRATION 0042');
    // inside the card on the title row, not astride the outline under the selection toolbar
    expect(Number(tags[0].querySelector('rect')!.getAttribute('y'))).toBeGreaterThanOrEqual(0);
    // the change reads from the sign and the band; no "+ added" words crowd the type column
    expect(world.querySelector('.schema-row.change-dropped .schema-sign')?.textContent).toBe('−');
    expect(world.querySelector('.schema-change')).toBeNull();
    expect(world.querySelector('.schema-row.change-dropped')?.textContent).toContain('name');
    expect(world.querySelectorAll('.schema-row.change-added')).toHaveLength(2);
    const anchor = world.querySelector('.schema-row')!.closest('.node')!;
    expect(anchor.classList.contains('note-destructive')).toBe(true);
    expect(anchor.querySelector('.node-label')?.textContent).toBe('Postgres');
    expect(anchor.querySelector('.node-label')?.classList.contains('token-ink')).toBe(true); // the title reads at full ink
  });

  it('on a card too narrow for title and tag, the tag moves onto the outline and the title stays whole', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(4, { kind: 'datastore', label: 'Postgres', w: 160, h: 184 })], [], mkState({ notes: notes([noteRow({ readers: '[]' })], []) }));
    expect(world.querySelector('.schema-title')?.textContent).toBe('Postgres');
    expect(Number(world.querySelector('.node-note-tag rect')!.getAttribute('y'))).toBeLessThan(0);
  });

  it('two notes on one anchor share one tag with the count', () => {
    const world = mkWorld();
    renderBoard(world, nodes, edges, mkState({ notes: notes([noteRow(), noteRow({ id: 2n, severity: 'notable', title: 'Migration 0043' })]) }));
    expect([...world.querySelectorAll('.node-note-tag')].map(t => t.textContent)).toEqual(['2 MIGRATIONS']);
  });

  it('stale reader edge is red dashed with its label; an updated one says so', () => {
    const world = mkWorld();
    renderBoard(world, nodes, edges, mkState({ notes: notes() }));
    const stale = world.querySelector('.edge-line.reader-stale')!;
    expect(stale).not.toBeNull();
    expect(stale.getAttribute('marker-end')).toBe('url(#mk-c-red)');
    expect([...world.querySelectorAll('.edge-reader')].map(g => g.textContent).sort()).toEqual(['reads customers.name', '✓ updated']);
    expect(world.querySelector('.edge-line.reader-updated')).not.toBeNull();
  });

  it('pip on a reader node without an edge', () => {
    const world = mkWorld();
    renderBoard(world, nodes, [edges[0]], mkState({ notes: notes([noteRow()], [edges[0]]) }));
    const pips = world.querySelectorAll('.node-reader-pip');
    expect(pips).toHaveLength(1);
    expect(pips[0].closest('.node')!.querySelector('.node-label')?.textContent).toBe('node-3');
  });

  it('keyed no-op, and the card goes away with the note', () => {
    const world = mkWorld();
    const state = mkState({ notes: notes() });
    renderBoard(world, nodes, edges, state);
    expect(mutations(world, () => renderBoard(world, nodes, edges, mkState({ notes: notes() })))).toHaveLength(0);
    renderBoard(world, nodes, edges, mkState());
    expect(world.querySelector('.schema-row')).toBeNull();
    expect(world.querySelector('.node-note-tag')).toBeNull();
    expect(world.querySelector('.edge-reader')).toBeNull();
    expect(world.querySelector('.edge-line.reader-stale')).toBeNull();
  });

  it('a merged card taller than the node keeps changed rows and counts the cut ones', () => {
    const a = JSON.stringify({ table: 'customers', columns: [{ name: 'id', type: 'uuid', change: null }, { name: 'a1', type: 'text', change: 'added' }, { name: 'a2', type: 'text', change: 'added' }] });
    const b = JSON.stringify({ table: 'customers', columns: [{ name: 'legacy', type: 'text', change: 'dropped' }] });
    const world = mkWorld();
    // room for 2 rows: 60 + 2 * 24 + 28 = 136
    renderBoard(world, [mkNode(4, { kind: 'datastore', h: 136 })], [], mkState({ notes: notes([noteRow({ schema: a, readers: '[]' }), noteRow({ id: 2n, schema: b, readers: '[]' })], []) }));
    // dropped first, then renamed, then added: the cut never hides the drop
    expect([...world.querySelectorAll('.schema-row .schema-col')].map(t => t.textContent)).toEqual(['a1', 'legacy']);
    expect(world.querySelector('.schema-more')?.textContent).toBe('+2 more');
  });

  it('a reader row sits below a ref count that dropped to its own row', () => {
    const world = mkWorld();
    // a long label on a short path: the ref count drops under the label (edgeRun)
    const shortNodes = [mkNode(2, { x: 0 }), mkNode(4, { kind: 'datastore', x: 220, h: 160 })];
    const edge = { ...mkEdge(10, 2, 4), label: 'reads the customers table' };
    const refsByEdge = new Map([[10n, { key: 'k', count: 3, title: 't' }]]);
    renderBoard(world, shortNodes, [edge], mkState({ codeOverlay: true, refsByEdge, notes: notes([noteRow({ readers: JSON.stringify([{ refId: '21', subject: 0, status: 'stale', checkpoint: 1 }]) })], [mkEdge(10, 2, 4)]) }));
    const countBg = world.querySelector('.edge-refs .edge-label-bg')!;
    const readerBg = world.querySelector('.edge-reader-bg')!;
    expect(countBg).not.toBeNull();
    expect(Number(readerBg.getAttribute('y'))).toBeGreaterThanOrEqual(Number(countBg.getAttribute('y')) + 18);
  });

  it('the ref badge has the footer row to itself: it never overlaps the last column row', () => {
    const world = mkWorld();
    const h = schemaCardHeight(JSON.parse(SCHEMA)); // exactly the height the module stores for this card
    renderBoard(world, [mkNode(4, { kind: 'datastore', h })], [], mkState({
      codeOverlay: true,
      refsByNode: new Map([[4n, { key: 'b', count: 1, first: 'customers', title: 't' } as RefBadge]]),
      notes: notes([noteRow({ readers: '[]' })], []),
    }));
    const rows = [...world.querySelectorAll('.schema-row .schema-col')];
    const lastBaseline = Math.max(...rows.map(t => Number(t.getAttribute('y'))));
    const badgeBaseline = Number(world.querySelector('.node-refs-text')!.getAttribute('y'));
    expect(badgeBaseline - lastBaseline).toBeGreaterThanOrEqual(20);
  });

  it('wide schema shows +N more', () => {
    const wide = JSON.stringify({ table: 't', columns: Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, type: 'text', change: i === 50 ? 'dropped' : null })) });
    const world = mkWorld();
    renderBoard(world, [mkNode(4, { kind: 'datastore', h: 216 })], [], mkState({ notes: notes([noteRow({ schema: wide, readers: '[]' })], []) }));
    expect(world.querySelectorAll('.schema-row')).toHaveLength(5);
    expect(world.querySelector('.schema-more')?.textContent).toBe('+95 more');
  });
});

describe('threat markers', () => {
  const spec = { glyph: 'hazard' as const, tone: 'red' as const, pulse: true, count: 1, label: 'Threat on node-1: x, high, compromised' };
  it('draws one keyed marker, makes no mutations when unchanged, removes it with the spec', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2)];
    const state = mkState({ threatMarkers: new Map([[1n, spec]]) });
    renderBoard(world, nodes, [], state);
    expect(world.querySelectorAll('.board-marker')).toHaveLength(1);
    expect(world.querySelector('[data-id="1"] .board-marker')).not.toBeNull();
    expect(mutations(world, () => renderBoard(world, nodes, [], mkState({ threatMarkers: new Map([[1n, { ...spec }]]) })))).toHaveLength(0);
    renderBoard(world, nodes, [], mkState());
    expect(world.querySelectorAll('.board-marker')).toHaveLength(0);
  });
  it('sits at the top right corner, 26 px left when a route marker shares it', () => {
    const world = mkWorld();
    const nodes = [mkNode(1)];
    renderBoard(world, nodes, [], mkState({ threatMarkers: new Map([[1n, spec]]) }));
    expect(world.querySelector('.board-marker')!.getAttribute('transform')).toBe('translate(160 0)');
    renderBoard(world, nodes, [], mkState({ threatMarkers: new Map([[1n, spec]]), routeByNode: new Map([[1n, { number: 1, status: 'current' as const }]]) }));
    expect(world.querySelector('.board-marker')!.getAttribute('transform')).toBe('translate(134 0)');
  });
  it('no resize handle covers the marker centre on a selected anchor (a click must open the card, not resize)', () => {
    const world = mkWorld();
    const nodes = [mkNode(1)];
    const covered = () => {
      const [cx, cy] = world.querySelector('.board-marker')!.getAttribute('transform')!.match(/-?[\d.]+/g)!.map(Number);
      return [...world.querySelectorAll('.resize-handle')].filter(h => {
        const [x, y, w, hh] = ['x', 'y', 'width', 'height'].map(a => Number(h.getAttribute(a)));
        return cx >= x && cx <= x + w && cy >= y && cy <= y + hh;
      }).map(h => (h as SVGElement).dataset.corner);
    };
    for (const scale of [1, 0.25]) {
      renderBoard(world, nodes, [], mkState({ selection: new Set([1n]), scale, threatMarkers: new Map([[1n, spec]]) }));
      expect(world.querySelectorAll('.resize-handle')).toHaveLength(3);
      expect(covered()).toEqual([]);
      renderBoard(world, nodes, [], mkState({ selection: new Set([1n]), scale, threatMarkers: new Map([[1n, spec]]), routeByNode: new Map([[1n, { number: 1, status: 'current' as const }]]) }));
      expect(covered()).toEqual([]);
    }
    renderBoard(world, nodes, [], mkState({ selection: new Set([1n]) }));
    expect(world.querySelectorAll('.resize-handle')).toHaveLength(4); // no marker, all four corners again
  });
});

describe('blast display', () => {
  const nodes = [mkNode(1), mkNode(2), mkNode(3), mkNode(4)];
  const edges = [mkEdge(10, 1, 2), mkEdge(11, 2, 3), mkEdge(12, 3, 4)];
  const blast = blastRadius(1n, nodes.map(n => n.id), edges, id => `node-${id}`, { direction: 'reaches', depth: 2 });
  const cls = (world: Element, sel: string) => world.querySelector(sel)!.getAttribute('class')!;

  it('marks the source, hop 1 and 2 nodes with badges, and dims the rest', () => {
    const world = mkWorld();
    renderBoard(world, nodes, edges, mkState({ blast }));
    expect(world.classList.contains('blast-on')).toBe(true);
    expect(cls(world, '[data-id="1"]')).toContain('blast-src');
    expect(cls(world, '[data-id="2"]')).toContain('blast-hop1');
    expect(cls(world, '[data-id="3"]')).toContain('blast-hopn');
    expect(cls(world, '[data-id="4"]')).toContain('blast-clear');
    expect(world.querySelector('[data-id="2"] .hop-badge')!.textContent).toBe('1');
    expect(world.querySelector('[data-id="3"] .hop-badge')!.textContent).toBe('2');
    expect(world.querySelectorAll('.hop-badge')).toHaveLength(2);
  });

  it('colours edges hot, warm or clear', () => {
    const world = mkWorld();
    renderBoard(world, nodes, edges, mkState({ blast }));
    const edgeCls = (id: number) => world.querySelector(`.edge-hit[data-edge-id="${id}"]`)!.parentElement!.getAttribute('class')!;
    expect(edgeCls(10)).toContain('blast-hot');
    expect(edgeCls(11)).toContain('blast-warm');
    expect(edgeCls(12)).toContain('blast-clear');
  });

  it('past 40 edges the rest stay still; the keyed no-op holds', () => {
    const many = Array.from({ length: 51 }, (_, i) => mkNode(i + 1));
    const fan = Array.from({ length: 50 }, (_, i) => mkEdge(100 + i, 1, i + 2));
    const big = blastRadius(1n, many.map(n => n.id), fan, id => `node-${id}`, { direction: 'reaches', depth: 1 });
    const world = mkWorld();
    renderBoard(world, many, fan, mkState({ blast: big }));
    expect(world.querySelectorAll('.edge.blast-hot')).toHaveLength(50);
    expect(world.querySelectorAll('.edge.blast-still')).toHaveLength(10);
    expect(mutations(world, () => renderBoard(world, many, fan, mkState({ blast: big })))).toHaveLength(0);
  });

  it('the blast owns dimming: no focus-dim while it is on', () => {
    const world = mkWorld();
    renderBoard(world, nodes, edges, mkState({ blast, focus: { id: 2n, flow: true } }));
    expect(world.classList.contains('focus-dim')).toBe(false);
    expect(world.classList.contains('focus-flow')).toBe(false);
  });

  it('a null blast removes every blast class and badge; an unchanged one mutates nothing', () => {
    const world = mkWorld();
    renderBoard(world, nodes, edges, mkState({ blast }));
    expect(mutations(world, () => renderBoard(world, nodes, edges, mkState({ blast })))).toHaveLength(0);
    renderBoard(world, nodes, edges, mkState({ blast: null }));
    expect(world.querySelectorAll('[class*="blast-"]')).toHaveLength(0);
    expect(world.querySelectorAll('.hop-badge')).toHaveLength(0);
  });
});

describe('ghost edges', () => {
  const edges = [
    mkEdge(10, 1, 2),
    mkEdge(11, 2, 3),
    { ...mkEdge(12, 1, 2), hidden: true },
    { ...mkEdge(13, 2, 3), hidden: true },
    mkEdge(14, 1, 4),
  ];
  const renderable = new Set([1n, 2n, 3n]);

  it('keeps revealed hidden edges and shown edges with a ghost endpoint', () => {
    const shownNodes = vi.fn(() => [mkNode(1), mkNode(2)]);
    const ghosts = ghostEdges(edges, renderable, shownNodes, e => e.id === 12n);
    expect(ghosts.map(e => e.id)).toEqual([11n, 12n]);
  });

  it('lists the shown nodes once per call, not once per edge', () => {
    const shownNodes = vi.fn(() => [mkNode(1), mkNode(2)]);
    ghostEdges(edges, renderable, shownNodes, () => false);
    expect(shownNodes).toHaveBeenCalledTimes(1);
  });
});

describe('hand-set edge style (RC-688)', () => {
  const nodes = [mkNode(1), mkNode(2)];
  const line = (world: SVGGElement) => world.querySelector('.edge-line')!;
  const classes = (world: SVGGElement) => [...line(world).classList].filter(c => /^(color|stroke|weight)-/.test(c));

  it('draws colour, line and weight as classes on the line; the defaults add none', () => {
    const world = mkWorld();
    renderBoard(world, nodes, [mkEdge(10, 1, 2)], mkState());
    expect(classes(world)).toEqual([]);
    const styled = { ...mkEdge(10, 1, 2), color: 'blue', strokeStyle: 'dotted' };
    renderBoard(world, nodes, [styled], mkState({ edgeWeights: new Map([[10n, 'bold']]) }));
    expect(classes(world)).toEqual(['color-blue', 'stroke-dotted', 'weight-bold']);
    renderBoard(world, nodes, [{ ...styled, strokeStyle: 'dashed' }], mkState({ edgeWeights: new Map([[10n, 'medium']]) }));
    expect(classes(world)).toEqual(['color-blue', 'stroke-dashed', 'weight-medium']);
    // regular has no row; a value the client does not know draws as regular
    renderBoard(world, nodes, [styled], mkState({ edgeWeights: new Map([[10n, 'heavy']]) }));
    expect(classes(world)).toEqual(['color-blue', 'stroke-dotted']);
  });

  it('keeps the classes under the evidence overlay, so turning it off brings the style back unchanged', () => {
    const world = mkWorld();
    const edge = { ...mkEdge(10, 1, 2), evidence: 'import', color: 'red', strokeStyle: 'dashed' };
    const weights = new Map([[10n, 'bold']]);
    renderBoard(world, nodes, [edge], mkState({ edgeWeights: weights }));
    const before = line(world).getAttribute('class');
    renderBoard(world, nodes, [edge], mkState({ edgeWeights: weights, overlay: true }));
    expect(classes(world)).toEqual(['color-red', 'stroke-dashed', 'weight-bold']);
    expect(line(world).classList.contains('ev-import')).toBe(true);
    // the head keeps the person's colour under the overlay too
    expect(line(world).getAttribute('marker-end')).toBe('url(#mk-c-red)');
    renderBoard(world, nodes, [edge], mkState({ edgeWeights: weights }));
    expect(line(world).getAttribute('class')).toBe(before);
  });

  it('a selected edge keeps a colour of its own, head included; an uncoloured one takes the selection look', () => {
    const world = mkWorld();
    const selected = mkState({ selectedEdges: new Set([10n]) });
    renderBoard(world, nodes, [mkEdge(10, 1, 2)], selected);
    expect(line(world).getAttribute('marker-end')).toBe('url(#mk-sel)');
    renderBoard(world, nodes, [{ ...mkEdge(10, 1, 2), color: 'green' }], selected);
    expect(line(world).classList.contains('selected')).toBe(true);
    expect(line(world).getAttribute('marker-end')).toBe('url(#mk-c-green)');
  });

  it('a weight change patches the line in place, and an identical frame writes nothing', () => {
    const world = mkWorld();
    const edge = mkEdge(10, 1, 2);
    renderBoard(world, nodes, [edge], mkState({ edgeWeights: new Map([[10n, 'medium']]) }));
    const el = line(world);
    const state = mkState({ edgeWeights: new Map([[10n, 'bold']]) });
    renderBoard(world, nodes, [edge], state);
    expect(line(world)).toBe(el);
    expect(el.classList.contains('weight-bold')).toBe(true);
    expect(mutations(world, () => renderBoard(world, nodes, [edge], state))).toHaveLength(0);
  });

  it('style.css: the overlay owns line and weight, the person keeps colour, and the head follows the weight', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
    const naming = (cls: string) => rules.filter(r => r.sel.split(',').some(s => new RegExp(`\\.${cls}\\b`).test(s) && /edge-line/.test(s)));
    // line and weight: off while the overlay is on, never a #world.overlay rule
    for (const cls of ['stroke-dashed', 'stroke-dotted', 'weight-medium', 'weight-bold']) {
      const found = naming(cls);
      expect(found.length, cls).toBeGreaterThan(0);
      for (const r of found) {
        for (const s of r.sel.split(',')) expect(s.trim(), cls).toMatch(/^#world:where\((\.dense)?:not\(\.overlay\)\) /);
      }
    }
    // weights halve below 60% zoom with every other edge
    expect(rules.find(r => r.sel === '#world:where(.dense:not(.overlay)) .edge-line.weight-bold')?.body).toMatch(/stroke-width:\s*1\.5/);
    expect(rules.find(r => r.sel === '#world:where(:not(.overlay)) .edge-line.weight-bold')?.body).toMatch(/stroke-width:\s*3/);
    // a dot is a round cap
    expect(rules.find(r => r.sel === '#world:where(:not(.overlay)) .edge-line.stroke-dotted')?.body).toMatch(/stroke-linecap:\s*round/);
    // colour holds in both modes
    for (const c of ['ink', 'blue', 'red', 'green', 'purple', 'gray']) {
      const sels = naming(`color-${c}`).flatMap(r => r.sel.split(',').map(s => s.trim())).filter(s => s.endsWith(`.edge-line.color-${c}`));
      expect(sels, c).toEqual([`#world .edge-line.color-${c}`, `#world.overlay .edge-line.color-${c}`]);
    }
    // selection recolours only an edge without a colour of its own, and haloes the rest
    const colours = ':not(.color-ink, .color-blue, .color-red, .color-green, .color-purple, .color-gray)';
    expect(rules.find(r => r.sel.startsWith(`#world .edge-line.selected:where(${colours})`))?.body).toMatch(/stroke:\s*var\(--sel\)/);
    expect(rules.find(r => r.sel === '#world .edge-line.selected:where(.color-ink, .color-blue, .color-red, .color-green, .color-purple, .color-gray)')?.body)
      .toMatch(/filter:\s*drop-shadow\([^)]*var\(--sel\)\)/);
    expect(rules.some(r => r.sel.split(',').some(s => s.trim() === '#world .edge-line.selected'))).toBe(false);
    // below 60% zoom a weighted head thins with its line, half a pixel over it
    expect(rules.find(r => r.sel === '#world.dense .edge-arrowhead.head-medium')?.body).toMatch(/stroke-width:\s*1\.5/);
    expect(rules.find(r => r.sel === '#world.dense .edge-arrowhead.head-bold')?.body).toMatch(/stroke-width:\s*2/);
  });

  it('a medium or bold edge takes a head of its weight at the usual size; under the overlay the evidence head returns', () => {
    const world = mkWorld();
    const head = () => line(world).getAttribute('marker-end');
    const width = (id: string) => world.querySelector(`marker[id="${id}"] path`)?.getAttribute('stroke-width');
    const blue = { ...mkEdge(10, 1, 2), color: 'blue', evidence: 'import' };
    renderBoard(world, nodes, [blue], mkState({ edgeWeights: new Map([[10n, 'bold']]) }));
    expect(head()).toBe('url(#mk-c-blue-bold)');
    renderBoard(world, nodes, [mkEdge(10, 1, 2)], mkState({ edgeWeights: new Map([[10n, 'medium']]) }));
    expect(head()).toBe('url(#mk-edge-medium)');
    renderBoard(world, nodes, [mkEdge(10, 1, 2)], mkState({ edgeWeights: new Map([[10n, 'medium']]), selectedEdges: new Set([10n]) }));
    expect(head()).toBe('url(#mk-sel-medium)');
    renderBoard(world, nodes, [blue], mkState({ edgeWeights: new Map([[10n, 'bold']]), overlay: true }));
    expect(head()).toBe('url(#mk-c-blue)');
    // half a pixel over the line, as the regular head (1.5) is over a 1 px line
    expect([width('mk-c-blue'), width('mk-c-blue-medium'), width('mk-c-blue-bold')]).toEqual(['1.5', '2.5', '3.5']);
    for (const id of ['mk-edge', 'mk-sel', 'mk-c-ink', 'mk-c-blue', 'mk-c-red', 'mk-c-green', 'mk-c-purple', 'mk-c-gray']) {
      for (const weight of ['medium', 'bold']) {
        const m = world.querySelector(`marker[id="${id}-${weight}"]`)!;
        expect(m, `${id}-${weight}`).not.toBeNull();
        expect([m.getAttribute('markerUnits'), m.getAttribute('markerWidth'), m.getAttribute('overflow')]).toEqual(['userSpaceOnUse', '12', 'visible']);
        expect(m.querySelector('path')!.classList.contains(id)).toBe(true);
        expect(m.querySelector('path')!.classList.contains(`head-${weight}`)).toBe(true);
      }
    }
  });
});

describe('library icons on nodes (spec 2026-10-18)', () => {
  beforeAll(() => loadLogos());
  const icons = (entries: Array<[number, string]>) => new Map(entries.map(([id, icon]) => [BigInt(id), icon]));
  const slot = (world: SVGGElement, id: number) => world.querySelector<SVGGElement>(`[data-id="${id}"] .node-icon-slot`);
  const translate = (el: Element) => el.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!.slice(1).map(Number);

  it('draws the icon centred above the label, named for assistive tech, with the text in the band below', () => {
    const world = mkWorld();
    const n = mkNode(1, { label: 'Planner', sublabel: 'agent', w: 160, h: 96 });
    renderBoard(world, [n], [], mkState({ icons: icons([[1, 'orchestrator']]) }));
    const g = slot(world, 1)!;
    expect(g.getAttribute('role')).toBe('img');
    expect(g.querySelector(':scope > title')!.textContent).toBe('Orchestrator');
    expect(translate(g)).toEqual([(160 - 28) / 2, 12]);
    expect(g.querySelector('.node-icon-stroke')).not.toBeNull();
    // label and sublabel lay out in the band from 12 + 28 + 6 = 46 down
    const plain = layoutNodeText(n, 160, 96, null);
    const t = renderedText(world, 1n)!;
    expect(t.labelY - 0.72 * t.fontSize).toBeGreaterThanOrEqual(46);
    expect(t.labelY).toBeGreaterThan(plain.labelY);
    expect(t.sub).toBe('agent');
    // the icon is drawn after the outline, before the text
    const kids = [...world.querySelector(`[data-id="1"]`)!.children];
    expect(kids.indexOf(g)).toBeGreaterThan(kids.findIndex(k => k.classList.contains('node-rect')));
    expect(kids.indexOf(g)).toBeLessThan(kids.findIndex(k => k.classList.contains('node-label')));
  });

  it('a node without an icon, or with an id this client cannot draw, renders exactly as before', () => {
    const plain = mkWorld();
    const withUnknown = mkWorld();
    const n = mkNode(1, { h: 96 });
    renderBoard(plain, [n], [], mkState());
    renderBoard(withUnknown, [n], [], mkState({ icons: icons([[1, 'clippy']]) }));
    expect(slot(withUnknown, 1)).toBeNull();
    expect(withUnknown.innerHTML).toBe(plain.innerHTML);
  });

  it('icon sizes follow the node size: 24, 28, 36', () => {
    const world = mkWorld();
    const nodes = [mkNode(1, { size: 's', h: 96 }), mkNode(2, { size: 'm', h: 96 }), mkNode(3, { size: 'l', h: 112 })];
    renderBoard(world, nodes, [], mkState({ icons: icons([[1, 'queue'], [2, 'queue'], [3, 'queue']]) }));
    const scale = (id: number) => Number(slot(world, id)!.querySelector('.node-icon-stroke > g')!.getAttribute('transform')!.match(/scale\(([\d.]+)\)/)![1]);
    expect([scale(1), scale(2), scale(3)].map(s => s * 16)).toEqual([24, 28, 36]);
  });

  it('centres the icon alone when the node has no text, and drops it when the node is too short for icon and label', () => {
    const world = mkWorld();
    const alone = mkNode(1, { label: '', sublabel: '', w: 64, h: 64 });
    const short = mkNode(2, { label: 'Queue', sublabel: '', w: 160, h: 48 });
    renderBoard(world, [alone, short], [], mkState({ icons: icons([[1, 'tool'], [2, 'queue']]) }));
    expect(translate(slot(world, 1)!)).toEqual([18, 18]);
    expect(slot(world, 2)).toBeNull();
    // the short node lays its label out as a plain one
    expect(renderedText(world, 2n)!.labelY).toBe(layoutNodeText(short, 160, 48, null).labelY);
  });

  it('a resize that makes room adds the icon; one that takes it away removes it', () => {
    const world = mkWorld();
    const n = mkNode(1, { label: 'Queue', sublabel: '', h: 48 });
    const state = mkState({ icons: icons([[1, 'queue']]) });
    renderBoard(world, [n], [], state);
    expect(slot(world, 1)).toBeNull();
    renderBoard(world, [{ ...n, h: 96 }], [], state);
    expect(slot(world, 1)).not.toBeNull();
    renderBoard(world, [{ ...n, h: 48 }], [], state);
    expect(slot(world, 1)).toBeNull();
  });

  it('keeps the icon element across renders, and swaps it when the icon changes', () => {
    const world = mkWorld();
    const n = mkNode(1, { h: 96 });
    renderBoard(world, [n], [], mkState({ icons: icons([[1, 'model']]) }));
    const first = slot(world, 1);
    renderBoard(world, [{ ...n, x: n.x + 40 }], [], mkState({ icons: icons([[1, 'model']]) }));
    expect(slot(world, 1)).toBe(first);
    renderBoard(world, [n], [], mkState({ icons: icons([[1, 'grok']]) }));
    expect(slot(world, 1)).not.toBe(first);
    expect(slot(world, 1)!.querySelector('title')!.textContent).toBe('Grok');
    expect(slot(world, 1)!.querySelector('.node-icon-brand')).not.toBeNull();
    renderBoard(world, [n], [], mkState());
    expect(slot(world, 1)).toBeNull();
  });

  it('a datastore with an icon draws its rule but no rim across the icon; an external keeps its arrow', () => {
    const world = mkWorld();
    const db = mkNode(1, { kind: 'datastore', label: 'Memory', sublabel: '', h: 96 });
    const ext = mkNode(2, { kind: 'external', label: 'Model', sublabel: '', h: 96 });
    renderBoard(world, [db, ext], [], mkState({ icons: icons([[1, 'memory'], [2, 'model']]) }));
    expect(world.querySelector('[data-id="1"] .node-rule')).not.toBeNull();
    expect(world.querySelector('[data-id="1"] .node-rim')).toBeNull();
    expect(world.querySelector('[data-id="2"] .node-glyph')).not.toBeNull();
  });

  it('a boundary shows its icon left of the heading, which moves right to clear it', () => {
    const world = mkWorld();
    const b = mkNode(1, { kind: 'boundary', label: 'AWS', w: 320, h: 240 });
    renderBoard(world, [b], [], mkState({ icons: icons([[1, 'aws']]) }));
    expect(translate(slot(world, 1)!)).toEqual([14, 9]);
    expect(world.querySelector('[data-id="1"] .node-boundary-label')!.getAttribute('x')).toBe('40');
    renderBoard(world, [b], [], mkState());
    expect(world.querySelector('[data-id="1"] .node-boundary-label')!.getAttribute('x')).toBe('16');
  });

  it('keeps the label clear of the icon when a code-ref badge takes the bottom row: the icon goes instead', () => {
    const n = mkNode(1, { label: 'Queue', sublabel: '', w: 160, h: 72 });
    const badge: RefBadge = { key: 'k1', count: 1, first: 'Queue.push', title: 'src/queue.ts' };
    const withoutBadge = mkWorld();
    renderBoard(withoutBadge, [n], [], mkState({ icons: icons([[1, 'queue']]) }));
    expect(slot(withoutBadge, 1)).not.toBeNull();
    const withBadge = mkWorld();
    renderBoard(withBadge, [n], [], mkState({ icons: icons([[1, 'queue']]), codeOverlay: true, refsByNode: new Map([[1n, badge]]) }));
    expect(slot(withBadge, 1)).toBeNull();
    // the label is laid out exactly as on a node without an icon
    const plain = mkWorld();
    renderBoard(plain, [n], [], mkState({ codeOverlay: true, refsByNode: new Map([[1n, badge]]) }));
    expect(renderedText(withBadge, 1n)!.labelY).toBe(renderedText(plain, 1n)!.labelY);
    // a box tall enough for icon, label and badge keeps all three, the label below the icon
    const tall = mkWorld();
    renderBoard(tall, [{ ...n, h: 96 }], [], mkState({ icons: icons([[1, 'queue']]), codeOverlay: true, refsByNode: new Map([[1n, badge]]) }));
    expect(slot(tall, 1)).not.toBeNull();
    const t = renderedText(tall, 1n)!;
    expect(t.labelY - 0.72 * t.fontSize).toBeGreaterThanOrEqual(12 + 28 + 6);
  });

  it('notes and charts never draw an icon', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { kind: 'note', h: 96 })], [], mkState({ icons: icons([[1, 'agent']]) }));
    expect(slot(world, 1)).toBeNull();
  });

  it('takes the node colour and focal classes the stylesheet paints authored icons with', () => {
    const world = mkWorld();
    renderBoard(world, [mkNode(1, { color: 'blue', h: 96 }), mkNode(2, { focal: true, h: 96 })], [], mkState({ icons: icons([[1, 'agent'], [2, 'agent']]) }));
    expect(world.querySelector('[data-id="1"]')!.classList.contains('color-blue')).toBe(true);
    expect(world.querySelector('[data-id="2"]')!.classList.contains('focal')).toBe(true);
    expect(world.querySelectorAll('.node-icon-stroke')).toHaveLength(2);
  });
});

describe('incident triage: the time window and chart pins', () => {
  const CSV = 'time,p95\n2026-10-31T14:00:00Z,1\n2026-10-31T14:10:00Z,2\n2026-10-31T14:20:00Z,3';
  const T = (hhmm: string) => Date.parse(`2026-10-31T${hhmm}:00Z`);
  const chart = (over: Partial<Chart> = {}): Chart => ({
    nodeId: 9n, boardId: 1n, type: 'timeseries', csv: CSV, options: '{}', source: 'live tap',
    updatedAt: { microsSinceUnixEpoch: 1000n } as unknown as Chart['updatedAt'], ...over,
  });
  const chartNode = mkNode(9, { kind: 'chart', label: 'latency', x: 300, y: 400, w: 352, h: 224 });

  it('draws only the points inside the board window, and says so when none are', () => {
    const world = mkWorld();
    const charts = new Map([[9n, chart()]]);
    renderBoard(world, [chartNode], [], mkState({ charts }));
    expect(world.querySelectorAll('rect.chart-hit[data-t]')).toHaveLength(3);
    renderBoard(world, [chartNode], [], mkState({ charts, window: { startMs: T('14:05'), endMs: T('14:25') } }));
    expect([...world.querySelectorAll<SVGRectElement>('rect.chart-hit')].map(r => Number(r.dataset.t))).toEqual([T('14:10'), T('14:20')]);
    renderBoard(world, [chartNode], [], mkState({ charts, window: { startMs: T('15:00'), endMs: T('16:00') } }));
    expect(world.querySelector('.chart-plot > .chart-empty')!.textContent).toBe('outside the time window');
  });

  it('leads a pinned chart to the middle of its edge or the centre of its node, and drops a pin whose target is gone', () => {
    const world = mkWorld();
    const nodes = [mkNode(1), mkNode(2), chartNode];
    const edges = [mkEdge(5, 1, 2)];
    const pins = (targetKind: string, targetId: bigint) => new Map([[9n, { targetKind, targetId }]]);
    renderBoard(world, nodes, edges, mkState({ anchors: pins('edge', 5n) }));
    const lead = world.querySelector('.layer-anchors line.chart-pin')!;
    const seg = routeEdges([{ id: 5n, from: 1n, to: 2n }], new Map(nodes.map(n => [n.id, nodeRect(n, new Map())])), new Map(nodes.map(n => [n.id, 'rect']))).get(5n)!.seg;
    expect([lead.getAttribute('x2'), lead.getAttribute('y2')]).toEqual([String(Math.round((seg.a.x + seg.b.x) / 2)), String(Math.round((seg.a.y + seg.b.y) / 2))]);
    expect(Number(lead.getAttribute('y1'))).toBe(400); // the chart's top edge, below the hop
    renderBoard(world, nodes, edges, mkState({ anchors: pins('node', 1n) }));
    expect(world.querySelector('.layer-anchors line')!.getAttribute('x2')).toBe('380');
    renderBoard(world, nodes, [], mkState({ anchors: pins('edge', 5n) }));
    expect(world.querySelector('.layer-anchors')!.childElementCount).toBe(0);
  });
});
