/** One clock for playback: no timer continues while paused or offscreen. */
export class EmbedClock {
  elapsed = 0;
  playing = false;
  loop = false;
  private blocked = false;
  private reduced = false;
  private raf = 0;
  private last = 0;
  constructor(private duration: number, private paint: (ms: number) => void, private changed: () => void) {}
  reset(duration: number): void {
    this.stop(); this.duration = Math.max(1, duration); this.elapsed = 0; this.paint(0); this.changed();
  }
  play(): void {
    if (this.reduced) return;
    if (this.elapsed >= this.duration) this.elapsed = 0;
    this.playing = true; this.start(); this.changed();
  }
  pause(): void { this.playing = false; this.stop(); this.changed(); }
  replay(): void { if (this.reduced) return; this.elapsed = 0; this.paint(0); this.play(); }
  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    if (blocked) this.stop(); else this.start();
  }
  setReduced(reduced: boolean): void {
    this.reduced = reduced;
    if (reduced) { this.pause(); this.elapsed = this.duration; this.paint(this.elapsed); }
  }
  destroy(): void { this.pause(); }
  private stop(): void { cancelAnimationFrame(this.raf); this.raf = 0; }
  private start(): void {
    if (this.raf || !this.playing || this.blocked || this.reduced) return;
    this.last = performance.now();
    const frame = (now: number) => {
      this.elapsed += now - this.last; this.last = now;
      if (this.elapsed >= this.duration) {
        if (this.loop) this.elapsed %= this.duration;
        else { this.elapsed = this.duration; this.playing = false; }
      }
      this.paint(this.elapsed);
      this.raf = 0;
      if (this.playing) this.raf = requestAnimationFrame(frame);
      else this.changed();
    };
    this.raf = requestAnimationFrame(frame);
  }
}
