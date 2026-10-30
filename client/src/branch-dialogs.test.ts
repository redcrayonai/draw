import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openBranchCreate, openBranchReview, type ChangeRow } from './branch-dialogs';

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom does not implement native dialog methods; browser checks cover them.
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => {
  document.querySelector<HTMLDialogElement>('#branch-create')?.close();
  document.querySelector<HTMLDialogElement>('#branch-review')?.close();
});

const flush = () => new Promise(r => setTimeout(r, 0));
const dialog = (id: string) => document.querySelector<HTMLDialogElement>(`#${id}`)!;
const submit = (id: string) => dialog(id).querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const button = (id: string, label: string) => [...dialog(id).querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!;

describe('openBranchCreate', () => {
  const opts = (create = vi.fn(async () => {})) => ({ baseName: 'acme-shop', counts: '4 nodes · 3 edges', suggested: 'acme-shop-branch', create });

  it('prefills the name, shows the base line, and disables Create on an empty name', () => {
    openBranchCreate(opts());
    const input = dialog('branch-create').querySelector<HTMLInputElement>('#branch-create-name')!;
    expect(input.value).toBe('acme-shop-branch');
    expect(dialog('branch-create').querySelector('.branch-from')!.textContent).toContain('acme-shop');
    expect(dialog('branch-create').querySelector('.branch-from')!.textContent).toContain('4 nodes · 3 edges');
    expect(button('branch-create', 'Create branch').disabled).toBe(false);
    input.value = '  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(button('branch-create', 'Create branch').disabled).toBe(true);
  });

  it('calls create with the trimmed name and closes on success', async () => {
    const create = vi.fn(async () => {});
    openBranchCreate(opts(create));
    const input = dialog('branch-create').querySelector<HTMLInputElement>('#branch-create-name')!;
    input.value = ' add-queue ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    submit('branch-create');
    await flush();
    expect(create).toHaveBeenCalledWith('add-queue');
    expect(document.querySelector('#branch-create')).toBeNull();
  });

  it('shows the refusal and stays open when create rejects', async () => {
    openBranchCreate(opts(vi.fn(async () => { throw new Error('REJECTED: a branch forks a board or a snapshot, not another branch'); })));
    submit('branch-create');
    await flush();
    const alert = dialog('branch-create').querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain('not another branch');
    expect(dialog('branch-create').open).toBe(true);
  });
});

describe('openBranchReview', () => {
  const changes: ChangeRow[] = [
    { sign: '+', title: 'Queue', detail: 'datastore', meta: 'js:src/queue.ts' },
    { sign: '+', title: 'Orders → Queue', detail: 'enqueues', meta: '' },
    { sign: '−', title: 'Legacy', detail: 'service', meta: '' },
  ];
  const opts = (over: Partial<Parameters<typeof openBranchReview>[0]> = {}) => ({
    name: 'add-queue', baseName: 'acme-shop', status: 'submitted' as const, baseIsFact: false, changes, actions: ['accept', 'reject'] as const, run: vi.fn(async () => {}), ...over,
  });

  it('renders the name, the steps with the current one marked, and the change rows', () => {
    openBranchReview(opts());
    const d = dialog('branch-review');
    expect(d.querySelector('h2')!.textContent).toContain('add-queue');
    expect(d.querySelector('.branch-sub')!.textContent).toContain('acme-shop');
    const steps = [...d.querySelectorAll('.branch-step')];
    expect(steps.map(s => s.textContent)).toEqual(['Draft', 'In review', 'Accepted', 'Merged']);
    expect(steps.map(s => s.className.includes('done'))).toEqual([true, false, false, false]);
    expect(steps.map(s => s.className.includes('now'))).toEqual([false, true, false, false]);
    const rows = [...d.querySelectorAll('.branch-change')];
    expect(rows.map(r => r.querySelector('.branch-sign')!.textContent)).toEqual(['+', '+', '−']);
    expect(rows[0].querySelector('.branch-change-meta')!.textContent).toBe('js:src/queue.ts');
  });

  it('offers Reject and Accept to the owner of a submitted branch and runs the choice', async () => {
    const run = vi.fn(async () => {});
    openBranchReview(opts({ run }));
    expect(button('branch-review', 'Reject')).toBeDefined();
    button('branch-review', 'Accept').click();
    await flush();
    expect(run).toHaveBeenCalledWith('accept');
    expect(document.querySelector('#branch-review')).toBeNull();
  });

  it('on an accepted branch of a plain board offers Merge with the counts sentence', () => {
    openBranchReview(opts({ status: 'accepted', actions: ['merge'] as const }));
    const d = dialog('branch-review');
    expect(button('branch-review', 'Merge')).toBeDefined();
    expect(d.querySelector('.branch-note')!.textContent).toBe('Merging adds 1 node and 1 edge to acme-shop, removes 1 node, and keeps anything added there since the branch began.');
    expect([...d.querySelectorAll('.branch-step')].map(s => s.className.includes('now'))).toEqual([false, false, true, false]);
  });

  it('names the rejected step and offers Submit for review on a rejected branch', () => {
    openBranchReview(opts({ status: 'rejected', actions: ['submit'] as const }));
    const steps = [...dialog('branch-review').querySelectorAll('.branch-step')];
    expect(steps.map(s => s.textContent)).toEqual(['Draft', 'In review', 'Rejected', 'Merged']);
    expect(button('branch-review', 'Submit for review')).toBeDefined();
  });

  it('shows a refusal and stays open when the action rejects', async () => {
    openBranchReview(opts({ run: vi.fn(async () => { throw new Error('REJECTED: merge needs an accepted branch whose graph has not changed since review'); }) }));
    button('branch-review', 'Accept').click();
    await flush();
    const alert = dialog('branch-review').querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain('has not changed since review');
  });
});
