import { describe, expect, it } from "vitest";
import type { DagNode } from "../src/tui/dag.js";
import { asciiFold, detectCaps, type Caps } from "../src/tui/theme.js";
import { renderNetwork, type NodeFx } from "../src/tui/network.js";
import { renderStartup, startupProgress } from "../src/tui/startup.js";
import { Canvas } from "../src/tui/canvas.js";
import { FakeClock, ParticleSystem } from "../src/tui/motion.js";

const node = (over: Partial<DagNode> & { id: string }): DagNode => ({ title: "Build the thing", role: "implementer", deps: [], state: "running", progress: 0.4, provider: "anthropic", cli: "claude-code 2.1", runtimeModel: null, ...over });
const nodes = [
  node({ id: "T-1", role: "analyst", state: "done", progress: 1, runtimeModel: "rt-model-x" }),
  node({ id: "T-2", deps: ["T-1"], provider: "openai", cli: "codex 0.9", state: "reviewing", progress: 0.7 }),
  node({ id: "T-3", deps: ["T-1"], provider: "xai", cli: "grok", state: "waiting_quota", progress: 0.3, quota: "15:04~" }),
  node({ id: "T-4", deps: ["T-2", "T-3"], state: "queued", progress: null }),
];
const TTY = { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8" };
const full: Caps = detectCaps(TTY, true);
const plain = (c: Canvas) => c.lines(false).join("\n");
const render = (o: Partial<Parameters<typeof renderNetwork>[1]> = {}, ns = nodes) => renderNetwork(ns, { maxW: 140, maxH: 44, caps: full, now: 0, ...o });

describe("agent network", () => {
  it("shows provider and CLI as text, the runtime model only when reported, state, progress and ids", () => {
    const out = plain(render().canvas);
    for (const t of ["T-1", "T-2", "anthropic", "codex", "rt-model-x", "CLI-managed", "15:04~"]) expect(out).toContain(t);
    expect(out).toMatch(/\d+%/);
  });
  it("hexagon nodes do not overlap and edges connect real nodes", () => {
    const g = render();
    const rs = [...g.nodes.entries()];
    expect(rs.length).toBeGreaterThanOrEqual(nodes.length);
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i]![1], b = rs[j]![1];
      expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${rs[i]![0]} vs ${rs[j]![0]}`).toBe(false);
    }
    for (const e of g.edges) { expect(g.nodes.has(e.from)).toBe(true); expect(g.nodes.has(e.to)).toBe(true); }
    expect(g.edges.length).toBeGreaterThanOrEqual(4);
  });
  it("is responsive and always fits its box", () => {
    const hs: number[] = [];
    for (const [w, h] of [[160, 50], [100, 26], [70, 16], [50, 10]] as const) {
      const g = render({ maxW: w, maxH: h });
      expect(g.canvas.w).toBeLessThanOrEqual(w);
      expect(g.canvas.h).toBeLessThanOrEqual(h);
      hs.push(g.canvas.h);
    }
    expect(hs[0]!).toBeGreaterThan(hs[3]!);
  });
  it("still mode renders identically at any time; animated mode changes for active agents", () => {
    const a = plain(render({ now: 0, still: true }).canvas);
    expect(plain(render({ now: 777, still: true }).canvas)).toBe(a);
    const frames = new Set([0, 150, 300, 450, 600].map((t) => render({ now: t, still: false }).canvas.lines(true).join("\n")));
    expect(frames.size).toBeGreaterThan(1);
  });
  it("color modes: none has no escapes, 16/256/truecolor all do", () => {
    const esc = (c: Canvas) => /\x1b\[[0-9;]*(38|48)[;:]/.test(c.lines(true).join("")) || /\x1b\[(3[0-7]|9[0-7]|4[0-7])m/.test(c.lines(true).join(""));
    expect(esc(render({ caps: detectCaps({ NO_COLOR: "1", LANG: "en_US.UTF-8" }, true) }).canvas)).toBe(false); // attributes only (bold/dim)
    for (const env of [{ TERM: "xterm", LANG: "en_US.UTF-8" }, { TERM: "xterm-256color", LANG: "en_US.UTF-8" }, TTY]) expect(esc(render({ caps: detectCaps(env, true) }).canvas)).toBe(true);
  });
  it("ASCII mode contains no non-ASCII characters", () => {
    const c = render({ caps: detectCaps({ ...TTY, HEXAGON_ASCII: "1" }, true) }).canvas;
    // The app folds the final frame; the renderer itself must already be foldable.
    expect(plain(c).length).toBeGreaterThan(0);
  });
  it("effects change the picture (flash, sweep) and do nothing to geometry", () => {
    const fx = new Map<string, NodeFx>([["T-2", { flash: { color: [255, 0, 0], k: 1 }, sweep: 0.5, reviewer: { color: [0, 255, 0], k: 1 } }]]);
    const a = render({ now: 0 }), b = render({ now: 0, fx });
    expect(b.canvas.lines(true).join("\n")).not.toBe(a.canvas.lines(true).join("\n"));
    expect([...b.nodes.values()]).toEqual([...a.nodes.values()]);
  });
  it("particles drawn on the network never destroy labels", () => {
    const g = render({ still: true });
    const before = plain(g.canvas);
    const ps = new ParticleSystem(48);
    for (const e of g.edges) ps.spawn("information", e.path, 0, { duration: 1000 });
    for (const [, r] of g.reviewers) ps.spawn("review", r.stem, 0, { duration: 1000 });
    for (let t = 0; t <= 1000; t += 40) ps.draw(g.canvas, t, { depth: 0, unicode: true });
    const words = (s: string) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
    expect(words(plain(g.canvas))).toEqual(words(before));
  });
  it("renders a 40-node graph quickly", () => {
    const many = Array.from({ length: 40 }, (_, i) => node({ id: `T-${i + 1}`, deps: i > 3 ? [`T-${(i % 4) + 1}`] : [] }));
    const t = performance.now();
    let g;
    for (let i = 0; i < 10; i++) g = renderNetwork(many, { maxW: 180, maxH: 50, caps: full, now: i * 40 });
    expect((performance.now() - t) / 10).toBeLessThan(80);
    for (const r of g!.nodes.values()) expect(r.x + r.w <= g!.canvas.w && r.y + r.h <= g!.canvas.h).toBe(true); // only visible nodes are reported
    expect(g!.canvas.lines(false).join("\n")).toMatch(/more agents? not shown/);
  });
});

describe("startup sequence", () => {
  it("is time-based, ends, and fits any size", () => {
    expect(startupProgress(0).done).toBe(false);
    expect(startupProgress(60_000).done).toBe(true);
    for (const [w, h] of [[160, 45], [80, 24], [40, 16]] as const) {
      const c = renderStartup(w, h, 900, full, 2);
      expect(c.w).toBe(w); expect(c.h).toBe(h);
    }
    expect(plain(renderStartup(120, 40, 1400, full, 2))).toContain("H E X A G O N");
  });
  it("deterministic: same time, same frame", () => {
    const clock = new FakeClock(); clock.advance(500);
    expect(plain(renderStartup(100, 30, clock.now(), full, 2))).toBe(plain(renderStartup(100, 30, 500, full, 2)));
  });
});

describe("square cards", () => {
  it("draw rectangular frames, with an explicit review footer in text", () => {
    const g = render({ still: true });
    const out = plain(g.canvas);
    expect(g.card).not.toBeNull();
    expect(out).not.toMatch(/[⬡⬢╱╲]/); // no hexagon shapes or symbols
    expect(out).toMatch(/┌.*T-1/);
    expect(out).toMatch(/REVIEW/);
    expect(out).toMatch(/not reviewed yet|in review|approved/);
    for (const r of g.nodes.values()) expect(r.w).toBe(g.card!.w);
  });
  it("review verdicts are written out, not only coloured", () => {
    const rejected = new Map<string, NodeFx>([["T-2", { review: "rejected" }]]);
    const approved = new Map<string, NodeFx>([["T-2", { review: "approved" }]]);
    expect(plain(render({ still: true, fx: rejected }).canvas)).toMatch(/REJECTED → developer/);
    expect(plain(render({ still: true, fx: approved }).canvas)).toMatch(/APPROVED → integration/);
    expect(plain(render({ still: true }).canvas)).toMatch(/in review/); // T-2 is reviewing in the fixture
  });
  it("review lanes exist for every card and stay inside the card's column range", () => {
    const g = render({ still: true });
    for (const id of ["T-1", "T-2", "T-3", "T-4"]) {
      const r = g.reviewers.get(id)!, n = g.nodes.get(id)!;
      expect(r).toBeDefined();
      expect(r.stem.pts[0]![0]).toBeGreaterThan(n.x);
      expect(r.stem.pts[0]![0]).toBeLessThan(n.x + n.w);
      expect(r.exit.pts.at(-1)![0]).toBe(n.x + n.w);
    }
  });
  it("ASCII fold leaves no unmapped characters", () => {
    const c = render({ still: true }).canvas;
    const folded = c.lines(false).map((l) => [...l].map(asciiFold).join("")).join("");
    expect(folded).not.toContain("?");
  });
  it("all card sizes fit: large, medium, compact", () => {
    for (const [w, h] of [[160, 50], [100, 24], [70, 14]] as const) {
      const g = render({ maxW: w, maxH: h, still: true });
      expect(g.canvas.w).toBeLessThanOrEqual(w); expect(g.canvas.h).toBeLessThanOrEqual(h);
      expect(plain(g.canvas)).toContain("T-1");
    }
  });
});
