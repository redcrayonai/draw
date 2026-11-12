// The walk-through caption bar: a pure view. The player builds the model; this paints it
// and calls its handlers. Repaints only what changed so the live region does not re-announce.
export interface TellingBarModel {
  audiences: string[]; active: number;       // the switch; hidden when there is one audience
  at: number; count: number;                 // zero-based: 0..count-1 is a step, at === count is the ending
  title: string; body: string; source: string;
  playing: boolean; reduced: boolean;
  onPlay(): void; onPause(): void; onReplay(): void; onNext(): void; onBack(): void; onAudience(i: number): void; onExit(): void;
}

type Act = 'back' | 'play' | 'pause' | 'replay' | 'next' | 'exit';

interface Parts {
  model: TellingBarModel;
  controls: HTMLElement; back: HTMLButtonElement; main: HTMLButtonElement; next: HTMLButtonElement;
  count: HTMLElement; switchSlot: HTMLElement; title: HTMLElement; body: HTMLElement; source: HTMLElement | null;
  sourceSlot: HTMLElement; progress: HTMLElement;
  names: string; segments: number;
}

const parts = new WeakMap<HTMLElement, Parts>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, cls = 'btn-primary telling-btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  return b;
}

function set<T extends HTMLElement>(node: T, key: 'textContent' | 'title', v: string): void {
  if (node[key] !== v) node[key] = v;
}

function build(root: HTMLElement): Parts {
  const call = (name: keyof TellingBarModel) => () => (p.model[name] as () => void)();
  const act = (label: string, a: Act, fn: () => void): HTMLButtonElement => {
    const b = button(label);
    b.dataset.act = a;
    b.addEventListener('click', fn);
    return b;
  };
  const back = act('Back', 'back', call('onBack'));
  const next = act('Next', 'next', call('onNext'));
  const exit = act('Exit', 'exit', call('onExit'));
  exit.classList.add('telling-exit');
  const main = act('Play', 'play', call('onPlay'));
  const count = el('span', 'telling-count');
  const switchSlot = el('span', 'telling-switch-slot');
  const controls = el('div', 'telling-controls');
  controls.append(back, main, next, count, switchSlot, exit);
  const title = el('div', 'telling-title');
  const body = el('p', 'telling-body');
  const caption = el('div', 'telling-caption');
  caption.setAttribute('aria-live', 'polite');
  caption.append(title, body);
  const sourceSlot = el('div', 'telling-source-slot');
  const progress = el('div', 'telling-progress');
  progress.setAttribute('aria-hidden', 'true');
  root.replaceChildren(controls, caption, sourceSlot, progress);
  const p = { controls, back, main, next, count, switchSlot, title, body, source: null, sourceSlot, progress, names: '', segments: -1 } as unknown as Parts;
  return p;
}

export function renderTellingBar(root: HTMLElement, m: TellingBarModel | null): void {
  if (!m) { root.hidden = true; return; }
  let p = parts.get(root);
  if (!p) { p = build(root); parts.set(root, p); }
  p.model = m;
  const opening = root.hidden;
  root.hidden = false;
  const focused = document.activeElement;
  const inside = root.contains(focused);
  const heldMain = focused === p.main;

  const ending = m.at >= m.count;
  p.back.disabled = m.at <= 0;
  p.next.disabled = ending;
  set(p.count, 'textContent', ending ? '' : `${m.at + 1} of ${m.count}`);

  // Exactly one of Play / Pause / Replay; focus follows a swapped control.
  const want: Act = ending ? 'replay' : m.playing ? 'pause' : 'play';
  if (p.main.dataset.act !== want) {
    const fresh = button(want === 'replay' ? 'Replay' : want === 'pause' ? 'Pause' : 'Play');
    fresh.dataset.act = want;
    const fn = { replay: 'onReplay', pause: 'onPause', play: 'onPlay' }[want] as 'onReplay' | 'onPause' | 'onPlay';
    fresh.addEventListener('click', () => p.model[fn]());
    p.main.replaceWith(fresh);
    p.main = fresh;
  }
  p.main.disabled = want === 'play' && m.reduced;
  set(p.main, 'title', p.main.disabled ? 'Motion is reduced on this device. Use Next.' : '');
  if (!p.main.title) p.main.removeAttribute('title');

  const names = m.audiences.length > 1 ? JSON.stringify(m.audiences) : '';
  if (names !== p.names) {
    p.names = names;
    if (!names) p.switchSlot.replaceChildren();
    else {
      const group = el('span', 'telling-switch');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Told for');
      m.audiences.forEach((a, i) => {
        const b = button(a, 'btn-primary telling-btn telling-aud');
        b.dataset.audience = String(i);
        b.addEventListener('click', () => p.model.onAudience(i));
        group.append(b);
      });
      p.switchSlot.replaceChildren(group);
    }
  }
  p.switchSlot.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === m.active)));

  set(p.title, 'textContent', m.title);
  set(p.body, 'textContent', m.body);

  const src = m.source ? `source ${m.source}` : '';
  if (!src) { p.source?.remove(); p.source = null; }
  else {
    if (!p.source) { p.source = el('div', 'telling-source'); p.sourceSlot.append(p.source); }
    set(p.source, 'textContent', src);
  }

  if (p.segments !== m.count) {
    p.segments = m.count;
    p.progress.replaceChildren(...Array.from({ length: m.count }, () => el('span', '')));
  }
  [...p.progress.children].forEach((s, i) => s.classList.toggle('done', i <= m.at));

  // One focus rule, after every disabled flag is set: a control that held focus and is now detached or
  // disabled hands it to the main button, else Exit, so keyboard users never drop to <body>.
  if (inside) {
    const held = heldMain ? p.main : (focused as HTMLElement);
    const ok = held.isConnected && !(held as HTMLButtonElement).disabled;
    const target = ok ? held : p.main.disabled ? p.controls.querySelector<HTMLElement>('[data-act="exit"]')! : p.main;
    if (document.activeElement !== target) target.focus();
  }
  // Opening takes focus into the bar: Space then works its controls, not the button that opened it.
  if (opening) (p.main.disabled ? p.next : p.main).focus();
}
