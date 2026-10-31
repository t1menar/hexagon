import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceTools, validateToolInput, toolsForRole } from "../src/agents/tools.js";
import type { Plan, Task } from "../src/contracts/types.js";
import { validateMessage, validateStatus } from "../src/contracts/validate.js";
import { checkPlan, topoOrder } from "../src/core/plan.js";
import { RunPaths } from "../src/core/project.js";
import { MessageRouter } from "../src/core/router.js";
import { overlaps, escalate } from "../src/core/scheduler.js";
import { lintSpec, parseSpec } from "../src/core/spec.js";
import { StatusStore } from "../src/core/status.js";
import { confinePath, globToRegExp, matchesAny, readJsonl } from "../src/util/fsx.js";
import { tokenize } from "../src/shell/repl.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hex-test-"));

const task = (over: Partial<Task> = {}): Task => ({
  id: "T-1", title: "Do it", role: "implementer", requirements: ["REQ-A-001"], acceptance: ["AC-1", "AC-2"],
  depends_on: [], files: { write: ["src/a.ts"], read: [] }, skills: [], definition_of_done: ["done"], verify: [], ...over,
});

describe("globs", () => {
  it("matches ** and *", () => {
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/x.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("test/{a,b}.ts").test("test/b.ts")).toBe(true);
    expect(matchesAny("./src/auth/login.ts", ["src/auth/**"])).toBe(true);
  });
  it("detects write-scope overlap", () => {
    expect(overlaps(["src/auth/**"], ["src/auth/login.ts"])).toBe(true);
    expect(overlaps(["src/**"], ["src/auth/*.ts"])).toBe(true);
    expect(overlaps(["src/a.ts"], ["src/b.ts"])).toBe(false);
    expect(overlaps(["src/auth/**"], ["test/auth/**"])).toBe(false);
  });
  it("confines paths", () => {
    expect(confinePath("/r", "a/b")).toBe("/r/a/b");
    expect(confinePath("/r", "../etc/passwd")).toBeNull();
    expect(confinePath("/r", "/etc/passwd")).toBeNull();
  });
});

describe("spec", () => {
  const text = `---\nspec: auth\nversion: 1\n---\n# Auth\n\n## REQ-AUTH-001: Login\nUsers log in.\n\n**Acceptance**\n- AC-1: Valid credentials → 200\n- AC-2: Login should be fast\n\n**Touches**: \`src/auth/**\`\n\n## REQ-AUTH-002: Logout\nNo criteria here.\n`;
  it("parses requirements and acceptance criteria", () => {
    const s = parseSpec("auth.spec.md", text);
    expect(s.meta.spec).toBe("auth");
    expect(s.requirements.map((r) => r.id)).toEqual(["REQ-AUTH-001", "REQ-AUTH-002"]);
    expect(s.requirements[0]!.acceptance.map((a) => a.id)).toEqual(["AC-1", "AC-2"]);
    expect(s.requirements[0]!.touches).toEqual(["src/auth/**"]);
  });
  it("lints", () => {
    const issues = lintSpec(parseSpec("auth.spec.md", text), ["README.md"]);
    const rules = issues.map((i) => i.rule);
    expect(rules).toContain("no-acceptance");
    expect(rules).toContain("vague-acceptance");
    expect(rules).toContain("touches-missing");
  });
});

describe("plan", () => {
  const plan = (tasks: Task[]): Plan => ({ schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], tasks, spec_issues: [] });
  it("orders a DAG and detects cycles", () => {
    const a = task({ id: "T-1" });
    const b = task({ id: "T-2", depends_on: ["T-1"] });
    expect(topoOrder([b, a])).toEqual(["T-1", "T-2"]);
    expect(checkPlan(plan([a, b])).errors).toEqual([]);
    const c1 = task({ id: "T-1", depends_on: ["T-2"] });
    expect(checkPlan(plan([c1, b])).errors).toContain("dependency cycle detected");
  });
  it("rejects schema violations", () => {
    const bad = plan([task({ id: "X-1" })]);
    expect(checkPlan(bad).errors[0]).toMatch(/schema/);
  });
  it("escalates effort", () => {
    expect(escalate("medium", 1)).toBe("high");
    expect(escalate("max", 2)).toBe("max");
  });
});

