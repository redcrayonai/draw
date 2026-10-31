import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session } from './module_bindings/types';
import { renderSessionBlock, relativeTime, codeOverlayHint, PULSE_MS, type SessionModel } from './session-rail';
import { buildRouteModel } from './route';

const NOW = 1_800_000_000_000;

function ts(ms: number): Session['updatedAt'] {
  return { toDate: () => new Date(ms), toMillis: () => BigInt(ms) } as unknown as Session['updatedAt'];
}

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: 1n,
    boardId: 7n,
    repoRoot: '/Users/alan/repo',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    checkpoint: 3,
    coverage: '{}',
    startedAt: ts(NOW - 3_600_000),
    updatedAt: ts(NOW - 4 * 60_000),
    ...over,
  };
}

function mkModel(over: Partial<SessionModel> = {}): SessionModel {
  return {
    session: mkSession(),
    coverage: { changed: 0, uncovered: [], excluded: [], deleted: [] },
    agentFocus: null,
    now: NOW,
    codeOverlay: false,
    refCount: 0,
    editorScheme: 'vscode',
    refStatus: { stale: 0, ambiguous: 0 },
    ...over,
  };
}

function mkRoute(currentIndex = 1) {
  return buildRouteModel(
    { boardId: 7n, nodeIds: [1n, 2n, 3n], currentIndex, revision: 1, currentCheckpoint: 3, updatedAt: ts(NOW) },
    [{ id: 1n, boardId: 7n, kind: 'arrive', revision: 1, nodeId: 2n, nodeIds: [1n, 2n, 3n], reason: '', checkpoint: 3, at: ts(NOW) }],
    new Map([
      [1n, { label: 'Plan', sublabel: '', hidden: false }],
      [2n, { label: 'Auth', sublabel: '', hidden: false }],
      [3n, { label: 'Tests', sublabel: '', hidden: false }],
    ])
  );
}

let el: HTMLElement;
beforeEach(() => {
  el = document.createElement('div');
  el.hidden = true;
  document.body.replaceChildren(el);
});

describe('codeOverlayHint (P1)', () => {
  it('discloses hidden badges only while the overlay is on, refs exist and the board is dense', () => {
    expect(codeOverlayHint({ codeOverlay: true, dense: true, refCount: 3 })).toBe('ref badges show at 60% zoom and up');
    expect(codeOverlayHint({ codeOverlay: true, dense: false, refCount: 3 })).toBeNull();
    expect(codeOverlayHint({ codeOverlay: false, dense: true, refCount: 3 })).toBeNull();
    // no refs: the session block's 'no code refs yet' line speaks instead
    expect(codeOverlayHint({ codeOverlay: true, dense: true, refCount: 0 })).toBeNull();
  });
});

describe('relativeTime', () => {
  it('ticks from just now to days', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 4 * 60_000, NOW)).toBe('4 min ago');
    expect(relativeTime(NOW - 50_000, NOW)).toBe('1 min ago');
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2 h ago');
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3 d ago');
    expect(relativeTime(NOW + 5_000, NOW)).toBe('just now');
  });

  it('never shows 60 min or 24 h at the unit boundaries (G49)', () => {
    expect(relativeTime(NOW - 3570_000, NOW)).toBe('59 min ago');
    expect(relativeTime(NOW - 3600_000, NOW)).toBe('1 h ago');
    expect(relativeTime(NOW - 84_600_000, NOW)).toBe('23 h ago');
    expect(relativeTime(NOW - 86_400_000, NOW)).toBe('1 d ago');
  });
});

