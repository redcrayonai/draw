import { describe, it, expect } from 'vitest';
// ?raw keeps this dependency-free: the project ships no @types/node, and
// `tsc --noEmit` is part of the build gate.
import html from '../index.html?raw';
import { THEMES } from '../../shared/themes';

/**
 * index.html is a hand-authored contract, not just markup: chrome.ts wires
 * controls in its MODULE BODY (so a missing element throws at import time and
 * white-screens the app before the error strip can report it), and the Editor
 * constructor dereferences its control ids unconditionally.
 *
 * These tests lock that contract so a future re-layout cannot silently drop an
 * element the TypeScript depends on.
 */

function parse(): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Dereferenced while chrome.ts / interactions.ts are still initialising. */
const BOOT_CRITICAL = [
  'error-strip',
  'error-text',
  'error-dismiss',
  'participants-label',
  'participant-chips',
  'presence-pop',
  'overlay-row',
  'code-overlay-row',
  'rail-hint',
  'toolbar',
  'tb-kind',
  'tb-token',
  'tb-focal',
  'tb-delete',
  'hud-zoom',
  'hud-zoom-in',
  'hud-zoom-out',
  'hud-fit',
  'shortcuts',
  'rail',
  'rail-toggle',
  'act-theme',
];

/** Dereferenced unconditionally inside the per-frame render path. */
const RENDER_CRITICAL = [
  'board',
  'world',
  'canvas-wrap',
  'board-title',
  'board-counts',
  'exposure-chip',
  'chips-row',
  'legend',
  'legend-summary',
  'empty-state',
  'inspector',
  'session-row',
];

const OTHER_REQUIRED = [
  'act-export',
  'act-rescan',
  'act-review', // the red crayon's history button; Send drifts the circles into it
  'tool-crayon',
  'mark-send',
  'review-badge',
  'review-pop',
  'mark-banner', // agent state for the latest round (spec 2026-10-19 D6)
  'preview-tag', // hosted builds (VITE_PREVIEW) unhide it at boot
  'auth-gate',
  'auth-card',
  'empty-place',
  'copy-status',
  'crumb-boards', // the only in-page way back to the dashboard (RC-542)
  'save-status',
];

/** CommandPalette grabs these in its constructor. */
const PALETTE_REQUIRED = [
  'palette',
  'palette-panel',
  'palette-input',
  'palette-list',
  'palette-ctx',
  'palette-preview',
];

/** setupConnect fills these (hosted MCP §12); without one the dialog stays inert. */
/** setupShare (called after boot) dereferences these for the owner's Share popover. */
const SHARE_REQUIRED = ['act-share', 'share-pop', 'share-on', 'share-detail', 'share-url', 'share-copy', 'share-hint', 'share-error'];

const CONNECT_REQUIRED = [
  'connect',
  'connect-panel',
  'connect-title',
  'connect-lead',
  'connect-tabs',
  'connect-panes',
  'connect-live',
  'connect-live-text',
  'connect-foot',
  'act-connect',
  'empty-connect',
  'empty-agent',
];

