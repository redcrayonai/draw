import { describe, it, expect, beforeAll, vi } from 'vitest';
import { filterCommands } from './palette';

type Chrome = typeof import('./chrome');
let chrome: Chrome;

beforeAll(async () => {
  // chrome.ts dereferences these in its module body.
  document.body.innerHTML = `
    <div id="error-strip" hidden><span id="error-text"></span><button id="error-dismiss"></button></div>
    <button id="participants-label"><span id="participant-chips"></span></button>
    <div id="presence-pop" hidden></div>
    <aside id="inspector" hidden tabindex="0"></aside>`;
  chrome = await import('./chrome');
});

function board(dense: boolean): SVGSVGElement {
  const style = document.createElement('style');
  // the screen's density rules, as in style.css
  style.textContent = `
    #world.dense .node-sublabel { display: none; }
    #world.dense .node-refs { display: none; }
    .gone { visibility: hidden; }`;
  document.head.append(style);
  const host = document.createElement('div');
  host.innerHTML = `
    <svg id="board" xmlns="http://www.w3.org/2000/svg">
      <g id="world" class="${dense ? 'dense' : ''}">
        <g class="node" data-id="1">
          <rect class="node-rect" width="160" height="80"></rect>
          <text class="node-label">svc</text>
          <text class="node-sublabel">src/svc.ts</text>
          <g class="node-refs"><title>Limiter.allow</title><text class="node-refs-text">1 ref</text></g>
          <text class="gone">invisible</text>
        </g>
      </g>
      <g id="presence"></g>
    </svg>`;
  document.body.append(host);
  return host.querySelector('svg') as SVGSVGElement;
}

