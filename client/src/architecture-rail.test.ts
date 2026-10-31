import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountArchitectureRail } from './architecture-rail';
import type { Version } from './architecture';

const v = (over: Partial<Version>): Version => ({
  boardId: 2n, historyId: 0n, index: 0, assertionMode: 'intent', baseBoardId: 1n, ref: '', sha: '',
  status: 'draft', requestKey: 'k', reviewedSignature: '', implementedBoardId: 0n, ...over,
});
const names = new Map<bigint, string>([[1n, 'acme-shop'], [2n, 'add-queue'], [7n, 'repo · main']]);

function mount() {
  document.body.innerHTML = '<aside id="rail"></aside>';
  const actions = { switchBoard: vi.fn(), applyView: vi.fn(), sourceKey: vi.fn(), toggleDiff: vi.fn() };
  const rail = mountArchitectureRail(document.getElementById('rail')!, actions);
  const panel = document.getElementById('architecture-panel')!;
  const q = <T extends Element>(sel: string) => panel.querySelector<T>(sel)!;
  return { rail, panel, actions, q };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('architecture rail', () => {
  it('on a branch of a plain board shows the diff toggle and summary only: no snapshot picker, no timeline, no buttons', () => {
    const { rail, panel, q } = mount();
    rail.update(v({}), [v({})], names, 'Nodes +1 −0 · edges +1 −0 · 0 changed', true);
    expect(panel.hidden).toBe(false);
    expect(panel.getAttribute('aria-label')).toContain('branches');
    expect(q<HTMLElement>('label.architecture-snapshot').hidden).toBe(true);
    expect(q<HTMLInputElement>('input[type="range"]').hidden).toBe(true);
    expect(q<HTMLElement>('label.architecture-proposal').hidden).toBe(true);
    expect(q<HTMLInputElement>('input[type="checkbox"]').checked).toBe(true);
    expect(q<HTMLElement>('.architecture-summary').textContent).toBe('Nodes +1 −0 · edges +1 −0 · 0 changed');
    expect(panel.querySelectorAll('.architecture-actions button')).toHaveLength(0);
    expect(q<HTMLElement>('.architecture-mode').textContent).toBe('Branch of acme-shop · Draft');
  });

  it('on a fact snapshot keeps the snapshot picker and Apply view to history, and never offers Create proposal', () => {
    const { rail, panel, q } = mount();
    const fact = v({ boardId: 7n, historyId: 3n, index: 0, assertionMode: 'fact', baseBoardId: 0n, ref: 'main', sha: '2222222222222222222222222222222222222222', status: 'ready' });
    rail.update(fact, [fact], names, 'First snapshot', false);
    expect(q<HTMLElement>('label.architecture-snapshot').hidden).toBe(false);
    expect([...panel.querySelectorAll('.architecture-actions button')].map(b => b.textContent)).toEqual(['Apply view to history']);
  });

  it('on a branch with a node selected offers Set source key', () => {
    const { rail, panel } = mount();
    rail.update(v({}), [v({})], names, '', true, 'proposal:9');
    expect([...panel.querySelectorAll('.architecture-actions button')].map(b => b.textContent)).toEqual(['Set source key']);
  });
});
