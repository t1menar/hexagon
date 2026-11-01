import { describe, expect, it } from "vitest";
import { Canvas } from "../src/tui/canvas.js";
import { AnimationManager, ease, FakeClock, ParticleSystem, Path } from "../src/tui/motion.js";

const mk = (motion: "full" | "reduced" | "off" = "full") => {
  const clock = new FakeClock();
  let frames = 0;
  const m = new AnimationManager({ clock, motion, manual: true, onFrame: () => frames++ });
  return { clock, m, frames: () => frames };
};

describe("easing", () => {
  it.each(Object.keys(ease).filter((k) => k !== "pulse"))("%s runs 0→1", (k) => {
    const f = (ease as Record<string, (t: number) => number>)[k]!;
    expect(f(0)).toBeCloseTo(0, 5);
    expect(f(1)).toBeCloseTo(1, 5);
  });
});

describe("animation manager (deterministic clock)", () => {
  it("tweens by elapsed time, not frame count", () => {
    const { clock, m } = mk();
    const seen: number[] = [];
    let done = false;
    m.tween("t", 1000, (v) => seen.push(v), { easing: ease.linear, onDone: () => (done = true) });
    clock.advance(250); m.step(clock.now());
    clock.advance(250); m.step(clock.now());
    expect(seen[0]).toBeCloseTo(0.25); expect(seen[1]).toBeCloseTo(0.5);
    clock.advance(10_000); m.step(clock.now());
    expect(seen.at(-1)).toBe(1);
    expect(done).toBe(true);
    expect(m.count).toBe(0);
  });
  it("timelines fire steps in order exactly once", () => {
    const { clock, m } = mk();
    const log: string[] = [];
    m.timeline("tl").at(0, () => log.push("a")).at(300, () => log.push("b")).at(600, () => log.push("c")).play();
    for (let i = 0; i < 12; i++) { clock.advance(100); m.step(clock.now()); }
    expect(log).toEqual(["a", "b", "c"]);
  });
  it("cancel stops a tween without finishing it", () => {
    const { clock, m } = mk();
    let done = false;
    m.tween("x", 500, () => {}, { onDone: () => (done = true) });
    m.cancel("x");
    clock.advance(1000); m.step(clock.now());
    expect(done).toBe(false);
    expect(m.count).toBe(0);
  });
  it("is idle when nothing animates: no redraw requested", () => {
    const { clock, m, frames } = mk();
    clock.advance(1000);
    expect(m.step(clock.now())).toBe(false);
    expect(frames()).toBe(0);
    expect(m.busy).toBe(false);
    m.invalidate();
    expect(m.step(clock.now())).toBe(true); // a state change redraws exactly once
    expect(m.step(clock.now())).toBe(false);
    expect(frames()).toBe(1);
  });
  it("holds keep continuous effects alive until released", () => {
    const { clock, m } = mk();
    m.hold("live");
    expect(m.busy).toBe(true);
    clock.advance(100);
    expect(m.step(clock.now())).toBe(true);
    m.release("live");
    expect(m.busy).toBe(false);
  });
  it("real timers: nothing is armed when idle and dispose clears everything", async () => {
    const m = new AnimationManager({ motion: "full", onFrame: () => {} });
    expect(m.running).toBe(false);
    m.tween("t", 5000, () => {});
    expect(m.running).toBe(true);
    m.dispose();
    expect(m.running).toBe(false);
    expect(m.busy).toBe(false);
    m.tween("t2", 100, () => {});
    expect(m.running).toBe(false);
  });
  it("motion off: end states apply immediately, no particles, no holds", () => {
    const { m } = mk("off");
    let v = 0;
    m.tween("t", 1000, (x) => (v = x));
    expect(v).toBe(1);
    expect(m.spawn("information", new Path([[0, 0], [5, 0]]))).toBe(false);
    m.hold("live");
    expect(m.busy).toBe(false);
  });
  it("reduced motion disables ambient particles but keeps meaningful ones", () => {
    const { m } = mk("reduced");
    const p = new Path([[0, 0], [10, 0]]);
    expect(m.spawn("ambient", p)).toBe(false);
    expect(m.spawn("review", p)).toBe(true);
  });
});

