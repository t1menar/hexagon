/**
 * The agent network: regular hexagonal nodes joined by bonds, plus one reviewer satellite per node and an integration
 * hub. Renders into a Canvas and returns the geometry (node rects, edge paths) so the motion layer can run particles
 * along the real connections.
 */
import { Canvas, clip, st } from "./canvas.js";
import { ACTIVE, bar, layout, type DagNode } from "./dag.js";
import { cellAspect, drawHexagon, hexMetrics, placeLabels, type HexLabel, type HexMetrics } from "./hex.js";
import { Path, type Pt } from "./motion.js";
import { asciiFold, STATE_LOOK, sgr, TOKENS, mix, type Caps, type Rgb, type Token } from "./theme.js";

export const INTEGRATION = "∑integration";

export interface NetNode extends DagNode {
  /** Unresolved review rounds shown as a badge; the visual rejection itself is driven by effects. */
  reviewOpen?: number | null;
}

/** Transient visual effects per node, owned by the motion director. */
export interface NodeFx {
  /** 0..1 progress of a one-shot activation sweep around the outline; null = none. */
  sweep?: number | null;
  /** Colour override blended over the outline (0..1). */
  flash?: { color: Rgb; k: number } | null;
  /** Reviewer satellite highlight (0..1). */
  reviewer?: { color: Rgb; k: number } | null;
}

