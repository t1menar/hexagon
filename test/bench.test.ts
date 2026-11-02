import { describe, expect, it } from "vitest";
import { benchTable, benchTasks, runBench } from "../src/bench.js";

// The bench itself spends real tokens and is never run here: this exercises the harness against the mock agent.
describe("hexagon bench harness (mock agent)", () => {
  it("five tasks of different sizes; the idle gap is a wait after task 3", () => {
    const t = benchTasks(310);
    expect(t).toHaveLength(5);
    expect(t[2]!.verify).toContain("sleep 310");
    expect(benchTasks(0)[2]!.verify).not.toContain("sleep 310");
    expect(new Set(t.map((x) => x.files.write.length)).size).toBeGreaterThan(1);
  });

  it("runs each policy and tabulates tokens, turns and wall time", async () => {
    const log: string[] = [];
    const rows = await runBench({ real: false, agent: "mock", policies: ["a", "b", "c"], gapsLong: 0, withReview: false, maxCost: 100, pollMs: 100, log: (l) => log.push(l) });
    expect(rows.map((r) => r.policy)).toEqual(["a", "b", "c"]);
    for (const r of rows) { expect(r.tasks_done).toBe(5); expect(r.turns).toBeGreaterThan(0); }
    // project scope reuses the session, task scope pays for a cold start every time
    const by = Object.fromEntries(rows.map((r) => [r.policy, r]));
    expect(by.b!.input).toBeGreaterThan(by.a!.input);
    expect(benchTable(rows)).toMatch(/\| a \| none \| 5\/5 \|/);
  }, 180000);

  it("stops before running anything once the cap is spent", async () => {
    const log: string[] = [];
    const rows = await runBench({ real: false, agent: "mock", policies: ["a"], gapsLong: 0, withReview: false, maxCost: 0, pollMs: 100, log: (l) => log.push(l) });
    expect(rows).toEqual([]);
    expect(log.join("\n")).toMatch(/cost cap \$0 reached/);
  });
});
