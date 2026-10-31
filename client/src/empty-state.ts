/**
 * The canvas empty state has three variants (G11). A board without a session
 * row offers the importer; a session board with no nodes yet is the agent's
 * to draw, so it says it is waiting and offers only hand placement; and a
 * board an agent is already on says so by name (hosted MCP §12). Variant
 * parts carry `data-mode-only` (one or more modes) and are hidden with the
 * attribute, never by CSS alone, so a row arriving later switches the copy in
 * place.
 */
export function syncEmptyState(el: HTMLElement, s: { nodeCount: number; hasSession: boolean; agent?: string }): void {
  const hidden = s.nodeCount > 0;
  if (el.hidden !== hidden) {
    el.hidden = hidden;
  }
  const agentLine = el.querySelector('#empty-agent');
  const text = s.agent === undefined ? '' : `${s.agent} is here. Nothing drawn yet.`;
  if (agentLine !== null && agentLine.textContent !== text) {
    agentLine.textContent = text;
  }
  const mode = s.agent !== undefined ? 'agent' : s.hasSession ? 'session' : 'board';
  if (el.dataset.mode === mode) {
    return;
  }
  el.dataset.mode = mode;
  for (const part of el.querySelectorAll<HTMLElement>('[data-mode-only]')) {
    part.hidden = !part.dataset.modeOnly!.split(' ').includes(mode);
  }
}
