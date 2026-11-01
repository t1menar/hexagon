import type { AgentState } from "../contracts/types.js";
import { Canvas, clip, S, st } from "./canvas.js";
import { cellAspect, drawHexagon, hexMetrics, placeLabels, type HexLabel, type HexMetrics } from "./hex.js";

export interface DagNode {
  id: string;
  title: string;
  role: string;
  deps: string[];
  state: AgentState;
  /** 0..1 through the task pipeline, or null when not started. */
  progress?: number | null;
  /** Vendor and CLI of the agent (from its status); undefined until an agent exists. */
  provider?: string | null;
  cli?: string | null;
  /** Model the running process reported. null/undefined = not reported: shown as "CLI-managed", never guessed. */
  runtimeModel?: string | null;
  /** Provider-limit wait summary, e.g. "resumes 15:04 (est.)". */
  quota?: string | null;
  fixCycle?: number | null;
}

/**
 * How far a task is, from what is actually known: the stage it is in, and inside "working" the share of its acceptance
 * criteria that are done. Nothing is invented: with no criteria the work stage reports its floor, not a guess. It can go
 * down (a fix cycle returns to work), because the task really did.
 *
 *   preparing 0–5% · working 5–65% (by criteria) · verifying 70% · reviewing 85% · integrating 97% · done 100%
 */
export const STAGE_AT = { prepared: 0.05, worked: 0.65, verifying: 0.7, reviewing: 0.85, integrating: 0.97 } as const;

export function progressOf(state: AgentState, prog?: { done: number; total: number } | null): number | null {
  switch (state) {
    case "queued": return null;
    case "preparing": return 0.02;
    case "verifying": return STAGE_AT.verifying;
    case "reviewing": return STAGE_AT.reviewing;
    case "integrating": return STAGE_AT.integrating;
    case "done": return 1;
    default: {
      // working, fixing, and the parked/failed states: where its criteria stand
      const frac = prog && prog.total ? Math.min(1, prog.done / prog.total) : 0;
      return STAGE_AT.prepared + (STAGE_AT.worked - STAGE_AT.prepared) * frac;
    }
  }
}

/** Overall progress of a set of tasks: the mean of their progress (queued counts 0, done counts 1). */
export function overallProgress(ps: (number | null)[]): number {
  return ps.length ? ps.reduce<number>((a, p) => a + (p ?? 0), 0) / ps.length : 0;
}

/**
 * Transitive reduction: drop a dependency when another dependency of the same task already leads to it. The order is
 * unchanged, the picture loses its redundant long edges. Unknown ids and cycles are left as they are.
 */
