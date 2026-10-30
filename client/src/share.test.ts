import { describe, it, expect, beforeAll, vi } from 'vitest';

type Share = typeof import('./share');
let share: Share;

const POPOVER = `
  <button id="exposure-chip" aria-expanded="false"></button>
  <div class="header-actions"><button id="act-share" hidden aria-expanded="false">Share</button><button id="act-export">Export SVG</button></div>
  <div id="share-pop" role="group" aria-label="Share" hidden>
    <p class="eyebrow">Share</p>
    <label class="share-row"><span>Share with link</span><input id="share-on" type="checkbox" role="switch"></label>
    <div id="share-detail" hidden>
      <div class="share-seg" role="group" aria-label="Link access">
        <button data-share-mode="view" aria-pressed="false">Can view</button>
        <button data-share-mode="edit" aria-pressed="false">Can edit</button>
      </div>
      <fieldset class="share-includes">
        <legend>Also include</legend>
        <label class="share-check"><input id="share-threats" type="checkbox"><span><b>Threats</b><small>markers, details and blast radius</small></span><em class="share-count"></em></label>
        <label class="share-check"><input id="share-code" type="checkbox"><span><b>Code</b><small>code refs and source snippets</small></span><em class="share-count"></em></label>
      <small id="share-code-note" class="share-note" hidden>Edit links always include code, so undo can restore what an edit removes.</small>
      </fieldset>
      <div class="share-link"><input id="share-url" readonly aria-label="Share link"><button id="share-copy" class="btn-primary">Copy</button></div>
    </div>
    <p id="share-hint" class="share-hint"></p>
    <p id="share-error" class="share-error" role="alert" hidden></p>
  </div>`;

