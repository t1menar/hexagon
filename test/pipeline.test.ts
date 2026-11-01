import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Approvals, checkAnalysis, checkDesign } from "../src/core/pipeline.js";

const SPEC = (a: string, b = "prints bye") =>
  `# S\n\n## REQ-A-001: Greets\nSays hello.\n- AC-1: ${a}\n\n## REQ-A-002: Farewell\nSays bye.\n- AC-1: ${b}\n`;

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hp-"));
  const spec = path.join(root, "specs", "s.spec.md");
  fs.mkdirSync(path.dirname(spec), { recursive: true });
  fs.writeFileSync(spec, SPEC("prints hello"));
  return { root, spec, ap: new Approvals(path.join(root, "approvals.json"), root) };
}
const task = (id: string, requirements: string[]) => ({ id, requirements });

describe("spec approval gate", () => {
  it("blocks a task that cites a requirement of an unapproved spec", () => {
    const { ap, spec } = rig();
    const g = ap.check(task("T-1", ["REQ-A-001"]), [spec]);
    expect(g.ok).toBe(false);
    expect(g.problems[0]).toMatch(/not approved/);
  });

  it("lets ungated tasks and approved tasks through", () => {
    const { ap, spec } = rig();
    expect(ap.check(task("T-0", []), [spec]).ok).toBe(true);
    ap.approve(spec);
    expect(ap.check(task("T-1", ["REQ-A-001"]), [spec]).ok).toBe(true);
  });

  it("blocks only the tasks whose requirement changed after approval", () => {
    const { ap, spec } = rig();
    ap.approve(spec);
    fs.writeFileSync(spec, SPEC("prints hello world"));
    const t1 = ap.check(task("T-1", ["REQ-A-001"]), [spec]);
    expect(t1.ok).toBe(false);
    expect(t1.changed).toEqual(["REQ-A-001"]);
    expect(ap.check(task("T-2", ["REQ-A-002"]), [spec]).ok).toBe(true);
    ap.approve(spec);
    expect(ap.check(task("T-1", ["REQ-A-001"]), [spec]).ok).toBe(true);
  });

  it("flags a requirement that exists in no spec and refuses to approve a broken spec", () => {
    const { ap, spec, root } = rig();
    expect(ap.check(task("T-1", ["REQ-Z-009"]), [spec]).problems[0]).toMatch(/in no spec/);
    const bad = path.join(root, "bad.md");
    fs.writeFileSync(bad, "# Bad\n\n## REQ-B-001: No criteria\nText.\n");
    expect(() => ap.approve(bad)).toThrow(/errors/);
  });
});

describe("stage artifacts", () => {
  it("analysis must have the required sections", () => {
    expect(checkAnalysis("# A\n").length).toBeGreaterThan(0);
    const ok = ["Current state", "Constraints", "Risks", "Open questions", "Impacted areas"].map((h) => `## ${h}\nx\n`).join("\n");
    expect(checkAnalysis(ok)).toEqual([]);
  });
  it("design must cover interfaces, data flow and trade-offs", () => {
    expect(checkDesign("# D\n").length).toBeGreaterThan(0);
    expect(checkDesign(["Interfaces", "Data flow", "Trade-offs"].map((h) => `## ${h}\nx\n`).join("\n"))).toEqual([]);
  });
});
