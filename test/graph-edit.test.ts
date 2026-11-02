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
    const added = await exec("graph.addNode", { role: "developer", title: "Docs", depends_on: ["T-2"] });
    expect(added.status).toBe("done");
    const plan = await c.call<{ plan: Plan }>("ui.snapshot");
    expect(plan.plan.tasks.map((t) => t.id)).toEqual(["T-1", "T-2", "T-3"]);
    await exec("graph.addNode", { role: "qa", title: "Extra", id: "T-4" });
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
    await exec("graph.addNode", { role: "developer", title: "Docs", depends_on: ["T-2"] });
    const r = await exec("graph.removeNode", { id: "T-2" });
    expect(r.status).toBe("proposed"); // destructive: your own call waits for a yes
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
    await expect(exec("graph.addNode", { role: "wizard", title: "x" })).rejects.toThrow(/unknown role/);
    await expect(exec("graph.removeEdge", { from: "T-9", to: "T-2" })).rejects.toThrow(/does not wait/);
    await finish();
    await expect(exec("graph.addNode", { role: "developer", title: "late" })).rejects.toThrow(/no graph to edit|finished/);
  }, 90000);

  it("the assistant's live edit is a proposal; confirming applies it to the running graph", async () => {
    const { c, finish } = await boot();
    const r = await c.call<{ ok: boolean; message: string }>("agent.api", { agent: "control", op: "command", args: { name: "graph.addNode", args: { role: "qa", title: "Check", depends_on: ["T-1"] } } });
    expect(r.message).toMatch(/Proposed P-1/);
    expect((await c.call<{ plan: Plan }>("ui.snapshot")).plan.tasks).toHaveLength(2);
    await c.call("command.confirm", { id: "P-1" });
    expect((await c.call<{ plan: Plan }>("ui.snapshot")).plan.tasks).toHaveLength(3);
    await finish();
  }, 90000);
});
