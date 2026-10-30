/**
 * Coverage = "a code ref intersects a diff hunk" (spec Decision 10). Pure: git
 * access is injected through hunksFor so this is unit-testable and lazy (hunks
 * are only computed for paths that have refs).
 *
 * Caller contract: `refs` must already exclude refs whose target node/edge no
 * longer exists; this function has no view of the board.
 */
export type Coverage = {
  changed: number;
  uncovered: string[];
  excluded: { reason: string; paths: string[] }[];
  deleted: string[];
  /** changed migration files that no change note cites (spec 2026-10-16 D2); absent when none */
  unconfirmed?: string[];
};

export type Hunk = { start: number; end: number };
type RefRange = { path: string; startLine: number; endLine: number };

// Tiny matcher: a double star matches any depth (a leading double star plus slash also matches zero dirs), a single star one segment, `?` one char.
// (Not a block comment: a double star followed by a slash would terminate it.)
// Not a RegExp: the caller picks both glob and path, and nested stars would backtrack
// exponentially. Each glob token steps the set of path positions it can end at: O(glob × path).
// A meter caps the positions scanned across every test that shares it.
export function globToRegExp(glob: string, meter?: { left: number }): { test(path: string): boolean } {
  const toks: string[] = [];
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] !== '*') toks.push(glob[i]);
    else if (glob[i + 1] !== '*') toks.push('*');
    else {
      const t = glob[i + 2] === '/' ? '**/' : '**';
      toks.push(t);
      i += t.length - 1;
    }
  }
  const SLASH = 47;
  return {
    test(path) {
      const n = path.length;
      const spend = () => {
        if (meter && (meter.left -= n + 1) < 0) throw new Error('the exclude globs cost too much to match against this many changed paths; pass fewer or simpler globs');
      };
      spend();
      // cur[j] = 1: the tokens so far can match path.slice(0, j). Two buffers, swapped per token.
      let cur = new Uint8Array(n + 1);
      let next = new Uint8Array(n + 1);
      cur[0] = 1;
      for (const t of toks) {
        spend();
        let any = 0;
        if (t === '*') {
          for (let j = 0; j <= n; j++) any |= next[j] = cur[j] || (j > 0 && next[j - 1] && path.charCodeAt(j - 1) !== SLASH) ? 1 : 0;
        } else if (t === '**') {
          for (let j = 0; j <= n; j++) any |= next[j] = cur[j] || (j > 0 && next[j - 1]) ? 1 : 0;
        } else if (t === '**/') {
          let before = 0; // some cur[i] with i < j
          for (let j = 0; j <= n; j++) {
            any |= next[j] = cur[j] || (before && path.charCodeAt(j - 1) === SLASH) ? 1 : 0;
            before |= cur[j];
          }
        } else {
          const one = t === '?';
          const code = t.charCodeAt(0);
          next[0] = 0;
          for (let j = 1; j <= n; j++) {
            const c = path.charCodeAt(j - 1);
            any |= next[j] = cur[j - 1] && (one ? c !== SLASH : c === code) ? 1 : 0;
          }
        }
        if (!any) return false; // no position left to match from
        [cur, next] = [next, cur];
      }
      return cur[n] === 1;
    },
  };
}

/**
 * Path positions one checkpoint may scan matching its exclude globs: about 3 s of CPU.
 * A count, not a time budget: a Worker's clock stands still while it computes.
 * shortcut: a fixed allowance (100k changed paths x 30 globs spend about half of it),
 * scan only reachable positions if real repos run out of it.
 */
export const MAX_GLOB_STEPS = 1e9;

export function intersects(ref: { startLine: number; endLine: number }, hunks: Hunk[]): boolean {
  return hunks.some(h => ref.startLine <= h.end && ref.endLine >= h.start);
}

export function computeCoverage(input: {
  changed: string[];
  deleted: string[];
  untracked: string[];
  refs: RefRange[];
  hunksFor: (path: string) => Hunk[];
  exclude: { reason: string; glob: string }[];
  /** shared by every exclude glob; none: unmetered */
  meter?: { left: number };
}): Coverage {
  const untracked = new Set(input.untracked);
  const all: string[] = [];
  const seen = new Set<string>();
  for (const p of [...input.changed, ...input.untracked]) {
    if (!seen.has(p)) {
      seen.add(p);
      all.push(p);
    }
  }

  const refsByPath = new Map<string, RefRange[]>();
  for (const r of input.refs) {
    const list = refsByPath.get(r.path);
    if (list) list.push(r);
    else refsByPath.set(r.path, [r]);
  }

  // One group per reason, in first-seen order (G20): the client keys a chip on
  // its reason, so two globs with one reason must not become two chips.
  const byReason = new Map<string, { reason: string; paths: string[] }>();
  for (const e of input.exclude) if (!byReason.has(e.reason)) byReason.set(e.reason, { reason: e.reason, paths: [] });
  const globs = input.exclude.map(e => ({ re: globToRegExp(e.glob, input.meter), group: byReason.get(e.reason)! }));
  const uncovered: string[] = [];

  for (const p of all) {
    const refs = refsByPath.get(p) ?? [];
    let covered = false;
    if (refs.length > 0) {
      if (untracked.has(p)) {
        covered = true;
      } else {
        const hunks = input.hunksFor(p);
        covered = refs.some(r => intersects(r, hunks));
      }
    }
    if (covered) continue;
    const glob = globs.find(g => g.re.test(p));
    if (glob) glob.group.paths.push(p);
    else uncovered.push(p);
  }

  return {
    changed: all.length,
    uncovered,
    excluded: [...byReason.values()].filter(g => g.paths.length > 0),
    deleted: [...new Set(input.deleted)],
  };
}
