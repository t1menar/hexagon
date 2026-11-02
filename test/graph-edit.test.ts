import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan, RunStatus, Task } from "../src/contracts/types.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 40000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(50); }
}
function project(): string {
  const root = fs.mkdtempSync(path.join("/tmp", "hg-"));
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  scaffold(root);
  const f = path.join(root, ".hexagon/config.toml");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 30"));
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
  return root;
}
const task = (id: string, deps: string[], description = ""): Task => ({ id, title: `Task ${id}`, role: "developer", requirements: [], acceptance: [], depends_on: deps, files: { write: [`src/${id}.txt`], read: [] }, skills: [], definition_of_done: ["done"], verify: [], verify_exempt: "test fixture", description });

describe("editing a running graph", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  /** T-1 asks a question and so holds still until answered; T-2 waits for it. */
  async function boot() {
    const root = project();
    const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [], tasks: [task("T-1", [], "@ask: go on?"), task("T-2", ["T-1"])] };
    fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(p));
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.subscribe();
    await c.call("run.start", { plan_path: "plan.json" });
    await until(async () => (await c.call<AgentStatus>("agent.status", { task: "T-1" })).state === "waiting_input");
    const exec = (name: string, args: Record<string, unknown>) => c.call<{ status: string; proposal?: { id: string; diff: string[] }; result?: unknown }>("command.exec", { name, args });
    const finish = async () => {
      const q = await c.call<{ questions: { question_id: string }[] }>("inbox.list");
      await c.call("question.answer", { question_id: q.questions[0]!.question_id, answer: "1" });
      return until(async () => { const r = await c.call<RunStatus>("run.status"); return r.state === "done" ? r : null; }, 60000);
    };
    return { root, c, s, exec, finish };
  }

  it("adds a task and an edge while the run is going; the new task runs after what it waits for", async () => {
    const { c, exec, finish, root } = await boot();
    const added = await exec("graph.addNode", { write: ["docs/new.txt"], verify_exempt: "test fixture", role: "developer", title: "Docs", depends_on: ["T-2"] });
    expect(added.status).toBe("done");
    const plan = await c.call<{ plan: Plan }>("ui.snapshot");
    expect(plan.plan.tasks.map((t) => t.id)).toEqual(["T-1", "T-2", "T-3"]);
    await exec("graph.addNode", { verify_exempt: "test fixture", role: "qa", title: "Extra", id: "T-4", write: ["docs/extra.txt"] });
    await exec("graph.addEdge", { from: "T-4", to: "T-3" });
    const final = await finish();
    expect(final.agents.map((a) => `${a.task_id}:${a.state}`).sort()).toEqual(["T-1:done", "T-2:done", "T-3:done", "T-4:done"]);
    // The edited graph is on disk with the run.
    const runDir = path.join(root, ".hexagon/runs", fs.readdirSync(path.join(root, ".hexagon/runs"))[0]!);
    const saved = JSON.parse(fs.readFileSync(path.join(runDir, "plan.json"), "utf8")) as Plan;
    expect(saved.tasks.find((t) => t.id === "T-3")!.depends_on.sort()).toEqual(["T-2", "T-4"]);
  }, 90000);

  it("removing a task asks for a yes first; once confirmed, a task that has not started is gone and nothing waits for it", async () => {
    const { c, exec, finish } = await boot();
    await exec("graph.addNode", { write: ["docs/new.txt"], verify_exempt: "test fixture", role: "developer", title: "Docs", depends_on: ["T-2"] });
    const r = await exec("graph.removeNode", { id: "T-2" });
    expect(r.status).toBe("proposed"); // destructive: your own call waits for a yes
    expect((await c.call<{ plan: Plan }>("ui.snapshot")).plan.tasks.map((t) => t.id)).toEqual(["T-1", "T-2", "T-3"]); // destructive: your own call waits for a yes
    expect(r.proposal!.diff).toEqual(expect.arrayContaining(["- task T-2 [developer] Task T-2"]));
    await c.call("command.confirm", { id: r.proposal!.id });
    const snap = await c.call<{ plan: Plan }>("ui.snapshot");
    expect(snap.plan.tasks.map((t) => t.id)).toEqual(["T-1", "T-3"]);
    expect(snap.plan.tasks.find((t) => t.id === "T-3")!.depends_on).toEqual([]);
    const final = await finish();
    expect(final.agents.filter((a) => a.state === "done").map((a) => a.task_id).sort()).toEqual(["T-1", "T-3"]);
  }, 90000);

  it("refuses what the run cannot honour: a started task, an edge into it, a cycle, an unknown role", async () => {
    const { exec, finish } = await boot();
    await expect(exec("graph.removeNode", { id: "T-1" })).rejects.toThrow(/already started/);
    await expect(exec("graph.addEdge", { from: "T-2", to: "T-1" })).rejects.toThrow(/cycle|already started/);
    await expect(exec("graph.addEdge", { from: "T-1", to: "T-1" })).rejects.toThrow();
    await expect(exec("graph.addNode", { write: ["docs/new.txt"], verify_exempt: "test fixture", role: "wizard", title: "x" })).rejects.toThrow(/unknown role/);
    await expect(exec("graph.removeEdge", { from: "T-9", to: "T-2" })).rejects.toThrow(/does not wait/);
    await finish();
    await expect(exec("graph.addNode", { write: ["docs/new.txt"], verify_exempt: "test fixture", role: "developer", title: "late" })).rejects.toThrow(/no graph to edit|finished/);
  }, 90000);

  it("the assistant's live edit is a proposal; confirming applies it to the running graph", async () => {
    const { c, finish } = await boot();
    const r = await c.call<{ ok: boolean; message: string }>("agent.api", { agent: "control", op: "command", args: { name: "graph.addNode", args: { write: ["docs/new.txt"], verify_exempt: "test fixture", role: "qa", title: "Check", depends_on: ["T-1"] } } });
    expect(r.message).toMatch(/Proposed P-1/);
    expect((await c.call<{ plan: Plan }>("ui.snapshot")).plan.tasks).toHaveLength(2);
    await c.call("command.confirm", { id: "P-1" });
    expect((await c.call<{ plan: Plan }>("ui.snapshot")).plan.tasks).toHaveLength(3);
    await finish();
  }, 90000);
});

