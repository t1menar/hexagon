import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { costReport } from "../src/core/cost.js";
import type { AgentStatus } from "../src/contracts/types.js";

const st = (task: string, role: string, agent: string, u: Partial<AgentStatus["usage"]>): AgentStatus =>
  ({ task_id: task, role, agent: { id: agent, provider: agent }, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, wall_ms: 0, turns: 0, ...u } }) as unknown as AgentStatus;

describe("cost report", () => {
  it("sums every attempt and role under the task, and splits by role and agent", () => {
    const r = costReport([
      st("T-1", "developer", "a", { input_tokens: 100, cache_read_tokens: 900, cost_usd: 0.5 }),
      st("T-1", "reviewer", "b", { input_tokens: 50, cache_read_tokens: 50, cost_usd: 0.25 }),
      st("T-2", "developer", "a", { input_tokens: 10, cost_usd: 0.1 }),
    ]);
    expect(r.by_task.find((x) => x.key === "T-1")!.cost_usd).toBeCloseTo(0.75);
    expect(r.by_task.find((x) => x.key === "T-1")!.attempts).toBe(2);
    expect(r.by_role.find((x) => x.key === "developer")!.cost_usd).toBeCloseTo(0.6);
    expect(r.total.cost_usd).toBeCloseTo(0.85);
    expect(r.by_agent.find((x) => x.key === "a")!.cache_hit).toBeCloseTo(900 / 1010);
  });

  it("a CLI that reports no cost is unknown unless the user gave a price; then it is marked an estimate", () => {
    const runs = [st("T-1", "developer", "codex", { input_tokens: 1_000_000, output_tokens: 100_000 })];
    const none = costReport(runs);
    expect(none.total.unknown_runs).toBe(1);
    expect(none.total.cost_usd).toBe(0);
    expect(none.warnings.join(" ")).toContain("unknown");
    const priced = costReport(runs, { codex: { input_per_mtok: 2, output_per_mtok: 10 } });
    expect(priced.total.cost_usd).toBeCloseTo(3);
    expect(priced.total.estimated_usd).toBeCloseTo(3);
    expect(priced.total.unknown_runs).toBe(0);
  });

  it("a run that happened but reported no usage at all is unknown, and one that never started is not counted", () => {
    const r = costReport([st("T-1", "developer", "grok", { wall_ms: 5000 }), st("T-2", "developer", "grok", {})]);
    expect(r.total.unknown_runs).toBe(1);
    expect(r.by_task.find((x) => x.key === "T-2")!.unknown_runs).toBe(0);
  });

  it("warns when an agent's cache hit rate is low, not when the volume is tiny", () => {
    const low = costReport([st("T-1", "developer", "a", { input_tokens: 90_000, cache_read_tokens: 10_000, cost_usd: 1 })]);
    expect(low.warnings.join(" ")).toMatch(/10% of its input came from cache/);
    const tiny = costReport([st("T-1", "developer", "a", { input_tokens: 900, cache_read_tokens: 100, cost_usd: 1 })]);
    expect(tiny.warnings).toEqual([]);
  });

  it("ships no price table and no model name", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/core/cost.ts"), "utf8") + fs.readFileSync(path.join(__dirname, "../templates/config.toml"), "utf8").split("# Cost.")[1]!;
    expect(src).not.toMatch(/claude-|gpt-|gemini-|grok-\d/i);
    expect(src).not.toMatch(/per_mtok\s*=\s*[1-9]/);
  });
});
