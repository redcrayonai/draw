/**
 * The chat's two sounds, made in the browser (no files): `done` when the agent
 * finishes, `attention` when it needs the person. They play only when the person
 * is not looking at the chat, and never before the page has had a click, which
 * browsers require before they play sound.
 */
export type ChimeKind = 'done' | 'attention';

// Notes in Hz and their start in seconds: a soft falling pair for done, a rising pair that asks.
const NOTES: Record<ChimeKind, [number, number][]> = {
  done: [[784, 0], [523.25, 0.12]],
  attention: [[659.25, 0], [987.77, 0.14]],
};
const KEY = 'redcrayon.chatSound';

export function soundOn(): boolean {
  return localStorage.getItem(KEY) !== 'off';
}

export function setSound(on: boolean): void {
  localStorage.setItem(KEY, on ? 'on' : 'off');
}

let ctx: AudioContext | null = null;
/** Created on the first click anywhere: a context made earlier stays silent. */
export function armChime(target: EventTarget = document): void {
  target.addEventListener('pointerdown', () => {
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!ctx && Ctor) ctx = new Ctor();
    void ctx?.resume?.();
  }, { capture: true });
}

export function chime(kind: ChimeKind, watching: boolean): void {
  if (watching || !soundOn() || !ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  for (const [freq, at] of NOTES[kind]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Quick rise, gentle fall: a chime, not a beep.
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.12, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.5);
  }
}

/** For tests: forget the context. */
export function resetChime(): void {
  ctx = null;
}
