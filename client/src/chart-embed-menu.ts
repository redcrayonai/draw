import { copyText, dismissible, flashLabel } from './chrome';
import { newShareToken } from '../../shared/share-link';
import { embedHref, embedSnippet, type EmbedTheme } from './embed-link';

export interface ChartEmbedSelection { nodeId: bigint; title: string; token: string }
export interface BoardEmbedSelection { boardId: bigint; title: string; token: string; threats: boolean; comparisonBoardId: bigint; previousBoardId: bigint }
export function setupChartEmbed(deps: {
  base: string; db: string; home: string;
  enable(nodeId: bigint, token: string): Promise<void>;
  disable(nodeId: bigint): Promise<void>;
  enableBoard(boardId: bigint, token: string, threats: boolean, comparisonBoardId: bigint): Promise<void>;
  disableBoard(boardId: bigint): Promise<void>;
}): (selection: ChartEmbedSelection | null, board: BoardEmbedSelection | null) => void {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const button = el<HTMLButtonElement>('act-embed'), pop = el('embed-pop');
  const on = el<HTMLInputElement>('embed-on'), detail = el('embed-detail'), error = el('embed-error');
  const theme = el<HTMLSelectElement>('embed-theme'), url = el<HTMLInputElement>('embed-url'), snippet = el<HTMLTextAreaElement>('embed-snippet');
  const scope = el<HTMLSelectElement>('embed-scope');
  const threats = el<HTMLInputElement>('embed-threats'), comparison = el<HTMLInputElement>('embed-comparison');
  let selection: ChartEmbedSelection | null = null;
  let board: BoardEmbedSelection | null = null;
  let pending = false;
  const close = () => { pop.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  const paint = () => {
    button.hidden = !board;
    if (!board) close();
    const whole = scope.value === 'board';
    const target = whole ? board : selection;
    button.textContent = whole ? 'Embed board' : 'Embed chart';
    pop.setAttribute('aria-label', whole ? 'Embed board' : 'Embed chart');
    el('embed-access-hint').textContent = `Anyone with this link can view this ${whole ? 'board' : 'chart'} and its published data without signing in. Private Notion page permissions do not protect the embed URL.`;
    el('embed-board-options').hidden = !whole;
    el('embed-comparison-row').hidden = !board?.previousBoardId;
    threats.checked = board?.threats ?? false;
    comparison.checked = Boolean(board?.comparisonBoardId);
    threats.disabled = comparison.disabled = pending || !target?.token;
    scope.disabled = pending;
    on.checked = Boolean(target?.token);
    on.disabled = pending;
    detail.hidden = !target?.token;
    const href = target?.token ? embedHref(deps.base, deps.db, target.token, theme.value as EmbedTheme, deps.home, whole ? 'board' : 'chart') : '';
    url.value = href;
    snippet.value = href ? embedSnippet(href, target!.title) : '';
  };
  button.addEventListener('click', () => {
    pop.hidden = !pop.hidden;
    button.setAttribute('aria-expanded', String(!pop.hidden));
  });
  const change = async (includes = false) => {
    const whole = scope.value === 'board';
    const current = whole ? board : selection;
    if (!current || pending) return;
    pending = true;
    on.disabled = threats.disabled = comparison.disabled = scope.disabled = true;
    error.hidden = true;
    try {
      if (whole && board) {
        if (on.checked || includes) await deps.enableBoard(board.boardId, newShareToken(), threats.checked, comparison.checked ? board.previousBoardId : 0n);
        else await deps.disableBoard(board.boardId);
      } else if (selection) {
        if (on.checked) await deps.enable(selection.nodeId, newShareToken());
        else await deps.disable(selection.nodeId);
      }
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
      error.hidden = false;
    } finally { pending = false; paint(); }
  };
  on.addEventListener('change', () => void change());
  threats.addEventListener('change', () => void change(true));
  comparison.addEventListener('change', () => void change(true));
  scope.addEventListener('change', () => { error.hidden = true; paint(); });
  theme.addEventListener('change', paint);
  for (const [id, input] of [['embed-copy-url', url], ['embed-copy-snippet', snippet]] as const) {
    const copy = el<HTMLButtonElement>(id);
    copy.addEventListener('click', async () => flashLabel(copy, await copyText(input.value), 'Copy', 'Copied ✓'));
  }
  dismissible(pop, button, close);
  return (next, nextBoard) => {
    if (next?.nodeId !== selection?.nodeId) { close(); error.hidden = true; }
    if (next?.nodeId !== selection?.nodeId) scope.value = next ? 'chart' : 'board';
    scope.querySelector<HTMLOptionElement>('[value="chart"]')!.disabled = !next;
    selection = next;
    board = nextBoard;
    if (!selection) scope.value = 'board';
    paint();
  };
}
