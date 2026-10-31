import { Timestamp } from 'spacetimedb';
import type { EmbedGraph, EmbedScene } from '../../module/src/embed-contracts';
import type { Node, Edge, Chart } from './module_bindings/types';
import { renderBoard, contentBounds, el } from './render';
import { routeLegs, legSampler, legMs, easeInOut, type Leg } from './route-play';
import { blastRadius } from './blast';
import { diffScene } from './architecture';
import { EmbedClock } from './embed-clock';
import { ChartMotion } from './chart-motion';
import type { MarkerSpec } from './board-marker';

function graph(rows: EmbedGraph) {
  const nodes: Node[] = rows.nodes.map(n => ({ ...n, id: BigInt(n.id), sourceKey: n.key,
    boardId: 0n, doc: '', hidden: false, imported: false }));
  const edges: Edge[] = rows.edges.map(e => ({ ...e, id: BigInt(e.id), fromNode: BigInt(e.fromNode), toNode: BigInt(e.toNode),
    boardId: 0n, evidence: '', evidenceSnippet: '', evidenceStatus: '', latencySource: '', hidden: false, imported: false }));
  const charts = new Map<bigint, Chart>(rows.charts.map(c => [BigInt(c.nodeId), { ...c, nodeId: BigInt(c.nodeId), boardId: 0n, updatedAt: new Timestamp(BigInt(c.updatedAt)) }]));
  const icons = new Map(rows.nodes.filter(n => n.icon).map(n => [BigInt(n.id), n.icon!]));
  const edgeWeights = new Map(rows.edges.filter(e => e.weight).map(e => [BigInt(e.id), e.weight!]));
  return { nodes, edges, charts, icons, edgeWeights };
}
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
type Hop = { leg: Leg; start: number; end: number; sample: ReturnType<typeof legSampler>; dot: SVGCircleElement };

