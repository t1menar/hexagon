/**
 * The agent network: rectangular agent cards joined by edges. Each card carries its own review footer (status in text)
 * and an integration hub closes the graph. Renders into a Canvas and returns the geometry (node rects, edge paths) so the motion layer can run particles
 * along the real connections.
 */
import { Canvas, clip, st } from "./canvas.js";
import { ACTIVE, bar, layout, type DagNode } from "./dag.js";
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
  /** Review footer highlight (0..1). */
  reviewer?: { color: Rgb; k: number } | null;
  /** Transient emphasis of the review footer text while a verdict is being delivered. */
  review?: "rejected" | "approved" | null;
}

export interface NetOptions {
  maxW: number;
  maxH: number;
  caps: Caps;
  /** Elapsed milliseconds (animation clock). Only used when `still` is false. */
  now: number;
  selected?: string | null;
  /** Kept for API compatibility; cards do not depend on the cell aspect. */
  aspect?: number;
  still?: boolean;
  fx?: ReadonlyMap<string, NodeFx>;
  /**
   * Graph restructuring animation. `from` holds the previous canvas position of every node that existed before;
   * k runs 0→1. Nodes glide to their new place, new nodes and edges fade in, edges of moving nodes wait until they settle.
   */
  morph?: { from: ReadonlyMap<string, { x: number; y: number }>; k: number; prevEdges: ReadonlySet<string> } | null;
  /** Integration hub is shown when there is more than one node or the run is active. */
  hub?: boolean;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Geometry {
  canvas: Canvas;
  card: { w: number; h: number; level: 0 | 1 | 2 } | null;
  compact: boolean;
  nodes: Map<string, Rect & { cx: number; cy: number }>;
  /** Path of every dependency edge from → to, as drawn. */
  edges: { from: string; to: string; path: Path }[];
  /**
   * Review lanes per card. `stem` is the rejection lane: from the review row up the card's left rail to the work area.
   * `exit` is the approval lane: from the review row out of the card to where its outgoing edges start.
   */
  reviewers: Map<string, { cell: Pt; stem: Path; exit: Path }>;
}

const U = 1, R = 2, D = 4, L = 8;
const LINE: Record<number, string> = {
  [R | L]: "─", [R]: "─", [L]: "─", [U | D]: "│", [U]: "│", [D]: "│",
  [R | D]: "╭", [L | D]: "╮", [U | R]: "╰", [U | L]: "╯",
  [U | D | R]: "├", [U | D | L]: "┤", [L | R | D]: "┬", [L | R | U]: "┴", [U | D | L | R]: "┼",
};
const DOUBLE: Record<string, string> = { "─": "═", "│": "║", "╭": "╔", "╮": "╗", "╰": "╚", "╯": "╝", "├": "╠", "┤": "╣", "┬": "╦", "┴": "╩", "┼": "╬" };

/** Minimum columns between layers; each gap grows by one column per trunk line that has to run through it. */
const MIN_GAP = 5;

export interface CardSize { w: number; h: number; level: 0 | 1 | 2 }
const CARD_SIZES: CardSize[] = [{ w: 30, h: 9, level: 0 }, { w: 26, h: 7, level: 1 }, { w: 23, h: 7, level: 1 }, { w: 20, h: 5, level: 2 }];
const ROW_GAP = 1;

export function renderNetwork(input: NetNode[], o: NetOptions): Geometry {
  const withHub = (o.hub ?? true) && input.length > 0;
  const hubNode: NetNode | null = withHub
    ? { id: INTEGRATION, title: "integration", role: "integration", deps: input.filter((n) => !input.some((m) => m.deps.includes(n.id))).map((n) => n.id), state: input.every((n) => n.state === "done") ? "done" : input.some((n) => ACTIVE.has(n.state)) ? "merging" : "queued", progress: null }
    : null;
  const nodes: NetNode[] = hubNode ? [...input, hubNode] : input;
  const geom: Geometry = { canvas: new Canvas(1, 1), card: null, compact: false, nodes: new Map(), edges: [], reviewers: new Map() };
  if (!input.length) { geom.canvas = new Canvas(Math.max(1, o.maxW), 1); return geom; }

  const { layers, edges } = layout(nodes);
  const nL = layers.length;
  const layerIdx = new Map<string, number>();
  layers.forEach((l, li) => l.forEach((n) => layerIdx.set(n.key, li)));
  const realMap = new Map(layers.flat().map((n) => [n.key, n.real]));
  const realOf = (key: string) => realMap.get(key) ?? null;

  // Positions depend on the card size: real cards are tall, pass-through lanes of long edges are a single row thin, so
  // a skip-layer edge squeezes between cards instead of reserving a whole card slot.
  const planFor = (cs: CardSize) => {
    const hubH = 4;
    const hOf = (key: string) => (!realOf(key) ? 1 : key === INTEGRATION ? hubH : cs.h);
    const layerH = layers.map((l) => l.reduce((a, n, i) => a + hOf(n.key) + (i ? ROW_GAP : 0), 0));
    const height = Math.max(...layerH);
    const y = new Map<string, number>();
    layers.forEach((l, li) => { let yy = Math.floor((height - layerH[li]!) / 2); for (const n of l) { y.set(n.key, yy); yy += hOf(n.key) + ROW_GAP; } });
    const midOf = (key: string) => y.get(key)! + Math.floor(hOf(key) / 2);
    // One track column per source that has to change row inside its gap (fan-out shares a single trunk).
    const movers: Set<string>[] = Array.from({ length: Math.max(0, nL - 1) }, () => new Set());
    for (const [a, b] of edges) if (midOf(a) !== midOf(b)) movers[layerIdx.get(a)!]?.add(a);
    const gapW = movers.map((set) => Math.max(MIN_GAP, set.size + 4));
    const gapSum = gapW.reduce((a, b) => a + b, 0);
    return { cs, hubH, hOf, y, midOf, gapW, gapSum, height, width: nL * cs.w + gapSum };
  };
  let plan = planFor(CARD_SIZES[CARD_SIZES.length - 1]!); // too small even for the smallest card: clipped, never malformed
  for (const cs of CARD_SIZES) { const pl = planFor(cs); if (pl.width <= o.maxW && pl.height <= o.maxH) { plan = pl; break; } }
  const { gapW, gapSum, midOf: midY } = plan;
  const card = plan.cs;
  const compact = card.level === 2;
  geom.card = card;
  geom.compact = compact;
  const hubH = plan.hubH;
  const boxOf = (id: string) => ({ w: card.w, h: plan.hOf(id) });
  const colW = card.w;
  const c = new Canvas(Math.max(1, Math.min(o.maxW, plan.width)), Math.max(1, Math.min(o.maxH, plan.height)));
  geom.canvas = c;
  const depth = o.caps.color;
  const colorOf = (t: Token) => sgr(TOKENS[t], depth);
  const rgbStyle = (rgb: Rgb, ...extra: string[]) => st(sgr(rgb, depth), ...extra);

  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, li) => {
    const lx = li * colW + gapW.slice(0, li).reduce((a, b) => a + b, 0);
    for (const n of layer) pos.set(n.key, { x: lx, y: plan.y.get(n.key)! });
  });

  // Restructuring animation: nodes move from where they were to where they belong.
  const mo = o.morph && o.morph.k < 1 && !o.still ? o.morph : null;
  const moved = (key: string) => {
    const f = mo?.from.get(key), q = pos.get(key);
    return Boolean(mo && (!f || (q && (f.x !== q.x || f.y !== q.y))));
  };
  const dpos = (key: string): { x: number; y: number } => {
    const q = pos.get(key)!;
    const f = mo?.from.get(key);
    if (!mo || !f) return q;
    return { x: Math.round(f.x + (q.x - f.x) * mo.k), y: Math.round(f.y + (q.y - f.y) * mo.k) };
  };

  // ── edges: orthogonal routing ──
  // Every edge leaves its card at the right-middle port and enters the target at its left-middle port. A source that has
  // to change rows runs ONE vertical trunk in its own track column inside the gap (fan-out shares it); different sources
  // never share a column, so a crossing is a real crossing and a junction is a real junction.
  const mask = new Map<string, number>();
  const rank = new Map<string, number>();
  const styleAt = new Map<string, string>();
  const mark = (x: number, y: number, bits: number, style: string, r: number) => {
    const k = `${x},${y}`;
    mask.set(k, (mask.get(k) ?? 0) | bits);
    if ((rank.get(k) ?? -1) < r) { rank.set(k, r); styleAt.set(k, style); }
  };
  let drawEdges = true;
  const segH = (x1: number, x2: number, y: number, s: string, r: number) => { if (!drawEdges) return; const [a, b] = x1 <= x2 ? [x1, x2] : [x2, x1]; for (let x = a; x <= b; x++) mark(x, y, (x < b ? R : 0) | (x > a ? L : 0) || (R | L), s, r); };
  const segV = (x: number, y1: number, y2: number, s: string, r: number) => { if (!drawEdges) return; const [a, b] = y1 <= y2 ? [y1, y2] : [y2, y1]; for (let y = a; y <= b; y++) mark(x, y, (y < b ? D : 0) | (y > a ? U : 0), s, r); };
  const stateOf = new Map(nodes.map((n) => [n.id, n.state]));
  const arrows: { x: number; y: number; s: string }[] = [];
  const colX = (li: number) => li * colW + gapW.slice(0, li).reduce((a, b) => a + b, 0);

  // 1. track columns per gap
  const trackOf = new Map<string, number>(); // source key -> x of its trunk
  for (let g = 0; g < gapW.length; g++) {
    const sx = colX(g) + colW;
    const hops = edges.filter(([a]) => layerIdx.get(a) === g);
    const bySource = new Map<string, number[]>();
    for (const [a, b] of hops) {
      if (midY(a) === midY(b)) continue;
      bySource.set(a, [...(bySource.get(a) ?? []), midY(b)]);
    }
    const down: string[] = [], up: string[] = [];
    for (const [a, ys] of bySource) (ys.reduce((x, y) => x + y, 0) / ys.length > midY(a) ? down : up).push(a);
    down.sort((p, q) => midY(q) - midY(p)); // the lower the source, the further left (no needless crossings)
    up.sort((p, q) => midY(p) - midY(q));  // the higher the source, the further left
    [...down, ...up].forEach((a, i) => trackOf.set(a, sx + 1 + i));
  }

  // 2. draw every edge (source -> ... -> target) along its chain of hops
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!pos.has(d)) continue;
      const from = layers.findIndex((l) => l.some((x) => x.key === d));
      const to = layers.findIndex((l) => l.some((x) => x.key === n.id));
      const chain: string[] = [d];
      for (let l = from + 1; l < to; l++) chain.push(`${d}>${n.id}#${l}`);
      chain.push(n.id);
      const dst = stateOf.get(n.id)!;
      const src = stateOf.get(d)!;
      const failed = src === "failed" || dst === "failed";
      const blockedEdge = !failed && (src === "blocked" || dst === "blocked");
      const rk = failed || blockedEdge || ACTIVE.has(dst) || dst === "waiting_quota" ? 2 : src === "done" ? 1 : 0;
      const tok: Token = failed ? "error" : blockedEdge ? "warning" : rk === 2 ? STATE_LOOK[dst].token : rk === 1 ? "success" : "border";
      // During a restructure, edges of moving nodes wait for them; brand-new edges fade in.
      let fade = 1;
      if (mo) {
        if (moved(d) || moved(n.id)) fade = Math.max(0, (mo.k - 0.7) / 0.3);
        else if (!mo.prevEdges.has(`${d}>${n.id}`)) fade = mo.k;
      }
      const style = fade >= 1 ? colorOf(tok) : sgr(mix(TOKENS.surface2, TOKENS[tok], fade), depth);
      const hide = fade < 0.08;
      drawEdges = !hide;
      const pts: Pt[] = [];
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i]!, b = chain[i + 1]!;
        const pa = pos.get(a)!, pb = pos.get(b)!;
        const sx = pa.x + colW;
        const ya = midY(a), yb = midY(b);
        const tx = realOf(b) ? pb.x - 1 : pb.x;
        if (!realOf(a)) { segH(pa.x, sx, ya, style, rk); pts.push([pa.x, ya]); }
        const trunk = trackOf.get(a);
        if (ya === yb || trunk === undefined) { segH(sx, tx, ya, style, rk); pts.push([sx, ya], [tx, yb]); }
        else {
          segH(sx, trunk, ya, style, rk); segV(trunk, ya, yb, style, rk); segH(trunk, tx, yb, style, rk);
          pts.push([sx, ya], [trunk, ya], [trunk, yb], [tx, yb]);
        }
        if (realOf(b) && i === chain.length - 2 && !hide) arrows.push({ x: tx, y: yb, s: style });
        if (!realOf(b)) { segH(pb.x, pb.x + colW - 1, yb, style, rk); pts.push([pb.x + colW - 1, yb]); }
      }
      drawEdges = true;
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
  const uni = o.caps.unicode;
  for (const layer of layers) {
    for (const ln of layer) {
      if (!ln.real) continue;
      const node = ln.real as NetNode;
      const pf = pos.get(ln.key)!;
      const p = dpos(ln.key);
      const m = boxOf(node.id);
      const isHub = node.id === INTEGRATION;
      const appearing = Boolean(mo && !mo.from.has(node.id));
      if (appearing && mo!.k < 0.3) { geom.nodes.set(node.id, { x: pf.x, y: pf.y, w: m.w, h: m.h, cx: pf.x + Math.floor(m.w / 2), cy: pf.y + Math.floor(m.h / 2) }); continue; }
      const look = STATE_LOOK[node.state];
      const fx = o.fx?.get(node.id);
      const sel = o.selected === node.id;
      let base: Rgb = TOKENS[look.token];
      if (fx?.flash) base = mix(base, fx.flash.color, fx.flash.k);
      const bg = sel ? sgr(TOKENS.surface, depth, true) : "";
      const outline = sel ? st(sgr(TOKENS.text, depth), "1", bg) : st(sgr(base, depth), isHub || appearing || node.state === "queued" ? "2" : "", bg);
      const sty = (...x: string[]) => st(...x, bg);
      const x0 = p.x, y0 = p.y, x1 = p.x + m.w - 1, y1 = p.y + m.h - 1;
      const dashed = node.state === "queued";

      // frame (square corners; dashed while queued)
      c.fill(x0, y0, m.w, m.h, sty(), " ");
      const ring: [number, number][] = [];
      for (let x = x0; x <= x1; x++) { c.set(x, y0, dashed ? "┄" : "─", outline); ring.push([x, y0]); }
      for (let y = y0 + 1; y <= y1; y++) { c.set(x1, y, dashed ? "┆" : "│", outline); ring.push([x1, y]); }
      for (let x = x1 - 1; x >= x0; x--) { c.set(x, y1, dashed ? "┄" : "─", outline); ring.push([x, y1]); }
      for (let y = y1 - 1; y > y0; y--) { c.set(x0, y, dashed ? "┆" : "│", outline); ring.push([x0, y]); }
      c.set(x0, y0, "┌", outline); c.set(x1, y0, "┐", outline); c.set(x0, y1, "└", outline); c.set(x1, y1, "┘", outline);
      geom.nodes.set(node.id, { x: pf.x, y: pf.y, w: m.w, h: m.h, cx: pf.x + Math.floor(m.w / 2), cy: pf.y + Math.floor(m.h / 2) });

      const glyph = uni ? look.symbol : look.ascii;
      const inner = m.w - 4; // text columns between the rail gutter and the right border
      const tx = x0 + 3;
      const text = (y: number, t: string, style: string) => c.text(tx, y, clip(t, inner), style, x1);
      const boldText = sty(sgr(TOKENS.text, depth), "1");
      const mutedText = sty(sgr(TOKENS.muted, depth));
      const stateCol = sty(sgr(base, depth), "1");

      if (isHub) {
        c.text(tx, y0 + 1, clip("INTEGRATION", inner), sty(sgr(TOKENS.brand2, depth), "1"), x1);
        text(y0 + 2, `${glyph} ${look.label}`, stateCol);
        continue;
      }

      // title row sits in the border: id · role
      c.text(x0 + 2, y0, clip(` ${node.id} · ${node.role} `, m.w - 4), sty(sgr(TOKENS.text, depth), "1"), x1);
      const bar2 = node.progress != null ? bar(node.progress, Math.max(6, inner - 5)) : null;
      const state = node.quota ? `${glyph} ${node.quota}` : `${glyph} ${look.label}${node.fixCycle ? ` · fix ${node.fixCycle}` : ""}`;
      const idLine = [node.provider, node.cli].filter(Boolean).join(" · ") || "no agent yet";
      const modelLine = node.provider || node.cli ? `model: ${node.runtimeModel ?? "CLI-managed"}` : "";
      const pct = node.progress != null ? `${Math.round(node.progress * 100)}%` : "";
      let sepY: number, revY: number;
      if (card.level === 0) {
        text(y0 + 1, node.title, boldText);
        text(y0 + 2, idLine, mutedText);
        text(y0 + 3, modelLine, mutedText);
        text(y0 + 4, state, stateCol);
        if (bar2) { const bx = c.text(tx, y0 + 5, bar2.fill, sty(sgr(base, depth)), x1); const bx2 = c.text(bx, y0 + 5, bar2.rest, sty(sgr(TOKENS.border, depth)), x1); c.text(bx2, y0 + 5, bar2.label, mutedText, x1); }
        sepY = y0 + 6; revY = y0 + 7;
      } else if (card.level === 1) {
        text(y0 + 1, node.title, boldText);
        text(y0 + 2, idLine, mutedText);
        text(y0 + 3, state, stateCol);
        if (pct) c.text(x1 - 1 - pct.length, y0 + 3, pct, mutedText, x1);
        sepY = y0 + 4; revY = y0 + 5;
      } else {
        text(y0 + 1, node.title, boldText);
        text(y0 + 2, state, stateCol);
        if (pct) c.text(x1 - 1 - pct.length, y0 + 2, pct, mutedText, x1);
        sepY = -1; revY = y0 + 3;
      }

      // review footer: its status is always written out, never only coloured
      const rv = fx?.reviewer;
      const verdict: { sym: string; text: string; tok: Token } =
        fx?.review === "rejected" ? { sym: uni ? "▲" : "^", text: "REJECTED → developer", tok: "warning" }
        : fx?.review === "approved" ? { sym: uni ? "✔" : "+", text: "APPROVED → integration", tok: "success" }
        : node.state === "reviewing" ? { sym: uni ? "◐" : "~", text: "in review", tok: "brand2" }
        : node.state === "merging" || node.state === "done" ? { sym: uni ? "✔" : "+", text: "approved", tok: "success" }
        : node.fixCycle ? { sym: uni ? "↩" : "<", text: `changes requested (fix ${node.fixCycle})`, tok: "warning" }
        : { sym: uni ? "○" : "o", text: "not reviewed yet", tok: "muted" };
      if (inner < 20) verdict.text = verdict.text.replace("not reviewed yet", "not reviewed").replace("REJECTED → developer", "REJECTED").replace("APPROVED → integration", "APPROVED").replace(/changes requested \(fix (\d+)\)/, "fix $1 requested");
      const vcol = rv ? mix(TOKENS[verdict.tok], rv.color, rv.k) : TOKENS[verdict.tok];
      if (sepY >= 0) {
        c.set(x0, sepY, "├", outline); c.set(x1, sepY, "┤", outline);
        for (let x = x0 + 1; x < x1; x++) c.set(x, sepY, "─", sty(sgr(TOKENS.border, depth)));
        c.text(x0 + 2, sepY, " REVIEW ", sty(sgr(TOKENS.muted, depth), "1"), x1);
      }
      const label = sepY >= 0 ? `${verdict.sym} ${verdict.text}` : `${verdict.sym} ${verdict.text}`;
      c.text(tx, revY, clip(label, inner), sty(sgr(vcol, depth), rv || fx?.review || node.state === "reviewing" ? "1" : ""), x1);

      // review lanes. Rejection lane: a rail in the left gutter from the review row up to the work area.
      // Approval lane: out of the card on the right edge at the review row.
      const railX = x0 + 1;
      const top = y0 + 1;
      const railOn = node.state === "reviewing" || Boolean(node.fixCycle) || fx?.review === "rejected";
      if (railOn) {
        for (let y = top; y <= revY; y++) c.set(railX, y, "╎", sty(sgr(mix(TOKENS.border, TOKENS.warning, node.fixCycle || fx?.review === "rejected" ? 0.7 : 0), depth)));
        c.set(railX, top, uni ? "▲" : "^", sty(sgr(node.fixCycle || fx?.review === "rejected" ? TOKENS.warning : TOKENS.muted, depth)));
      }
      const approved = node.state === "merging" || node.state === "done" || fx?.review === "approved";
      if (approved) c.set(x1, revY, uni ? "▸" : ">", sty(sgr(TOKENS.success, depth), "1"));
      const ya = y0 + Math.floor(m.h / 2);
      geom.reviewers.set(node.id, {
        cell: [railX, revY],
        stem: new Path([[railX, revY], [railX, top]]),
        exit: new Path([[x1 - 1, revY], [x1 + 1, revY], [x1 + 1, ya]]),
      });

      // perimeter highlight: activity arc and one-shot activation sweep
      if (!reduce && ring.length) {
        const arc = (head: number, len: number, col: Rgb, bold: boolean) => {
          for (let i = 0; i < len; i++) {
            const [rx, ry] = ring[(((head - i) % ring.length) + ring.length) % ring.length]!;
            const k = 1 - i / len;
            if (rx < 0 || rx >= c.w || !c.styles[ry]) continue;
            c.styles[ry]![rx] = st(sgr(mix(base, col, 0.35 + 0.65 * k), depth), bold && i < 2 ? "1" : "", bg);
          }
        };
        if (ACTIVE.has(node.state)) arc(Math.floor((o.now / 1000) * 14), Math.max(4, Math.round(ring.length / 5)), TOKENS.text, true);
        else if (node.state === "waiting_quota") arc(Math.floor((o.now / 1000) * 3), 3, TOKENS.waiting, false);
        if (fx?.sweep != null) arc(Math.floor(fx.sweep * ring.length), Math.max(5, Math.round(ring.length / 4)), TOKENS.text, true);
      }
    }
  }
  // Ports: where edges attach to a card, the border turns into a junction (├ leaving, ┤ entering).
  for (const n of nodes) {
    const pp = pos.has(n.id) ? dpos(n.id) : undefined;
    if (!pp) continue;
    const ya = midY(n.id);
    const out = geom.edges.find((e) => e.from === n.id);
    if (out) c.set(pp.x + colW - 1, ya, "├", colorOf(n.state === "done" ? "success" : stateOf.get(n.id) && ACTIVE.has(n.state) ? STATE_LOOK[n.state].token : "border"));
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