describe('renderSessionBlock', () => {
  it('shows route destination, progress and ordered waypoint status independently of agent focus', () => {
    const route = mkRoute();
    renderSessionBlock(el, mkModel({ route, agentFocus: 'Other task' }));
    expect(el.querySelector('.session-route-destination')!.textContent).toBe('destination: Tests');
    expect(el.querySelector('.session-route-progress')!.textContent).toBe('2/3 · now: Auth · next: Tests');
    const rows = [...el.querySelectorAll('.session-waypoint')];
    expect(rows.map(r => r.textContent)).toEqual(['1Plan done', '2Auth current', '3Tests pending']);
    expect(rows[1].getAttribute('aria-current')).toBe('step');
    expect(el.querySelector('.session-focus')!.textContent).toBe('agent on Other task');
    renderSessionBlock(el, mkModel({ route, agentFocus: null }));
    expect(el.querySelector('.session-focus')).toBeNull();
    expect(el.querySelector('.session-waypoint[aria-current="step"]')!.textContent).toContain('Auth current');
  });

  it('waypoint clicks select for inspection without changing progress and memo hits use the latest callback', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const route = mkRoute();
    renderSessionBlock(el, mkModel({ route, onSelectWaypoint: first }));
    const button = el.querySelector<HTMLButtonElement>('.session-waypoint')!;
    expect(button.getAttribute('aria-label')).toBe('Waypoint 1: Plan · done');
    const observer = new MutationObserver(() => {});
    observer.observe(el, { attributes: true, characterData: true, childList: true, subtree: true });
    renderSessionBlock(el, mkModel({ route, onSelectWaypoint: latest }));
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    expect(el.querySelector('.session-waypoint')).toBe(button);
    button.click();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(1n);
    expect(el.querySelector('.session-route-progress')!.textContent).toBe('2/3 · now: Auth · next: Tests');
  });

  it('offers Play route with two visible waypoints and calls the latest handler', () => {
    const first = vi.fn();
    const latest = vi.fn();
    renderSessionBlock(el, mkModel({ route: mkRoute(), onPlayRoute: first }));
    renderSessionBlock(el, mkModel({ route: mkRoute(), onPlayRoute: latest }));
    el.querySelector<HTMLButtonElement>('.session-route-play')!.click();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });

  it('shows the last trace with a Replay button only when there is one', () => {
    const replay = vi.fn();
    renderSessionBlock(el, mkModel({ trace: null, onReplayTrace: replay }));
    expect(el.querySelector('.session-trace-play')).toBeNull();
    renderSessionBlock(el, mkModel({ trace: 'GET /checkout · 6 spans · 180ms · prod', onReplayTrace: replay }));
    expect(el.querySelector('.session-trace')!.textContent).toContain('last trace: GET /checkout · 6 spans · 180ms · prod');
    el.querySelector<HTMLButtonElement>('.session-trace-play')!.click();
    expect(replay).toHaveBeenCalledOnce();
  });

  it('preserves waypoint focus and accessible route history disclosure across updates', () => {
    renderSessionBlock(el, mkModel({ route: mkRoute() }));
    const details = el.querySelector<HTMLDetailsElement>('.session-route-history')!;
    expect(details.querySelector('summary')!.textContent).toBe('Route history (1)');
    expect(details.textContent).toContain('Arrived: Auth · checkpoint 3 · revision 1');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    el.querySelector<HTMLButtonElement>('.session-waypoint[data-key="waypoint:2"]')!.focus();
    renderSessionBlock(el, mkModel({ route: mkRoute(2) }));
    expect(el.querySelector<HTMLDetailsElement>('.session-route-history')!.open).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.key).toBe('waypoint:2');
    expect(el.querySelector('.session-route-progress')!.textContent).toBe('3/3 · destination reached');
  });

  it('discloses hidden and missing waypoints and disables unavailable inspection', () => {
    const route = buildRouteModel(
      { boardId: 7n, nodeIds: [1n, 2n], currentIndex: -1, revision: 1, currentCheckpoint: 0, updatedAt: ts(NOW) }, [],
      new Map([[1n, { label: 'Private', sublabel: '', hidden: true }]])
    );
    renderSessionBlock(el, mkModel({ route }));
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('.session-waypoint')];
    expect(buttons.map(b => b.textContent)).toEqual(['1Private (hidden) pending', '2missing node 2 pending']);
    expect(buttons.every(b => b.disabled)).toBe(true);
  });

  it('renders no session chrome at all without a session row, even with the overlay on', () => {
    renderSessionBlock(el, mkModel({ session: null }));
    expect(el.hidden).toBe(true);
    expect(el.children).toHaveLength(0);
    renderSessionBlock(el, mkModel({ session: null, codeOverlay: true, refCount: 0 }));
    expect(el.hidden).toBe(true);
    expect(el.children).toHaveLength(0);
    expect(el.querySelector('.session-hint')).toBeNull();
  });

  it('shows the checkpoint line with a relative time and the empty coverage state', () => {
    renderSessionBlock(el, mkModel());
    expect(el.hidden).toBe(false);
    expect(el.querySelector('.eyebrow')!.textContent).toBe('SESSION');
    expect(el.querySelector('.session-line')!.textContent).toBe('checkpoint 3 · 4 min ago');
    expect(el.querySelector('.session-empty')!.textContent).toBe('nothing changed since the session started');
    expect(el.querySelector('.session-line')!.classList.contains('pulse')).toBe(false);
    expect(el.lastElementChild!.classList.contains('rail-divider')).toBe(true);
  });

  it('says no checkpoint yet at checkpoint 0', () => {
    renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 0 }) }));
    expect(el.querySelector('.session-line')!.textContent).toBe('no checkpoint yet');
  });

  it('pulses once when the checkpoint advances', () => {
    renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 1 }) }));
    renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 2 }), now: NOW + 100 }));
    expect(el.querySelector('.session-line')!.classList.contains('pulse')).toBe(true);
    renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 2 }), now: NOW + 100 + PULSE_MS }));
    expect(el.querySelector('.session-line')!.classList.contains('pulse')).toBe(false);
  });

  it('renders debt, excluded and deleted chips that expand to path lists with open links', () => {
    renderSessionBlock(
      el,
      mkModel({
        coverage: {
          changed: 5,
          uncovered: ['client/src/palette.ts', 'docs/a b.md'],
          excluded: [{ reason: 'generated bindings', paths: ['client/src/module_bindings/code_ref_table.ts'] }],
          deleted: ['docs/old.md'],
        },
      })
    );
    const chips = [...el.querySelectorAll<HTMLButtonElement>('.chip')];
    // G37: every label leads with its count; the debt chip's warning is an SVG icon
    expect(chips.map(c => c.textContent)).toEqual([
      '2 changed files not on board',
      '1 · generated bindings',
      '1 deleted',
    ]);
    expect(chips[0].querySelector('svg[aria-hidden="true"]')!.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(chips.map(c => c.title)).toEqual([
      'Changed files not on the board · click to list the paths',
      'Excluded: generated bindings · click to list the paths',
      'Deleted since the session started · click to list the paths',
    ]);
    expect(chips[0].classList.contains('debt')).toBe(true);
    expect(chips[0].getAttribute('aria-expanded')).toBe('false');
    // P5: each chip ends in the toolbar's chevron, the visible disclosure cue.
    for (const c of chips) {
      const disc = c.lastElementChild!;
      expect(disc.classList.contains('disc')).toBe(true);
      expect(disc.getAttribute('aria-hidden')).toBe('true');
      expect(disc.querySelector('path')!.getAttribute('d')).toBe('M5 6.5l3 3 3-3');
    }
    const lists = [...el.querySelectorAll<HTMLElement>('.chip-paths')];
    expect(lists).toHaveLength(3);
    expect(lists.every(l => l.hidden)).toBe(true);

    chips[0].click();
    expect(chips[0].getAttribute('aria-expanded')).toBe('true');
    expect(chips[0].classList.contains('active')).toBe(true);
    expect(lists[0].hidden).toBe(false);
    const rows = [...lists[0].querySelectorAll('.chip-path')];
    expect(rows.map(r => r.querySelector('.chip-path-name')!.textContent)).toEqual([
      'client/src/palette.ts',
      'docs/a b.md',
    ]);
    // a path breaks after a '/', never inside the file name
    const name = rows[0].querySelector('.chip-path-name')!;
    expect([...name.childNodes].map(n => (n.nodeName === 'WBR' ? '|' : n.textContent)).join('')).toBe('client/|src/|palette.ts');
    expect(rows[1].querySelector('a.chip-open')!.getAttribute('href')).toBe(
      'vscode://file/Users/alan/repo/docs/a%20b.md:1'
    );
    expect(rows[1].querySelector('a.chip-open')!.textContent).toBe('open');
    // deleted files have no open link
    expect(lists[2].querySelector('a.chip-open')).toBeNull();

    chips[0].click();
    expect(lists[0].hidden).toBe(true);
  });

  it('keeps a chip open across re-renders', () => {
    const m = mkModel({ coverage: { changed: 1, uncovered: ['x.ts'], excluded: [], deleted: [] } });
    renderSessionBlock(el, m);
    el.querySelector<HTMLButtonElement>('.chip')!.click();
    renderSessionBlock(el, m);
    expect(el.querySelector<HTMLElement>('.chip-paths')!.hidden).toBe(false);
  });

  it('shows the no-refs hint only when a session row exists, the overlay is on and the index is empty', () => {
    renderSessionBlock(el, mkModel({ codeOverlay: true, refCount: 0 }));
    expect(el.hidden).toBe(false);
    expect(el.querySelector('.session-hint')!.textContent).toBe(
      'no code refs yet — the agent adds them at checkpoints'
    );
    // the hint sits inside the block, before the trailing divider
    expect(el.lastElementChild!.classList.contains('rail-divider')).toBe(true);
    renderSessionBlock(el, mkModel({ codeOverlay: false, refCount: 0 }));
    expect(el.querySelector('.session-hint')).toBeNull();
    renderSessionBlock(el, mkModel({ codeOverlay: true, refCount: 2 }));
    expect(el.querySelector('.session-hint')).toBeNull();
  });

  it('reconciles a fully covered board: N changed · C on board · E excluded · U not on board (F13)', () => {
    // The acceptance run: 4 changed = 3 covered + 1 excluded + 0 uncovered.
    renderSessionBlock(
      el,
      mkModel({
        session: mkSession({ checkpoint: 2 }),
        coverage: {
          changed: 4,
          uncovered: [],
          excluded: [{ reason: 'generated bindings', paths: ['client/src/module_bindings/x.ts'] }],
          deleted: [],
        },
      })
    );
    const recon = el.querySelector('.session-recon')!;
    expect(recon.textContent).toBe('4 changed · 3 on board · 1 excluded · 0 not on board');
    expect(recon.classList.contains('debt')).toBe(false);
    // The exclusion chip still lists its paths.
    expect([...el.querySelectorAll('.chip')].map(c => c.textContent)).toEqual(['1 · generated bindings']);
    // G37: each figure is a nowrap span, so the line never breaks inside one
    expect([...recon.querySelectorAll('.recon-part')].map(p => p.textContent)).toEqual([
      '4 changed',
      '3 on board',
      '1 excluded',
      '0 not on board',
    ]);
  });

  it('marks the reconciliation line as debt when files are not on board, without ⚠ (F13, G37)', () => {
    renderSessionBlock(
      el,
      mkModel({
        coverage: {
          changed: 6,
          uncovered: ['a.ts', 'b.ts'],
          excluded: [
            { reason: 'generated bindings', paths: ['g1.ts', 'g2.ts'] },
            { reason: 'lockfiles', paths: ['pnpm-lock.yaml'] },
          ],
          deleted: ['old.md'],
        },
      })
    );
    const recon = el.querySelector('.session-recon')!;
    // The debt chip below carries the warning; the line only states the totals.
    expect(recon.textContent).toBe('6 changed · 1 on board · 3 excluded · 2 not on board');
    expect(recon.classList.contains('debt')).toBe(true);
    // the line sits between the checkpoint line and the chips
    expect(recon.previousElementSibling!.classList.contains('session-line')).toBe(true);
    expect(recon.nextElementSibling!.classList.contains('session-chips')).toBe(true);
  });

  it('renders the reconciliation line once something changed; nothing changed says it once (F13, G37)', () => {
    renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 1 }) }));
    expect(el.querySelector('.session-recon')).toBeNull();
    expect(el.querySelector('.session-empty')!.textContent).toBe('nothing changed since the session started');
    renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 1 }), coverage: { changed: 1, uncovered: [], excluded: [], deleted: [] } }));
    expect(el.querySelector('.session-recon')!.textContent).toBe('1 changed · 1 on board · 0 excluded · 0 not on board');
    renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 0 }) }));
    expect(el.querySelector('.session-recon')).toBeNull();
  });

  it('before the first checkpoint says coverage comes at the first checkpoint, not "nothing changed" (F19)', () => {
    renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 0 }) }));
    expect(el.querySelector('.session-empty')!.textContent).toBe('coverage appears at the first checkpoint');
    expect(el.textContent).not.toContain('nothing changed');
    renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 1 }) }));
    expect(el.querySelector('.session-empty')!.textContent).toBe('nothing changed since the session started');
  });

  it('stale count line: N stale · M ambiguous refs; a click asks for the owning node (G12)', () => {
    const select = vi.fn();
    renderSessionBlock(el, mkModel({ refStatus: { stale: 2, ambiguous: 1 }, onSelectStale: select }));
    const line = el.querySelector<HTMLButtonElement>('button.session-stale')!;
    expect(line.textContent).toBe('2 stale · 1 ambiguous refs');
    expect(line.title).toMatch(/select/i);
    line.click();
    expect(select).toHaveBeenCalledTimes(1);
    renderSessionBlock(el, mkModel({ refStatus: { stale: 1, ambiguous: 0 }, onSelectStale: select }));
    expect(el.querySelector('.session-stale')!.textContent).toBe('1 stale ref');
    renderSessionBlock(el, mkModel({ refStatus: { stale: 0, ambiguous: 2 }, onSelectStale: select }));
    expect(el.querySelector('.session-stale')!.textContent).toBe('2 ambiguous refs');
    renderSessionBlock(el, mkModel({ refStatus: { stale: 0, ambiguous: 0 }, onSelectStale: select }));
    expect(el.querySelector('.session-stale')).toBeNull();
  });

  it('names the node the agent is on', () => {
    renderSessionBlock(el, mkModel({ agentFocus: 'limiter' }));
    expect(el.querySelector('.session-focus')!.textContent).toBe('agent on limiter');
  });

  it('agent focus shows the label; its path goes in the title (G37)', () => {
    renderSessionBlock(el, mkModel({ agentFocus: 'editor links', agentFocusPath: 'client/src/editor-link.ts' }));
    const focus = el.querySelector<HTMLElement>('.session-focus')!;
    expect(focus.textContent).toBe('agent on editor links');
    expect(focus.title).toBe('client/src/editor-link.ts');
  });

  describe('memo (F8)', () => {
    function mutations(target: Element, fn: () => void): MutationRecord[] {
      const mo = new MutationObserver(() => {});
      mo.observe(target, { attributes: true, childList: true, characterData: true, subtree: true });
      fn();
      const recs = mo.takeRecords();
      mo.disconnect();
      return recs;
    }
    const cov = { changed: 3, uncovered: ['a.ts'], excluded: [{ reason: 'lockfiles', paths: ['pnpm-lock.yaml'] }], deleted: [] };

    it('identical input produces zero mutation records', () => {
      renderSessionBlock(el, mkModel({ coverage: cov, agentFocus: 'limiter' }));
      const recs = mutations(el, () =>
        renderSessionBlock(el, mkModel({ coverage: structuredClone(cov), agentFocus: 'limiter' }))
      );
      expect(recs).toHaveLength(0);
    });

    it('a clock tick patches only the checkpoint line text; chips keep identity', () => {
      renderSessionBlock(el, mkModel({ coverage: cov }));
      const chip = el.querySelector('.chip')!;
      const same = mutations(el, () => renderSessionBlock(el, mkModel({ coverage: cov, now: NOW + 20_000 })));
      expect(same).toHaveLength(0);
      const line = el.querySelector('.session-line')!;
      const recs = mutations(el, () => renderSessionBlock(el, mkModel({ coverage: cov, now: NOW + 2 * 60_000 })));
      expect(recs.length).toBeGreaterThan(0);
      for (const r of recs) {
        expect(line === r.target || line.contains(r.target)).toBe(true);
      }
      expect(line.textContent).toBe('checkpoint 3 · 6 min ago');
      expect(el.querySelector('.chip')).toBe(chip);
    });

    it('a real rebuild puts focus back on the same chip or open link', () => {
      renderSessionBlock(el, mkModel({ coverage: cov }));
      const debt = el.querySelector<HTMLButtonElement>('.chip.debt')!;
      debt.click();
      debt.focus();
      renderSessionBlock(el, mkModel({ coverage: cov, agentFocus: 'limiter' }));
      expect(el.querySelector('.session-focus')).not.toBeNull();
      expect(el.querySelector('.chip.debt')).not.toBe(debt);
      expect(document.activeElement).toBe(el.querySelector('.chip.debt'));
      const link = el.querySelector<HTMLAnchorElement>('a.chip-open')!;
      link.focus();
      renderSessionBlock(el, mkModel({ coverage: cov, agentFocus: 'store' }));
      expect(el.querySelector('a.chip-open')).not.toBe(link);
      expect(document.activeElement).toBe(el.querySelector('a.chip-open'));
    });

    it('pulses only on the render where the checkpoint increased', () => {
      renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 1 }) }));
      renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 2 }), now: NOW + 100 }));
      expect(el.querySelector('.session-line')!.classList.contains('pulse')).toBe(true);
      // A burst of writes right after the checkpoint rebuilds the block but
      // must not restart the one-shot animation.
      renderSessionBlock(el, mkModel({ session: mkSession({ checkpoint: 2 }), now: NOW + 200, agentFocus: 'x' }));
      expect(el.querySelector('.session-line')!.classList.contains('pulse')).toBe(false);
    });
  });
});

