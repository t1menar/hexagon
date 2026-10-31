import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, toolSummary } from "../src/agents/claude-code.js";
import type { AgentRunContext } from "../src/agents/types.js";
import type { Plan, Task } from "../src/contracts/types.js";
import { validateMessage, validateStatus } from "../src/contracts/validate.js";
import { checkPlan, normalizePlan, topoOrder } from "../src/core/plan.js";
import { RunPaths } from "../src/core/project.js";
import { MessageRouter } from "../src/core/router.js";
import { overlaps, escalate } from "../src/core/scheduler.js";
import { lintSpec, parseSpec } from "../src/core/spec.js";
import { StatusStore } from "../src/core/status.js";
import { confinePath, globToRegExp, matchesAny, readJsonl } from "../src/util/fsx.js";
import { tokenize } from "../src/tui/app.js";
import { renderDag } from "../src/tui/dag.js";
import { chatLines, itemsFromEvents } from "../src/tui/chat.js";
import { taskStack } from "../src/tui/stack.js";
import { allowCommands } from "../src/core/config.js";
import { commandPrefix } from "../src/daemon/orchestrator.js";

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

describe("claude code adapter", () => {
  const ctx = (over: Partial<AgentRunContext>): AgentRunContext => ({
    agentRunId: "T-1-a1", role: "implementer", effort: "medium", cwd: "/w", system: "SYS", prompt: "P", sessionId: "uuid-1", resume: false,
    env: { HEXAGON_BIN: "/r/.hexagon/bin/hexagon" }, allowCommands: ["mvn", "git diff"], readOnly: false,
    host: {} as never, api: {} as never, signal: new AbortController().signal, ...over,
  });
  const a = new ClaudeCodeAdapter("claude", { command: ["claude"], model: "sonnet", args: [] });
  it("builds stream-json args with permissions from the allowlist", () => {
    const args = a.args(ctx({}));
    expect(args).toContain("--input-format");
    expect(args.slice(args.indexOf("--session-id"), args.indexOf("--session-id") + 2)).toEqual(["--session-id", "uuid-1"]);
    expect(args).toContain("Bash(mvn:*)");
    expect(args).toContain("Bash(git diff:*)");
    expect(args).toContain("Bash(hexagon:*)");
    expect(args).toContain("Bash(/r/.hexagon/bin/hexagon:*)");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  });
  it("resumes sessions, goes read-only for reviewers, and bypasses with *", () => {
    expect(a.args(ctx({ resume: true }))).toContain("--resume");
    const ro = a.args(ctx({ readOnly: true }));
    expect(ro).toContain("--disallowedTools");
    expect(ro.slice(ro.indexOf("--allowedTools"))).not.toContain("Edit");
    const any = a.args(ctx({ allowCommands: ["*"] }));
    expect(any[any.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(a.takeoverCommand("uuid-1")).toEqual(["claude", "--resume", "uuid-1"]);
  });
  it("summarizes tool calls and hides protocol reports", () => {
    expect(toolSummary("Bash", { command: "mvn -q test" })).toBe("$ mvn -q test");
    expect(toolSummary("Bash", { command: "hexagon report \"x\"" })).toBeNull();
    expect(toolSummary("Edit", { file_path: "/p/.hexagon/worktrees/r-1/T-1-a1/src/A.java" })).toBe("edit src/A.java");
  });
});

describe("plan normalization", () => {
  it("fills optional fields so agents can write short plans", () => {
    const p = normalizePlan({ tasks: [{ id: "T-1", title: "x", acceptance: ["AC-1"], files: { write: ["a"] }, verify: ["true"] }] }, { id: "p-1", specs: ["specs/x.md"] });
    expect(checkPlan(p).errors).toEqual([]);
    expect(p.tasks[0]!.definition_of_done).toEqual(["AC-1 holds"]);
  });
});

describe("config", () => {
  it("adds allowed commands in place", () => {
    const f = path.join(tmp(), "config.toml");
    fs.writeFileSync(f, "[sandbox]\nallow_commands = [\"ls\"]\ncommand_timeout_s = 5\n");
    expect(allowCommands(f, ["mvn", "ls"])).toEqual(["mvn"]);
    expect(fs.readFileSync(f, "utf8")).toContain('allow_commands = ["mvn", "ls"]');
  });
});

describe("dag", () => {
  it("draws boxes and arrows for dependencies", () => {
    const nodes = [
      { id: "T-1", title: "Controller", role: "implementer", deps: [], state: "done" as const },
      { id: "T-2", title: "Smoke test", role: "tester", deps: ["T-1"], state: "running" as const },
      { id: "T-3", title: "Docs", role: "implementer", deps: [], state: "queued" as const },
      { id: "T-4", title: "Release", role: "implementer", deps: ["T-2", "T-3"], state: "queued" as const },
    ];
    const text = renderDag(nodes, { maxW: 120, maxH: 20, frame: 0 }).lines(false).join("\n");
    for (const id of ["T-1", "T-2", "T-3", "T-4"]) expect(text).toContain(id);
    expect(text).toContain("▶");
    expect(text).toContain("╭");
  });
});

describe("shell", () => {
  it("tokenizes quotes", () => {
    expect(tokenize(`tell T-1 "hello world" x`)).toEqual(["tell", "T-1", "hello world", "x"]);
  });
});

describe("git", () => {
  it("lists uncommitted files without losing characters", async () => {
    const { execFileSync } = await import("node:child_process");
    const { uncommittedFiles } = await import("../src/core/git.js");
    const dir = tmp();
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
    g("init", "-q");
    fs.writeFileSync(path.join(dir, "hello.sh"), "a");
    g("add", "-A");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
    fs.writeFileSync(path.join(dir, "hello.sh"), "b");
    fs.writeFileSync(path.join(dir, "new file.txt"), "c");
    expect((await uncommittedFiles(dir)).sort()).toEqual(["hello.sh", "new file.txt"]);
  });
});

describe("chat", () => {
  it("shows tokens for each model step", () => {
    const ts = "2026-01-01T10:00:00.000Z";
    const { items } = itemsFromEvents([
      { ts, seq: 1, event: { type: "chat", from: "agent", text: "Looking at the code" } },
      { ts, seq: 2, event: { type: "usage", step: true, input: 1000, cache_read: 11300, cache_write: 0, output: 310, cost_usd: 0 } },
    ] as never);
    expect(items[0]!.tokens).toEqual({ input: 12300, output: 310 });
    expect(chatLines(items, 80, "T-1").map((l) => l.text).join("\n")).toContain("12k in · 310 out");
  });
});

describe("permissions", () => {
  it("derives the allow rule for a denied command", () => {
    expect(commandPrefix("brew install go")).toBe("brew");
    expect(commandPrefix("go test ./...")).toBe("go test");
    expect(commandPrefix("git push origin main")).toBe("git push");
    expect(commandPrefix("cd x && go test")).toBeNull();
    expect(commandPrefix("GOFLAGS=-v go build")).toBeNull();
  });
});

describe("stack", () => {
  it("names a task's technologies from its files, commands and text", () => {
    const t = { id: "T-1", title: "Hello endpoint with MockMvc test", role: "implementer", files: { write: ["pom.xml", "src/main/java/app/Hello.java"], read: [] }, verify: ["mvn -q test"], description: "Spring Boot controller" } as unknown as Task;
    expect(taskStack(t)).toEqual(["Maven", "Java", "Spring Boot", "MockMvc", "HTTP API"]);
    const g = { ...t, title: "x", description: "", files: { write: ["src/**"], read: [] }, verify: [] } as unknown as Task;
    expect(taskStack(g, ["Go"])).toEqual(["Go"]);
  });
});
