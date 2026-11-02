import { describe, expect, it } from "vitest";
import { Canvas } from "../src/tui/canvas.js";
import { computeLayout, overlaps } from "../src/tui/layout.js";
import { AnimationManager, FakeClock, LINE_CELLS, Path } from "../src/tui/motion.js";

const rows = (c: Canvas) => c.chars.map((r) => r.join(""));

describe("rules join into one border family", () => {
  it("a vertical rule meeting a horizontal one makes tees, corners and a cross", () => {
    const c = new Canvas(9, 5);
    c.hrule(0, 0, 9, ""); c.hrule(0, 2, 9, ""); c.hrule(0, 4, 9, "");
    c.vrule(4, 0, 5, "");
    expect(rows(c)).toEqual(["────┬────", "    │    ", "────┼────", "    │    ", "────┴────"]);
  });
  it("panel corners are rounded, shared edges become tees", () => {
    const c = new Canvas(7, 4);
    for (const r of [{ x: 0, y: 0, w: 4, h: 4 }, { x: 3, y: 0, w: 4, h: 4 }]) {
      c.hrule(r.x, r.y, r.w, ""); c.hrule(r.x, r.y + r.h - 1, r.w, "");
      c.vrule(r.x, r.y, r.h, ""); c.vrule(r.x + r.w - 1, r.y, r.h, "");
    }
    expect(rows(c)).toEqual(["╭──┬──╮", "│  │  │", "│  │  │", "╰──┴──╯"]);
    expect(rows(c).join("")).not.toMatch(/[┌┐└┘]/); // one family: no square corners next to rounded ones
  });
  it("never overwrites text, and a free end stays a plain line", () => {
    const c = new Canvas(5, 1);
    c.text(0, 0, "ab", "");
    c.hrule(0, 0, 5, "");
    expect(rows(c)[0]).toBe("ab───");
  });
});

describe("shared layout", () => {
  it("neighbouring panels share only their border cells; interiors stay disjoint and on screen", () => {
    for (const [W, H] of [[160, 45], [120, 30], [80, 24]] as const) {
      const L = computeLayout(W, H, { inspector: true, inputRows: 1, shared: true });
      const regions = [L.agents, L.network, L.inspector, L.activity, L.chat].filter((r): r is NonNullable<typeof r> => Boolean(r));
      const inner = regions.map((r) => ({ x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 }));
      for (let i = 0; i < inner.length; i++) for (let j = i + 1; j < inner.length; j++) expect(overlaps(inner[i]!, inner[j]!), `${W}x${H} ${i}/${j}`).toBe(false);
      for (const r of regions) { expect(r.x).toBeGreaterThanOrEqual(0); expect(r.x + r.w).toBeLessThanOrEqual(W); expect(r.y + r.h).toBeLessThanOrEqual(L.input.y); }
    }
  });
});

describe("edge activity recolors the line instead of drawing over it", () => {
  it("a particle on a line cell leaves the glyph and changes its colour; on a blank cell it may draw", () => {
    const clock = new FakeClock();
    const m = new AnimationManager({ clock, motion: "full", manual: true });
    const c = new Canvas(12, 1);
    for (let x = 0; x < 12; x++) c.set(x, 0, "─", "base");
    m.spawn("information", new Path([[0, 0], [11, 0]]), { duration: 1000, easing: (t) => t });
    clock.advance(500);
    m.particles.draw(c, clock.now(), { depth: "truecolor" as never, unicode: true, onLines: "recolor" });
    expect(rows(c)[0]).toBe("────────────"); // line stays continuous
    expect(c.styles[0]!.some((s) => s !== "base")).toBe(true); // ...but something lit up
    for (const ch of rows(c)[0]!) expect(LINE_CELLS.has(ch)).toBe(true);
    m.dispose();
  });
});