beforeAll(async () => {
  // chrome.ts (imported by share.ts) dereferences these in its module body.
  document.body.innerHTML = `
    <div id="error-strip" hidden><span id="error-text"></span><button id="error-dismiss"></button></div>
    <button id="participants-label"><span id="participant-chips"></span></button>
    <div id="presence-pop" hidden></div>
    <aside id="inspector" hidden tabindex="0"></aside>${POPOVER}`;
  share = await import('./share');
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const T = 'ab'.repeat(16);

function setup(over: Partial<import('./share').ShareDeps> = {}) {
  const deps = { base: 'https://draw.example.com/', db: 'redcrayon', setLink: vi.fn(async () => {}), stopLink: vi.fn(async () => {}), setIncludes: vi.fn(async () => {}), ...over };
  return { deps, paint: share.setupShare(deps) };
}

describe('share popover', () => {
  it('is hidden unless the caller owns the board', () => {
    const { paint } = setup();
    paint(null);
    expect($('act-share').hidden).toBe(true);
    expect($('act-export').hidden).toBe(false);
    paint({ mode: '', token: '', threats: false, code: false });
    expect($('act-share').hidden).toBe(false);
    expect($('act-share').textContent).toBe('Share');
    // owners export from the popover, so the header shows one filled button
    expect($('act-export').hidden).toBe(true);
  });

  it('turning it on sends view with a fresh token; the shared state shows mode and link', async () => {
    const { deps, paint } = setup();
    paint({ mode: '', token: '', threats: false, code: false });
    $<HTMLInputElement>('share-on').click();
    await vi.waitFor(() => expect(deps.setLink).toHaveBeenCalledWith('view', expect.stringMatching(/^[0-9a-f]{32}$/)));
    paint({ mode: 'view', token: T, threats: false, code: false });
    expect($('share-hint').textContent).toBe('Anyone with the link can view. Turning this off ends access for everyone.');
    paint({ mode: 'edit', token: T, threats: false, code: false });
    expect($('share-hint').textContent).toBe('Anyone with the link can view. Signed-in people can edit. Turning this off ends access for everyone.');
    expect($('act-share').textContent).toBe('Shared');
    expect($('share-detail').hidden).toBe(false);
    expect($<HTMLInputElement>('share-url').value).toBe(`https://draw.example.com/#s=${T}`);
    expect(document.querySelector('[data-share-mode="edit"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('switching mode and turning it off call the right reducers', async () => {
    const { deps, paint } = setup();
    paint({ mode: 'view', token: T, threats: false, code: false });
    (document.querySelector('[data-share-mode="edit"]') as HTMLElement).click();
    await vi.waitFor(() => expect(deps.setLink).toHaveBeenCalledWith('edit', expect.any(String)));
    $<HTMLInputElement>('share-on').click();
    await vi.waitFor(() => expect(deps.stopLink).toHaveBeenCalled());
  });

  it('a failed reducer shows its sentence and puts the switch back', async () => {
    const { paint } = setup({ setLink: vi.fn(async () => { throw new Error('share rule: only an owner of board 1 can share it'); }) });
    paint({ mode: '', token: '', threats: false, code: false });
    $<HTMLInputElement>('share-on').click();
    await vi.waitFor(() => expect($('share-error').textContent).toBe('share rule: only an owner of board 1 can share it'));
    expect($('share-error').hidden).toBe(false);
    expect($<HTMLInputElement>('share-on').checked).toBe(false);
  });

  it('Escape closes the popover while focus is on the switch', () => {
    const { paint } = setup();
    paint({ mode: '', token: '', threats: false, code: false });
    $('act-share').click();
    expect($('share-pop').hidden).toBe(false);
    $<HTMLInputElement>('share-on').focus();
    $('share-on').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect($('share-pop').hidden).toBe(true);
    expect($('act-share').getAttribute('aria-expanded')).toBe('false');
  });

  it('threats and code start off and show what the module holds; each box sends both flags', async () => {
    const { deps, paint } = setup();
    paint({ mode: 'view', token: T, threats: false, code: false });
    const threats = $<HTMLInputElement>('share-threats'), code = $<HTMLInputElement>('share-code');
    expect([threats.checked, code.checked]).toEqual([false, false]);
    threats.click();
    await vi.waitFor(() => expect(deps.setIncludes).toHaveBeenCalledWith(true, false));
    paint({ mode: 'view', token: T, threats: true, code: false });
    code.click();
    await vi.waitFor(() => expect(deps.setIncludes).toHaveBeenLastCalledWith(true, true));
    paint({ mode: 'view', token: T, threats: true, code: true });
    expect([threats.checked, code.checked]).toEqual([true, true]);
  });

  it('a refused include puts the boxes back and says why', async () => {
    const { paint } = setup({ setIncludes: vi.fn(async () => { throw new Error('share rule: turn on the link before choosing what it includes'); }) });
    paint({ mode: 'view', token: T, threats: false, code: false });
    $<HTMLInputElement>('share-code').click();
    await vi.waitFor(() => expect($('share-error').hidden).toBe(false));
    expect($('share-error').textContent).toBe('share rule: turn on the link before choosing what it includes');
    expect($<HTMLInputElement>('share-code').checked).toBe(false);
    expect($<HTMLInputElement>('share-code').disabled).toBe(false);
  });

  it('an edit link shows code as included and locked; the threats box sends the stored code choice', async () => {
    const { deps, paint } = setup();
    paint({ mode: 'edit', token: T, threats: false, code: false });
    const code = $<HTMLInputElement>('share-code');
    expect([code.checked, code.disabled, $('share-code-note').hidden]).toEqual([true, true, false]);
    $<HTMLInputElement>('share-threats').click();
    await vi.waitFor(() => expect(deps.setIncludes).toHaveBeenCalledWith(true, false));
    expect(code.disabled).toBe(true); // stays locked after the call
    paint({ mode: 'view', token: T, threats: true, code: false });
    expect([code.checked, code.disabled, $('share-code-note').hidden]).toEqual([false, false, true]);
  });

  it('shows how many threats and code refs each box carries, and the header chip opens on them', () => {
    const { paint } = setup();
    const count = (id: string) => $(id).closest('label')!.querySelector('.share-count')!.textContent;
    paint({ mode: 'view', token: T, threats: false, code: true, counts: { threats: 2, code: 12 } });
    expect([count('share-threats'), count('share-code')]).toEqual(['2', '12']);
    paint({ mode: 'view', token: T, threats: false, code: true, counts: { threats: 0, code: 12 } });
    expect(count('share-threats')).toBe('');

    $('exposure-chip').click();
    expect($('share-pop').hidden).toBe(false);
    expect($('share-pop').classList.contains('from-exposure')).toBe(true);
    expect($('exposure-chip').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe($('share-threats'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect($('share-pop').hidden).toBe(true);
    expect($('share-pop').classList.contains('from-exposure')).toBe(false);
    expect(document.activeElement).toBe($('exposure-chip')); // back to the opener, not #act-share

    // A press on the chip is not "outside": the second click closes, as aria-expanded says it can.
    const chip = $('exposure-chip');
    chip.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    chip.click();
    expect($('share-pop').hidden).toBe(false);
    chip.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    chip.click();
    expect($('share-pop').hidden).toBe(true);
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });
});