describe('exportSvg follows the screen (G29)', () => {
  it('marks proposal exports visibly as intent', () => {
    const svg = board(false);
    svg.dataset.assertionMode = 'intent';
    const out = new DOMParser().parseFromString(chrome.exportSvgMarkup(svg), 'image/svg+xml');
    expect(out.querySelector('[data-intent-label]')?.textContent).toBe('Intent proposal · planned architecture');
  });
  it('dense export contains no .node-refs or .node-sublabel', () => {
    const markup = chrome.exportSvgMarkup(board(true));
    expect(markup).not.toContain('node-refs');
    expect(markup).not.toContain('node-sublabel');
    expect(markup).not.toContain('invisible');
    expect(markup).toContain('node-label');
    expect(markup).not.toContain('id="presence"');
  });

  it('carries the theme\'s corners and box shadow into the file', () => {
    const svg = board(false);
    const rect = svg.querySelector<SVGRectElement>('.node-rect')!;
    rect.setAttribute('rx', '10');
    rect.setAttribute('ry', '10');
    const style = document.createElement('style');
    // what brutal does on screen: square the rect, cast a hard shadow
    style.textContent = `.node-rect { rx: 0px; ry: 0px; width: 200px; filter: drop-shadow(4px 4px 0 #000); }`;
    document.head.append(style);
    try {
      const out = new DOMParser().parseFromString(chrome.exportSvgMarkup(svg), 'image/svg+xml');
      const exported = out.querySelector('.node-rect')!;
      expect(exported.getAttribute('rx')).toBe('0');
      expect(exported.getAttribute('ry')).toBe('0');
      expect(exported.getAttribute('style')).toContain('filter:drop-shadow(4px 4px 0 #000)');
      expect(exported.getAttribute('width')).toBe('200');
    } finally {
      style.remove();
    }
  });

  it('exports a boundary\'s faint fill as fill-opacity, never color-mix() (Task 9)', async () => {
    const svg = board(false);
    const style = document.createElement('style');
    style.textContent = `.node-rect { fill: #000000; fill-opacity: 0.03; }`;
    document.head.append(style);
    try {
      const out = new DOMParser().parseFromString(chrome.exportSvgMarkup(svg), 'image/svg+xml');
      expect(out.querySelector('.node-rect')!.getAttribute('style')).toContain('fill-opacity:0.03');
    } finally {
      style.remove();
    }
    // Non-browser SVG readers drop color(srgb …), the computed form of color-mix().
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const rules = [...css.matchAll(/\n[^\n{}]*\.node-boundary \.node-rect \{[^}]*\}/g)].map(m => m[0]);
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const r of rules) {
      expect(r).not.toContain('color-mix');
      expect(r).toContain('fill-opacity: 0.03');
    }
  });

  it('drops chart hover chrome (.chart-hit, .chart-xhair) and keeps the marks', () => {
    const svg = board(false);
    const ns = 'http://www.w3.org/2000/svg';
    const plot = document.createElementNS(ns, 'g');
    plot.setAttribute('class', 'chart-plot');
    for (const [tag, cls] of [['rect', 'series-1'], ['rect', 'chart-hit'], ['line', 'chart-xhair']]) {
      const mark = document.createElementNS(ns, tag);
      mark.setAttribute('class', cls);
      mark.setAttribute('data-tip', '10:05\ncheckout 135');
      plot.append(mark);
    }
    svg.querySelector('[data-id="1"]')!.append(plot);
    const out = new DOMParser().parseFromString(chrome.exportSvgMarkup(svg), 'image/svg+xml');
    expect(out.querySelector('.chart-hit')).toBeNull();
    expect(out.querySelector('.chart-xhair')).toBeNull();
    expect(out.querySelector('.chart-plot > .series-1')).not.toBeNull();
  });

  it('never carries threat data: no marker, hop badge, blast dot or blast styling; live classes restored', () => {
    const svg = board(false);
    const style = document.createElement('style');
    style.textContent = `#world .node.blast-clear { opacity: 0.22; } #world .node.blast-src .node-rect { stroke: rgb(255, 0, 0); }`;
    document.head.append(style);
    try {
      const ns = 'http://www.w3.org/2000/svg';
      const world = svg.querySelector('#world')!;
      world.setAttribute('class', 'blast-on');
      const node = svg.querySelector('[data-id="1"]')!;
      node.setAttribute('class', 'node blast-src tc-lit');
      const clear = node.cloneNode(true) as Element;
      clear.setAttribute('class', 'node blast-clear');
      world.append(clear);
      for (const cls of ['board-marker tone-red', 'board-marker hop-badge tone-amber']) {
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', cls);
        g.innerHTML = '<title>Threat on svc: CVE-2026-1, critical, compromised</title>';
        node.append(g);
      }
      const comet = document.createElementNS(ns, 'g');
      comet.setAttribute('class', 'route-comet');
      comet.innerHTML = '<circle class="route-dot blast-dot"></circle>';
      world.append(comet);
      const markup = chrome.exportSvgMarkup(svg);
      expect(markup).not.toMatch(/blast-|board-marker|hop-badge|route-comet|tc-lit|CVE/);
      expect(markup).not.toContain('opacity:0.22');
      expect(markup).not.toContain('rgb(255, 0, 0)');
      expect(world.getAttribute('class')).toBe('blast-on');
      expect(node.getAttribute('class')).toBe('node blast-src tc-lit');
    } finally {
      style.remove();
    }
  });

  it('exports the settled board: no focus dimming or flow, live classes restored', () => {
    const svg = board(false);
    const style = document.createElement('style');
    style.textContent = `#world.focus-dim .node:not(.focus-near) { opacity: 0.22; }`;
    document.head.append(style);
    try {
      const world = svg.querySelector('#world')!;
      world.setAttribute('class', 'focus-dim focus-flow');
      const markup = chrome.exportSvgMarkup(svg);
      expect(markup).not.toContain('opacity:0.22');
      expect(markup).not.toMatch(/focus-dim|focus-flow|exporting/);
      expect(world.classList.contains('focus-dim')).toBe(true);
      expect(world.classList.contains('focus-flow')).toBe(true);
      expect(world.classList.contains('exporting')).toBe(false);
    } finally {
      style.remove();
    }
  });

  it("keeps a styled edge's colour, weight, dots and round caps in the file (RC-688)", () => {
    const svg = board(false);
    const style = document.createElement('style');
    // what a bold, dotted, blue edge computes to on screen
    style.textContent = `.edge-line.styled { stroke: rgb(37, 99, 235); stroke-width: 3px; stroke-dasharray: 0.5 7; stroke-linecap: round; stroke-linejoin: round; }`;
    document.head.append(style);
    try {
      const ns = 'http://www.w3.org/2000/svg';
      const line = document.createElementNS(ns, 'path');
      line.setAttribute('class', 'edge-line styled');
      line.setAttribute('d', 'M0 0 L100 0');
      svg.querySelector('#world')!.append(line);
      const out = new DOMParser().parseFromString(chrome.exportSvgMarkup(svg), 'image/svg+xml');
      const exported = out.querySelector('.edge-line')!.getAttribute('style')!;
      for (const decl of ['stroke:rgb(37, 99, 235)', 'stroke-width:3px', 'stroke-dasharray:0.5 7', 'stroke-linecap:round', 'stroke-linejoin:round']) {
        expect(exported).toContain(decl);
      }
    } finally {
      style.remove();
    }
  });

  it('a normal-zoom export keeps badges and sublabels', () => {
    const markup = chrome.exportSvgMarkup(board(false));
    expect(markup).toContain('node-refs-text');
    expect(markup).toContain('node-sublabel');
  });
});

