import { Canvas, clip, st } from "./canvas.js";

/**
 * Regular hexagons on a character grid.
 *
 * A terminal cell is taller than wide (`aspect` = cell height / cell width, ~2 for most fonts). A flat-topped regular
 * hexagon of side s has a top/bottom edge of length s and four slanted edges of length s. In cells:
 *   - r rows per slanted half (total height 2r rows), k columns of horizontal shift per row,
 *   - one slanted edge covers r rows × k columns → physical length r·√(k² + aspect²) (width unit = 1 cell width),
 *   - so the horizontal edge is t = round(r·√(k² + aspect²)) cells,
 *   - total width w = t + 2·r·k.
 * k is chosen so the slant is as close to 60° as the grid allows.
 */
export interface HexMetrics {
  r: number; k: number; aspect: number;
  /** Cell width and height of the whole hexagon. */
  w: number; h: number;
  /** Horizontal edge length in cells (physical length = top, in cell widths). */
  top: number;
  /** Physical lengths (in cell widths) of the horizontal and the slanted edges; equal for a regular hexagon. */
  topLen: number; slantLen: number;
}

export function hexMetrics(r: number, aspect = 2): HexMetrics {
  const k = Math.max(1, Math.round(aspect / Math.sqrt(3)));
  const slantLen = r * Math.hypot(k, aspect);
  const top = Math.max(2, Math.round(slantLen));
  return { r, k, aspect, w: top + 2 * r * k, h: 2 * r, top, topLen: top, slantLen };
}

/** Relative difference between the longest and shortest side: 0 = perfectly regular. */
export function irregularity(m: HexMetrics): number {
  const lens = [m.topLen, m.slantLen];
  return (Math.max(...lens) - Math.min(...lens)) / Math.max(...lens);
}

/** Cell-aspect from the environment (HEXAGON_CELL_ASPECT) or a sensible default. */
export function cellAspect(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.HEXAGON_CELL_ASPECT);
  return Number.isFinite(v) && v >= 1 && v <= 4 ? v : 2;
}

/** Columns of the left/right outline in row `j` (0 = top edge row), or null on the horizontal edges. */
function slantOffset(m: HexMetrics, j: number): number | null {
  if (j <= 0 || j >= m.h - 1) return null;
  return (j < m.r ? m.r - j : j - m.r + 1) * m.k;
}

/** Usable text width of inner row `j` (exclusive of the outline cells). */
export function innerWidth(m: HexMetrics, j: number): number {
  const d = slantOffset(m, j);
  return d === null ? 0 : Math.max(0, m.w - 2 * d - 2);
}

/** Draw the outline at (x, y); returns the outline cells clockwise (for orbiting particles). */
export function drawHexagon(c: Canvas, x: number, y: number, m: HexMetrics, style: string, dashed = false): [number, number][] {
  const edge = dashed ? "╌" : "─";
  const ring: [number, number][] = [];
  const left = m.r * m.k;
  for (let i = 0; i < m.top; i++) { c.set(x + left + i, y, edge, style); ring.push([x + left + i, y]); }
  for (let j = 1; j < m.h - 1; j++) {
    const d = slantOffset(m, j)!;
    const upper = j < m.r;
    c.set(x + d - (upper ? 0 : 0), y + j, upper ? "╱" : "╲", style);
    c.set(x + m.w - 1 - d, y + j, upper ? "╲" : "╱", style);
  }
  for (let j = 1; j < m.h - 1; j++) { const d = slantOffset(m, j)!; ring.push([x + m.w - 1 - d, y + j]); }
  for (let i = m.top - 1; i >= 0; i--) { c.set(x + left + i, y + m.h - 1, edge, style); ring.push([x + left + i, y + m.h - 1]); }
  for (let j = m.h - 2; j >= 1; j--) ring.push([x + slantOffset(m, j)!, y + j]);
  return ring;
}

export interface HexLabel { text: string; style: string; key: string }

/**
 * Put labels into the inner rows, dropping low-priority ones when rows are scarce. Labels are given top→bottom with a
 * `key`; `priority` lists keys from most to least important.
 */
export function placeLabels(c: Canvas, x: number, y: number, m: HexMetrics, labels: HexLabel[], priority: string[]): void {
  const rows = m.h - 2;
  let keep = labels.slice();
  while (keep.length > rows) {
    const drop = [...priority].reverse().find((p) => keep.some((l) => l.key === p));
    keep = keep.filter((l) => l.key !== drop);
    if (!drop) keep.pop();
  }
  const start = 1 + Math.floor((rows - keep.length) / 2);
  keep.forEach((l, i) => {
    const j = start + i;
    const wMax = innerWidth(m, j);
    if (wMax <= 0) return;
    const text = clip(l.text, wMax);
    const d = slantOffset(m, j)!;
    const offset = d + 1 + Math.floor((wMax - [...text].length) / 2);
    c.text(x + offset, y + j, text, l.style, x + m.w - 1 - d);
  });
}