describe("hexagon scope request", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  it("grants lockfiles at once, refuses what a running task holds, and asks the user for the rest", async () => {
    const root = project();
    // Both tasks hold still on a question, so both are running while the requests come in.
    const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [], tasks: [task("T-1", [], "@ask: go on?"), task("T-2", [], "@ask: go on?")] };
    fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(p));
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.call("run.start", { plan_path: "plan.json" });
    for (const t of ["T-1", "T-2"]) await until(async () => (await c.call<AgentStatus>("agent.status", { task: t })).state === "waiting_input");
    const api = (args: Record<string, unknown>) => s.orch.agentApi("T-1", null, "scope", args) as Promise<{ ok: boolean; message: string }>;

    expect(await api({ globs: ["package-lock.json"] })).toMatchObject({ ok: false, message: expect.stringMatching(/usage/) }); // no reason given
    const lock = await api({ globs: ["package-lock.json"], why: "added a dependency" });
    expect(lock.ok).toBe(true);
    const plan = (await c.call<{ plan: Plan }>("ui.snapshot")).plan;
    expect(plan.tasks.find((t) => t.id === "T-1")!.files.write).toContain("package-lock.json");

    const held = await api({ globs: ["src/T-2.txt"], why: "needs the other task's file" });
    expect(held).toMatchObject({ ok: false, message: expect.stringMatching(/T-2 is running/) });

    s.orch.cfg.run.shared_files = ["src/registry.ts"];
    expect(await api({ globs: ["src/registry.ts"], why: "register" })).toMatchObject({ ok: false, message: expect.stringMatching(/owned by the integration/) });

    // Anything else is the user's call: the request waits for an answer in the approval box.
    const pending = api({ globs: ["docs/guide.md"], why: "document the flag" });
    const perm = await until(async () => (await c.call<{ permissions: { id: string; action?: string }[] }>("ui.snapshot")).permissions.find((x) => x.action === "scope"));
    await c.call("question.answer", { question_id: perm.id, answer: "n" });
    expect(await pending).toMatchObject({ ok: false, message: expect.stringMatching(/denied/) });
    expect(((await c.call<{ plan: Plan }>("ui.snapshot")).plan.tasks.find((t) => t.id === "T-1")!.files.write)).not.toContain("docs/guide.md");
    const pending2 = api({ globs: ["docs/guide.md"], why: "document the flag" });
    const perm2 = await until(async () => (await c.call<{ permissions: { id: string; action?: string }[] }>("ui.snapshot")).permissions.find((x) => x.action === "scope"));
    await c.call("question.answer", { question_id: perm2.id, answer: "1" });
    expect((await pending2).ok).toBe(true);
  }, 60000);
});

