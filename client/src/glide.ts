/** Render-only position tweens: a node whose stored position changed is
 *  drawn gliding from where it was to where it is (G2 holds once settled). */
export interface XY {
  x: number;
  y: number;
}

export const GLIDE_MS = 240;

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

interface Track {
  from: XY;
  to: XY;
  start: number;
}

export class Glide {
  private tracks = new Map<bigint, Track>();

  private at(t: Track, now: number): XY {
    const k = easeOut(Math.min(1, Math.max(0, (now - t.start) / GLIDE_MS)));
    return { x: t.from.x + (t.to.x - t.from.x) * k, y: t.from.y + (t.to.y - t.from.y) * k };
  }

  begin(moves: Array<{ id: bigint; from: XY; to: XY }>, now: number): void {
    for (const m of moves) {
      const prev = this.tracks.get(m.id);
      const from = prev !== undefined && now - prev.start < GLIDE_MS ? this.at(prev, now) : m.from;
      this.tracks.set(m.id, { from, to: m.to, start: now });
    }
  }

  /** Drop a node's track: a local gesture now owns its position. */
  cancel(id: bigint): void {
    this.tracks.delete(id);
  }

  /** Jump every glide to its end (export reads settled positions). */
  clear(): void {
    this.tracks.clear();
  }

  frame(now: number): Map<bigint, XY> {
    const out = new Map<bigint, XY>();
    for (const [id, t] of this.tracks) {
      if (now - t.start >= GLIDE_MS) {
        this.tracks.delete(id);
      } else {
        out.set(id, this.at(t, now));
      }
    }
    return out;
  }

  /** One render frame: positions to draw, and whether the glide is over. The
   *  step that reports done has no positions, so drawing it is the clean settle. */
  step(now: number): { positions: Map<bigint, XY>; done: boolean } {
    const positions = this.frame(now);
    return { positions, done: this.tracks.size === 0 };
  }

  active(now: number): boolean {
    for (const t of this.tracks.values()) {
      if (now - t.start < GLIDE_MS) {
        return true;
      }
    }
    return false;
  }
}
