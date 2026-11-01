import { describe, expect, it } from "vitest";
import { Canvas } from "../src/tui/canvas.js";
import { renderDag, type DagNode } from "../src/tui/dag.js";
import { drawHexagon, hexMetrics, innerWidth, irregularity } from "../src/tui/hex.js";
import { agentIdentity, modelLine, quotaLabel, recoveryLine } from "../src/tui/identity.js";

const node = (over: Partial<DagNode> & { id: string }): DagNode => ({ title: "Do the thing", role: "implementer", deps: [], state: "running", progress: 0.4, ...over });
const text = (c: Canvas) => c.lines(false).join("\n");

describe("regular hexagon geometry", () => {
  it.each([2, 3, 4, 5, 6])("r=%i: all six sides have (nearly) equal physical length at cell aspect 2", (r) => {
    const m = hexMetrics(r, 2);
    const slant = r * Math.hypot(m.k, m.aspect);
    expect(Math.abs(m.top - slant) / slant).toBeLessThan(0.12);
    expect(irregularity(m)).toBeLessThan(0.12);
    expect(m.h).toBe(2 * r);
    expect(m.w).toBe(m.top + 2 * r * m.k);
  });
  it("compensates for different cell shapes", () => {
    const sq = hexMetrics(4, 1);
    const tall = hexMetrics(4, 2);
    const taller = hexMetrics(4, 3);
    for (const m of [sq, tall, taller]) expect(irregularity(m)).toBeLessThan(0.15);
    expect(taller.top).toBeGreaterThan(tall.top);
    expect(tall.top).toBeGreaterThan(sq.top);
  });
  it("draws a symmetric outline with the right size", () => {
    const m = hexMetrics(4, 2);
    const c = new Canvas(m.w + 2, m.h + 2);
    const ring = drawHexagon(c, 1, 1, m, "");
    const rows = c.lines(false);
    expect(rows[1]!.trim().length).toBe(m.top);
    for (let j = 2; j < m.h; j++) {
      const row = [...rows[j]!.padEnd(m.w + 2)];
      const l = row.findIndex((ch) => ch !== " ");
      const r = row.length - 1 - [...row].reverse().findIndex((ch) => ch !== " ");
      expect(l + r).toBe(m.w + 1); // mirror image around the centre
    }
    expect(ring.length).toBeGreaterThan(m.top * 2);
    expect(innerWidth(m, 1)).toBeLessThan(innerWidth(m, m.r));
  });
});

describe("DAG of hexagonal agent nodes", () => {
  const nodes = [
    node({ id: "T-1", state: "done", progress: 1, provider: "anthropic", cli: "claude-code 2.1", runtimeModel: "rt-model-x" }),
    node({ id: "T-2", deps: ["T-1"], provider: "openai", cli: "codex 0.9", runtimeModel: null }),
    node({ id: "T-3", deps: ["T-1"], state: "waiting_quota", progress: 0.3, provider: "xai", cli: "grok", quota: "15:04~" }),
  ];
  it("shows provider, CLI, the runtime model only when reported, state, progress and id", () => {
    const out = text(renderDag(nodes, { maxW: 120, maxH: 40, frame: 0, aspect: 2 }));
    expect(out).toContain("T-1");
    expect(out).toContain("anthropic");
    expect(out).toContain("codex");
    expect(out).toContain("rt-model-x");
    expect(out).toContain("CLI-managed");
    expect(out).toContain("15:04~");
    expect(out).toMatch(/\d+%/);
  });
  it("is responsive to terminal size", () => {
    const big = renderDag(nodes, { maxW: 140, maxH: 50, frame: 0 });
    const mid = renderDag(nodes, { maxW: 80, maxH: 14, frame: 0 });
    const small = renderDag(nodes, { maxW: 50, maxH: 9, frame: 0 });
    expect(big.h).toBeGreaterThan(mid.h);
    expect(mid.h).toBeGreaterThan(small.h);
    for (const c of [big, mid, small]) expect(c.w).toBeLessThanOrEqual(140);
    expect(text(small)).toContain("T-1");
  });
  it("animation can be disabled: identical frames when still, differing when animated", () => {
    const f = (frame: number, still: boolean) => text(renderDag(nodes, { maxW: 120, maxH: 40, frame, still }));
    expect(f(0, true)).toBe(f(7, true));
    expect(new Set([0, 1, 2, 3, 4, 5, 6, 7].map((n) => f(n, false))).size).toBeGreaterThan(1);
  });
  it("plain output has no escape codes", () => {
    const c = renderDag(nodes, { maxW: 120, maxH: 40, frame: 3 });
    expect(c.lines(false).join("")).not.toContain("\x1b");
  });
  it("renders a 40-node graph quickly", () => {
    const many = Array.from({ length: 40 }, (_, i) => node({ id: `T-${i + 1}`, deps: i > 3 ? [`T-${(i % 4) + 1}`] : [], provider: "p", cli: "c" }));
    const t = performance.now();
    for (let i = 0; i < 10; i++) renderDag(many, { maxW: 160, maxH: 50, frame: i });
    expect((performance.now() - t) / 10).toBeLessThan(80);
  });
});

describe("agent identity lines keep provider, CLI, selection and runtime model apart", () => {
  const base = { state: "running" as const, agent: { id: "a", provider: "anthropic", adapter: "claude-code", cli_version: "2.1.316", model: null, model_mode: "cli-default" as const, runtime_model: null } };
  it("never invents a model", () => {
    expect(agentIdentity(base)).toBe("anthropic · claude-code 2.1.316");
    expect(modelLine(base)).toBe("model unknown (CLI-managed) · selection: CLI default");
    expect(modelLine({ ...base, agent: { ...base.agent, runtime_model: "rt-1", model: "mine", model_mode: "custom" } })).toBe("model rt-1 · selection: custom override mine");
  });
  it("explains a quota wait and a recovery", () => {
    const rec = { cls: "quota_exhausted", status: "waiting" as const, next_retry_at: "2026-01-01T15:04:00", reset_source: "estimate" as const, waits: 1, waited_s: 0, message: "", history: [] };
    const w = { ...base, state: "waiting_quota" as const, recovery: rec };
    expect(quotaLabel(w)).toBe("resumes 15:04~");
    expect(recoveryLine(w)).toMatch(/quota exhausted.*automatically.*estimated.*preserved/);
    expect(recoveryLine({ ...base, recovery: { ...rec, status: "recovered", waits: 2, waited_s: 90 } })).toMatch(/recovered from quota exhausted \(2 waits, 90s\)/);
    expect(recoveryLine({ ...base, recovery: { ...rec, status: "blocked", cls: "auth" } })).toMatch(/needs you/);
  });
});
