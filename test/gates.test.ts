import { describe, expect, it } from "vitest";
import type { Plan, Task } from "../src/contracts/types.js";
import { checkPlan, qualifyAcceptance } from "../src/core/plan.js";
import { parseSpec } from "../src/core/spec.js";

const SPEC = (extra = "") => `# S\n\n## REQ-A-001: Greets\nSays hello.\n- AC-1: prints hello\n- AC-2: exits zero\n\n## REQ-A-002: Farewell\nSays bye.\n- AC-1: prints bye\n${extra}`;
const spec = (text = SPEC()) => parseSpec("s.spec.md", text);
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, title: id, role: "developer", requirements: [], acceptance: [], depends_on: [], files: { write: ["a.txt"], read: [] }, skills: [], definition_of_done: ["done"], verify: ["npm test"], ...over });
const plan = (...tasks: Task[]): Plan => ({ schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: ["s.spec.md"], tasks, spec_issues: [] });

describe("plan-check lets nothing vacuous through", () => {
  it("a task without verify is an error unless it says why", () => {
    expect(checkPlan(plan(task("T-1", { verify: [] }))).errors.join()).toMatch(/T-1 has no verify command/);
    expect(checkPlan(plan(task("T-1", { verify: [], verify_exempt: "docs only" }))).errors).toEqual([]);
  });

  it("an acceptance criterion no task covers is an error", () => {
    const p = plan(task("T-1", { requirements: ["REQ-A-001"], acceptance: ["AC-1"] }));
    const e = checkPlan(p, [spec()]).errors.join("\n");
    expect(e).toMatch(/REQ-A-001\/AC-2 is not covered/);
    expect(e).toMatch(/REQ-A-002\/AC-1 is not covered/);
  });

  it("an unknown requirement is an error", () => {
    expect(checkPlan(plan(task("T-1", { requirements: ["REQ-Z-001"] })), [spec()]).errors.join()).toMatch(/unknown requirement REQ-Z-001/);
  });

  it("a bare AC id counts for one requirement, never both", () => {
    const t = task("T-1", { requirements: ["REQ-A-001", "REQ-A-002"], acceptance: ["AC-1"] });
    const q = qualifyAcceptance(t, [spec()]);
    expect(q.ids).toEqual([]);
    expect(q.problems[0]).toMatch(/REQ-A-001 and REQ-A-002 both define\. Write REQ-A-001\/AC-1 or REQ-A-002\/AC-1/);
    // AC-2 only exists on REQ-A-001: unambiguous, accepted in the old form
    expect(qualifyAcceptance(task("T-2", { requirements: ["REQ-A-001", "REQ-A-002"], acceptance: ["AC-2"] }), [spec()]).ids).toEqual(["REQ-A-001/AC-2"]);
  });

  it("qualified ids cover exactly what they name", () => {
    const p = plan(task("T-1", { requirements: ["REQ-A-001", "REQ-A-002"], acceptance: ["REQ-A-001/AC-1", "REQ-A-001/AC-2"] }));
    const e = checkPlan(p, [spec()]).errors.join("\n");
    expect(e).toMatch(/REQ-A-002\/AC-1 is not covered/);
    expect(e).not.toMatch(/REQ-A-001\/AC/);
    const full = plan(task("T-1", { requirements: ["REQ-A-001", "REQ-A-002"], acceptance: ["REQ-A-001/AC-1", "REQ-A-001/AC-2", "REQ-A-002/AC-1"] }));
    expect(checkPlan(full, [spec()]).errors).toEqual([]);
  });

  it("an AC the task does not cite a requirement for is an error", () => {
    expect(qualifyAcceptance(task("T-1", { requirements: ["REQ-A-001"], acceptance: ["REQ-A-002/AC-1"] }), [spec()]).problems[0]).toMatch(/does not cite REQ-A-002/);
  });
});
