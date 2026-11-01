/**
 * Ambient layer: a few very small hexagons that fade in, drift and dissolve in the empty parts of the network panel.
 * Purely decorative and fully deterministic (a function of time), so tests and snapshots are reproducible. It only ever
 * lands on blank cells with blank neighbours, so it can never touch text, frames, edges or particles.
 */
import { Canvas, st } from "./canvas.js";
import { mix, sgr, TOKENS, type ColorDepth } from "./theme.js";

/** Neighbour offsets of a hexagonal lattice on 2:1 terminal cells. */
const LATTICE: [number, number][] = [[0, 0], [4, 0], [2, 1], [-2, 1], [2, -1]];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AmbientOptions {
  depth: ColorDepth;
  unicode: boolean;
  /** 0..1: how much of the field is shown (reduced while the app is inactive, 0 = nothing). */
  level: number;
  /** Cells the field must stay out of (the graph, overlays). */
  blocked?: (x: number, y: number) => boolean;
}

export class AmbientField {
  constructor(private clusters = 9, private seed = 11) {}

  /** Cells of the clusters alive at `now`, with their brightness. Exposed for tests. */
  cells(w: number, h: number, now: number, level = 1): { x: number; y: number; a: number }[] {
    const out: { x: number; y: number; a: number }[] = [];
    const n = Math.ceil(this.clusters * Math.max(0, Math.min(1, level)));
    for (let i = 0; i < n; i++) {
      const r0 = rng(this.seed * 977 + i);
      const period = 9000 + r0() * 8000;
      const phase = r0() * period;
      const t = now + phase;
      const cycle = Math.floor(t / period);
      const life = (t % period) / period; // 0..1
      const r = rng(this.seed * 7919 + i * 131 + cycle * 17);
      const bx = r() * w, by = r() * h;
      const dx = (r() - 0.5) * 6, dy = (r() - 0.5) * 2; // total drift over a lifetime, in cells
      const size = 1 + Math.floor(r() * 3);
      const a = Math.sin(Math.PI * life) ** 2; // fade in, hold, dissolve
      // Cluster members appear one after another (forming) and leave in the same order (dissolving).
      for (let m = 0; m < size; m++) {
        const k = Math.max(0, Math.min(1, (a - m * 0.18) / 0.5));
        if (k <= 0.02) continue;
        const [ox, oy] = LATTICE[m]!;
        out.push({ x: Math.round(bx + dx * life + ox), y: Math.round(by + dy * life + oy), a: k * 0.55 });
      }
    }
    return out;
  }

  draw(c: Canvas, x0: number, y0: number, w: number, h: number, now: number, o: AmbientOptions): void {
    if (o.level <= 0 || w < 8 || h < 4) return;
    for (const cell of this.cells(w, h, now, o.level)) {
      const x = x0 + cell.x, y = y0 + cell.y;
      if (cell.x < 1 || cell.y < 0 || cell.x >= w - 1 || cell.y >= h) continue;
      if (c.chars[y]?.[x] !== " " || c.chars[y]?.[x - 1] !== " " || c.chars[y]?.[x + 1] !== " ") continue;
      if (o.blocked?.(x, y)) continue;
      const col = mix(TOKENS.surface2, TOKENS.brand, 0.12 + 0.35 * cell.a);
      c.set(x, y, o.unicode ? (cell.a > 0.25 ? "⬡" : "·") : ".", st(sgr(col, o.depth), "2"));
    }
  }
}
