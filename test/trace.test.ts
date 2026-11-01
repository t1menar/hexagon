import { describe, expect, it } from "vitest";
import type { Plan, Task } from "../src/contracts/types.js";
import { parseSpec } from "../src/core/spec.js";
import { formatTrace, trace, type TaskEvidence } from "../src/core/trace.js";

const spec = parseSpec("s.md", "# S\n\n## REQ-A-001: Greets\nSays hello.\n- AC-1: prints hello\n\n## REQ-A-002: Farewell\nSays bye.\n- AC-1: prints bye\n\n## REQ-A-003: Nobody plans me\n- AC-1: x\n");
const task = (id: string, reqs: string[], verify: string[] = ["npm test"]): Task => ({ id, title: id, role: "developer", requirements: reqs, acceptance: ["AC-1"], depends_on: [], files: { write: [`${id}.ts`], read: [] }, skills: [], definition_of_done: [], verify });
const plan: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: "", specs: [], spec_issues: [], tasks: [task("T-1", ["REQ-A-001"]), task("T-2", ["REQ-A-002"]), task("T-3", [])] };

describe("traceability", () => {
  it("counts only recorded evidence, never agent claims", () => {
    const ev = new Map<string, TaskEvidence>([
      ["T-1", { state: "done", agent: "claude", provider: "anthropic", verify: [{ cmd: "npm test", code: 0 }], review: "approve", merged: true }],
      ["T-2", { state: "done", agent: "claude", provider: "anthropic", verify: [{ cmd: "npm test", code: 0 }], review: null, merged: true }], // not reviewed
    ]);
    const t = trace([spec], plan, ev);
    const by = Object.fromEntries(t.rows.map((r) => [r.requirement, r.status]));
    expect(by["REQ-A-001"]).toBe("complete");
    expect(by["REQ-A-002"]).not.toBe("complete"); // no approving review → not complete
    expect(by["REQ-A-003"]).toBe("unplanned");
    expect(t.orphanTasks).toEqual(["T-3"]);
    expect(formatTrace(t)).toContain("T-1 done by anthropic/claude · verify passed · review approve · merged");
  });
  it("a failed verification fails the requirement; unknown references are reported", () => {
    const ev = new Map<string, TaskEvidence>([["T-1", { state: "done", verify: [{ cmd: "npm test", code: 1 }], review: "approve", merged: true }]]);
    const bad = { ...plan, tasks: [...plan.tasks, task("T-4", ["REQ-Z-9"])] };
    const t = trace([spec], bad, ev);
    expect(t.rows.find((r) => r.requirement === "REQ-A-001")!.status).toBe("failed");
    expect(t.unknownRefs).toEqual([{ task: "T-4", ref: "REQ-Z-9" }]);
  });
});