export function reduceDeps<T extends { id: string; deps: string[] }>(nodes: T[]): T[] {
  const deps = new Map(nodes.map((n) => [n.id, n.deps.filter((d) => nodes.some((m) => m.id === d))]));
  const memo = new Map<string, Set<string>>();
  const reach = (id: string, stack = new Set<string>()): Set<string> => {
    const known = memo.get(id);
    if (known) return known;
    const out = new Set<string>();
    if (stack.has(id)) return out; // cycle guard
    stack.add(id);
    for (const d of deps.get(id) ?? []) { out.add(d); for (const x of reach(d, stack)) out.add(x); }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  return nodes.map((n) => {
    const own = deps.get(n.id)!;
    const kept = own.filter((d) => !own.some((o) => o !== d && reach(o).has(d)));
    return kept.length === own.length ? n : { ...n, deps: [...n.deps.filter((d) => !deps.get(n.id)!.includes(d)), ...kept] };
  });
}

/** "━━━━━━──── 60%" in `w` cells. */
export function bar(p: number, w: number): { fill: string; rest: string; label: string } {
  const label = ` ${Math.round(p * 100)}%`;
  const n = Math.max(1, w - label.length);
  const f = Math.round(p * n);
  return { fill: "━".repeat(f), rest: "─".repeat(n - f), label };
}

export const STATE_GLYPH: Record<AgentState, string> = {
  queued: "○", preparing: "◔", working: "●", waiting_input: "?", paused: "‖", waiting_quota: "⏳",
  verifying: "◑", reviewing: "◐", fixing: "↺", integrating: "⇢", done: "✔", failed: "✖", blocked: "⊘", cancelled: "−",
};

export const STATE_COLOR: Record<AgentState, string> = {
  queued: S.gray, preparing: S.cyan, working: S.blue, waiting_input: S.orange, paused: S.magenta, waiting_quota: S.orange,
  verifying: S.cyan, reviewing: S.cyan, fixing: S.orange, integrating: S.cyan, done: S.green, failed: S.red, blocked: S.orange, cancelled: S.gray,
};

export const ACTIVE: ReadonlySet<AgentState> = new Set(["preparing", "working", "fixing", "verifying", "reviewing", "integrating"]);
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinner = (frame: number) => SPIN[frame % SPIN.length]!;

export function glyph(state: AgentState, frame: number): string {
  return ACTIVE.has(state) ? spinner(frame) : STATE_GLYPH[state];
}

interface LNode { key: string; layer: number; real: DagNode | null }

/** Longest-path layering + dummy nodes for long edges + barycenter ordering. */
export function layout(nodes: DagNode[]): { layers: LNode[][]; edges: [string, string][] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (n: DagNode): number => {
    const known = layerOf.get(n.id);
    if (known !== undefined) return known;
    if (visiting.has(n.id)) return 0; // cycle guard
    visiting.add(n.id);
    const deps = n.deps.map((d) => byId.get(d)).filter((d): d is DagNode => Boolean(d));
    const l = deps.length ? Math.max(...deps.map(depth)) + 1 : 0;
    visiting.delete(n.id);
    layerOf.set(n.id, l);
    return l;
  };
  nodes.forEach(depth);
  const maxLayer = Math.max(0, ...layerOf.values());
  const layers: LNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) layers[layerOf.get(n.id)!]!.push({ key: n.id, layer: layerOf.get(n.id)!, real: n });
  const edges: [string, string][] = [];
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!byId.has(d)) continue;
      const from = layerOf.get(d)!;
      const to = layerOf.get(n.id)!;
      let prev = d;
      for (let l = from + 1; l < to; l++) {
        const key = `${d}>${n.id}#${l}`;
        layers[l]!.push({ key, layer: l, real: null });
        edges.push([prev, key]);
        prev = key;
      }
      edges.push([prev, n.id]);
    }
  }
  // Barycenter sweeps to reduce crossings.
  const preds = new Map<string, string[]>();
  for (const [a, b] of edges) preds.set(b, [...(preds.get(b) ?? []), a]);
  for (let pass = 0; pass < 3; pass++) {
    for (let l = 1; l < layers.length; l++) {
      const prevIdx = new Map(layers[l - 1]!.map((n, i) => [n.key, i]));
      const bary = new Map(layers[l]!.map((n, i) => {
        const ps = (preds.get(n.key) ?? []).map((p) => prevIdx.get(p)).filter((x): x is number => x !== undefined);
        return [n.key, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : i];
      }));
      layers[l]!.sort((a, b) => bary.get(a.key)! - bary.get(b.key)!);
    }
  }
  return { layers, edges };
}

const U = 1, R = 2, D = 4, L = 8;
const LINE: Record<number, string> = {
  [R | L]: "─", [R]: "─", [L]: "─", [U | D]: "│", [U]: "│", [D]: "│",
  [R | D]: "╭", [L | D]: "╮", [U | R]: "╰", [U | L]: "╯",
  [U | D | R]: "├", [U | D | L]: "┤", [L | R | D]: "┬", [L | R | U]: "┴", [U | D | L | R]: "┼",
};

/** Finished links are drawn as double bonds. */
const DOUBLE: Record<string, string> = { "─": "═", "│": "║", "╭": "╔", "╮": "╗", "╰": "╚", "╯": "╝", "├": "╠", "┤": "╣", "┬": "╦", "┴": "╩", "┼": "╬" };

/** Cells of a hexagon's outline, clockwise from the top-left edge (for the orbiting electron). */
function perimeter(x: number, y: number, w: number, h: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = x + 1; i <= x + w - 2; i++) out.push([i, y]);
  for (let j = y + 1; j <= y + h - 2; j++) out.push([x + w - 1, j]);
  for (let i = x + w - 2; i >= x + 1; i--) out.push([i, y + h - 1]);
  for (let j = y + h - 2; j >= y + 1; j--) out.push([x, j]);
  return out;
}

