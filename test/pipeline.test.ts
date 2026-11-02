import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
const task = (id: string, requirements: string[]) => ({ id, requirements, title: id, description: "", files: { write: ["a.txt"], read: [] as string[] }, acceptance: [] as string[], verify: [] as string[] });

describe("spec approval gate", () => {
  it("blocks a task that cites a requirement of an unapproved spec", () => {
    const { ap, spec } = rig();
    const g = ap.check(task("T-1", ["REQ-A-001"]), [spec]);
    expect(g.ok).toBe(false);
    expect(g.problems[0]).toMatch(/not approved/);
  });

  it("lets ungated tasks and approved tasks through", () => {
    const { ap, spec } = rig();
    // No silent bypass: a task that cites no requirement needs the user's recorded approval.
    const t0 = task("T-0", []);
    expect(ap.check(t0, [spec]).problems[0]).toMatch(/cites no requirement/);
    expect(ap.check(t0, []).ok).toBe(true); // not spec-driven: nothing to cover
    ap.approveTask(t0, "user");
    expect(ap.check(t0, [spec]).ok).toBe(true);
    expect(ap.check({ ...t0, title: "something else" }, [spec]).ok).toBe(false); // changing it voids the approval
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

describe("acceptance: an unapproved spec blocks implementation", () => {
  it("run.start refuses a plan whose requirements are not approved, and accepts it after approval", async () => {
    const { execFileSync } = await import("node:child_process");
    const { HexClient } = await import("../src/client/client.js");
    const { DaemonServer } = await import("../src/daemon/server.js");
    const { scaffold } = await import("../src/core/project.js");
    const root = fs.mkdtempSync(path.join("/tmp", "hq-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const cfg = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 30"));
    git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon");
    fs.mkdirSync(path.join(root, "specs"), { recursive: true });
    fs.writeFileSync(path.join(root, "specs/s.spec.md"), "# S\n\n## REQ-A-001: Greets\nSays hello.\n- AC-1: prints hello\n");
    const plan = {
      schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: ["specs/s.spec.md"], spec_issues: [],
      tasks: [{ id: "T-1", title: "Greet", role: "developer", requirements: ["REQ-A-001"], acceptance: ["AC-1"], depends_on: [], files: { write: ["src/a.txt"], read: [] }, skills: [], definition_of_done: ["done"], verify: [], verify_exempt: "test fixture" }],
    };
    fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(plan));
    const server = new DaemonServer(root);
    await server.listen();
    const client = await HexClient.connect(root, { autostart: false });
    try {
      await expect(client.call("run.start", { plan_path: "plan.json" })).rejects.toThrow(/spec gate: .*not approved/);
      await client.call("spec.approve", { spec: "specs/s.spec.md" });
      const { run_id } = await client.call<{ run_id: string }>("run.start", { plan_path: "plan.json" });
      expect(run_id).toMatch(/^r-/);
    } finally {
      client.close();
      server.orch.shutdown();
    }
  }, 30000);

  it("a spec edit after approval sends the gated task to replan (once) instead of leaving it stuck", async () => {
    const { execFileSync } = await import("node:child_process");
    const { HexClient } = await import("../src/client/client.js");
    const { DaemonServer } = await import("../src/daemon/server.js");
    const { scaffold } = await import("../src/core/project.js");
    const root = fs.mkdtempSync(path.join("/tmp", "hq-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const cfg = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 30"));
    git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon");
    fs.mkdirSync(path.join(root, "specs"), { recursive: true });
    fs.writeFileSync(path.join(root, "specs/s.spec.md"), "# S\n\n## REQ-A-001: Greets\nSays hello.\n- AC-1: prints hello\n");
    const plan = {
      schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: ["specs/s.spec.md"], spec_issues: [],
      tasks: [{ id: "T-1", title: "Greet", role: "developer", requirements: ["REQ-A-001"], acceptance: ["AC-1"], depends_on: [], files: { write: ["src/a.txt"], read: [] }, skills: [], definition_of_done: ["done"], verify: [], verify_exempt: "test fixture" }],
    };
    plan.tasks.push({ ...plan.tasks[0]!, id: "T-2", depends_on: ["T-1"], files: { write: ["src/b.txt"], read: [] } } as never);
    fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(plan));
    const saved = process.env.HEXAGON_NO_CHECKPOINT;
    const server = new DaemonServer(root);
    await server.listen();
    const client = await HexClient.connect(root, { autostart: false });
    try {
      await client.call("spec.approve", { spec: "specs/s.spec.md" });
      delete process.env.HEXAGON_NO_CHECKPOINT;
      const calls: string[] = [];
      (server.orch as any).replan = (task: { id: string }, why: string) => { calls.push(`${task.id}: ${why}`); };
      await client.call("run.start", { plan_path: "plan.json" });
      fs.writeFileSync(path.join(root, "specs/s.spec.md"), "# S\n\n## REQ-A-001: Greets\nSays hello loudly.\n- AC-1: prints HELLO\n");
      // The checkpoint after the first merge holds T-2; once the human resumes, the changed spec gates it and sends it to replan.
      await vi.waitFor(async () => expect(JSON.stringify(await client.call("run.status", {}))).toContain('"checkpoint"'), { timeout: 20000 });
      await client.call("run.resume", {});
      await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: 20000 });
      await new Promise((r) => setTimeout(r, 500));
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatch(/^T-2: the spec changed after approval: REQ-A-001 changed/);
    } finally {
      if (saved !== undefined) process.env.HEXAGON_NO_CHECKPOINT = saved;
      client.close();
      server.orch.shutdown();
    }
  }, 30000);
});
