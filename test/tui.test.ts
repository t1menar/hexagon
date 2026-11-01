import { describe, expect, it } from "vitest";
import { Canvas } from "../src/tui/canvas.js";
import { drawHexagon, hexMetrics, innerWidth, irregularity } from "../src/tui/hex.js";
import { agentIdentity, modelLine, quotaLabel, recoveryLine } from "../src/tui/identity.js";


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

describe("agent identity lines keep provider, CLI, selection and runtime model apart", () => {
  const base = { state: "working" as const, agent: { id: "a", provider: "anthropic", adapter: "claude-code", cli_version: "2.1.316", model: null, model_mode: "cli-default" as const, runtime_model: null } };
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
