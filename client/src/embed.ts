import './style.css';
import './embed.css';
import { EmbedBoard } from './embed-board';
import type { EmbedScene } from '../../module/src/embed-contracts';
import { DbConnection } from './module_bindings';
import type { EmbeddedChartData } from './module_bindings/types';
import { pickDb } from '../../shared/db-target';
import { parsedChart, renderPlot } from './charts';
import { bindChartTooltip } from './chart-tooltip';
import { ChartMotion } from './chart-motion';
import { embedToken, EMBED_GONE } from './embed-link';
import { parseCsv } from '../../module/src/chart-contracts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const svg = document.getElementById('embed-chart') as unknown as SVGSVGElement;
const plot = svg.querySelector<SVGGElement>('.chart-plot')!;
const host = el('embed-plot-host'), status = el('embed-status');
const motion = new ChartMotion(plot);
const boardMode = new URLSearchParams(location.search).get('kind') === 'board';
const board = boardMode ? new EmbedBoard(svg, host) : null;
if (boardMode) {
  plot.setAttribute('hidden', '');
  svg.querySelector('#world')!.removeAttribute('hidden');
  svg.setAttribute('tabindex', '0');
  svg.removeAttribute('aria-labelledby');
  svg.setAttribute('aria-label', 'Read-only diagram. Use arrow keys to pan, or the zoom and fit buttons.');
  document.body.classList.add('board-embed');
  el('embed-title').textContent = 'Loading board…';
  el('embed-card').setAttribute('aria-label', 'Live board');
}
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const scheme = matchMedia('(prefers-color-scheme: dark)');
const theme = el<HTMLSelectElement>('viewer-theme');
const requestedTheme = new URLSearchParams(location.search).get('theme');
theme.value = requestedTheme === 'light' || requestedTheme === 'dark' ? requestedTheme : 'auto';
const paintTheme = () => { document.documentElement.dataset.theme = theme.value === 'auto' ? scheme.matches ? 'dark' : 'light' : theme.value; };
theme.addEventListener('change', paintTheme);
scheme.addEventListener('change', paintTheme);
paintTheme();

let row: EmbeddedChartData | undefined;
let paused = false;
let onscreen = true;
const syncMotion = () => {
  board?.setMotion(reduce.matches, !onscreen || document.visibilityState === 'hidden');
  document.body.classList.toggle('motion-paused', paused || !onscreen || document.visibilityState === 'hidden' || reduce.matches);
  motion.setReduced(reduce.matches);
  motion.setPaused(paused || !onscreen || document.visibilityState === 'hidden');
  if (!boardMode) {
    el<HTMLButtonElement>('embed-pause').disabled = reduce.matches;
    el<HTMLButtonElement>('embed-replay').disabled = reduce.matches;
  }
};
document.addEventListener('visibilitychange', syncMotion);
reduce.addEventListener('change', syncMotion);
if (typeof IntersectionObserver === 'function') new IntersectionObserver(entries => {
  onscreen = entries[0]?.isIntersecting ?? true;
  syncMotion();
}).observe(document.documentElement);
el('embed-pause').addEventListener('click', () => {
  if (boardMode) return;
  paused = !paused;
  el('embed-pause').textContent = paused ? 'Resume animations' : 'Pause animations';
  el('embed-pause').setAttribute('aria-pressed', String(paused));
  syncMotion();
});
el('embed-replay').addEventListener('click', () => { if (!boardMode) motion.replay(); });
syncMotion();

let unbindTooltip = () => {};
const unavailable = (message: string) => {
  row = undefined;
  motion.clear();
  board?.clear();
  unbindTooltip();
  unbindTooltip = () => {};
  svg.setAttribute('hidden', '');
  delete svg.dataset.chartType;
  el('embed-title').textContent = boardMode ? 'Board unavailable' : 'Chart unavailable';
  document.title = `${boardMode ? 'Board' : 'Chart'} unavailable · Draw`;
  el('embed-subtitle').textContent = '';
  el('embed-source').textContent = '';
  el('embed-data').hidden = true;
  el('embed-data').querySelector('table')!.replaceChildren();
  el('embed-playback').hidden = el('embed-open').hidden = el('embed-board-tools').hidden = true;
  status.textContent = message;
  status.hidden = false;
};
let lastSize = '';
const draw = (animate: boolean) => {
  if (boardMode) { board?.fit(); return; }
  if (!row) return;
  const parsed = parsedChart(row);
  if (!parsed.ok) { unavailable('This chart cannot be displayed.'); return; }
  const box = host.getBoundingClientRect();
  const w = Math.max(200, box.width), h = Math.max(100, box.height);
  const size = `${w},${h}`;
  if (!animate && size === lastSize) return;
  lastSize = size;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.dataset.chartType = row.type;
  motion.replace(renderPlot(parsed.data, { x: 4, y: 4, w: w - 8, h: h - 8 }, false), animate);
};
new ResizeObserver(() => draw(false)).observe(host);

