import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyBoard } from './apply-board';
import { TOOLS } from './tools';
import { errorResult, okResult } from './scrub';

const node = (key: string) => ({ key, label: key, sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false });
const edge = { fromNode: '$api', toNode: '$db', label: 'writes', evidence: 'agent:user described the topology' };
const input = (extra = {}) => ({ board: '1', nodes: [node('api'), node('db')], edges: [edge], layout: true, ...extra });

describe('apply_board', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([5_999, 6_001])('keeps layout out of the final six seconds (%i ms left)', async remaining => {
    let clock = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const deadline = clock + 15_000;
    const calls: string[] = [];
    const result = await applyBoard(input({ nodes: [node('api')], edges: [] }), async name => {
      calls.push(name);
      clock = deadline - remaining;
      return okResult(name === 'create_node' ? 'committed id=11 board=main' : 'committed layout: moved 1, resized 0 board=main');
    }, deadline);
    expect(calls).toEqual(remaining < 6_000 ? ['create_node'] : ['create_node', 'layout_board']);
    expect(result.structuredContent).toMatchObject({ complete: remaining > 6_000, nodes: { api: '11' } });
    if (remaining < 6_000) expect(result.content[0].text).toMatch(/^UNAVAILABLE:.*Call layout_board/);
  });

  it('creates nodes before their edges, resolves local keys, and lays out last', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const result = await applyBoard(input(), async (name, args) => {
      calls.push({ name, args });
      return okResult(name === 'layout_board' ? 'committed layout: moved 2, resized 0 board=main' : `committed id=${calls.length + 10} board=main`);
    }, Date.now() + 15_000);
    expect(calls.map(c => c.name)).toEqual(['create_node', 'create_node', 'create_edge', 'layout_board']);
    expect(calls[0].args).toEqual({ board: '1', ...node('api'), key: undefined });
    expect(calls[2].args).toEqual({ board: '1', ...edge, fromNode: '11', toNode: '12' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ complete: true, nodes: { api: '11', db: '12' }, edges: ['13'] });
  });

  it('validates every input and local key before any operation can run', () => {
    for (const value of [
      input({ nodes: [node('api'), node('api')] }),
      input({ edges: [{ ...edge, toNode: '$missing' }] }),
      input({ edges: [{ ...edge, toNode: '1', force: true }] }),
      input({ nodes: [{ ...node('api'), w: '160' }] }),
      input({ nodes: Array.from({ length: 17 }, (_, i) => node(`n${i}`)), edges: [] }),
      input({ nodes: [], edges: [], layout: false }),
    ]) expect(TOOLS.apply_board.input.safeParse(value).success).toBe(false);
    expect(TOOLS.apply_board.input.safeParse(input({ edges: [{ ...edge, toNode: '42' }] })).success).toBe(true);
    expect(TOOLS.apply_board.input.safeParse(input({ nodes: [node('__proto__')] })).success).toBe(false);
  });

  it('requires source captures before creating nodes, and keeps captures on their edges', () => {
    const source = { ...edge, evidence: 'source:src/api.ts:10' };
    expect(TOOLS.apply_board.input.safeParse(input({ edges: [source] })).success).toBe(false);
    const capture = 'cap_AAAAAAAAAAAAAAAAAAAAAA';
    expect(TOOLS.apply_board.input.parse(input({ edges: [{ ...source, capture }] }))).toMatchObject({ edges: [{ capture }] });
  });

  it('returns completed ids and settles in-flight writes before stopping on a refusal', async () => {
    const calls: string[] = [];
    const result = await applyBoard(input({ nodes: [...input().nodes, node('worker'), node('queue')] }), async (name, args) => {
      calls.push(name);
      if (args.label === 'db') return errorResult('REJECTED: cannot edit board=main');
      await new Promise(r => setTimeout(r, 1));
      return okResult(`committed id=${args.label === 'api' ? 11 : 13} board=main`);
    }, Date.now() + 15_000);
    expect(calls).toEqual(['create_node', 'create_node', 'create_node']);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^REJECTED:/);
    expect(result.structuredContent).toMatchObject({ complete: false, nodes: { api: '11', worker: '13' }, edges: [] });
  });

  it('does not connect edges when a committed node has no unambiguous id', async () => {
    const calls: string[] = [];
    const result = await applyBoard(input(), async name => {
      calls.push(name);
      return okResult('committed (no new row observed; re-read with get_board) board=main');
    }, Date.now() + 15_000);
    expect(calls).toEqual(['create_node', 'create_node']);
    expect(result.content[0].text).toMatch(/^UNCONFIRMED/);
    expect(result.structuredContent).toMatchObject({ complete: false, nodes: {}, edges: [] });
  });

  it('starts no more operations after its budget expires', async () => {
    let calls = 0;
    const result = await applyBoard(input(), async () => { calls++; return okResult('committed'); }, Date.now() - 1);
    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^UNCONFIRMED/);
  });

  it('reports unfinished layout and directs the caller to continue only that operation', async () => {
    const result = await applyBoard(input({ nodes: [], edges: [] }), async () => okResult('committed layout: moved 3 of 9, resized 0 of 0; call again to continue board=main'), Date.now() + 15_000);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ complete: false });
    expect(result.content[0].text).toMatch(/^UNAVAILABLE:.*Call layout_board to continue/);
  });

  it('never runs more than three independent creates together', async () => {
    let active = 0;
    let peak = 0;
    let id = 10;
    const result = await applyBoard(input({ nodes: Array.from({ length: 7 }, (_, i) => node(`n${i}`)), edges: [], layout: false }), async () => {
      peak = Math.max(peak, ++active);
      await new Promise(r => setTimeout(r, 1));
      active--;
      return okResult(`committed id=${++id} board=main`);
    }, Date.now() + 15_000);
    expect(peak).toBe(3);
    expect(result.structuredContent).toMatchObject({ complete: true });
    expect(Object.keys(result.structuredContent!.nodes as object)).toHaveLength(7);
  });
});