describe('change notes chip (spec 2026-10-16)', () => {
  const counts = (o: Partial<{ notes: number; byKind: Record<string, number>; staleReaders: number }> = {}) =>
    ({ notes: 1, byKind: { migration: 1 }, staleReaders: 1, ...o });

  it('counts notes, stale readers and unconfirmed migrations, and selects the next anchor', () => {
    const onSelectNote = vi.fn();
    renderSessionBlock(el, mkModel({ changeNotes: { counts: counts(), unconfirmed: 1 }, onSelectNote }));
    const chip = el.querySelector<HTMLButtonElement>('button.session-notes')!;
    expect(chip.textContent).toBe('1 migration · 1 reader not updated · 1 unconfirmed migration');
    chip.click();
    expect(onSelectNote).toHaveBeenCalledTimes(1);
    renderSessionBlock(el, mkModel({ changeNotes: { counts: counts({ notes: 2, byKind: { migration: 2 }, staleReaders: 0 }), unconfirmed: 0 } }));
    expect(el.querySelector('.session-notes')!.textContent).toBe('2 migrations');
  });

  it('no chip when every count is zero', () => {
    renderSessionBlock(el, mkModel({ changeNotes: { counts: counts({ notes: 0, byKind: {}, staleReaders: 0 }), unconfirmed: 0 } }));
    expect(el.querySelector('.session-notes')).toBeNull();
    renderSessionBlock(el, mkModel());
    expect(el.querySelector('.session-notes')).toBeNull();
  });
});

describe('threats chip', () => {
  it('shows the rail text and selects the next threat', () => {
    const onSelectThreat = vi.fn();
    renderSessionBlock(el, mkModel({ threats: '1 threat · auth-svc compromised', onSelectThreat }));
    const chip = el.querySelector<HTMLButtonElement>('button.session-threats')!;
    expect(chip.textContent).toBe('1 threat · auth-svc compromised');
    chip.click();
    expect(onSelectThreat).toHaveBeenCalledTimes(1);
  });

  it('is marked contained when every threat is', () => {
    renderSessionBlock(el, mkModel({ threats: '1 threat · 1 contained', threatsContained: true }));
    expect(el.querySelector('.session-threats')!.classList.contains('is-contained')).toBe(true);
    renderSessionBlock(el, mkModel({ threats: '2 threats · 1 contained', threatsContained: false }));
    expect(el.querySelector('.session-threats')!.classList.contains('is-contained')).toBe(false);
  });

  it('no rows, no chip (a visitor or a public board)', () => {
    renderSessionBlock(el, mkModel());
    expect(el.querySelector('.session-threats')).toBeNull();
    renderSessionBlock(el, mkModel({ threats: '' }));
    expect(el.querySelector('.session-threats')).toBeNull();
  });
});