/**
 * A hexagonal node:   ╱──────────╲
 *                    ╱ ● Title    ╲
 *                    ╲ T-1 · role ╱
 *                     ╲──────────╱
 */
function hexagon(c: Canvas, x: number, y: number, w: number, h: number, style: string, dashed: boolean) {
  const edge = dashed ? "╌" : "─";
  c.set(x + 1, y, "╱", style);
  for (let i = x + 2; i <= x + w - 3; i++) c.set(i, y, edge, style);
  c.set(x + w - 2, y, "╲", style);
  const mid = h - 2;
  for (let j = 0; j < mid; j++) {
    const upper = j < Math.ceil(mid / 2);
    const one = mid === 1;
    c.set(x, y + 1 + j, one ? "<" : upper ? "╱" : "╲", style);
    c.set(x + w - 1, y + 1 + j, one ? ">" : upper ? "╲" : "╱", style);
  }
  c.set(x + 1, y + h - 1, "╲", style);
  for (let i = x + 2; i <= x + w - 3; i++) c.set(i, y + h - 1, edge, style);
  c.set(x + w - 2, y + h - 1, "╱", style);
}

export interface DagRenderOptions {
  maxW: number;
  maxH: number;
  frame: number;
  selected?: string | null;
  /** Cell height ÷ width. Default from HEXAGON_CELL_ASPECT or 2. */
  aspect?: number;
  /** Animations off: static glyphs, no orbiting particles. */
  still?: boolean;
}