describe('participant avatars (G47)', () => {
  const id = (hex: string) => ({ toHexString: () => hex });
  const person = (hex: string, kind: string, displayName: string) =>
    ({ identity: id(hex), displayName, kind, connections: 1, connectedAt: { toDate: () => new Date() } }) as never;

  it('the agent wears a drawn bot icon in a dashed outline, never a glyph', () => {
    chrome.renderParticipantChips([person('a', 'agent', 'redcrayon-agent'), person('h', 'human', 'human-c200ad')]);
    const [agent, human] = [...document.querySelectorAll('#participant-chips .p-chip')];
    expect(agent.classList.contains('agent')).toBe(true);
    expect(agent.textContent).toBe('');
    const svg = agent.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(svg.getAttribute('stroke-width')).toBe('1.3');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(human.textContent).toBe('H');
    chrome.renderPresencePop([person('a', 'agent', 'redcrayon-agent')], [], new Map());
    const avatar = document.querySelector('#presence-pop .pp-row.agent .pp-avatar')!;
    expect(avatar.textContent).toBe('');
    expect(avatar.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16');
    // P14: the legend describes the avatars as drawn since G47.
    expect(document.querySelector('#presence-pop .pp-note')!.textContent).toBe('Initial: human. Bot icon, dashed ring: agent.');
  });

  it('a hosted agent (no socket) reads active now, selecting <node>, or idle, and never joined … ago (D17)', () => {
    const now = Date.UTC(2026, 9, 10, 12);
    const hosted = (ageMs: number) =>
      ({ identity: id('a'), displayName: 'agent of Alan Lee', kind: 'agent', connections: 0, connectedAt: { toDate: () => new Date(0) }, lastSeenAt: { toDate: () => new Date(now - ageMs) } }) as never;
    const node = { id: 4n, label: 'limiter', sublabel: '' } as never;
    const chip = () => document.querySelector('#participant-chips .p-chip')!;
    const status = () => document.querySelector('#presence-pop .pp-status')!.textContent;

    chrome.renderParticipantChips([hosted(30_000)], now);
    expect(chip().getAttribute('role')).toBe('img');
    expect(chip().getAttribute('aria-label')).toBe('agent of Alan Lee, active now');
    expect(chip().querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(chip().classList.contains('idle')).toBe(false);
    chrome.renderPresencePop([hosted(30_000)], [], new Map(), now);
    expect(status()).toBe('active now');
    chrome.renderPresencePop([hosted(30_000)], [{ identity: id('a'), boardId: 1n, nodeIds: [4n] } as never], new Map([[4n, node]]), now);
    expect(status()).toBe('selecting limiter');

    chrome.renderParticipantChips([hosted(12 * 60_000)], now);
    expect(chip().classList.contains('idle')).toBe(true);
    expect(chip().getAttribute('aria-label')).toBe('agent of Alan Lee, idle · active 12m ago');
    chrome.renderPresencePop([hosted(12 * 60_000)], [{ identity: id('a'), boardId: 1n, nodeIds: [4n] } as never], new Map([[4n, node]]), now);
    expect(status()).toBe('idle · active 12m ago');
    expect(document.querySelector('#presence-pop .pp-row.agent.idle')).not.toBeNull();
    expect(document.getElementById('presence-pop')!.textContent).not.toMatch(/joined/);
  });
});

describe('account menu', () => {
  it('opens from the name, signs out from inside, and closes on Escape', () => {
    const actions = document.createElement('div');
    actions.className = 'header-actions';
    document.body.append(actions);
    const signOut = vi.fn();
    chrome.initAccountBar('Ada', signOut);
    const name = document.getElementById('account-name') as HTMLButtonElement;
    const pop = document.getElementById('account-pop')!;
    expect(name.textContent).toBe('Ada');
    expect(pop.hidden).toBe(true);

    // a real press: pointerdown on the name must not close what the click opens
    name.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    name.click();
    expect(pop.hidden).toBe(false);
    expect(name.getAttribute('aria-expanded')).toBe('true');
    const item = pop.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(document.activeElement).toBe(item);
    item.click();
    expect(signOut).toHaveBeenCalledOnce();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(pop.hidden).toBe(true);
    expect(name.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(name);
    actions.remove();
  });
});

describe('presence popover dismissal', () => {
  const label = () => document.getElementById('participants-label') as HTMLButtonElement;
  const pop = () => document.getElementById('presence-pop') as HTMLDivElement;
  const open = () => {
    if (pop().hidden) {
      label().click();
    }
    expect(pop().hidden).toBe(false);
  };

  it('toggles from its button and reports aria-expanded', () => {
    open();
    expect(label().getAttribute('aria-expanded')).toBe('true');
    label().click();
    expect(pop().hidden).toBe(true);
    expect(label().getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape closes it, returns focus to the button, and goes no further', () => {
    open();
    const later = vi.fn();
    window.addEventListener('keydown', later);
    try {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } finally {
      window.removeEventListener('keydown', later);
    }
    expect(pop().hidden).toBe(true);
    expect(label().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(label());
    // the canvas's Escape (clear selection, disarm) waits for the next press
    expect(later).not.toHaveBeenCalled();
  });

  it('Escape with the popover closed passes through untouched', () => {
    expect(pop().hidden).toBe(true);
    const later = vi.fn();
    window.addEventListener('keydown', later);
    try {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } finally {
      window.removeEventListener('keydown', later);
    }
    expect(later).toHaveBeenCalledOnce();
  });

  it('Escape in a text field stays with the field (cancel an edit) and leaves the popover open', () => {
    open();
    const input = document.createElement('input');
    document.body.append(input);
    const own = vi.fn();
    input.addEventListener('keydown', own);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.remove();
    expect(own).toHaveBeenCalledOnce();
    expect(pop().hidden).toBe(false);
    label().click();
  });

  it('a pointerdown outside closes it; one inside it or on its button does not', () => {
    open();
    pop().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pop().hidden).toBe(false);
    label().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pop().hidden).toBe(false);
    document.getElementById('inspector')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pop().hidden).toBe(true);
    expect(label().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('evidence legend placement (P2)', () => {
  function shell() {
    const wrap = document.createElement('main');
    wrap.innerHTML = `
      <aside id="rail">
        <div class="eyebrow">BOARD</div>
        <button id="overlay-row"></button>
        <button id="code-overlay-row"></button>
      </aside>
      <div id="legend" hidden></div>`;
    document.body.append(wrap);
    return {
      wrap,
      rail: wrap.querySelector<HTMLElement>('#rail')!,
      legend: wrap.querySelector<HTMLElement>('#legend')!,
    };
  }

  it('sits under the evidence switch while the rail is open, floats while it is collapsed', () => {
    const { wrap, rail, legend } = shell();
    chrome.placeLegend(legend, rail, wrap);
    expect(legend.parentElement).toBe(rail);
    expect(legend.previousElementSibling?.id).toBe('overlay-row');
    expect(legend.classList.contains('in-rail')).toBe(true);

    // identical state: nothing moves
    const recs: MutationRecord[] = [];
    const mo = new MutationObserver(r => recs.push(...r));
    mo.observe(wrap, { subtree: true, childList: true, attributes: true });
    chrome.placeLegend(legend, rail, wrap);
    recs.push(...mo.takeRecords());
    mo.disconnect();
    expect(recs).toHaveLength(0);

    rail.classList.add('collapsed');
    chrome.placeLegend(legend, rail, wrap);
    expect(legend.parentElement).toBe(wrap);
    expect(legend.classList.contains('in-rail')).toBe(false);
  });
});

describe('legend summary (P2)', () => {
  it('wraps between figures only: each figure and its separator never split', () => {
    const el = document.createElement('div');
    chrome.renderLegendSummary(el, ['8 shown edges', '8 proven', '0 none']);
    expect(el.textContent).toBe('8 shown edges · 8 proven · 0 none');
    expect([...el.querySelectorAll('.legend-part')].map(s => s.textContent)).toEqual(['8 shown edges ·', '8 proven ·', '0 none']);
    // unchanged figures: nothing written
    const recs: MutationRecord[] = [];
    const mo = new MutationObserver(r => recs.push(...r));
    mo.observe(el, { subtree: true, childList: true, characterData: true });
    chrome.renderLegendSummary(el, ['8 shown edges', '8 proven', '0 none']);
    recs.push(...mo.takeRecords());
    mo.disconnect();
    expect(recs).toHaveLength(0);
  });
});

describe('theme: dark, light, neo-brutalism', () => {
  it('setTheme applies, persists and announces the theme', () => {
    const heard = vi.fn();
    window.addEventListener('redcrayon:theme', heard);
    chrome.setTheme('brutal');
    window.removeEventListener('redcrayon:theme', heard);
    expect(document.documentElement.dataset.theme).toBe('brutal');
    expect(localStorage.getItem('redcrayon-theme')).toBe('brutal');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('setTheme still applies the theme when storage throws', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    try {
      chrome.setTheme('light');
      expect(document.documentElement.dataset.theme).toBe('light');
    } finally {
      set.mockRestore();
    }
  });

  it('currentTheme reads data-theme and falls back to dark for anything else', () => {
    document.documentElement.dataset.theme = 'brutal';
    expect(chrome.currentTheme()).toBe('brutal');
    document.documentElement.dataset.theme = 'sepia';
    expect(chrome.currentTheme()).toBe('dark');
  });

  it('codeTheme gives neo-brutalism the light code palette (its paper is light)', () => {
    expect(chrome.codeTheme('brutal')).toBe('light');
    expect(chrome.codeTheme('light')).toBe('light');
    expect(chrome.codeTheme('dark')).toBe('dark');
  });

  it('codeTheme gives every editor theme its own code palette', () => {
    expect(chrome.codeTheme('nord')).toBe('nord');
    expect(chrome.codeTheme('one-light')).toBe('one-light');
  });

  it('currentTheme accepts every theme in the registry', () => {
    for (const t of chrome.THEMES) {
      document.documentElement.dataset.theme = t.id;
      expect(chrome.currentTheme()).toBe(t.id);
    }
  });
});

describe('⌘K theme commands', () => {
  it('offers one command per theme and marks the current one', () => {
    document.documentElement.dataset.theme = 'light';
    const cmds = chrome.themeCommands();
    expect(cmds.map(c => [c.id, c.title])).toEqual(chrome.THEMES.map(t => [`theme-${t.id}`, `Theme: ${t.name}`]));
    expect(cmds.slice(0, 4).map(c => [c.title, c.checked])).toEqual([
      ['Theme: Dark', false],
      ['Theme: Light', true],
      ['Theme: Neo-brutalism', false],
      ['Theme: Catppuccin Mocha', false],
    ]);
    expect(cmds.filter(c => c.checked)).toHaveLength(1);
    expect(cmds.some(c => c.undoable)).toBe(false); // ⌘Z cannot revert a theme switch
  });

  it('running a theme command applies that theme', () => {
    document.documentElement.dataset.theme = 'dark';
    void chrome.themeCommands().find(c => c.id === 'theme-brutal')!.run();
    expect(document.documentElement.dataset.theme).toBe('brutal');
    expect(localStorage.getItem('redcrayon-theme')).toBe('brutal');
  });

  it('still answers to the old toggle wording', () => {
    for (const c of chrome.themeCommands()) expect(c.keywords).toContain('toggle');
  });

  it.each(['dark', 'light'] as const)("'theme %s' and '%s' find exactly the %s themes", scheme => {
    const want = chrome.THEMES.filter(t => t.scheme === scheme).map(t => `theme-${t.id}`).sort();
    for (const query of [`theme ${scheme}`, scheme]) {
      expect(filterCommands(chrome.themeCommands(), query).map(c => c.id).sort(), query).toEqual(want);
    }
  });
});

describe('theme picker', () => {
  const btn = () => document.getElementById('act-theme') as HTMLButtonElement;
  const pop = () => document.getElementById('theme-pop') as HTMLDivElement;
  const opt = (t: string) => pop().querySelector<HTMLButtonElement>(`[data-theme-opt="${t}"]`)!;

  beforeAll(() => {
    const bar = document.createElement('header');
    bar.innerHTML = `
      <button id="act-theme" aria-expanded="false" aria-controls="theme-pop"></button>
      <div id="theme-pop" hidden></div>`;
    document.body.append(bar);
    document.documentElement.dataset.theme = 'dark';
    chrome.setupTheme();
  });

  it('lists every theme, grouped, each with a chip in its own tokens', () => {
    const groups = [...pop().querySelectorAll<HTMLElement>('.theme-group')];
    expect(groups.map(g => g.querySelector('.eyebrow')!.textContent)).toEqual(['redcrayon', 'Dark', 'Light']);
    for (const g of groups) {
      expect(g.getAttribute('role')).toBe('group');
      expect(document.getElementById(g.getAttribute('aria-labelledby')!)).toBe(g.querySelector('.eyebrow'));
    }
    const opts = [...pop().querySelectorAll<HTMLButtonElement>('[data-theme-opt]')];
    // the button's name is the theme's, as ⌘K names it; the chip is decoration
    expect(opts.map(o => [o.dataset.themeOpt, o.textContent])).toEqual(chrome.THEMES.map(t => [t.id, t.name]));
    for (const o of opts) {
      const chip = o.querySelector<HTMLElement>('.theme-swatch')!;
      expect(chip.dataset.swatch).toBe(o.dataset.themeOpt);
      expect(chip.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('opens from its button and marks the theme showing', () => {
    btn().click();
    expect(pop().hidden).toBe(false);
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(['dark', 'light', 'brutal', 'nord'].map(t => opt(t).getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false']);
    btn().click();
    expect(pop().hidden).toBe(true);
  });

  it('choosing an option applies it, closes the picker and returns focus', () => {
    btn().click();
    opt('brutal').click();
    expect(document.documentElement.dataset.theme).toBe('brutal');
    expect(opt('brutal').getAttribute('aria-pressed')).toBe('true');
    expect(opt('dark').getAttribute('aria-pressed')).toBe('false');
    expect(pop().hidden).toBe(true);
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn());
  });

  it('follows a theme set elsewhere (⌘K)', () => {
    chrome.setTheme('light');
    expect(opt('light').getAttribute('aria-pressed')).toBe('true');
    expect(btn().title).toBe('Theme: Light');
    chrome.setTheme('one-dark');
    expect(opt('one-dark').getAttribute('aria-pressed')).toBe('true');
    expect(opt('light').getAttribute('aria-pressed')).toBe('false');
    expect(btn().title).toBe('Theme: One Dark');
  });

  it('Escape closes it, returns focus, and goes no further', () => {
    btn().click();
    const later = vi.fn();
    window.addEventListener('keydown', later);
    try {
      opt('dark').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } finally {
      window.removeEventListener('keydown', later);
    }
    expect(pop().hidden).toBe(true);
    expect(document.activeElement).toBe(btn());
    expect(later).not.toHaveBeenCalled();
  });

  it('Escape in a text field (the ⌘K palette) stays with the field and leaves the picker open', () => {
    btn().click();
    const input = document.createElement('input');
    document.body.append(input);
    const own = vi.fn();
    input.addEventListener('keydown', own);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.remove();
    expect(own).toHaveBeenCalledOnce();
    expect(pop().hidden).toBe(false);
    btn().click();
  });

  it('closes when keyboard focus leaves it and its button', () => {
    btn().click();
    opt('light').focus();
    expect(pop().hidden).toBe(false);
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    elsewhere.remove();
    expect(pop().hidden).toBe(true);
  });

  it('a pointerdown outside closes it; one inside does not', () => {
    btn().click();
    opt('dark').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pop().hidden).toBe(false);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pop().hidden).toBe(true);
  });
});

describe('link back to the dashboard (RC-542)', () => {
  it('builds the board-list URL and forwards any non-default database', () => {
    expect(chrome.dashboardHref('https://dash.example', 'redcrayon')).toBe(
      'https://dash.example/dashboard'
    );
    // a trailing slash or a pasted page path still lands on the board list
    expect(chrome.dashboardHref('https://dash.example/', 'rc-dev')).toBe('https://dash.example/dashboard?db=rc-dev');
    expect(chrome.dashboardHref('http://localhost:5174/settings?x=1', 'a b')).toBe(
      'http://localhost:5174/dashboard?db=a+b'
    );
  });

  it('gives no link when the URL is unset or malformed', () => {
    expect(chrome.dashboardHref(undefined, 'redcrayon')).toBeUndefined();
    expect(chrome.dashboardHref('', 'redcrayon')).toBeUndefined();
    expect(chrome.dashboardHref('dash.example', 'redcrayon')).toBeUndefined();
  });

  const crumb = () => document.getElementById('crumb-boards') as HTMLAnchorElement;
  const mount = () => {
    document.getElementById('crumb-boards')?.remove();
    const a = document.createElement('a');
    a.id = 'crumb-boards';
    a.textContent = 'Boards';
    document.body.append(a);
  };

  it('stays plain text without a URL', () => {
    mount();
    chrome.initBoardsLink(undefined, true);
    expect(crumb().hasAttribute('href')).toBe(false);
  });

  it('links signed-in users without a caveat', () => {
    mount();
    chrome.initBoardsLink('https://dash.example/dashboard?db=redcrayon', true);
    expect(crumb().getAttribute('href')).toBe('https://dash.example/dashboard?db=redcrayon');
    expect(crumb().title).toBe('Back to boards');
  });

  it('gives guests no link and no separator (RC-570)', () => {
    mount();
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    crumb().after(sep);
    chrome.initBoardsLink('https://dash.example/dashboard?db=redcrayon', false);
    expect(crumb().hidden).toBe(true);
    expect(crumb().hasAttribute('href')).toBe(false);
    expect(sep.hidden).toBe(true);
    sep.remove();
  });

  it('tolerates a missing crumb element', () => {
    document.getElementById('crumb-boards')?.remove();
    expect(() => chrome.initBoardsLink('https://dash.example/dashboard?db=x', true)).not.toThrow();
  });
});

describe('board unavailable recovery', () => {
  it('retains navigation and offers only the supplied recovery destinations', () => {
    const header = document.createElement('header');
    header.innerHTML = '<h1 id="board-title">Old board</h1>';
    const wrap = document.createElement('main');
    wrap.id = 'canvas-wrap';
    wrap.setAttribute('inert', '');
    wrap.setAttribute('aria-busy', 'true');
    wrap.innerHTML = '<svg id="board"></svg>';
    const loading = document.createElement('div');
    loading.id = 'board-loading';
    document.body.append(header, wrap, loading);
    try {
      chrome.showBoardUnavailable('https://dash.example/dashboard?db=demo', 'https://canvas.example/?new=1&db=demo');
      expect(loading.hidden).toBe(true);
      expect(wrap.hasAttribute('inert')).toBe(false);
      expect(wrap.getAttribute('aria-busy')).toBe('false');
      expect(header.isConnected).toBe(true);
      const panel = document.getElementById('board-unavailable')!;
      expect(panel.textContent).toContain('This board is unavailable');
      expect([...panel.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')])).toEqual([
        ['Back to boards', 'https://dash.example/dashboard?db=demo'],
        ['Start a new board', 'https://canvas.example/?new=1&db=demo'],
      ]);
      expect(panel.textContent).not.toMatch(/Old board|available boards|boardId/i);
      expect(document.body.classList.contains('board-unavailable')).toBe(true);
      expect(document.activeElement).toBe(panel);
    } finally {
      header.remove();
      wrap.remove();
      loading.remove();
      document.body.classList.remove('board-unavailable');
    }
  });

  it('still offers a new board without a configured dashboard', () => {
    chrome.showBoardUnavailable(undefined, '/?new=1&db=demo');
    const panel = document.getElementById('board-unavailable')!;
    expect([...panel.querySelectorAll('a')].map(a => a.textContent)).toEqual(['Start a new board']);
    panel.remove();
    document.body.classList.remove('board-unavailable');
  });
});

describe('connection recovery', () => {
  it('dismisses loading and releases the canvas so retry feedback is reachable', () => {
    const fixture = document.createElement('div');
    fixture.innerHTML = '<main id="canvas-wrap" aria-busy="true" inert></main><div id="board-loading">Loading board…</div>';
    document.body.append(fixture);
    const wrap = fixture.querySelector('#canvas-wrap')!;
    const loading = fixture.querySelector<HTMLElement>('#board-loading')!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      chrome.showReconnect('connection closed', 2000);
      expect(loading.hidden).toBe(true);
      expect(wrap.hasAttribute('inert')).toBe(false);
      expect(wrap.getAttribute('aria-busy')).toBe('false');
      const panel = document.getElementById('reconnect')!;
      expect(panel.getAttribute('role')).toBe('status');
      expect(panel.textContent).toContain('Retrying in 2s');
      expect(panel.querySelector('button')!.textContent).toBe('Retry now');
    } finally {
      fixture.remove();
      document.getElementById('reconnect')?.remove();
      warn.mockRestore();
    }
  });
});

describe('save feedback', () => {
  it('reports reducer progress separately from connection status', () => {
    const status = document.createElement('span');
    status.id = 'save-status';
    status.hidden = true;
    const live = document.createElement('div');
    live.id = 'live';
    live.innerHTML = '<span class="live-dot"></span>Live';
    document.body.append(status, live);
    try {
      chrome.setSaveStatus('pending');
      expect(status.hidden).toBe(false);
      expect(status.textContent).toBe('Saving…');
      expect(status.dataset.state).toBe('pending');
      chrome.setLive(true);
      expect(status.textContent).toBe('Saving…');
      chrome.setSaveStatus('saved');
      expect(status.textContent).toBe('Saved');
      chrome.setSaveStatus('error', 'Changes could not be saved. Try again.');
      expect(status.textContent).toBe('Save failed');
      expect(status.title).toBe('Changes could not be saved. Try again.');
      chrome.setLive(true);
      expect(status.textContent).toBe('Save failed');
    } finally {
      status.remove();
      live.remove();
    }
  });
});

describe('showNotice', () => {
  it('shows a success line in the strip and says it in the polite status region, then hides it', () => {
    vi.useFakeTimers();
    try {
      chrome.showNotice('Saved "API" to your library');
      const strip = document.getElementById('error-strip')!;
      expect(strip.hidden).toBe(false);
      expect(document.getElementById('error-text')!.textContent).toBe('Saved "API" to your library');
      const region = document.getElementById('copy-status')!;
      expect([region.getAttribute('role'), region.getAttribute('aria-live')]).toEqual(['status', 'polite']);
      expect(region.textContent).toBe('Saved "API" to your library');
      vi.advanceTimersByTime(chrome.NOTICE_MS);
      expect(strip.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('main.ts announces a library save once the server accepts it', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, encoding: 'utf8'): string };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const main = readFileSync(`${cwd}/src/main.ts`, 'utf8');
    expect(main).toMatch(/saveLibraryItem\(\{ name, payload \}\)\s*\.then\(\(\) => showNotice\(`Saved "\$\{name\.trim\(\)\}" to your library`\)\)\s*\.catch\(report\)/);
  });
});

describe('showBoardUnavailable', () => {
  it('says why when a share link was turned off', () => {
    chrome.showBoardUnavailable(undefined, 'http://x/?new=1', chrome.LINK_GONE);
    expect(document.getElementById('board-unavailable')?.textContent).toContain('This link is no longer shared. Ask the owner for a new link.');
    chrome.showBoardUnavailable(undefined, 'http://x/?new=1');
    expect(document.getElementById('board-unavailable')?.textContent).toContain('It may have been removed, or this link may need a different account.');
  });
});

describe('exportSvg keeps library icons (spec 2026-10-18)', () => {
  it('writes each icon into the file with its name, and only the logo file the theme shows', async () => {
    const { renderBoard } = await import('./render');
    await (await import('./node-icons')).loadLogos();
    const host = document.createElement('div');
    host.innerHTML = '<svg id="board" xmlns="http://www.w3.org/2000/svg"><g id="world"></g><g id="presence"></g></svg>';
    document.body.append(host);
    const svg = host.querySelector('svg') as SVGSVGElement;
    const world = svg.querySelector('#world') as SVGGElement;
    const node = (id: number, label: string) => ({
      id: BigInt(id), boardId: 1n, label, sublabel: '', x: id * 200, y: 0, w: 160, h: 96, token: 'ink', focal: false,
      kind: 'service', doc: '', hidden: false, imported: false, shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '',
    });
    renderBoard(world, [node(1, 'Lead'), node(2, 'Cloud')], [], {
      selection: new Set(), selectedEdges: new Set(), overrides: new Map(), handles: new Set(), edgeTarget: null,
      ghosts: new Set(), ghostEdges: new Set(), ghostSetNames: new Map(), overlay: false, codeOverlay: false,
      refsByNode: new Map(), scale: 1, icons: new Map([[1n, 'orchestrator'], [2n, 'aws']]),
    });
    // a dark theme, as style.css applies it
    const style = document.createElement('style');
    style.textContent = '.logo-on-light { display: none; } .node-icon-stroke { color: rgb(236, 236, 238); }';
    document.head.append(style);
    try {
      const out = new DOMParser().parseFromString(chrome.exportSvgMarkup(svg), 'image/svg+xml');
      const slots = [...out.querySelectorAll('.node-icon-slot')];
      expect(slots.map(s => s.querySelector('title')?.textContent)).toEqual(['Orchestrator', 'AWS Cloud']);
      expect(slots[0].querySelector('path')?.getAttribute('d')).toMatch(/^M5\.5 1\.5h5/);
      // the drawing's own paint attributes travel with it (a browser also inlines the
      // computed colour; jsdom does not resolve presentation attributes)
      const paint = slots[0].querySelector('.node-icon-stroke > g')!;
      expect([paint.getAttribute('stroke'), paint.getAttribute('stroke-width'), paint.getAttribute('fill')]).toEqual(['currentColor', '1.3', 'none']);
      expect(slots[0].getAttribute('role')).toBe('img');
      expect(out.querySelectorAll('.logo-on-light')).toHaveLength(0);
      expect(out.querySelectorAll('.logo-on-dark')).toHaveLength(1);
    } finally {
      style.remove();
      host.remove();
    }
  });
});