describe("a blocked task", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  async function blocked(reason: string, tag = "@block") {
    const root = project();
    const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [], tasks: [task("T-1", [], `${tag}: ${reason}`), task("T-2", ["T-1"])] };
    fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(p));
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    const asked: string[] = [];
    s.orch.chat = (t: string) => { asked.push(t); };
    await c.call("run.start", { plan_path: "plan.json" });
    await until(async () => (await c.call<AgentStatus>("agent.status", { task: "T-1" })).state === "blocked");
    return { c, s, asked };
  }
  const proposals = async (c: HexClient) => (await c.call<{ proposals: { id: string; command: string; diff: string[] }[] }>("ui.snapshot")).proposals;

  it("is re-planned only when the plan is the problem: the analyst proposes, nothing changes until you confirm, and started tasks are untouched", async () => {
    const { c, asked } = await blocked("REQ-A contradicts REQ-B about the retry limit");
    const { MockAdapter } = await import("../src/agents/mock.js");
    const p = await until(async () => (await proposals(c)).find((x) => x.command === "replan.apply"));
    expect(asked).toEqual([]);
    expect(MockAdapter.turns.some((t) => /<stage>replan<\/stage>[\s\S]*Waiting behind it: T-2 "Task T-2"/.test(t.text))).toBe(true); // real context, not an empty note // the analyst was free, so the Assistant was not asked
    expect(p.diff[0]).toMatch(/mock replan/);
    expect(p.diff).toEqual(expect.arrayContaining(["- task T-2 [developer] Task T-2"]));
    expect(p.diff.some((d) => /^\+ task T-3 \[developer\] Rework after replan/.test(d))).toBe(true);
    expect(p.diff.some((d) => /^[-+~] task T-1\b/.test(d))).toBe(false); // T-1 (the blocked, started task) is not edited
    expect((await c.call<{ plan: Plan }>("ui.snapshot")).plan.tasks.map((t) => t.id)).toEqual(["T-1", "T-2"]); // proposal only
    await c.call("command.confirm", { id: p.id });
    expect((await c.call<{ plan: Plan }>("ui.snapshot")).plan.tasks.map((t) => t.id)).toEqual(["T-1", "T-3"]);
  }, 60000);

  it("while the replan is pending the tasks after it wait (not failed), the run stays open and its graph stays editable", async () => {
    const { c } = await blocked("REQ-A contradicts REQ-B about the retry limit");
    const state = async (id: string) => (await c.call<AgentStatus>("agent.status", { task: id })).state;
    await until(async () => (await proposals(c)).find((x) => x.command === "replan.apply"));
    expect(await state("T-2")).toBe("queued");
    const snap = await c.call<{ run: { state: string; attention: { kind: string; task_id: string }[] } }>("ui.snapshot");
    expect(snap.run.state).toBe("running");
    expect(snap.run.attention).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "replan", task_id: "T-1" })]));
    // The Assistant's own graph edit works meanwhile: this is the "no graph to edit" regression.
    const r = await c.call<{ status: string }>("command.exec", { name: "graph.addNode", args: { write: ["docs/x.txt"], verify_exempt: "test fixture", role: "developer", title: "Extra", depends_on: ["T-2"] } });
    expect(r.status).toBe("done");
    expect((await c.call<{ plan: Plan }>("ui.snapshot")).plan.tasks.map((t) => t.id)).toEqual(["T-1", "T-2", "T-3"]);
  }, 60000);

  it("applying the replan retries the blocked task and the new task after it runs", async () => {
    const { c } = await blocked("REQ-A contradicts REQ-B about the retry limit", "@block-once");
    const p = await until(async () => (await proposals(c)).find((x) => x.command === "replan.apply"));
    await c.call("command.confirm", { id: p.id });
    // The first attempt was the only one that blocked: the retry completes, then T-3 (added by the replan) runs.
    await until(async () => (await c.call<AgentStatus>("agent.status", { task: "T-1" })).state === "done");
    await until(async () => (await c.call<AgentStatus>("agent.status", { task: "T-3" }).catch(() => null))?.state === "done");
    const snap = await c.call<{ run: { attention: unknown[] } }>("ui.snapshot");
    expect(snap.run.attention).toEqual([]);
  }, 60000);

  it("rejecting the proposal leaves the plan as it was", async () => {
    const { c } = await blocked("REQ-A contradicts REQ-B about the retry limit");
    const p = await until(async () => (await proposals(c)).find((x) => x.command === "replan.apply"));
    await c.call("command.reject", { id: p.id });
    expect((await c.call<{ plan: Plan }>("ui.snapshot")).plan.tasks.map((t) => t.id)).toEqual(["T-1", "T-2"]);
  }, 60000);

  it("a missing tool is not a plan problem: no re-plan", async () => {
    const { c, asked } = await blocked("go is not installed");
    await sleep(600);
    expect(asked).toEqual([]);
    expect(await proposals(c)).toEqual([]);
  }, 60000);
});

describe("a reviewer question", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  it("goes to the user, and the answer comes back into the review before the verdict", async () => {
    const { MockAdapter } = await import("../src/agents/mock.js");
    MockAdapter.turns.length = 0;
    MockAdapter.reviews.clear(); // the mock counts reviews per task id across tests
    const root = project();
    const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [], tasks: [task("T-1", [], "@review-question: keep the legacy flag?")] };
    fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(p));
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.call("run.start", { plan_path: "plan.json" });
    const q = await until(async () => (await c.call<{ questions: { question_id: string; prompt: string }[] }>("inbox.list")).questions.find((x) => /Reviewer asks: keep the legacy flag\?/.test(x.prompt)));
    expect((await c.call<AgentStatus>("agent.status", { task: "T-1" })).state).toBe("waiting_input");
    await c.call("question.answer", { question_id: q.question_id, answer: "1" });
    const st = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "done" || x.state === "failed" ? x : null; }, 60000);
    expect(st.state).toBe("done");
    expect(MockAdapter.turns.some((t) => /The user answered your question \("keep the legacy flag\?"\): 1\) Yes/.test(t.text))).toBe(true);
  }, 90000);
});
