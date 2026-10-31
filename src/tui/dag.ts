import type { AgentState } from "../contracts/types.js";
import { Canvas, clip, S, st } from "./canvas.js";

export interface DagNode {
  id: string;
  title: string;
  role: string;
  deps: string[];
  state: AgentState;
  /** 0..1 through the task pipeline, or null when not started. */
  progress?: number | null;
}

const PHASE_AT: Record<string, number> = { reading: 0.1, planning: 0.2, editing: 0.45, testing: 0.65, reporting: 0.75 };

/** How far an agent is through its pipeline: work (phase / acceptance criteria) → verify → review → merge. */
export function progressOf(state: AgentState, phase?: string | null, prog?: { done: number; total: number } | null, prev = 0): number | null {
  switch (state) {
    case "queued": return null;
    case "starting": return 0.03;
    case "verifying": return 0.82;
    case "reviewing": return 0.9;
    case "merging": return 0.97;
    case "done": return 1;
    default: {
      const ac = prog && prog.total ? 0.1 + 0.65 * (prog.done / prog.total) : 0;
      return Math.max(0.05, PHASE_AT[phase ?? ""] ?? 0.05, ac, Math.min(prev, 0.8));
    }
  }
}

/** "━━━━━━──── 60%" in `w` cells. */
export function bar(p: number, w: number): { fill: string; rest: string; label: string } {
  const label = ` ${Math.round(p * 100)}%`;
  const n = Math.max(1, w - label.length);
  const f = Math.round(p * n);
  return { fill: "━".repeat(f), rest: "─".repeat(n - f), label };
}

export const STATE_GLYPH: Record<AgentState, string> = {
  queued: "○", starting: "◔", running: "●", waiting_input: "?", paused: "‖",
  verifying: "◑", reviewing: "◐", merging: "⇢", done: "✔", failed: "✖", blocked: "⊘", cancelled: "−",
};

export const STATE_COLOR: Record<AgentState, string> = {
  queued: S.gray, starting: S.cyan, running: S.blue, waiting_input: S.orange, paused: S.magenta,
  verifying: S.cyan, reviewing: S.cyan, merging: S.cyan, done: S.green, failed: S.red, blocked: S.orange, cancelled: S.gray,
};

export const ACTIVE: ReadonlySet<AgentState> = new Set(["starting", "running", "verifying", "reviewing", "merging"]);
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

export interface DagRenderOptions {
  maxW: number;
  maxH: number;
  frame: number;
  selected?: string | null;
}

/** Render the task DAG as boxes and arrows. */
export function renderDag(nodes: DagNode[], o: DagRenderOptions): Canvas {
  if (!nodes.length) return new Canvas(Math.max(1, o.maxW), 1);
  const { layers, edges } = layout(nodes);
  const nL = layers.length;
  const G = 5;
  const boxW = Math.max(16, Math.min(30, Math.floor((o.maxW - (nL - 1) * G) / nL)));
  const rows = Math.max(...layers.map((l) => l.length));
  const normal = rows * 5 - 1 <= o.maxH;
  const boxH = normal ? 4 : 3;
  const slot = normal ? 5 : 3;
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
    if (!realOf(a)) hseg(pa.x, sx, pa.mid, style, r);
    if (pa.mid === pb.mid) hseg(sx, tx, pa.mid, style, r);
    else {
      hseg(sx, bus, pa.mid, style, r);
      vseg(bus, pa.mid, pb.mid, style, r);
      hseg(bus, tx, pb.mid, style, r);
    }
    // Make the junction where bus meets segments correct.
    if (pa.mid !== pb.mid) {
      mark(bus, pa.mid, L | (pb.mid > pa.mid ? D : U), style, r);
      mark(bus, pb.mid, R | (pb.mid > pa.mid ? U : D), style, r);
    }
    if (bReal) arrows.push({ x: tx, y: pb.mid, style });
    else hseg(pb.x, pb.x + boxW - 1, pb.mid, style, r);
  }
  for (const [k, bits] of mask) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    c.set(x, y, LINE[bits] ?? "┼", styleAt.get(k) ?? S.gray);
  }
  for (const a of arrows) c.set(a.x, a.y, "▶", a.style);

  // Boxes.
  for (const layer of layers) {
    for (const n of layer) {
      if (!n.real) continue;
      const p = pos.get(n.key)!;
      const node = n.real;
      const sel = o.selected === node.id;
      const color = STATE_COLOR[node.state];
      const border = sel ? st(S.white, S.bold) : color;
      c.fill(p.x + 1, p.y + 1, boxW - 2, boxH - 2, sel ? S.bgSel : "");
      c.box(p.x, p.y, boxW, boxH, border);
      const g = glyph(node.state, o.frame);
      const inner = boxW - 4;
      const bg = sel ? S.bgSel : "";
      if (node.progress != null && boxW >= 12) {
        const b = bar(node.progress, boxW - 4);
        let bx = c.text(p.x + 2, p.y + boxH - 1, b.fill, color);
        bx = c.text(bx, p.y + boxH - 1, b.rest, st(S.gray, S.dim));
        c.text(bx, p.y + boxH - 1, b.label, node.state === "done" ? S.green : S.gray);
      }
      if (normal) {
        let x = c.text(p.x + 2, p.y + 1, g, st(color, bg));
        x = c.text(x + 1, p.y + 1, node.id, st(S.bold, bg), p.x + boxW - 2);
        c.text(x + 1, p.y + 1, clip(node.role, Math.max(0, p.x + boxW - 3 - x)), st(S.gray, bg), p.x + boxW - 2);
        c.text(p.x + 2, p.y + 2, clip(node.title, inner), st(node.state === "queued" ? S.gray : "", bg), p.x + boxW - 2);
      } else {
        let x = c.text(p.x + 2, p.y + 1, g, st(color, bg));
        x = c.text(x + 1, p.y + 1, node.id, st(S.bold, bg), p.x + boxW - 2);
        c.text(x + 1, p.y + 1, clip(node.title, Math.max(0, p.x + boxW - 3 - x)), st(S.gray, bg), p.x + boxW - 2);
      }
    }
  }
  return c;
}