describe('index.html DOM contract', () => {
  const doc = parse();

  it('keeps Share hidden for non-owners: no rule of its own sets display, so the header [hidden] rule wins', async () => {
    // vitest's ?raw on a .css file yields '' (CSS is stubbed), so read it like the dialog test below.
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    expect(css).toMatch(/\.header-actions \[hidden\]\s*\{\s*display: none;/);
    expect(css).not.toMatch(/#act-share(?![\w-])[^{}/]*\{[^}]*display:/); // [^/]: not across a comment
  });

  it.each(SHARE_REQUIRED)('keeps #%s for the Share popover', id => {
    expect(doc.getElementById(id)).not.toBeNull();
  });

  it.each(CONNECT_REQUIRED)('keeps #%s for the Connect an agent dialog', id => {
    expect(doc.getElementById(id)).not.toBeNull();
  });

  it('ships the Connect an agent dialog closed, modal and labelled, its tabs and steps built at boot', () => {
    expect(doc.getElementById('connect')?.hasAttribute('hidden')).toBe(true);
    const panel = doc.getElementById('connect-panel')!;
    expect(panel.parentElement?.id).toBe('connect');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-labelledby')).toBe('connect-title');
    expect(panel.getAttribute('aria-describedby')).toBe('connect-lead');
    expect(doc.getElementById('connect-title')?.textContent).toBe('Connect an agent');
    // the head stays put while the body scrolls: close is always reachable
    expect(panel.querySelector(':scope > .connect-head #connect-title')).not.toBeNull();
    expect(panel.querySelector(':scope > .connect-head button[data-act="close"]')).not.toBeNull();
    expect(panel.querySelector(':scope > .connect-body #connect-tabs')).not.toBeNull();
    // the close control is a drawn icon, not a × glyph
    const close = panel.querySelector('button[aria-label="Close"]')!;
    expect(close.textContent?.trim()).toBe('');
    expect([close.querySelector('svg')?.getAttribute('viewBox'), close.querySelector('svg')?.getAttribute('aria-hidden')]).toEqual(['0 0 16 16', 'true']);
    const tabs = doc.getElementById('connect-tabs')!;
    expect(tabs.getAttribute('role')).toBe('tablist');
    expect(tabs.getAttribute('aria-label')).toBe('Agent');
    expect(tabs.classList.contains('tb-seg')).toBe(true);
    // copy is built from shared/connect-guide.ts, never hand-written here
    expect(tabs.children).toHaveLength(0);
    expect(doc.getElementById('connect-panes')?.children).toHaveLength(0);
    expect(doc.getElementById('connect-foot')?.children).toHaveLength(0);
    const live = doc.getElementById('connect-live')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.querySelector('.live-dot')?.getAttribute('aria-hidden')).toBe('true');
    // no <textarea>: a top-bar popover's Escape skips text fields
    expect(panel.querySelector('textarea, input')).toBeNull();
  });

  it('puts Connect, Share and Embed before Export, secondary, hidden until boot', () => {
    const btn = doc.getElementById('act-connect')!;
    expect(btn.previousElementSibling?.id).toBe('act-rescan');
    expect(btn.nextElementSibling?.id).toBe('act-share');
    expect(btn.nextElementSibling?.nextElementSibling?.id).toBe('act-embed');
    expect(doc.getElementById('embed-pop')?.nextElementSibling?.id).toBe('act-export');
    // without VITE_MCP_URL it never shows; with one, setupConnect reveals it
    expect(btn.hasAttribute('hidden')).toBe(true);
    expect(btn.classList.contains('btn-primary')).toBe(false);
    // Share and Export are the filled buttons; share.ts shows one at a time (owners export from the popover)
    expect([...doc.querySelectorAll('.header-actions > .btn-primary')].map(b => b.id)).toEqual(['act-share', 'act-export']);
    expect(doc.querySelector('#share-pop #share-export')?.textContent).toBe('Export SVG');
    expect(btn.querySelector('.act-label')?.textContent).toBe('Connect an agent');
    // the label collapses to the icon at laptop widths; the name stays
    expect(btn.getAttribute('aria-label')).toBe('Connect an agent');
    expect(btn.getAttribute('title')).toBe('Connect a coding agent');
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
    expect(btn.getAttribute('aria-controls')).toBe('connect-panel');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    const svg = btn.querySelector('svg')!;
    expect([svg.getAttribute('viewBox'), svg.getAttribute('width'), svg.getAttribute('aria-hidden')]).toEqual(['0 0 16 16', '16', 'true']);
  });

  it('offers connect an agent on an empty board only, and names a present agent on any empty board', () => {
    const link = doc.getElementById('empty-connect')!;
    expect(link.textContent).toBe('connect an agent');
    expect(link.getAttribute('data-mode-only')).toBe('board');
    expect(link.parentElement?.classList.contains('empty-actions')).toBe(true);
    const agent = doc.getElementById('empty-agent')!;
    expect(agent.getAttribute('data-mode-only')).toBe('agent');
    expect(agent.hasAttribute('hidden')).toBe(true);
    expect(agent.classList.contains('empty-title')).toBe(true);
    // the thinking orb (#40) stays with whichever agent state is showing
    expect(doc.getElementById('empty-orb')?.getAttribute('data-mode-only')).toBe('session agent');
  });

  it('keeps the dialog tab row its height, its focus ring inside the segment, and its motion optional', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    // .tb-seg's overflow: hidden lets a scrolling flex column squash the row to its border
    expect(css).toMatch(/\n\.connect-tabs \{[^}]*flex: none;/);
    expect(css).toMatch(/\n\.tb-seg\.connect-tabs \{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/\n\.tb-seg button:focus-visible \{\s*outline-offset: -2px;\s*\}/);
    // the panel scrolls inside itself under a fixed head
    expect(css).toMatch(/\n\.connect-head \{\s*flex: none;/);
    expect(css).toMatch(/\n\.connect-body \{[^}]*min-height: 0;\s*overflow-y: auto;/);
    // reduced motion: no settle-in transition, no live-dot pulse
    const motion = [...css.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n');
    expect(motion).toMatch(/#connect-panel \{\s*transition:/);
    expect(motion).toMatch(/\.connect-live\.on \.live-dot \{\s*animation:/);
    expect(css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, '')).not.toMatch(/animation: connect-live|#connect-panel \{[^}]*transition/);
    // phones: icon above label in five cells
    const phone = css.slice(css.indexOf('\n@media (max-width: 540px) {'));
    expect(phone).toMatch(/\.tb-seg\.connect-tabs \[role='tab'\] \{[^}]*flex-direction: column;/);
    expect(css).toMatch(/:root\[data-theme='brutal'\] :is\([^)]*#connect-panel, #act-connect, #act-share, #share-pop, #empty-connect\) \{\s*border-width: 2px;/);
  });

  it.each(BOOT_CRITICAL)('keeps #%s (dereferenced during boot)', id => {
    expect(doc.getElementById(id), `#${id} missing — app would throw on import`).not.toBeNull();
  });

  it.each(RENDER_CRITICAL)('keeps #%s (dereferenced every render)', id => {
    expect(doc.getElementById(id), `#${id} missing — rerender() would throw`).not.toBeNull();
  });

  it.each(OTHER_REQUIRED)('keeps #%s', id => {
    expect(doc.getElementById(id)).not.toBeNull();
  });

  it('makes the breadcrumb root a real link with text (RC-542)', () => {
    const crumb = doc.getElementById('crumb-boards');
    expect(crumb?.tagName).toBe('A');
    expect(crumb?.textContent?.trim()).toBe('Boards');
  });

  it('exposes exactly the six node kinds as .add-row[data-kind]', () => {
    const kinds = [...doc.querySelectorAll('.add-row')].map(el =>
      el.getAttribute('data-kind')
    );
    expect(kinds).toEqual(['service', 'datastore', 'external', 'boundary', 'note', 'text']);
  });

  it('keeps #board inside #canvas-wrap, which worldToScreen() assumes', () => {
    // viewport.worldToScreen() returns SVG-local pixels, so every surface it
    // positions (#toolbar, #dim-badge, #inline-edit) must share #canvas-wrap as
    // its offset parent and #board must fill that box exactly.
    const wrap = doc.getElementById('canvas-wrap');
    expect(wrap?.querySelector('#board')).not.toBeNull();
    for (const id of ['toolbar', 'dim-badge']) {
      expect(wrap?.querySelector(`#${id}`), `#${id} must live in #canvas-wrap`).not.toBeNull();
    }
  });

  it.each(PALETTE_REQUIRED)('keeps #%s for the ⌘K palette', id => {
    expect(doc.getElementById(id)).not.toBeNull();
  });

  it('ships both canvas-navigation tools in the dock', () => {
    expect(doc.getElementById('tool-select')).not.toBeNull();
    expect(doc.getElementById('tool-hand')).not.toBeNull();
  });

  it('keeps unfinished repository actions hidden and save feedback unset at boot', () => {
    expect(doc.getElementById('act-rescan')?.hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('empty-import')?.hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('empty-import')?.hasAttribute('data-mode-only')).toBe(false);
    expect(doc.getElementById('save-status')?.hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('save-status')?.getAttribute('role')).toBe('status');
  });

  it('exposes the Sub-project C style controls the editor wires', () => {
    // six colours, and Default (an edge's '', edges only)
    expect([...doc.querySelectorAll('#tb-swatches .swatch')].map(b => b.getAttribute('data-color'))).toEqual([
      'ink', 'blue', 'red', 'green', 'purple', 'gray', '',
    ]);
    expect([...doc.querySelectorAll('#tb-size button')].map(b => b.getAttribute('data-size'))).toEqual([
      's',
      'm',
      'l',
    ]);
    expect(
      [...doc.querySelectorAll('#tb-stroke button')].map(b => b.getAttribute('data-stroke'))
    ).toEqual(['solid', 'dashed', 'dotted']);
    expect(
      [...doc.querySelectorAll('#tb-shape button')].map(b => b.getAttribute('data-shape'))
    ).toEqual(['rect', 'pill', 'ellipse']);
    expect([...doc.querySelectorAll('#tb-weight button')].map(b => b.getAttribute('data-weight'))).toEqual([
      'regular', 'medium', 'bold',
    ]);
    expect([...doc.querySelectorAll('#tb-motion button')].map(b => b.getAttribute('data-motion'))).toEqual(['none', 'dots', 'dash', 'threat']);
    expect([...doc.querySelectorAll('#tb-speed button')].map(b => b.getAttribute('data-speed'))).toEqual(['slow', 'normal', 'fast']);
    expect(doc.getElementById('tb-reset-style')?.textContent).toBe('Reset');
  });

  it('offers the edge-only controls (RC-688) to edges alone, and says when the overlay overrides them', () => {
    const edgeOnly = [...doc.querySelectorAll('#toolbar .tb-edge-control')];
    expect(edgeOnly.map(e => e.getAttribute('data-color') ?? e.getAttribute('data-stroke') ?? e.id ?? e.className)).toEqual([
      '', 'dotted', '', '', '', '', 'tb-overlay-note',
    ]);
    // the Weight, Motion, Speed and Reset rows and the note sit in the Style popover
    expect(edgeOnly.slice(2).every(e => e.closest('#tb-style-menu') !== null)).toBe(true);
    expect(edgeOnly[2].querySelector('#tb-weight')).not.toBeNull();
    expect(edgeOnly[3].querySelector('#tb-motion')).not.toBeNull();
    expect(edgeOnly[4].querySelector('#tb-speed')).not.toBeNull();
    expect(edgeOnly[5].querySelector('#tb-reset-style')).not.toBeNull();
    expect(doc.getElementById('tb-overlay-note')?.hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('tb-overlay-note')?.textContent).toBe('Evidence overlay is on, so line and weight show evidence. \u2325E turns it off.');
  });

  it('names every toolbar option in words and draws its icon as SVG (G32)', () => {
    const labels = (sel: string) => [...doc.querySelectorAll(sel)].map(b => b.getAttribute('aria-label'));
    expect(labels('#tb-size button')).toEqual(['Small', 'Medium', 'Large']);
    expect(labels('#tb-stroke button')).toEqual(['Solid line', 'Dashed line', 'Dotted line']);
    expect(labels('#tb-shape button')).toEqual(['Rectangle', 'Pill', 'Ellipse']);
    expect(labels('#tb-weight button')).toEqual(['Regular weight', 'Medium weight', 'Bold weight']);
    expect(labels('#tb-motion button')).toEqual(['No motion', 'Dots: traffic flows along the edge', 'Dash: the line flows', "Threat: attack traffic, as a threat's blast radius"]);
    expect(labels('#tb-speed button')).toEqual(['Slow', 'Normal speed', 'Fast']);
    expect(labels('#tb-swatches .swatch').slice(-1)).toEqual(['Default']);
    for (const b of doc.querySelectorAll('#tb-swatches .swatch, #tb-size button, #tb-stroke button, #tb-shape button, #tb-weight button')) {
      expect(b.getAttribute('aria-pressed'), b.outerHTML).toBe('false');
    }
    // no Unicode glyphs standing in for icons anywhere in the toolbar or the dock
    for (const b of doc.querySelectorAll('#toolbar button, #toolbar summary, #dock .add-row')) {
      expect(b.textContent ?? '', b.outerHTML).not.toMatch(/[\u2190-\u2BFF\u22EF]/);
    }
    for (const b of doc.querySelectorAll('#tb-stroke button, #tb-shape button, #tb-weight button, #tb-more, .add-row')) {
      const svg = b.querySelector('svg');
      expect(svg, b.outerHTML).not.toBeNull();
      expect(svg!.getAttribute('viewBox')).toBe('0 0 16 16');
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('strokes every 16-unit icon at 1.3 px whatever size it renders at', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    // Every shape inside a 16-unit icon (jsdom cannot match [viewBox] on SVG
    // in an HTML document; Chrome does, and the browser check confirms it).
    expect(css).toMatch(/\nsvg\[viewBox='0 0 16 16'\] \* \{\s*vector-effect: non-scaling-stroke;\s*\}/);
    const { warnIcon, disclosureIcon } = await import('./icons');
    const sixteen = (svg: Element) => svg.getAttribute('viewBox') === '0 0 16 16';
    const icons = [...doc.querySelectorAll('svg'), warnIcon(), disclosureIcon()].filter(sixteen);
    // drawn at 12, 14, 16, 17 and 20 px: the sizes differ, the stroke must not
    expect(new Set(icons.map(s => s.getAttribute('width')))).toEqual(new Set(['12', '14', '16', '17', '20']));
    for (const svg of icons) {
      for (const shape of svg.querySelectorAll('path, rect, line, circle, ellipse, polyline')) {
        const stroke = shape.closest('[stroke]')?.getAttribute('stroke');
        if (stroke === undefined || stroke === 'none') continue;
        const width = shape.closest('[stroke-width]')?.getAttribute('stroke-width');
        expect(width, svg.outerHTML).toBe('1.3');
      }
    }
  });

  it('ships the palette closed', () => {
    expect(doc.getElementById('palette')?.hasAttribute('hidden')).toBe(true);
  });

  it('does not ship a serif font', () => {
    expect(html).not.toMatch(/Instrument\+?\s?Serif/i);
    expect(html).toMatch(/family=Geist/);
  });

  it('lets the inspector take focus for ↑ ↓ ↵ o c', () => {
    expect(doc.getElementById('inspector')?.getAttribute('tabindex')).toBe('0');
  });

  it('ships both rail switches with aria-pressed and the ⌥C / inspector shortcut rows', () => {
    for (const id of ['overlay-row', 'code-overlay-row']) {
      const row = doc.getElementById(id)!;
      expect(row.getAttribute('aria-pressed')).toBe('false');
      expect(row.classList.contains('rail-switch')).toBe(true);
      expect(row.querySelector('.overlay-switch .knob')).not.toBeNull();
    }
    const keys = [...doc.querySelectorAll('#shortcuts td:first-child')].map(td => td.textContent?.trim());
    expect(keys).toContain('⌥C');
    expect(keys).toContain('↑ / ↓ (inspector)');
    expect(keys).toContain('↵ (inspector)');
    expect(keys).toContain('o (inspector)');
    expect(keys).toContain('c (inspector)');
  });

  it('ships a hidden hint line right under the code overlay switch (P1)', () => {
    const hint = doc.getElementById('code-overlay-hint')!;
    expect(hint.hasAttribute('hidden')).toBe(true);
    expect(hint.previousElementSibling?.id).toBe('code-overlay-row');
    expect(hint.classList.contains('session-hint')).toBe(true);
  });

  it('names the ⌥C control one way and never claims it hides the CODE section (G13)', () => {
    const row = doc.getElementById('code-overlay-row')!;
    expect(row.querySelector('.overlay-name')?.textContent).toBe('Code overlay');
    expect(row.getAttribute('title')).toBe('Code overlay · ⌥C');
    const rows = [...doc.querySelectorAll('#shortcuts tr')].map(tr => [...tr.children].map(td => td.textContent?.trim()));
    expect(rows).toContainEqual(['⌥C', 'toggle the code overlay (ref badges on nodes and edges)']);
    expect(html).not.toMatch(/inspector CODE section/);
  });

  it('? overlay lists ⌘K (G46)', () => {
    const rows = [...doc.querySelectorAll('#shortcuts tr')].map(tr => [...tr.children].map(td => td.textContent?.trim()));
    expect(rows).toContainEqual(['ctrl/⌘-k', 'command palette']);
    expect(doc.getElementById('tb-more')?.getAttribute('aria-keyshortcuts')).toBe('Meta+K Control+K');
  });

  it('ships the session row hidden: no session chrome until a session row exists', () => {
    expect(doc.getElementById('session-row')?.hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('session-row')?.children).toHaveLength(0);
  });

  it('ships the code overlay switch hidden, and the CSS lets hidden win over flex (G42)', async () => {
    expect(doc.getElementById('code-overlay-row')?.hasAttribute('hidden')).toBe(true);
    // the evidence switch too: it shows once an edge carries machine evidence
    expect(doc.getElementById('overlay-row')?.hasAttribute('hidden')).toBe(true);
    const session = [...doc.querySelectorAll('#shortcuts tr[data-session-only] td:first-child')].map(td => td.textContent?.trim());
    expect(session).toEqual(['⌥C', '↑ / ↓ (inspector)', '↵ (inspector)', 'o (inspector)', 'c (inspector)', '⌥-click open in editor']);
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    expect(readFileSync(`${cwd}/src/style.css`, 'utf8')).toMatch(/\.rail-switch\[hidden\] \{\s*display: none;/);
  });

  it('pulses the checkpoint line from --muted to --ink, never through the accent', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = readFileSync(`${cwd}/src/style.css`, 'utf8');
    const frames = /@keyframes session-pulse \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(frames).not.toBe('');
    expect(frames).not.toContain('--accent');
    expect(frames).toMatch(/from \{\s*color: var\(--muted\);/);
    expect(frames).toMatch(/to \{\s*color: var\(--ink\);/);
  });

  it('keeps each rail switch on one line when a classic scrollbar narrows the rail', async () => {
    document.body.innerHTML = html;
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const sheet = document.createElement('style');
    sheet.textContent = readFileSync(`${cwd}/src/style.css`, 'utf8');
    document.head.append(sheet);
    try {
      const name = getComputedStyle(document.querySelector('#overlay-row .overlay-name')!);
      expect(name.whiteSpace).toBe('nowrap');
      expect(name.minWidth).toBe('0px');
      expect(name.overflow).toBe('hidden');
      expect(name.textOverflow).toBe('ellipsis');
      // 8 px gaps leave 'evidence overlay' its 95 px inside a 219 px rail
      expect(sheet.textContent).toMatch(/\.rail-switch \{[^}]*gap: var\(--space-2\);/);
      // the hint under the code overlay switch still starts where its name does
      expect(sheet.textContent).toMatch(/#code-overlay-hint \{[^}]*calc\(var\(--space-2\) \+ 32px \+ var\(--space-2\)\)/);
    } finally {
      sheet.remove();
    }
  });
});

describe('empty state (G11)', () => {
  const shown = (el: Element | null) => el !== null && el.closest('[hidden]') === null;

  it('empty session board shows waiting state, no import CTA', async () => {
    document.body.innerHTML = html;
    const { syncEmptyState } = await import('./empty-state');
    const el = document.getElementById('empty-state')!;
    syncEmptyState(el, { nodeCount: 0, hasSession: true });
    expect(shown(el)).toBe(true);
    expect(el.dataset.mode).toBe('session');
    const visibleText = [...el.querySelectorAll('.empty-title, .empty-copy')].filter(shown).map(e => e.textContent?.trim());
    expect(visibleText).toEqual(['Waiting for the agent to draw', 'The board fills in at each checkpoint.']);
    expect(shown(el.querySelector('.live-dot'))).toBe(true);
    expect(shown(document.getElementById('empty-import'))).toBe(false);
    expect(shown(el.querySelector('.empty-hint'))).toBe(false);
    const actions = [...el.querySelectorAll('button')].filter(shown).map(b => b.id);
    expect(actions).toEqual(['empty-place']);
  });

  it('a session row arriving later switches the mode in place; nodes hide the state', async () => {
    document.body.innerHTML = html;
    const { syncEmptyState } = await import('./empty-state');
    const el = document.getElementById('empty-state')!;
    syncEmptyState(el, { nodeCount: 0, hasSession: false });
    expect(el.dataset.mode).toBe('board');
    expect(shown(document.getElementById('empty-import'))).toBe(false);
    expect(shown(el.querySelector('.empty-hint'))).toBe(true);
    expect(shown(el.querySelector('.live-dot'))).toBe(false);
    syncEmptyState(el, { nodeCount: 0, hasSession: true });
    expect(el.dataset.mode).toBe('session');
    expect(shown(document.getElementById('empty-import'))).toBe(false);
    syncEmptyState(el, { nodeCount: 3, hasSession: true });
    expect(el.hidden).toBe(true);
  });

  it('an agent on an empty board is named, centred, until the first node (hosted MCP §12)', async () => {
    document.body.innerHTML = html;
    const { syncEmptyState } = await import('./empty-state');
    const el = document.getElementById('empty-state')!;
    const visibleText = () => [...el.querySelectorAll('.empty-title, .empty-copy')].filter(shown).map(e => e.textContent?.trim());
    for (const hasSession of [false, true]) {
      syncEmptyState(el, { nodeCount: 0, hasSession, agent: 'agent of Alan Lee' });
      expect(el.dataset.mode).toBe('agent');
      expect(visibleText()).toEqual(['agent of Alan Lee is here. Nothing drawn yet.']);
      expect(shown(document.getElementById('empty-orb'))).toBe(true);
      expect(shown(document.getElementById('empty-connect'))).toBe(false);
    }
    // a second agent name replaces the line in place
    syncEmptyState(el, { nodeCount: 0, hasSession: true, agent: 'agent of Maya' });
    expect(visibleText()).toEqual(['agent of Maya is here. Nothing drawn yet.']);
    syncEmptyState(el, { nodeCount: 1, hasSession: true, agent: 'agent of Maya' });
    expect(el.hidden).toBe(true);
    // the agent leaves before drawing: the existing empty states come back
    syncEmptyState(el, { nodeCount: 0, hasSession: true });
    expect(visibleText()).toEqual(['Waiting for the agent to draw', 'The board fills in at each checkpoint.']);
    syncEmptyState(el, { nodeCount: 0, hasSession: false });
    expect(visibleText()).toEqual(['Start with your first node.', 'Map a service, datastore, or idea. Connect nodes as your drawing takes shape.']);
    expect(shown(document.getElementById('empty-connect'))).toBe(true);
  });
});

describe('header at 1024 px (G45)', () => {
  it('counts shrink with an ellipsis, the board name and Export keep their width, sub-counts can hide', async () => {
    document.body.innerHTML = html;
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const sheet = document.createElement('style');
    sheet.textContent = readFileSync(`${cwd}/src/style.css`, 'utf8');
    document.head.append(sheet);
    try {
      const { renderBoardCounts } = await import('./chrome');
      const el = document.getElementById('board-counts')!;
      expect(el.getAttribute('role')).toBe('group');
      renderBoardCounts(el, { nodes: 12, shownNodes: 12, edges: 8, shownEdges: 8, checkpoint: 4 });
      expect(el.textContent).toBe('12 nodes · 8 edges · checkpoint 4');
      expect(el.title).toBe('12 nodes · 12 shown · 0 hidden — 8 edges · 8 shown · 0 hidden · checkpoint 4');
      expect(el.getAttribute('aria-label')).toBe(el.title);
      expect([...el.querySelectorAll('.counts-sub')].map(s => s.textContent)).toEqual([
        '',
        '',
      ]);
      renderBoardCounts(el, { nodes: 1, shownNodes: 1, edges: 0, shownEdges: 0, checkpoint: null });
      expect(el.textContent).toBe('1 node · 0 edges');
      const counts = getComputedStyle(el);
      expect(counts.flexShrink).toBe('1');
      expect(counts.minWidth).toBe('0px');
      expect(counts.overflow).toBe('hidden');
      expect(counts.textOverflow).toBe('ellipsis');
      const title = getComputedStyle(document.getElementById('board-title')!);
      expect(title.flexShrink).toBe('0');
      // jsdom resolves ch to px; the rule itself says 12ch
      expect(title.minWidth).not.toBe('0px');
      expect(sheet.textContent).toMatch(/#board-title \{[^}]*min-width: 12ch;/);
      const exp = getComputedStyle(document.getElementById('act-export')!);
      expect(exp.whiteSpace).toBe('nowrap');
      expect(exp.flexShrink).toBe('0');
      expect(sheet.textContent).toMatch(/@media \(max-width: 1200px\)\s*\{\s*\.counts-sub\s*\{\s*display: none;/);
      // Connect an agent keeps its width too, and drops to its icon at laptop widths
      const conn = getComputedStyle(document.getElementById('act-connect')!);
      expect(conn.whiteSpace).toBe('nowrap');
      expect(conn.flexShrink).toBe('0');
      expect(sheet.textContent).toMatch(/@media \(max-width: 1200px\)\s*\{[^@]*#act-connect \.act-label\s*\{\s*display: none;/);
    } finally {
      sheet.remove();
    }
  });

  it('keeps omissions visible and full counts accessible when the header is compact', async () => {
    const { renderBoardCounts } = await import('./chrome');
    const el = document.createElement('div');
    renderBoardCounts(el, { nodes: 12, shownNodes: 9, edges: 8, shownEdges: 6, checkpoint: 0 });
    expect(el.textContent).toBe('12 nodes · 3 hidden · 8 edges · 2 hidden · checkpoint 0');
    expect(el.title).toBe('12 nodes · 9 shown · 3 hidden — 8 edges · 6 shown · 2 hidden · checkpoint 0');
    expect(el.getAttribute('aria-label')).toBe(el.title);
    expect([...el.querySelectorAll('.counts-sub')].map(s => s.textContent)).toEqual([' · 3 hidden', ' · 2 hidden']);

    renderBoardCounts(el, { nodes: 0, shownNodes: 0, edges: 1, shownEdges: 1, checkpoint: null });
    expect(el.textContent).toBe('0 nodes · 1 edge');
    expect(el.title).toBe('0 nodes · 0 shown · 0 hidden — 1 edge · 1 shown · 0 hidden');
    expect(el.getAttribute('aria-label')).toBe(el.title);
  });

  it('names what a share link can expose, and stays empty without code refs or threats', async () => {
    const { renderExposure } = await import('./chrome');
    const el = document.createElement('button');
    const text = () => el.textContent!.replace(/\s+/g, ' ');

    renderExposure(el, { code: 12, threats: 2, owner: true, link: null });
    expect(el.dataset.state).toBe('private');
    expect(text()).toBe('12 code refs·2 threats');
    expect(el.title).toBe('12 code refs and 2 threats on this board. Not shared. Click to change what the link shows.');
    expect(el.getAttribute('aria-label')).toBe(el.title);
    expect(el.disabled).toBe(false);

    renderExposure(el, { code: 1, threats: 0, owner: true, link: { code: false, threats: false } });
    expect(el.dataset.state).toBe('kept');
    expect(text()).toBe('Link hides1 code ref');
    expect(el.title).toBe('The share link leaves out 1 code ref. Click to change what the link shows.');

    renderExposure(el, { code: 12, threats: 2, owner: true, link: { code: true, threats: false } });
    expect(el.dataset.state).toBe('out');
    expect([...el.querySelectorAll('.item')].map(i => i.textContent)).toEqual(['12 code refs']);
    expect(el.title).toBe('Anyone with the link sees 12 code refs. 2 threats stay private. Click to change what the link shows.');
    renderExposure(el, { code: 12, threats: 1, owner: true, link: { code: true, threats: false } });
    expect(el.title).toBe('Anyone with the link sees 12 code refs. 1 threat stays private. Click to change what the link shows.');

    // Not the owner: the count, no link state, and nothing to open.
    renderExposure(el, { code: 3, threats: 0, owner: false, link: null });
    expect(el.title).toBe('3 code refs on this board.');
    expect(el.disabled).toBe(true);

    renderExposure(el, { code: 0, threats: 0, owner: true, link: { code: true, threats: true } });
    expect(el.childNodes.length).toBe(0);
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.hasAttribute('aria-label')).toBe(false);
  });
});

describe('theme picker markup', () => {
  it('ships an empty disclosure right after its button, for setupTheme to fill from THEMES', () => {
    const doc = parse();
    const btn = doc.getElementById('act-theme');
    expect(btn?.getAttribute('aria-controls')).toBe('theme-pop');
    expect(btn?.getAttribute('aria-expanded')).toBe('false');
    // a disclosure of toggle buttons, not a menu
    expect(btn?.hasAttribute('aria-haspopup')).toBe(false);
    // next in tab order: the options come right after their button
    expect(btn?.nextElementSibling?.id).toBe('theme-pop');
    const pop = doc.getElementById('theme-pop')!;
    expect(pop.getAttribute('role')).toBe('group');
    expect(pop.getAttribute('aria-label')).toBe('Theme');
    expect(pop.children).toHaveLength(0);
  });
});

describe('pre-paint theme script', () => {
  // The inline <head> script that applies the saved theme before first paint.
  const prepaint = [...parse().querySelectorAll('head script:not([src])')]
    .map(s => s.textContent ?? '')
    .find(t => t.includes('redcrayon-theme'));

  function applied(stored: string | null): string | undefined {
    if (stored === null) localStorage.removeItem('redcrayon-theme');
    else localStorage.setItem('redcrayon-theme', stored);
    delete document.documentElement.dataset.theme;
    new Function(prepaint!)();
    return document.documentElement.dataset.theme;
  }

  it.each<[string | null, string]>([
    ...THEMES.map((t): [string, string] => [t.id, t.id]),
    [null, 'dark'],
    ['sepia', 'dark'],
    ['constructor', 'dark'],
  ])('saved %s paints as %s', (stored, theme) => {
    expect(prepaint, 'pre-paint script missing from <head>').toBeDefined();
    expect(applied(stored)).toBe(theme);
  });
});

describe('library chrome (L, ⇧L)', () => {
  const doc = parse();
  const readCss = async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    return readFileSync(`${cwd}/src/style.css`, 'utf8');
  };

  it('adds the library to the dock as a plain tool after the six kinds, never as an .add-row', () => {
    const btn = doc.getElementById('tool-library')!;
    expect(btn).not.toBeNull();
    expect(btn.classList.contains('tool')).toBe(true);
    expect(btn.classList.contains('add-row')).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Library');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('library-popover');
    expect(btn.getAttribute('aria-keyshortcuts')).toBe('L');
    expect(btn.querySelector('.tool-key')?.textContent).toBe('L');
    const svg = btn.querySelector('svg')!;
    expect([svg.getAttribute('width'), svg.getAttribute('viewBox'), svg.getAttribute('aria-hidden')]).toEqual([
      '17', '0 0 16 16', 'true',
    ]);
    const tools = [...doc.querySelectorAll('#dock > *')];
    const text = tools.indexOf(doc.querySelector('.add-row[data-kind="text"]')!);
    // Text | red crayon | Library (the crayon sits between, behind its own divider)
    expect(tools[text + 3].classList.contains('dock-div')).toBe(true);
    expect(tools.indexOf(btn)).toBe(text + 4);
    expect(doc.querySelectorAll('.add-row')).toHaveLength(6);
  });

  it('adds the red crayon to the dock after the kinds, behind a divider, never as an .add-row', () => {
    const btn = doc.getElementById('tool-crayon')!;
    expect(btn.classList.contains('tool')).toBe(true);
    expect(btn.classList.contains('add-row')).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Red crayon');
    expect(btn.getAttribute('aria-keyshortcuts')).toBe('C');
    expect(btn.querySelector('.tool-key')?.textContent).toBe('C');
    const tools = [...doc.querySelectorAll('#dock > *')];
    const text = tools.indexOf(doc.querySelector('.add-row[data-kind="text"]')!);
    expect(tools[text + 1].classList.contains('dock-div')).toBe(true);
    expect(tools.indexOf(btn)).toBe(text + 2);
    const keys = [...doc.querySelectorAll('#shortcuts td:first-child')].map(td => td.textContent?.trim());
    expect(keys).toContain('C');
  });

  it('ships the Send pill hidden in #canvas-wrap and a bare Review button beside the theme button', () => {
    const pill = doc.getElementById('mark-send')!;
    expect(pill.localName).toBe('button');
    expect(pill.closest('#canvas-wrap')).not.toBeNull();
    expect(pill.hasAttribute('hidden')).toBe(true);
    const review = doc.getElementById('act-review')!;
    expect(review.classList.contains('icon-btn')).toBe(true);
    expect(review.getAttribute('aria-label')).toBe('Review');
    expect(review.getAttribute('title')).toBe('Review');
    expect(review.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(review.nextElementSibling?.id).toBe('act-theme');
  });

  it('ships the review badge inside #act-review, its popover closed and the banner hidden in #canvas-wrap', () => {
    const review = doc.getElementById('act-review')!;
    expect(review.getAttribute('aria-controls')).toBe('review-pop');
    expect(review.getAttribute('aria-expanded')).toBe('false');
    expect(doc.getElementById('review-badge')!.closest('#act-review')).toBe(review);
    expect(doc.getElementById('review-badge')!.hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('review-pop')!.hasAttribute('hidden')).toBe(true);
    const banner = doc.getElementById('mark-banner')!;
    expect(banner.closest('#canvas-wrap')).not.toBeNull();
    expect(banner.hasAttribute('hidden')).toBe(true);
    expect(banner.getAttribute('role')).toBe('status');
  });

  it('ships the popover container empty and closed, inside #canvas-wrap, as a labelled dialog', () => {
    const pop = doc.getElementById('library-popover')!;
    expect(pop.closest('#canvas-wrap')).not.toBeNull();
    expect(pop.hasAttribute('hidden')).toBe(true);
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(pop.getAttribute('aria-label')).toBe('Library');
    expect(pop.children).toHaveLength(0);
  });

  it('puts Add to library on the selection toolbar for nodes only, with ⇧L in the title and not the text', () => {
    const btn = doc.getElementById('tb-library')!;
    expect(btn.closest('#toolbar')).not.toBeNull();
    expect(btn.classList.contains('tb-node-control')).toBe(true);
    expect(btn.getAttribute('title')).toBe('Add to library · ⇧L');
    expect(btn.getAttribute('aria-label')).toBe('Add to library');
    expect(btn.getAttribute('aria-keyshortcuts')).toBe('Shift+L');
    expect(btn.textContent?.trim()).toBe('');
    expect(btn.nextElementSibling?.id).toBe('tb-delete');
  });

  it('lists L and ⇧L in the shortcuts overlay', () => {
    const rows = [...doc.querySelectorAll('#shortcuts tr')].map(tr => [...tr.children].map(td => td.textContent?.trim()));
    // L typed in the open popover's search is text, so Esc is what closes it
    expect(rows).toContainEqual(['L', 'open the library (Esc closes it): objects, charts, saved items']);
    expect(rows).toContainEqual(['⇧L', 'add the selection to your library']);
  });

  it('hides the closed popover, animates it only without reduced motion, and borders it in brutal', async () => {
    const css = await readCss();
    expect(css).toMatch(/#library-popover\[hidden\] \{\s*display: none;/);
    expect(css).toMatch(/\.lib-menu\[hidden\] \{\s*display: none;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*#library-popover:not\(\[hidden\]\) \{/);
    expect(css).toMatch(/:root\[data-theme='brutal'\] :is\(#library-popover, \.lib-menu\) \{\s*border-width: 2px;\s*border-color: var\(--ink\);/);
  });

  // Browser QA (.context/qa-l2): the popover scrolls, so a menu opening
  // downward from the last row was clipped (Delete hidden); "API gateway"
  // cut to "API gat…"; the open popover left its dock button unmarked.
  it('opens the saved-item menu upward, wraps saved names to two lines, and marks the open dock button', async () => {
    const css = await readCss();
    const block = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
    };
    expect(block('.lib-menu')).toMatch(/bottom: calc\(100% \+ 2px\);/);
    expect(block('.lib-menu')).not.toMatch(/\btop:/);
    expect(block('.lib-saved .lib-name')).toMatch(/-webkit-line-clamp: 2;/);
    expect(block("#dock #tool-library[aria-expanded='true']")).toMatch(/background: var\(--panel-hi\);\s*color: var\(--ink\);/);
  });

  // Merge review: #42 caps the dock at the phone width (≤ 720 px), and the
  // library button's flex shrink took all 8 tools to 37.7 px at 375 px.
  it('keeps every dock tool at 44 px on phones: tools never shrink, a narrow dock scrolls', async () => {
    const css = await readCss();
    const block = (source: string, selector: string) => {
      const at = source.indexOf(`\n${selector} {`);
      return at < 0 ? '' : source.slice(at, source.indexOf('}', at));
    };
    expect(block(css, '#dock .tool')).toMatch(/width: 44px;[\s\S]*height: 44px;/);
    expect(block(css, '#dock .tool')).toMatch(/flex: none;/);
    const at = css.indexOf('\n@media (max-width: 720px) {');
    const phone = css.slice(at, css.indexOf('\n}', at)).replace(/\n {2}/g, '\n');
    expect(block(phone, '#dock')).toMatch(/max-width: calc\(100% - 2 \* var\(--space-3\)\);/);
    expect(block(phone, '#dock')).toMatch(/overflow-x: auto;/);
    // 10 tools x 44 + 4 + 4 padding + 2 + 2 brutal border = 452 px: no dividers
    // or gaps; a 390 px phone (max-width 366) scrolls the last tool into view
    expect(doc.querySelectorAll('#dock .tool')).toHaveLength(10);
    expect(block(phone, '#dock')).toMatch(/gap: 0;/);
    expect(block(phone, '#dock')).toMatch(/padding-inline: 4px;/);
    expect(block(phone, '#dock .dock-div')).toMatch(/display: none;/);
    // the open popover clears the zoom cluster #42 put above the dock
    expect(block(phone, '#library-popover')).toMatch(/bottom: calc\(max\(var\(--space-4\), env\(safe-area-inset-bottom\)\) \+ var\(--dock-h\) \+ var\(--zoom-h\) \+ 2 \* var\(--space-3\)\);/);
    // the header wraps past --topbar-h on phones: its popovers drop from its real bottom, not over its buttons
    expect(phone).toMatch(/#presence-pop,\n#theme-pop,\n#review-pop,\n#share-pop,\n#account-pop \{\n {2}top: calc\(100% \+ var\(--space-2\)\);/);
  });
});
