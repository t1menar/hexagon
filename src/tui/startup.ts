/**
 * Short brand sequence: a hexagon appears, six neighbours bond to it, a molecular lattice forms, the name resolves,
 * then the dashboard is revealed. Pure function of elapsed time → deterministic and testable.
 */
import { Canvas, st } from "./canvas.js";
import { ease } from "./motion.js";
import { mix, sgr, TOKENS, type Caps } from "./theme.js";

export const STARTUP_MS = 1500;
const REVEAL_FROM = 1150;

export function startupProgress(t: number): { sequence: number; reveal: number; done: boolean } {
  return { sequence: Math.min(1, t / REVEAL_FROM), reveal: ease.inOutCubic(Math.min(1, Math.max(0, (t - REVEAL_FROM) / (STARTUP_MS - REVEAL_FROM)))), done: t >= STARTUP_MS };
}

/** Axial lattice (flat-top) in cell coordinates for terminal aspect `a` (cell height / width). */
function lattice(q: number, r: number, size: number, a: number): [number, number] {
  return [Math.round(1.5 * size * q), Math.round((Math.sqrt(3) * size * (r + q / 2)) / a)];
}
const RING1: [number, number][] = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const RING2: [number, number][] = [[2, 0], [1, 1], [0, 2], [-1, 2], [-2, 2], [-2, 1], [-2, 0], [-1, -1], [0, -2], [1, -2], [2, -2], [2, -1]];

export function renderStartup(W: number, H: number, t: number, caps: Caps, aspect = 2): Canvas {
  const c = new Canvas(W, H);
  const d = caps.color;
  const size = Math.max(3, Math.min(6, Math.floor(Math.min(W / 16, (H * aspect) / 9))));
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2) - 1;
  const put = (x: number, y: number, ch: string, col: readonly [number, number, number], bold = false) => c.set(cx + x, cy + y, ch, st(sgr(col, d), bold ? "1" : ""));
  const hexCh = caps.unicode ? ["⬢", "⬡"] : ["O", "o"];
  const line = (x1: number, y1: number, x2: number, y2: number, k: number, col: readonly [number, number, number]) => {
    const n = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1) * 2);
    const upto = Math.floor(n * k);
    for (let i = 1; i < Math.min(upto, n); i++) put(Math.round(x1 + ((x2 - x1) * i) / n), Math.round(y1 + ((y2 - y1) * i) / n), caps.unicode ? "·" : ".", col);
  };
  const k0 = ease.outCubic(Math.min(1, t / 250));
  const k1 = ease.inOutCubic(Math.min(1, Math.max(0, (t - 220) / 400)));
  const k2 = ease.inOutCubic(Math.min(1, Math.max(0, (t - 560) / 450)));
  const k3 = Math.min(1, Math.max(0, (t - 800) / 350));
  const faint = mix(TOKENS.surface2, TOKENS.border, 0.9);
  if (k2 > 0) for (const [q, r] of RING2) { const [x, y] = lattice(q, r, size, aspect); if (k2 > 0.25) put(x, y, hexCh[1]!, mix(faint, TOKENS.brand, k2 * 0.7)); }
  for (const [q, r] of RING1) {
    const [x, y] = lattice(q, r, size, aspect);
    line(0, 0, x, y, k1, mix(faint, TOKENS.brand, 0.7));
    if (k1 > 0.85) put(x, y, hexCh[0]!, mix(TOKENS.brand2, TOKENS.brand, 0.3), true);
  }
  put(0, 0, hexCh[0]!, mix(TOKENS.surface2, TOKENS.brand, k0), true);
  const title = "H E X A G O N";
  const tx = -Math.floor(title.length / 2);
  for (let i = 0; i < title.length; i++) {
    const lag = Math.min(1, Math.max(0, k3 * 1.6 - (i / title.length) * 0.6));
    if (lag > 0) c.set(cx + tx + i, cy + Math.max(3, Math.round((Math.sqrt(3) * size * 2.6) / aspect)), title[i]!, st(sgr(mix(TOKENS.surface2, TOKENS.text, lag), d), "1"));
  }
  return c;
}