export interface NetOptions {
  maxW: number;
  maxH: number;
  caps: Caps;
  /** Elapsed milliseconds (animation clock). Only used when `still` is false. */
  now: number;
  selected?: string | null;
  aspect?: number;
  still?: boolean;
  fx?: ReadonlyMap<string, NodeFx>;
  /** Integration hub is shown when there is more than one node or the run is active. */
  hub?: boolean;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Geometry {
  canvas: Canvas;
  hex: HexMetrics | null;
  compact: boolean;
  nodes: Map<string, Rect & { cx: number; cy: number }>;
  /** Path of every dependency edge from → to, as drawn. */
  edges: { from: string; to: string; path: Path }[];
  /** Reviewer satellite cell and the stem up to the node's lower edge. */
  reviewers: Map<string, { cell: Pt; stem: Path }>;
}

const U = 1, R = 2, D = 4, L = 8;
const LINE: Record<number, string> = {
  [R | L]: "─", [R]: "─", [L]: "─", [U | D]: "│", [U]: "│", [D]: "│",
  [R | D]: "╭", [L | D]: "╮", [U | R]: "╰", [U | L]: "╯",
  [U | D | R]: "├", [U | D | L]: "┤", [L | R | D]: "┬", [L | R | U]: "┴", [U | D | L | R]: "┼",
};
const DOUBLE: Record<string, string> = { "─": "═", "│": "║", "╭": "╔", "╮": "╗", "╰": "╚", "╯": "╝", "├": "╠", "┤": "╣", "┬": "╦", "┴": "╩", "┼": "╬" };

const G = 6; // columns between layers (room for bonds)

/** Pick the largest regular hexagon that lets the whole graph fit. */
export function fitHex(layers: number, rows: number, maxW: number, maxH: number, aspect: number, sat: boolean): HexMetrics | null {
  for (const r of [5, 4, 3, 2]) {
    const m = hexMetrics(r, aspect);
    const rowH = m.h + (sat ? 4 : 1);
    if (layers * m.w + (layers - 1) * G <= maxW && rows * rowH - 1 <= maxH) return m;
  }
  return null;
}

export function renderNetwork(input: NetNode[], o: NetOptions): Geometry {
  const aspect = o.aspect ?? cellAspect();
  const withHub = (o.hub ?? true) && input.length > 0;
  const hubNode: NetNode | null = withHub
    ? { id: INTEGRATION, title: "integration", role: "integration", deps: input.filter((n) => !input.some((m) => m.deps.includes(n.id))).map((n) => n.id), state: input.every((n) => n.state === "done") ? "done" : input.some((n) => ACTIVE.has(n.state)) ? "merging" : "queued", progress: null }
    : null;
  const nodes: NetNode[] = hubNode ? [...input, hubNode] : input;
  const geom: Geometry = { canvas: new Canvas(1, 1), hex: null, compact: false, nodes: new Map(), edges: [], reviewers: new Map() };
  if (!input.length) { geom.canvas = new Canvas(Math.max(1, o.maxW), 1); return geom; }

  const { layers, edges } = layout(nodes);
  const nL = layers.length;
  const rows = Math.max(...layers.map((l) => l.length));
  let sat = true;
  let hex = fitHex(nL, rows, o.maxW, o.maxH, aspect, true);
  if (!hex) { sat = false; hex = fitHex(nL, rows, o.maxW, o.maxH, aspect, false); }
  const compact = !hex || hex.r <= 2;
  if (!hex) hex = hexMetrics(2, aspect); // too small even for compact: clipped, never malformed
  geom.hex = hex;
  geom.compact = compact;
  const hubHex = hexMetrics(Math.max(2, hex.r - 1), aspect);
  const boxOf = (id: string) => (id === INTEGRATION ? hubHex : hex!);
  const colW = Math.max(hex.w, hubHex.w);
  const slot = hex.h + (sat ? 4 : 1);
  const width = Math.min(o.maxW, nL * colW + (nL - 1) * G);
  const height = Math.min(o.maxH, rows * slot - 1);
  const c = new Canvas(Math.max(1, width), Math.max(1, height));
  geom.canvas = c;
  const depth = o.caps.color;
  const colorOf = (t: Token) => sgr(TOKENS[t], depth);
  const rgbStyle = (rgb: Rgb, ...extra: string[]) => st(sgr(rgb, depth), ...extra);

  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, li) => {
    const offset = Math.floor(((rows - layer.length) * slot) / 2);
    layer.forEach((n, i) => pos.set(n.key, { x: li * (colW + G) + Math.floor((colW - (n.real ? boxOf(n.key).w : 0)) / 2), y: offset + i * slot }));
  });
  const realOf = (key: string) => layers.flat().find((n) => n.key === key)?.real ?? null;
  const midY = (key: string) => { const p = pos.get(key)!; const h = boxOf(key).h; return p.y + Math.floor(h / 2); };

  // ── bonds ──
  const mask = new Map<string, number>();
  const rank = new Map<string, number>();
  const styleAt = new Map<string, string>();
  const mark = (x: number, y: number, bits: number, style: string, r: number) => {
    const k = `${x},${y}`;
    mask.set(k, (mask.get(k) ?? 0) | bits);
    if ((rank.get(k) ?? -1) < r) { rank.set(k, r); styleAt.set(k, style); }
  };
  const segH = (x1: number, x2: number, y: number, s: string, r: number) => { const [a, b] = x1 <= x2 ? [x1, x2] : [x2, x1]; for (let x = a; x <= b; x++) mark(x, y, (x < b ? R : 0) | (x > a ? L : 0) || (R | L), s, r); };
  const segV = (x: number, y1: number, y2: number, s: string, r: number) => { const [a, b] = y1 <= y2 ? [y1, y2] : [y2, y1]; for (let y = a; y <= b; y++) mark(x, y, (y < b ? D : 0) | (y > a ? U : 0), s, r); };
  const stateOf = new Map(nodes.map((n) => [n.id, n.state]));
  const arrows: { x: number; y: number; s: string }[] = [];

  for (const n of nodes) {
    for (const d of n.deps) {
      if (!pos.has(d)) continue;
      // chain d → dummies → n (same keys as layout())
      const chain: string[] = [d];
      const from = layers.findIndex((l) => l.some((x) => x.key === d));
      const to = layers.findIndex((l) => l.some((x) => x.key === n.id));
      for (let l = from + 1; l < to; l++) chain.push(`${d}>${n.id}#${l}`);
      chain.push(n.id);
      const dst = stateOf.get(n.id)!;
      const rk = ACTIVE.has(dst) || dst === "waiting_quota" ? 2 : stateOf.get(d) === "done" ? 1 : 0;
      const tok: Token = rk === 2 ? STATE_LOOK[dst].token : rk === 1 ? "success" : "border";
      const style = colorOf(tok);
      const pts: Pt[] = [];
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i]!, b = chain[i + 1]!;
        const pa = pos.get(a)!, pb = pos.get(b)!;
        const aw = realOf(a) ? boxOf(a).w : colW;
        const sx = realOf(a) ? pa.x + aw : pa.x + colW;
        const ya = midY(a), yb = midY(b);
        const bus = sx + Math.floor(G / 2);
        const tx = realOf(b) ? pb.x - 1 : pb.x;
        if (!realOf(a)) { segH(pa.x, sx, ya, style, rk); pts.push([pa.x, ya]); }
        if (ya === yb) { segH(sx, tx, ya, style, rk); pts.push([sx, ya], [tx, yb]); }
        else {
          segH(sx, bus, ya, style, rk); segV(bus, ya, yb, style, rk); segH(bus, tx, yb, style, rk);
          mark(bus, ya, L | (yb > ya ? D : U), style, rk); mark(bus, yb, R | (yb > ya ? U : D), style, rk);
          pts.push([sx, ya], [bus, ya], [bus, yb], [tx, yb]);
        }
        if (realOf(b) && i === chain.length - 2) arrows.push({ x: tx, y: yb, s: style });
        if (!realOf(b)) { segH(pb.x, pb.x + colW - 1, yb, style, rk); pts.push([pb.x + colW - 1, yb]); }
      }
      geom.edges.push({ from: d, to: n.id, path: new Path(pts) });
    }
  }
  for (const [k, bits] of mask) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    const ch = LINE[bits] ?? "┼";
    c.set(x, y, rank.get(k) === 1 ? DOUBLE[ch] ?? ch : ch, styleAt.get(k) ?? colorOf("border"));
  }
  for (const a of arrows) c.set(a.x, a.y, "▸", a.s);

  // ── nodes ──
  const reduce = o.still || o.caps.motion === "off";
  for (const layer of layers) {
    for (const ln of layer) {
      if (!ln.real) continue;
      const node = ln.real as NetNode;
      const p = pos.get(ln.key)!;
      const m = boxOf(node.id);
      const isHub = node.id === INTEGRATION;
      const look = STATE_LOOK[node.state];
      const fx = o.fx?.get(node.id);
      const sel = o.selected === node.id;
      let base: Rgb = TOKENS[look.token];
      if (fx?.flash) base = mix(base, fx.flash.color, fx.flash.k);
      const selBg = sel ? sgr(TOKENS.surface, depth, true) : "";
      const outline = sel ? st(sgr(TOKENS.text, depth), "1") : st(sgr(base, depth), isHub ? "2" : "");
      if (sel) c.fill(p.x + 2, p.y + 1, m.w - 4, m.h - 2, selBg);
      const ring = drawHexagon(c, p.x, p.y, m, outline, node.state === "queued");
      if (sel) for (const [rx, ry] of ring) c.styles[ry]![rx] = st(c.styles[ry]![rx]!, selBg);
      geom.nodes.set(node.id, { x: p.x, y: p.y, w: m.w, h: m.h, cx: p.x + Math.floor(m.w / 2), cy: p.y + Math.floor(m.h / 2) });

      // labels (information hierarchy: id & state first, then role/provider/model, then title)
      const sty = (...x: string[]) => st(...x, selBg);
      const glyph = o.caps.unicode ? look.symbol : look.ascii;
      const labels: HexLabel[] = isHub
        ? [{ key: "id", text: "INTEGRATION", style: sty(sgr(TOKENS.brand2, depth), "1") }, { key: "state", text: `${glyph} ${look.label}`, style: sty(sgr(base, depth), "1") }]
        : [
          { key: "id", text: node.id, style: sty(sgr(TOKENS.text, depth), "1") },
          { key: "role", text: node.role, style: sty(sgr(TOKENS.brand, depth)) },
          { key: "title", text: node.title, style: sty(sgr(TOKENS.text, depth)) },
          { key: "provider", text: [node.provider, node.cli].filter(Boolean).join(" · ") || "no agent yet", style: sty(sgr(TOKENS.muted, depth)) },
          { key: "model", text: node.provider || node.cli ? (node.runtimeModel ? node.runtimeModel : "CLI-managed") : "", style: sty(sgr(TOKENS.muted, depth)) },
          { key: "state", text: node.quota ? `${glyph} ${node.quota}` : `${glyph} ${compact ? look.label.split(" ")[0] : look.label}${node.fixCycle ? ` ·fix ${node.fixCycle}` : ""}`, style: sty(sgr(base, depth), "1") },
          { key: "bar", text: node.progress != null ? ((b) => `${b.fill}${b.rest}${b.label}`)(bar(node.progress, Math.max(6, m.top))) : "", style: sty(sgr(base, depth)) },
        ].filter((l) => l.text);
      placeLabels(c, p.x, p.y, m, labels, ["id", "state", "role", "bar", "provider", "model", "title"]);

      // perimeter highlight: activity arc and one-shot activation sweep
      if (!reduce && ring.length) {
        const arc = (head: number, len: number, col: Rgb, bold: boolean) => {
          for (let i = 0; i < len; i++) {
            const [rx, ry] = ring[(((head - i) % ring.length) + ring.length) % ring.length]!;
            const k = 1 - i / len;
            if (rx < 0 || rx >= c.w || !c.styles[ry]) continue;
            c.styles[ry]![rx] = st(sgr(mix(base, col, 0.35 + 0.65 * k), depth), bold && i < 2 ? "1" : "");
          }
        };
        if (ACTIVE.has(node.state)) arc(Math.floor((o.now / 1000) * 14), Math.max(4, Math.round(ring.length / 5)), TOKENS.text, true);
        else if (node.state === "waiting_quota") arc(Math.floor((o.now / 1000) * 3), 3, TOKENS.waiting, false); // slow, restrained
        if (fx?.sweep != null) arc(Math.floor(fx.sweep * ring.length), Math.max(5, Math.round(ring.length / 4)), TOKENS.text, true);
      }

      // reviewer satellite + stem
      if (sat && !isHub) {
        const cx = p.x + Math.floor(m.w / 2);
        const sy = p.y + m.h + 2;
        const rv = fx?.reviewer;
        const col = rv ? mix(TOKENS.brand2, rv.color, rv.k) : node.state === "reviewing" ? TOKENS.brand2 : TOKENS.border;
        c.set(cx, p.y + m.h, "│", st(sgr(TOKENS.border, depth)));
        c.set(cx, p.y + m.h + 1, "│", st(sgr(TOKENS.border, depth)));
        c.set(cx, sy, o.caps.unicode ? (rv || node.state === "reviewing" ? "⬢" : "⬡") : "R", st(sgr(col, depth), rv || node.state === "reviewing" ? "1" : ""));
        if (m.w >= 12 && !compact) c.text(cx + 2, sy, clip(node.reviewOpen ? `review · ${node.reviewOpen} open` : node.state === "done" ? "approved" : "review", m.w - 4), st(sgr(TOKENS.muted, depth)));
        geom.reviewers.set(node.id, { cell: [cx, sy], stem: new Path([[cx, sy], [cx, p.y + m.h]]) });
      }
    }
  }
  if (!o.caps.unicode) for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) c.chars[y]![x] = asciiFold(c.chars[y]![x]!);
  // Graphs too large for the box are clipped, never malformed: only fully visible nodes stay in the geometry, and a
  // hint says how many are not shown (the agent navigator always lists all of them).
  const hidden = [...geom.nodes].filter(([, r]) => r.x < 0 || r.y < 0 || r.x + r.w > c.w || r.y + r.h > c.h).map(([id]) => id);
  if (hidden.length) {
    const gone = new Set(hidden);
    for (const id of hidden) { geom.nodes.delete(id); geom.reviewers.delete(id); }
    geom.edges = geom.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
    const shown = hidden.filter((id) => id !== INTEGRATION).length;
    if (shown) {
      const msg = clip(` +${shown} more agent${shown === 1 ? "" : "s"} not shown — see AGENTS `, c.w);
      c.fill(0, c.h - 1, c.w, 1, "");
      c.text(0, c.h - 1, msg, st(sgr(TOKENS.warning, o.caps.color)));
    }
  }
  return geom;
}