export class EmbedBoard {
  private world: SVGGElement;
  private scene: EmbedScene | null = null;
  private current = graph({ nodes: [], edges: [], charts: [] });
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private hops: Hop[] = [];
  private duration = 3000;
  private reduced = false;
  private blocked = false;
  private chartsPaused = false;
  private chartMotions: ChartMotion[] = [];
  private architecture: ReturnType<typeof diffScene> | null = null;
  private before = new Map<string, Node>();
  private mode = get<HTMLSelectElement>('embed-mode');
  private clock: EmbedClock;
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  constructor(private svg: SVGSVGElement, private host: HTMLElement) {
    this.world = svg.querySelector('#world')!;
    this.clock = new EmbedClock(this.duration, ms => this.paint(ms), () => this.controls());
    this.mode.addEventListener('change', () => this.build());
    get('embed-play').addEventListener('click', () => { this.chartsPaused = false; this.clock.play(); for (const m of this.chartMotions) m.setPaused(this.blocked); });
    get('embed-pause').addEventListener('click', () => { if (this.scene) { this.chartsPaused = true; this.clock.pause(); for (const m of this.chartMotions) m.setPaused(true); } });
    get('embed-replay').addEventListener('click', () => { if (this.scene) { this.chartsPaused = false; this.clock.replay(); for (const m of this.chartMotions) { m.setPaused(this.blocked); m.replay(); } } });
    get<HTMLInputElement>('embed-loop').addEventListener('change', e => { this.clock.loop = (e.target as HTMLInputElement).checked; });
    get('embed-fit').addEventListener('click', () => { this.zoom = 1; this.pan = { x: 0, y: 0 }; this.fit(); });
    for (const [id, factor] of [['embed-zoom-in', 1.4], ['embed-zoom-out', 1 / 1.4]] as const) {
      get(id).addEventListener('click', () => { this.zoom = Math.max(.5, Math.min(6, this.zoom * factor)); this.fit(); });
    }
    let drag: { id: number; x: number; y: number } | null = null;
    svg.addEventListener('pointerdown', e => {
      if (!this.scene || e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', e => {
      if (!drag || drag.id !== e.pointerId) return;
      const scale = svg.viewBox.baseVal.width / Math.max(1, svg.clientWidth);
      this.pan.x -= (e.clientX - drag.x) * scale; this.pan.y -= (e.clientY - drag.y) * scale;
      drag.x = e.clientX; drag.y = e.clientY; this.fit();
    });
    const stopDrag = () => { drag = null; };
    svg.addEventListener('pointerup', stopDrag); svg.addEventListener('pointercancel', stopDrag);
    svg.addEventListener('keydown', e => {
      const step = svg.viewBox.baseVal.width / 10;
      if (e.key === 'ArrowLeft') this.pan.x -= step;
      else if (e.key === 'ArrowRight') this.pan.x += step;
      else if (e.key === 'ArrowUp') this.pan.y -= step;
      else if (e.key === 'ArrowDown') this.pan.y += step;
      else return;
      e.preventDefault(); this.fit();
    });
  }
  update(scene: EmbedScene): void {
    this.scene = scene;
    this.current = graph(scene);
    const value = this.mode.value;
    this.mode.replaceChildren();
    const option = (value: string, title: string) => {
      const o = document.createElement('option'); o.value = value; o.textContent = title; this.mode.append(o);
    };
    option('flows', 'Connection flows');
    if (scene.route.length > 1) option('route', 'Highlighted route');
    if (scene.before) option('architecture', 'Architecture changes');
    for (const t of scene.threats) option(`threat:${t.id}`, `Threat: ${t.title}`);
    if ([...this.mode.options].some(o => o.value === value)) this.mode.value = value;
    this.build();
  }
  private build(): void {
    if (!this.scene) return;
    for (const m of this.chartMotions) m.settle(); this.chartMotions = [];
    // Restore DOM attributes owned by the playback before the renderer patches.
    for (const n of this.nodes) {
      const mark = this.world.querySelector<SVGGElement>(`.node[data-id="${n.id}"]`);
      if (mark) { mark.style.opacity = ''; mark.setAttribute('transform', `translate(${n.x} ${n.y})`); }
    }
    this.world.querySelectorAll<SVGElement>('.edge').forEach(e => { e.style.opacity = ''; });
    this.current = graph(this.scene);
    this.nodes = this.current.nodes; this.edges = this.current.edges;
    this.architecture = null; this.before.clear();
    const markers = new Map<bigint, MarkerSpec>();
    for (const t of this.scene.threats) markers.set(BigInt(t.anchorId), {
      glyph: 'hazard', tone: t.stage === 'compromised' || t.severity === 'critical' || t.severity === 'high' ? 'red' : 'amber',
      pulse: false, count: 1, label: `${t.title}, ${t.severity}, ${t.stage}`,
    });
    if (this.mode.value === 'architecture' && this.scene.before) {
      const before = graph(this.scene.before);
      this.before = new Map(before.nodes.map(n => [n.sourceKey, n]));
      this.architecture = diffScene(before.nodes, before.edges, this.nodes, this.edges);
      this.nodes = [...this.nodes, ...this.architecture.removedNodes];
      this.edges = [...this.edges, ...this.architecture.removedEdges];
      for (const n of this.architecture.removedNodes) {
        const icon = before.icons.get(-n.id); if (icon) this.current.icons.set(n.id, icon);
      }
      for (const e of this.architecture.removedEdges) {
        const weight = before.edgeWeights.get(-e.id); if (weight) this.current.edgeWeights.set(e.id, weight);
      }
    }
    renderBoard(this.world, this.nodes, this.edges, {
      selection: new Set(), selectedEdges: new Set(), overrides: new Map(), handles: new Set(), edgeTarget: null,
      ghosts: new Set(), ghostEdges: new Set(), ghostSetNames: new Map(), overlay: false, codeOverlay: false,
      refsByNode: new Map(), charts: this.current.charts, threatMarkers: markers, scale: 1,
      nodeDiff: this.architecture?.nodeDiff, edgeDiff: this.architecture?.edgeDiff,
      icons: this.current.icons, edgeWeights: this.current.edgeWeights,
    });
    // Markers are labels in this viewer; the editor's marker buttons have no action.
    this.world.querySelectorAll('.board-marker[role="button"]').forEach(m => { m.removeAttribute('role'); m.removeAttribute('tabindex'); });
    this.world.querySelector('.embed-particles')?.remove();
    const particles = el('g', { class: 'embed-particles', 'aria-hidden': 'true' }); this.world.append(particles);
    const centers = new Map(this.nodes.map(n => [n.id, { x: n.x + n.w / 2, y: n.y + n.h / 2 }]));
    const center = (id: bigint) => centers.get(id) ?? null;
    const edges = this.current.edges;
    let schedule: { leg: Leg; start: number }[] = [];
    let end = 0;
    if (this.mode.value === 'route') {
      for (const leg of routeLegs(this.scene.route.map(BigInt), edges)) {
        schedule.push({ leg, start: end });
        end += legMs(leg, legSampler(this.world, leg, center).length) + 350;
      }
    } else if (this.mode.value.startsWith('threat:')) {
      const threat = this.scene.threats.find(t => `threat:${t.id}` === this.mode.value);
      if (threat) {
        const blast = blastRadius(BigInt(threat.anchorId), this.nodes.map(n => n.id), edges, id => this.nodes.find(n => n.id === id)?.label ?? '', { direction: 'reaches', depth: 'all' });
        schedule = [...blast.nodes].map(([to, b]) => {
          const edge = edges.find(e => e.id === b.viaEdge)!;
          return { leg: { from: edge.fromNode, to, edgeId: edge.id, reverse: false, latencyMs: null }, start: (b.hop - 1) * 1000 };
        });
      }
    } else if (this.mode.value === 'flows') {
      schedule = edges.map(e => ({ leg: { from: e.fromNode, to: e.toNode, edgeId: e.id, reverse: false, latencyMs: e.latencyMs < 0 ? null : e.latencyMs }, start: 0 }));
    }
    this.hops = schedule.slice(0, 40).map(({ leg, start }) => {
      const sample = legSampler(this.world, leg, center);
      const duration = this.mode.value.startsWith('threat:') ? 1000 : legMs(leg, sample.length);
      const dot = el('circle', { class: 'embed-flow-dot', r: '5' }); particles.append(dot);
      return { leg, start, end: start + duration, sample, dot };
    });
    this.duration = this.mode.value === 'architecture' ? 3000 : Math.max(1, ...this.hops.map(h => h.end + 600));
    this.clock.reset(this.duration);
    this.clock.setReduced(this.reduced);
    this.clock.setBlocked(this.blocked);
    // Reuse chart motion on plots produced by the board renderer.
    this.world.querySelectorAll<SVGGElement>('.chart-plot').forEach(plot => {
      const motion = new ChartMotion(plot); motion.setReduced(this.reduced); motion.setPaused(this.blocked || this.chartsPaused);
      this.chartMotions.push(motion);
      // Scene updates still show current values while motion is paused.
      if (this.blocked || this.chartsPaused) motion.settle(); else motion.replay();
    });
    let description = 'Live board · read only';
    if (this.architecture) {
      const count = (status: string) => [...this.architecture!.nodeDiff.values(), ...this.architecture!.edgeDiff.values()].filter(s => s === status).length;
      description = `Architecture changes · ${count('added')} added, ${count('removed')} removed, ${count('changed')} changed`;
    } else if (this.mode.value === 'route') description = 'Highlighted route · waypoints play in order';
    else if (this.mode.value.startsWith('threat:')) description = 'Threat propagation · follows outgoing connections';
    get('embed-subtitle').textContent = description;
    this.fit(); this.controls();
  }
  private paint(ms: number): void {
    this.world.dataset.playbackMs = String(Math.round(ms));
    this.world.querySelectorAll('.embed-path, .embed-reached').forEach(n => n.classList.remove('embed-path', 'embed-reached'));
    const p = Math.min(1, ms / this.duration);
    for (const hop of this.hops) {
      const active = ms >= hop.start && ms <= hop.end && !this.reduced;
      hop.dot.style.display = active ? '' : 'none';
      if (active) {
        const at = hop.sample.at(easeInOut((ms - hop.start) / (hop.end - hop.start)));
        if (at) { hop.dot.setAttribute('cx', String(at.x)); hop.dot.setAttribute('cy', String(at.y)); }
      }
      if (ms >= hop.start || this.reduced) {
        this.world.querySelector(`.edge-hit[data-edge-id="${hop.leg.edgeId}"]`)?.closest('.edge')?.classList.add('embed-path');
        this.world.querySelector(`.node[data-id="${hop.leg.from}"]`)?.classList.add('embed-reached');
      }
      if (ms >= hop.end || this.reduced) this.world.querySelector(`.node[data-id="${hop.leg.to}"]`)?.classList.add('embed-reached');
    }
    if (this.architecture) {
      for (const n of this.nodes) {
        const mark = this.world.querySelector<SVGGElement>(`.node[data-id="${n.id}"]`);
        if (!mark) continue;
        const status = this.architecture.nodeDiff.get(n.id);
        mark.style.opacity = status === 'removed' ? String(1 - .8 * p) : status === 'added' ? String(p) : '';
        const before = this.before.get(n.sourceKey);
        if (before && n.id > 0n) mark.setAttribute('transform', `translate(${before.x + (n.x - before.x) * p} ${before.y + (n.y - before.y) * p})`);
      }
      for (const [id, status] of this.architecture.edgeDiff) {
        const mark = this.world.querySelector<SVGElement>(`.edge-hit[data-edge-id="${id}"]`)?.closest<SVGGElement>('.edge');
        if (mark) mark.style.opacity = status === 'removed' ? String(1 - .8 * p) : status === 'added' ? String(p) : '';
      }
    }
    get('embed-progress').textContent = this.reduced ? 'Reduced motion · static view' : `${Math.round(p * 100)}%`;
  }
  private controls(): void {
    get<HTMLButtonElement>('embed-play').disabled = this.reduced || this.clock.playing;
    get<HTMLButtonElement>('embed-pause').disabled = this.reduced || !this.clock.playing;
    get<HTMLButtonElement>('embed-replay').disabled = this.reduced;
  }
  fit(): void {
    const bounds = contentBounds(this.nodes);
    if (!bounds) { this.svg.setAttribute('viewBox', '0 0 400 240'); return; }
    const box = this.host.getBoundingClientRect();
    const aspect = Math.max(1, box.width) / Math.max(1, box.height);
    let w = Math.max(100, bounds.maxX - bounds.minX + 80), h = Math.max(100, bounds.maxY - bounds.minY + 80);
    if (w / h < aspect) w = h * aspect; else h = w / aspect;
    w /= this.zoom; h /= this.zoom;
    const x = (bounds.minX + bounds.maxX - w) / 2 + this.pan.x, y = (bounds.minY + bounds.maxY - h) / 2 + this.pan.y;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }
  setMotion(reduced: boolean, blocked: boolean): void {
    this.reduced = reduced; this.blocked = blocked;
    this.clock.setReduced(reduced); this.clock.setBlocked(blocked);
    for (const m of this.chartMotions) { m.setReduced(reduced); m.setPaused(blocked || this.chartsPaused); }
    this.controls();
  }
  clear(): void {
    this.scene = null; this.current = graph({ nodes: [], edges: [], charts: [] }); this.clock.destroy();
    for (const m of this.chartMotions) m.settle(); this.chartMotions = [];
    renderBoard(this.world, [], [], { selection: new Set(), selectedEdges: new Set(), overrides: new Map(), handles: new Set(), edgeTarget: null,
      ghosts: new Set(), ghostEdges: new Set(), ghostSetNames: new Map(), overlay: false, codeOverlay: false, refsByNode: new Map(), scale: 1 });
    this.world.querySelector('.embed-particles')?.remove();
    this.nodes = []; this.edges = []; this.hops = []; this.before.clear(); this.architecture = null;
    this.mode.replaceChildren(); get('embed-progress').textContent = '';
  }
}