describe("particles", () => {
  const p = new Path([[2, 1], [10, 1], [10, 5]]);
  it("pool is bounded and prefers important particles", () => {
    const ps = new ParticleSystem(8);
    for (let i = 0; i < 100; i++) ps.spawn("ambient", p, 0);
    expect(ps.activeCount).toBeLessThanOrEqual(8);
    expect(ps.spawn("review", p, 0)).toBe(true); // replaces a lower-priority one
    expect(ps.activeCount).toBeLessThanOrEqual(8);
  });
  it("follow the path and finish at its end", () => {
    const ps = new ParticleSystem(4);
    ps.spawn("information", p, 0, { duration: 1000, easing: ease.linear });
    for (const t of [0, 250, 500, 750, 990]) {
      const v = ps.visible(t)[0];
      if (!v) continue;
      const onPath = (v.x >= 2 && v.x <= 10 && v.y === 1) || (v.x === 10 && v.y >= 1 && v.y <= 5);
      expect(onPath).toBe(true);
    }
    expect(ps.update(1500)).toBe(false);
    expect(ps.activeCount).toBe(0);
  });
  it("never overwrite text or outlines when drawn", () => {
    const c = new Canvas(14, 7);
    c.text(2, 1, "LABEL", "");
    c.set(10, 3, "╱", "");
    const ps = new ParticleSystem(4);
    ps.spawn("information", p, 0, { duration: 1000, easing: ease.linear });
    for (let t = 0; t <= 1000; t += 50) ps.draw(c, t, { depth: 0, unicode: true });
    expect(c.lines(false)[1]!.slice(2, 7)).toBe("LABEL");
    expect(c.chars[3]![10]).toBe("╱");
  });
  it("onArrive fires once", () => {
    const ps = new ParticleSystem(2);
    let n = 0;
    ps.spawn("completion", p, 0, { duration: 100, onArrive: () => n++ });
    ps.update(200); ps.update(300);
    expect(n).toBe(1);
  });
});

import { AmbientField } from "../src/tui/ambient.js";

describe("ambient layer", () => {
  it("is deterministic: same time, same cells", () => {
    const a = new AmbientField(), b = new AmbientField();
    expect(a.cells(80, 24, 12_345)).toEqual(b.cells(80, 24, 12_345));
  });
  it("level scales the amount and 0 shows nothing", () => {
    const f = new AmbientField();
    const count = (lvl: number) => { let n = 0; for (let t = 0; t < 30_000; t += 500) n += f.cells(80, 24, t, lvl).length; return n; };
    expect(count(0)).toBe(0);
    expect(count(0.35)).toBeLessThan(count(1));
    expect(count(1)).toBeGreaterThan(0);
  });
  it("only lands on blank cells with blank neighbours and respects the blocked area", () => {
    const f = new AmbientField();
    const c = new Canvas(80, 24);
    c.text(10, 5, "agent information that must stay intact", "");
    const label = "agent information that must stay intact";
    const blocked = (x: number, y: number) => x >= 40;
    for (let t = 0; t < 40_000; t += 400) f.draw(c, 0, 0, 80, 24, t, { depth: 0, unicode: true, level: 1, blocked });
    const out = c.lines(false);
    expect(out[5]!.slice(10, 10 + label.length)).toBe(label); // text untouched
    out.forEach((l, y) => { if (y !== 5) expect([...l].slice(40).every((ch) => ch === " ")).toBe(true); });
    expect(out.join("").replace(/\s/g, "").length).toBeGreaterThan(label.replace(/\s/g, "").length); // and something was drawn elsewhere
  });
  it("cells stay in the field and drift slowly", () => {
    const f = new AmbientField();
    for (let t = 0; t < 60_000; t += 700) for (const cell of f.cells(60, 20, t)) { expect(cell.a).toBeGreaterThanOrEqual(0); expect(cell.a).toBeLessThanOrEqual(0.6); }
  });
});