/** Render the task DAG as a molecule: hexagonal agents joined by bonds. */
export function renderDag(nodes: DagNode[], o: DagRenderOptions): Canvas {
  if (!nodes.length) return new Canvas(Math.max(1, o.maxW), 1);
  const { layers, edges } = layout(nodes);
  const nL = layers.length;
  const G = 5;
  const boxW0 = Math.max(16, Math.min(30, Math.floor((o.maxW - (nL - 1) * G) / nL)));
  const rows = Math.max(...layers.map((l) => l.length));
  // Regular hexagons, as large as the terminal allows; the old compact node is the last resort.
  const aspect = o.aspect ?? cellAspect();
  let hex: HexMetrics | null = null;
  for (const r of [5, 4, 3, 2]) {
    const m = hexMetrics(r, aspect);
    if (nL * m.w + (nL - 1) * G <= o.maxW && rows * (m.h + 1) - 1 <= o.maxH) { hex = m; break; }
  }
  const normal = hex ? false : rows * 5 - 1 <= o.maxH;
  const boxW = hex ? hex.w : boxW0;
  const boxH = hex ? hex.h : normal ? 4 : 3;
  const slot = hex ? hex.h + 1 : normal ? 5 : 3;
  const width = Math.min(o.maxW, nL * boxW + (nL - 1) * G);
  const height = Math.min(o.maxH, rows * slot - (slot - boxH));
  const c = new Canvas(Math.max(1, width), Math.max(1, height));

  const pos = new Map<string, { x: number; y: number; mid: number }>();
  layers.forEach((layer, li) => {
    const offset = Math.floor(((rows - layer.length) * slot) / 2);
    layer.forEach((n, i) => {
      const x = li * (boxW + G);
      const y = offset + i * slot;
      pos.set(n.key, { x, y, mid: y + Math.floor(boxH / 2) });
    });
  });
  const realOf = (key: string): DagNode | null => layers.flat().find((n) => n.key === key)?.real ?? null;
  const sourceOf = (key: string): DagNode | null => {
    const r = realOf(key);
    if (r) return r;
    return nodes.find((n) => n.id === key.split(">")[0]) ?? null;
  };

  // Edges as line masks.
  const mask = new Map<string, number>();
  const rank = new Map<string, number>();
  const styleAt = new Map<string, string>();
  const mark = (x: number, y: number, bits: number, style: string, r: number) => {
    const k = `${x},${y}`;
    mask.set(k, (mask.get(k) ?? 0) | bits);
    if ((rank.get(k) ?? -1) < r) { rank.set(k, r); styleAt.set(k, style); }
  };
  const hseg = (x1: number, x2: number, y: number, style: string, r: number) => {
    const [a, b] = x1 <= x2 ? [x1, x2] : [x2, x1];
    for (let x = a; x <= b; x++) mark(x, y, (x < b ? R : 0) | (x > a ? L : 0) || (R | L), style, r);
  };
  const vseg = (x: number, y1: number, y2: number, style: string, r: number) => {
    const [a, b] = y1 <= y2 ? [y1, y2] : [y2, y1];
    for (let y = a; y <= b; y++) mark(x, y, (y < b ? D : 0) | (y > a ? U : 0), style, r);
  };
  const arrows: { x: number; y: number; style: string }[] = [];
  /** Cells of bonds into working agents, in flow order: electrons travel along them. */
  const flows: { cells: [number, number][]; style: string }[] = [];
  for (const [a, b] of edges) {
    const pa = pos.get(a)!;
    const pb = pos.get(b)!;
    const src = sourceOf(a);
    const dst = nodes.find((n) => n.id === b.split("#")[0]!.split(">").at(-1));
    const r = dst && ACTIVE.has(dst.state) ? 2 : src?.state === "done" ? 1 : 0;
    const style = r === 2 ? STATE_COLOR[dst!.state] : r === 1 ? st(S.green, S.dim) : S.gray;
    const sx = pa.x + boxW;
    const bus = sx + Math.floor(G / 2);
    const bReal = realOf(b) !== null;
    const tx = bReal ? pb.x - 1 : pb.x;
    const path: [number, number][] = [];
    const run = (x1: number, x2: number, y: number) => { for (let x = x1; x1 <= x2 ? x <= x2 : x >= x2; x += x1 <= x2 ? 1 : -1) path.push([x, y]); };
    const col = (x: number, y1: number, y2: number) => { for (let y = y1; y1 <= y2 ? y <= y2 : y >= y2; y += y1 <= y2 ? 1 : -1) path.push([x, y]); };
    if (!realOf(a)) { hseg(pa.x, sx, pa.mid, style, r); run(pa.x, sx - 1, pa.mid); }
    if (pa.mid === pb.mid) { hseg(sx, tx, pa.mid, style, r); run(sx, tx, pa.mid); }
    else {
      hseg(sx, bus, pa.mid, style, r);
      vseg(bus, pa.mid, pb.mid, style, r);
      hseg(bus, tx, pb.mid, style, r);
      run(sx, bus - 1, pa.mid); col(bus, pa.mid, pb.mid); run(bus + 1, tx, pb.mid);
    }
    // Make the junction where bus meets segments correct.
    if (pa.mid !== pb.mid) {
      mark(bus, pa.mid, L | (pb.mid > pa.mid ? D : U), style, r);
      mark(bus, pb.mid, R | (pb.mid > pa.mid ? U : D), style, r);
    }
    if (bReal) arrows.push({ x: tx, y: pb.mid, style });
    else { hseg(pb.x, pb.x + boxW - 1, pb.mid, style, r); run(pb.x, pb.x + boxW - 1, pb.mid); }
    if (r === 2) flows.push({ cells: path, style });
  }
  for (const [k, bits] of mask) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    const ch = LINE[bits] ?? "┼";
    c.set(x, y, rank.get(k) === 1 ? DOUBLE[ch] ?? ch : ch, styleAt.get(k) ?? S.gray);
  }
  for (const a of arrows) c.set(a.x, a.y, "▸", a.style);
  // Electrons flow along bonds into working agents.
  for (const f of o.still ? [] : flows) {
    const n = f.cells.length;
    if (n < 3) continue;
    for (let k = Math.floor(o.frame / 2) % 6; k < n - 1; k += 6) c.set(f.cells[k]![0], f.cells[k]![1], "•", st(f.style, S.bold));
  }

  // Boxes.
  for (const layer of layers) {
    for (const n of layer) {
      if (!n.real) continue;
      const p = pos.get(n.key)!;
      const node = n.real;
      const sel = o.selected === node.id;
      const color = STATE_COLOR[node.state];
      const live = ACTIVE.has(node.state) || node.state === "waiting_input";
      // Working agents "resonate": the outline brightens and dims.
      const border = sel ? st(S.white, S.bold) : live && !o.still && Math.floor(o.frame / 6) % 2 ? st(color, S.bold) : color;
      const g = o.still && ACTIVE.has(node.state) ? STATE_GLYPH[node.state] : glyph(node.state, o.frame);
      if (hex) {
        const ring = drawHexagon(c, p.x, p.y, hex, border, node.state === "queued");
        const sty = (...x: string[]) => st(...x, sel ? S.bgSel : "");
        const labels: HexLabel[] = [
          { key: "id", text: node.id, style: sty(S.bold) },
          { key: "role", text: node.role, style: sty(S.cyan) },
          { key: "title", text: node.title, style: sty(S.white) },
          { key: "provider", text: [node.provider, node.cli].filter(Boolean).join(" · ") || "no agent yet", style: sty(S.gray) },
          { key: "model", text: node.provider || node.cli ? (node.runtimeModel ? node.runtimeModel : "CLI-managed") : "", style: sty(S.gray) },
          { key: "state", text: `${g} ${node.quota ? node.quota : node.state.replace(/_/g, " ")}${node.fixCycle ? ` ·fix ${node.fixCycle}` : ""}`, style: sty(color, S.bold) },
          { key: "bar", text: node.progress != null ? ((b) => `${b.fill}${b.rest}${b.label}`)(bar(node.progress, Math.max(6, hex.top))) : "", style: sty(color) },
        ].filter((l) => l.text);
        placeLabels(c, p.x, p.y, hex, labels, ["id", "state", "role", "bar", "provider", "model", "title"]);
        if (!o.still && (ACTIVE.has(node.state) || node.state === "waiting_quota")) {
          const at = Math.floor(o.frame / (node.state === "waiting_quota" ? 3 : 1)) % ring.length;
          const [tx, ty] = ring[(at + ring.length - 1) % ring.length]!;
          c.set(tx, ty, "•", st(color, S.dim));
          c.set(ring[at]![0], ring[at]![1], node.state === "waiting_quota" ? "◌" : "●", st(color, S.bold));
        }
        continue;
      }
      c.fill(p.x + 1, p.y + 1, boxW - 2, boxH - 2, sel ? S.bgSel : "");
      hexagon(c, p.x, p.y, boxW, boxH, border, node.state === "queued");
      const inner = boxW - 4;
      const bg = sel ? S.bgSel : "";
      if (node.progress != null && boxW >= 12) {
        const b = bar(node.progress, boxW - 4);
        let bx = c.text(p.x + 2, p.y + boxH - 1, b.fill, color);
        bx = c.text(bx, p.y + boxH - 1, b.rest, st(S.gray, S.dim));
        c.text(bx, p.y + boxH - 1, b.label, node.state === "done" ? S.green : S.gray);
      }
      // An electron orbits a working agent's hexagon (with a short trail).
      if (ACTIVE.has(node.state)) {
        const ring = perimeter(p.x, p.y, boxW, boxH);
        const at = o.frame % ring.length;
        const [tx, ty] = ring[(at + ring.length - 1) % ring.length]!;
        c.set(tx, ty, "•", st(color, S.dim));
        c.set(ring[at]![0], ring[at]![1], "●", st(color, S.bold));
      }
      if (normal) {
        const x = c.text(p.x + 2, p.y + 1, g, st(color, bg));
        c.text(x + 1, p.y + 1, clip(node.title, Math.max(0, p.x + boxW - 3 - x)), st(node.state === "queued" ? S.white : S.bold, bg), p.x + boxW - 2);
        c.text(p.x + 4, p.y + 2, clip(`${node.id} · ${node.role}`, inner - 2), st(S.gray, bg), p.x + boxW - 2);
      } else {
        let x = c.text(p.x + 2, p.y + 1, g, st(color, bg));
        x = c.text(x + 1, p.y + 1, node.id, st(S.bold, bg), p.x + boxW - 2);
        c.text(x + 1, p.y + 1, clip(node.title, Math.max(0, p.x + boxW - 3 - x)), st(S.gray, bg), p.x + boxW - 2);
      }
    }
  }
  return c;
}
