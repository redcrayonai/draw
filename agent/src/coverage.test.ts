import { describe, it, expect, vi } from 'vitest';
import { computeCoverage, globToRegExp, intersects } from './coverage';

describe('globToRegExp', () => {
  it('supports ** (any depth, including zero) and * (one segment)', () => {
    const re = globToRegExp('**/module_bindings/**');
    expect(re.test('client/src/module_bindings/code_ref_table.ts')).toBe(true);
    expect(re.test('module_bindings/x.ts')).toBe(true);
    expect(re.test('client/src/render.ts')).toBe(false);
    expect(globToRegExp('*.lock').test('pnpm-lock.yaml')).toBe(false);
    expect(globToRegExp('*.lock').test('a.lock')).toBe(true);
    expect(globToRegExp('*.lock').test('sub/a.lock')).toBe(false);
    expect(globToRegExp('**/*.yaml').test('agent/pnpm-lock.yaml')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/a.b.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/sub/a.md')).toBe(false);
  });

  it('takes linear time on a glob and path the caller both chose (P8)', () => {
    let t = performance.now();
    expect(globToRegExp('**a**a**a**a**a**a**b').test('a'.repeat(80))).toBe(false); // ~10 s as a RegExp
    expect(performance.now() - t).toBeLessThan(100);
    t = performance.now();
    expect(globToRegExp('*a*a*a*a*a*a*a*a*b').test('a'.repeat(4096))).toBe(false);
    expect(globToRegExp('**/module_bindings/**').test('module_bindings/x.ts')).toBe(true);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('stays fast on the common case: 5 globs x 20k ordinary paths (P8)', () => {
    const globs = ['**/module_bindings/**', 'docs/**', '**/*.test.ts', 'client/src/module_bindings/**', '*.md'].map(g => globToRegExp(g));
    const paths = Array.from({ length: 20_000 }, (_, i) => `client/src/components/feature${i % 97}/sub${i % 13}/file_${i}_component.tsx`);
    const t = performance.now();
    expect(paths.filter(p => globs.some(g => g.test(p)))).toEqual([]);
    expect(performance.now() - t).toBeLessThan(500); // ~1.1 s with a boolean[] per token, ~90 ms now
  });

  it('matches exactly what the old RegExp matched, for every short glob and path (P8)', () => {
    // the old implementation, kept as the oracle
    const old = (glob: string) => {
      let re = '';
      for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
          if (glob[i + 1] === '*') {
            i++;
            if (glob[i + 1] === '/') {
              i++;
              re += '(?:.*/)?';
            } else re += '.*';
          } else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
      return new RegExp(`^${re}$`);
    };
    const all = (parts: string[], max: number) => {
      let level = [''];
      const out = [''];
      for (let k = 0; k < max; k++) out.push(...(level = level.flatMap(s => parts.map(p => s + p))));
      return out;
    };
    const globs = all(['a', '.', '/', '*', '?', '**', '**/'], 3);
    const paths = all(['a', '.', '/'], 5);
    const wrong = globs.flatMap(g => {
      const [a, b] = [old(g), globToRegExp(g)];
      return paths.filter(p => a.test(p) !== b.test(p)).map(p => `${g} ${p}`);
    });
    expect(wrong).toEqual([]);
  });
});

describe('intersects', () => {
  it('is inclusive on both ends and handles open-ended hunks', () => {
    expect(intersects({ startLine: 5, endLine: 9 }, [{ start: 9, end: 20 }])).toBe(true);
    expect(intersects({ startLine: 5, endLine: 9 }, [{ start: 10, end: 20 }])).toBe(false);
    expect(intersects({ startLine: 50, endLine: 60 }, [{ start: 1, end: Infinity }])).toBe(true);
    expect(intersects({ startLine: 1, endLine: 2 }, [])).toBe(false);
  });
});

describe('computeCoverage', () => {
  it('stops once the exclude globs spend the step allowance: the caller picks globs and (hosted) paths (P8)', () => {
    const paths = Array.from({ length: 200 }, (_, i) => 'a'.repeat(3990) + String(i).padStart(6, '0'));
    const input = { changed: paths, deleted: [], untracked: [], refs: [], hunksFor: () => [] };
    const t = performance.now();
    // ~2.4 s for all 200 paths; the allowance is spent on the third
    expect(() => computeCoverage({ ...input, exclude: [{ reason: 'x', glob: '**' + 'a'.repeat(1022) }], meter: { left: 1e7 } })).toThrow(/exclude globs/);
    // an empty glob costs a pass over the path too
    expect(() => computeCoverage({ ...input, exclude: Array(1000).fill({ reason: 'x', glob: '' }), meter: { left: 1e7 } })).toThrow(/exclude globs/);
    expect(performance.now() - t).toBeLessThan(200);
    const meter = { left: 1e7 };
    expect(computeCoverage({ ...input, exclude: [{ reason: 'x', glob: 'docs/**' }, { reason: 'x', glob: '*.md' }], meter }).uncovered).toHaveLength(200);
    expect(meter.left).toBeLessThan(1e7); // one allowance across globs and paths
  });

  it('counts a path covered only when a ref intersects one of its hunks', () => {
    const hunksFor = vi.fn((p: string) => (p === 'a.ts' ? [{ start: 10, end: 12 }] : [{ start: 100, end: 100 }]));
    const cov = computeCoverage({
      changed: ['a.ts', 'b.ts', 'c.ts'],
      deleted: [],
      untracked: [],
      refs: [
        { path: 'a.ts', startLine: 1, endLine: 10 },
        { path: 'b.ts', startLine: 1, endLine: 5 },
      ],
      hunksFor,
      exclude: [],
    });
    expect(cov).toEqual({ changed: 3, uncovered: ['b.ts', 'c.ts'], excluded: [], deleted: [] });
    expect(hunksFor).toHaveBeenCalledTimes(2); // not called for c.ts, which has no refs
  });

  it('any ref covers an untracked file; untracked files join the changed set once', () => {
    const hunksFor = vi.fn(() => []);
    const cov = computeCoverage({
      changed: ['a.ts', 'u.ts'],
      deleted: [],
      untracked: ['u.ts', 'v.ts'],
      refs: [{ path: 'u.ts', startLine: 1, endLine: 1 }],
      hunksFor,
      exclude: [],
    });
    expect(cov).toEqual({ changed: 3, uncovered: ['a.ts', 'v.ts'], excluded: [], deleted: [] });
    expect(hunksFor).not.toHaveBeenCalled();
  });

  it('groups uncovered paths under the first matching exclude, in exclude order, preserving path order', () => {
    const cov = computeCoverage({
      changed: ['pnpm-lock.yaml', 'client/src/module_bindings/a.ts', 'client/src/x.ts', 'agent/src/module_bindings/b.ts', 'agent/pnpm-lock.yaml'],
      deleted: [],
      untracked: [],
      refs: [],
      hunksFor: () => [],
      exclude: [
        { reason: 'generated bindings', glob: '**/module_bindings/**' },
        { reason: 'lockfiles', glob: '**/pnpm-lock.yaml' },
        { reason: 'never matches', glob: 'nothing/**' },
      ],
    });
    expect(cov).toEqual({
      changed: 5,
      uncovered: ['client/src/x.ts'],
      excluded: [
        { reason: 'generated bindings', paths: ['client/src/module_bindings/a.ts', 'agent/src/module_bindings/b.ts'] },
        { reason: 'lockfiles', paths: ['pnpm-lock.yaml', 'agent/pnpm-lock.yaml'] },
      ],
      deleted: [],
    });
  });

  it('two globs with one reason → one excluded group holding both paths (G20)', () => {
    const cov = computeCoverage({
      changed: ['client/src/module_bindings/a.ts', 'pnpm-lock.yaml', 'agent/src/module_bindings/b.ts', 'x.ts'],
      deleted: [],
      untracked: [],
      refs: [],
      hunksFor: () => [],
      exclude: [
        { reason: 'generated bindings', glob: 'client/src/module_bindings/**' },
        { reason: 'lockfiles', glob: '*.yaml' },
        { reason: 'generated bindings', glob: 'agent/src/module_bindings/**' },
      ],
    });
    expect(cov.excluded).toEqual([
      { reason: 'generated bindings', paths: ['client/src/module_bindings/a.ts', 'agent/src/module_bindings/b.ts'] },
      { reason: 'lockfiles', paths: ['pnpm-lock.yaml'] },
    ]);
    expect(cov.uncovered).toEqual(['x.ts']);
  });

  it('a covered path is never excluded; deleted paths are reported separately and deduped', () => {
    const cov = computeCoverage({
      changed: ['gen/a.ts'],
      deleted: ['old.md', 'old.md'],
      untracked: [],
      refs: [{ path: 'gen/a.ts', startLine: 1, endLine: 1 }],
      hunksFor: () => [{ start: 1, end: 1 }],
      exclude: [{ reason: 'generated', glob: 'gen/**' }],
    });
    expect(cov).toEqual({ changed: 1, uncovered: [], excluded: [], deleted: ['old.md'] });
  });
});