describe("status store", () => {
  it("writes schema-valid snapshots with monotonic seq", () => {
    const dir = tmp();
    const rp = new RunPaths(dir);
    const store = new StatusStore(rp, "r-1", { plan_path: "p.json", integration_branch: "i", base_branch: "main", budget_usd: null });
    const s = store.create({ task: task(), attempt: 1, role: "implementer", agent: { id: "mock", provider: "mock" }, supportsLiveInput: true });
    store.apply(s.agent_run_id, { type: "state", state: "running" });
    store.apply(s.agent_run_id, { type: "status_report", phase: "editing", activity: "Writing", checklist: [{ id: "AC-1", status: "done" }] });
    store.apply(s.agent_run_id, { type: "usage", input: 100, output: 10, cache_read: 50, cache_write: 0, cost_usd: 0.01 });
    const onDisk = JSON.parse(fs.readFileSync(rp.agentStatus("T-1-a1"), "utf8"));
    const v = validateStatus(onDisk);
    expect(v.errors).toEqual([]);
    expect(onDisk.seq).toBe(4);
    expect(onDisk.progress).toEqual({ done: 1, total: 2, unit: "acceptance criteria" });
    expect(onDisk.controller).toBe("agent");
    expect(readJsonl(rp.events)).toHaveLength(3);
    const run = JSON.parse(fs.readFileSync(rp.status, "utf8"));
    expect(run.agents[0].state).toBe("running");
    expect(run.totals.cost_usd).toBeCloseTo(0.01);
  });
});

describe("router", () => {
  it("queues, delivers, acks and rate-limits", () => {
    const rp = new RunPaths(tmp());
    const r = new MessageRouter(rp, "r-1", { max_outbound_per_run: 1 }, { activeTasks: () => ["T-1", "T-2"] });
    const [m] = r.send({ from: { kind: "user" }, to: { kind: "agent", id: "T-1" }, type: "instruction", body: "use X" });
    expect(m!.delivery.state).toBe("queued");
    expect(validateMessage(m).errors).toEqual([]);
    expect(r.pending("T-1")).toBe(1);
    const got = r.take("T-1");
    expect(got.map((x) => x.delivery.state)).toEqual(["delivered"]);
    expect(r.ack([m!.id])[0]!.delivery.state).toBe("acked");
    expect(r.send({ from: { kind: "user" }, to: { kind: "broadcast" }, type: "instruction", body: "all" })).toHaveLength(2);
    r.send({ from: { kind: "agent", id: "T-1" }, to: { kind: "blackboard" }, type: "note", body: "n1" });
    const rejected = r.send({ from: { kind: "agent", id: "T-1" }, to: { kind: "blackboard" }, type: "note", body: "n2" });
    expect(rejected[0]!.delivery.state).toBe("rejected");
    expect(r.notes()).toContain("n1");
    // reload from disk keeps the id counter
    const r2 = new MessageRouter(rp, "r-1", { max_outbound_per_run: 5 }, { activeTasks: () => [] });
    expect(r2.send({ from: { kind: "user" }, to: { kind: "user" }, type: "notify", body: "x" })[0]!.id).toBe("M-6");
  });
});

describe("tools", () => {
  it("enforces write scope and allowlist", async () => {
    const dir = tmp();
    const ws = new WorkspaceTools({ cwd: dir, writeGlobs: ["src/**"], allowCommands: ["ls", "node"], timeoutS: 10 });
    expect((await ws.run("write_file", { path: "src/a.ts", content: "x" })).is_error).toBeFalsy();
    expect((await ws.run("write_file", { path: "pkg.json", content: "x" })).content).toMatch(/outside your write scope/);
    expect((await ws.run("write_file", { path: "../evil", content: "x" })).content).toMatch(/escapes/);
    expect((await ws.run("edit_file", { path: "src/a.ts", old_str: "x", new_str: "y" })).is_error).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, "src/a.ts"), "utf8")).toBe("y");
    expect((await ws.run("run_cmd", { cmd: "rm -rf /" })).content).toMatch(/allowlist/);
    expect((await ws.run("run_cmd", { cmd: "ls; rm x" })).content).toMatch(/operators/);
    const ok = await ws.run("run_cmd", { cmd: "node -e \"process.exit(3)\"".replace(/"/g, "'") });
    expect(ok.content).toMatch(/^exit 3/);
  });
  it("validates tool inputs and keeps a stable order", () => {
    expect(validateToolInput("ask_user", { kind: "choice", prompt: "?", blocking: true })).toEqual([]);
    expect(validateToolInput("ask_user", { prompt: "?" }).length).toBeGreaterThan(0);
    expect(toolsForRole("implementer").map((t) => t.name)).toEqual([...toolsForRole("implementer").map((t) => t.name)].sort());
  });
});

describe("shell", () => {
  it("tokenizes quotes", () => {
    expect(tokenize(`tell T-1 "hello world" x`)).toEqual(["tell", "T-1", "hello world", "x"]);
  });
});