async function start(): Promise<void> {
  const token = embedToken(location.hash);
  const gone = boardMode ? 'This board is no longer embedded. Ask the owner for a new link.' : EMBED_GONE;
  const uri = import.meta.env.VITE_SPACETIME_URI;
  const home = import.meta.env.VITE_SPACETIME_DB;
  if (!token) { unavailable(gone); return; }
  if (!uri || !home) { unavailable(`${boardMode ? 'Board' : 'Chart'} embeds are not configured on this site.`); return; }
  const db = pickDb(location.search, home, import.meta.env.VITE_SPACETIME_DB_ALLOWED);
  if ((new URLSearchParams(location.search).get('db') || home) !== db) {
    unavailable(`This site does not serve the ${boardMode ? 'board' : 'chart'}’s database.`); return;
  }
  // No account restoration, cookie or localStorage access. Each frame gets its
  // own DB-issued identity, whose only private-content grant is this embed.
  const conn = DbConnection.builder().withUri(uri).withDatabaseName(db)
    .onConnect(async connection => {
      try {
        if (boardMode) await connection.reducers.openBoardEmbed({ token });
        else await connection.reducers.openChartEmbed({ token });
        let previousScene = '';
        const common = (title: string) => {
          el('embed-title').textContent = title;
          document.title = `${title} · Draw`;
          status.hidden = true; svg.removeAttribute('hidden');
          el('embed-playback').hidden = el('embed-open').hidden = false;
          el<HTMLAnchorElement>('embed-open').href = location.href;
          unbindTooltip(); unbindTooltip = bindChartTooltip(svg, host, () => true);
        };
        const refresh = () => {
          if (boardMode) {
            const next = [...connection.db.embeddedBoard.iter()].find(item => item.token === token);
            if (!next) { previousScene = ''; unavailable(gone); return; }
            common(next.title);
            el('embed-board-tools').hidden = el('embed-play').hidden = el('embed-loop-label').hidden = false;
            el('embed-pause').textContent = 'Pause';
            el('embed-pause').removeAttribute('aria-pressed');
            if (next.scene !== previousScene) {
              previousScene = next.scene;
              board!.update(JSON.parse(next.scene) as EmbedScene);
              syncMotion();
            }
            return;
          }
          const next = [...connection.db.embeddedChart.iter()].find(item => item.token === token);
          if (!next) { unavailable(gone); return; }
          if (next === row) return;
          row = next;
          el('embed-title').textContent = next.title;
          el('embed-subtitle').textContent = next.subtitle;
          el('embed-source').textContent = `Source: ${next.source}`;
          // All tooltip values are available to keyboard and touch users too.
          const csv = parseCsv(next.csv);
          const table = el('embed-data').querySelector('table')!;
          table.replaceChildren();
          if (csv.ok) {
            for (const [i, cells] of [csv.header, ...csv.rows].entries()) {
              const tr = document.createElement('tr');
              for (const text of cells) {
                const cell = document.createElement(i === 0 ? 'th' : 'td');
                if (i === 0) cell.setAttribute('scope', 'col');
                cell.textContent = text;
                tr.append(cell);
              }
              table.append(tr);
            }
          }
          el('embed-data').hidden = false;
          document.title = `${next.title} · Draw`;
          status.hidden = true;
          svg.removeAttribute('hidden');
          el('embed-playback').hidden = el('embed-open').hidden = false;
          el<HTMLAnchorElement>('embed-open').href = location.href;
          unbindTooltip();
          unbindTooltip = bindChartTooltip(svg, host, () => Boolean(row));
          draw(true);
        };
        // Views without a primary key deliver edits as delete + insert in one
        // transaction. Read after both, so data edits morph from the old plot.
        let pending = false;
        const schedule = () => {
          if (pending) return;
          pending = true;
          queueMicrotask(() => { pending = false; refresh(); });
        };
        connection.db.embeddedChart.onInsert(schedule);
        connection.db.embeddedChart.onUpdate(schedule);
        connection.db.embeddedChart.onDelete(schedule);
        connection.db.embeddedBoard.onInsert(schedule);
        connection.db.embeddedBoard.onUpdate(schedule);
        connection.db.embeddedBoard.onDelete(schedule);
        connection.subscriptionBuilder().onApplied(refresh)
          .onError(() => unavailable(`${boardMode ? 'Board' : 'Chart'} access could not be verified. Reload to retry.`))
          .subscribe([boardMode ? 'SELECT * FROM embedded_board' : 'SELECT * FROM embedded_chart']);
      } catch { unavailable(gone); }
    })
    .onConnectError(() => unavailable(`Could not connect to this ${boardMode ? 'board' : 'chart'}. Reload to retry.`))
    .onDisconnect(() => unavailable('Connection lost. Reload to verify access and reconnect.'))
    .build();
  window.addEventListener('pagehide', () => conn.disconnect(), { once: true });
}
void start();
