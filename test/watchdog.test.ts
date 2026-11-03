import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { Plan, RunStatus, Task } from "../src/contracts/types.js";
import { applyGraph, graphDiff, isGraphEdit } from "../src/core/commands.js";
import { checkPlan } from "../src/core/plan.js";
import { scaffold } from "../src/core/project.js";
import { DEFAULT_LIMITS, detect, digest, fresh, type WatchInput, type WatchTask } from "../src/core/watchdog.js";
import type { CommandResult } from "../src/daemon/control.js";
import { DaemonServer } from "../src/daemon/server.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 40000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(50); }
}

const MIN = 60_000;
const now = 10_000 * MIN;
const wt = (o: Partial<WatchTask> = {}): WatchTask => ({ id: "T-1", state: "working", last_progress_at: now - MIN, started_at: now - 20 * MIN, requirements: ["REQ-A"], samples: [], ...o });
const input = (o: Partial<WatchInput> = {}): WatchInput => ({ now, tasks: [wt()], bus: [], reopened: [], changes: [], ...o });
const kinds = (i: WatchInput) => detect(i).map((x) => x.kind);

describe("watchdog rules (pure)", () => {
  it("a healthy run reports nothing", () => {
    expect(detect(input())).toEqual([]);
  });

  it("stalled: an active task with no progress for stall_minutes", () => {
    expect(kinds(input({ tasks: [wt({ last_progress_at: now - 11 * MIN })] }))).toEqual(["stalled"]);
    expect(kinds(input({ tasks: [wt({ last_progress_at: now - 9 * MIN })] }))).toEqual([]);
    // a task that is waiting for the user is not "stalled"; a finished one is not watched
    expect(kinds(input({ tasks: [wt({ state: "waiting_input", last_progress_at: now - 60 * MIN })] }))).toEqual([]);
    expect(kinds(input({ tasks: [wt({ state: "done", last_progress_at: now - 60 * MIN })] }))).toEqual([]);
  });

  it("waiting_input older than the limit", () => {
    expect(kinds(input({ tasks: [wt({ state: "waiting_input", waiting_since: now - 31 * MIN })] }))).toEqual(["waiting_input"]);
    expect(kinds(input({ tasks: [wt({ state: "waiting_input", waiting_since: now - 5 * MIN })] }))).toEqual([]);
  });

  it("token burn: many tokens without the change growing", () => {
    const burn = [{ at: now - 10 * MIN, tokens: 100_000, files: 2 }, { at: now - MIN, tokens: 450_000, files: 2 }];
    expect(kinds(input({ tasks: [wt({ samples: burn })] }))).toEqual(["token_burn"]);
    // the same tokens with files growing is work, not burn
    expect(kinds(input({ tasks: [wt({ samples: [burn[0]!, { ...burn[1]!, files: 5 }] })] }))).toEqual([]);
    // samples outside the window do not count
    expect(kinds(input({ tasks: [wt({ samples: [{ at: now - 60 * MIN, tokens: 0, files: 2 }, { at: now - MIN, tokens: 900_000, files: 2 }] })] }))).toEqual([]);
  });

  it("ping-pong: the same pair exchanging questions/answers more than K times, or returning work", () => {
    const ex = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? "answer" : "question", from: i % 2 ? "T-2" : "T-1", to: i % 2 ? "T-1" : "T-2", subject: "which date format?", ts: now - (n - i) * MIN }));
    expect(kinds(input({ tasks: [], bus: ex(4) }))).toEqual([]);
    const items = detect(input({ tasks: [], bus: ex(6) }));
    expect(items.map((i) => i.kind)).toEqual(["ping_pong"]);
    expect(items[0]!.tasks).toEqual(["T-1", "T-2"]);
    expect(items[0]!.message).toContain("which date format?");
    // returns count too
    const ret = Array.from({ length: 5 }, (_, i) => ({ task: i % 2 ? "T-1" : "T-2", from: i % 2 ? "T-2" : "T-1", at: now - (5 - i) * MIN }));
    expect(kinds(input({ tasks: [], reopened: ret }))).toContain("ping_pong");
    // traffic with the user or between a task and itself is not ping-pong
    expect(kinds(input({ tasks: [], bus: ex(8).map((e) => ({ ...e, to: "user" })) }))).toEqual([]);
  });

  it("fix-loop oscillation: A reopened, then B, then A", () => {
    const re = (...t: string[]) => t.map((task, i) => ({ task, from: "T-9", at: now - (t.length - i) * MIN }));
    expect(kinds(input({ tasks: [], reopened: re("T-1", "T-2", "T-1") }))).toContain("oscillation");
    expect(kinds(input({ tasks: [], reopened: re("T-1", "T-2", "T-3") }))).not.toContain("oscillation");
    expect(kinds(input({ tasks: [], reopened: re("T-1", "T-1", "T-1") }))).not.toContain("oscillation");
  });

  it("stale context: the task started before a decision or spec patch that touches its requirements", () => {
    const t = wt({ started_at: now - 20 * MIN });
    expect(kinds(input({ tasks: [t], changes: [{ at: now - 5 * MIN, refs: ["REQ-A"], what: "a spec patch" }] }))).toEqual(["stale_context"]);
    expect(kinds(input({ tasks: [t], changes: [{ at: now - 30 * MIN, refs: ["REQ-A"], what: "a spec patch" }] }))).toEqual([]); // before it started
    expect(kinds(input({ tasks: [t], changes: [{ at: now - 5 * MIN, refs: ["REQ-Z"], what: "a spec patch" }] }))).toEqual([]); // unrelated
  });

  it("ids are stable, so a digest is sent once per problem; the digest is data for the Assistant", () => {
    const a = detect(input({ tasks: [wt({ last_progress_at: now - 12 * MIN })] }));
    const b = detect({ ...input({ tasks: [wt({ last_progress_at: now - 14 * MIN })] }), now: now + 2 * MIN });
    expect(a[0]!.id).toBe(b[0]!.id);
    const seen = new Set(a.map((i) => i.id));
    expect(fresh(b, seen)).toEqual([]);
    const d = digest(a);
    expect(d).toMatch(/^<hexagon_health /);
    expect(d).toContain("stalled:T-1");
    expect(d).toContain("Try:");
    expect(DEFAULT_LIMITS.ping_pong).toBe(4);
  });
});

describe("task and graph edits validate through checkPlan", () => {
  const T = (id: string, deps: string[] = [], write = [`src/${id.toLowerCase()}.ts`]): Task => ({ id, title: id, role: "developer", requirements: ["REQ-A"], acceptance: ["AC-1"], depends_on: deps, files: { write, read: [] }, skills: [], definition_of_done: ["d"], verify: ["true"] });
  const plan = (): Plan => ({ schema: "hexagon.plan/v1", id: "p", created_at: "", specs: [], spec_issues: [], tasks: [T("T-1"), T("T-2", ["T-1"]), T("T-3", ["T-2"])] });

  it("task.update changes fields, shows in the diff, and refuses what would leave a task without scope or check", () => {
    const p = plan();
    const next = applyGraph(p, "task.update", { id: "T-2", title: "renamed", write: ["src/new.ts"], verify: ["npm test"] });
    expect(next.tasks[1]).toMatchObject({ title: "renamed", files: { write: ["src/new.ts"] }, verify: ["npm test"] });
    expect(graphDiff(p, next)).toEqual(["~ task T-2 title, files, verify"]);
    expect(() => applyGraph(p, "task.update", { id: "T-2", write: [] })).toThrow(/must not be empty/);
    expect(() => applyGraph(p, "task.update", { id: "T-2", verify: [] })).toThrow(/no verify command/);
    expect(() => applyGraph(p, "task.update", { id: "T-9", title: "x" })).toThrow(/no task T-9/);
    expect(checkPlan(next).errors).toEqual(checkPlan(p).errors);
  });

  it("graph.insertNode puts a task between two others", () => {
    const next = applyGraph(plan(), "graph.insertNode", { after: "T-1", before: "T-2", title: "migrate", role: "developer", write: ["db/**"], verify: ["test -f db/a.txt"] });
    const n = next.tasks.find((t) => t.title === "migrate")!;
    expect(n.depends_on).toEqual(["T-1"]);
    expect(next.tasks.find((t) => t.id === "T-2")!.depends_on).toEqual([n.id]);
    expect(() => applyGraph(plan(), "graph.insertNode", { after: "T-1", title: "x", role: "developer", write: ["a"] })).toThrow(/verify/);
    expect(() => applyGraph(plan(), "graph.insertNode", { after: "T-8", title: "x", role: "developer", write: ["a"], verify: ["true"] })).toThrow(/no task T-8/);
  });

  it("graph.replaceTask: the new task inherits dependencies and dependents, and copies what is not overridden", () => {
    const next = applyGraph(plan(), "graph.replaceTask", { id: "T-2", title: "redo", verify: ["npm run check"] });
    const n = next.tasks.find((t) => t.title === "redo")!;
    expect(n.depends_on).toEqual(["T-1"]);
    expect(n.files.write).toEqual(["src/t-2.ts"]);
    expect(n.requirements).toEqual(["REQ-A"]);
    expect(next.tasks.find((t) => t.id === "T-3")!.depends_on).toEqual([n.id]);
    expect(next.tasks.some((t) => t.id === "T-2")).toBe(true); // history stays; the run cancels it
  });

  it("the new commands are graph edits", () => {
    for (const c of ["task.update", "graph.insertNode", "graph.replaceTask", "graph.addNode"]) expect(isGraphEdit(c)).toBe(true);
    expect(isGraphEdit("task.retry")).toBe(false);
  });
});

describe("the Assistant's control over a live run", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  async function boot(autonomy: "propose" | "safe") {
    const root = fs.mkdtempSync(path.join("/tmp", "hwd-"));
    git(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 20").replace('autonomy = "propose"', `autonomy = "${autonomy}"`));
    fs.writeFileSync(path.join(root, "HEXAGON.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
    const t = (id: string, deps: string[], description = ""): Task => ({ id, title: `task ${id}`, role: "developer", requirements: [], acceptance: [], depends_on: deps, files: { write: [`src/${id.toLowerCase()}.txt`], read: [] }, skills: [], definition_of_done: ["d"], verify: [`test -f src/${id.toLowerCase()}.txt`], description });
    // T-1 asks a question and waits for the user, so it is running while we work; T-2 and T-3 have not started.
    const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [], tasks: [t("T-1", [], "@ask: which?"), t("T-2", ["T-1"]), t("T-3", ["T-2"])] };
    fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(p));
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.call("run.start", { plan_path: "plan.json" });
    await until(async () => (await c.call<RunStatus>("run.status")).agents.find((a) => a.task_id === "T-1")?.state === "waiting_input");
    return { s, c, root };
  }
  const asAgent = (s: DaemonServer, name: string, args: Record<string, unknown>): Promise<CommandResult> => s.orch.control.exec(name, args, "agent");

  it("propose (default): every change waits for /apply; reads answer at once", async () => {
    const { s } = await boot("propose");
    expect((await asAgent(s, "task.pause", { id: "T-1" })).status).toBe("proposed");
    expect((await asAgent(s, "session.compact", {})).status).toBe("proposed");
    expect((await asAgent(s, "health.get", {})).status).toBe("done");
    expect((await asAgent(s, "bus.waiting", {})).status).toBe("done");
    const r = await asAgent(s, "bus.read", { limit: 5 });
    expect(r.status).toBe("done");
  }, 90000);

  it("safe: pause, resume and tell apply at once; retry, cancel, graph edits and replans never do", async () => {
    const { s, c } = await boot("safe");
    expect((await asAgent(s, "task.pause", { id: "T-1" })).status).toBe("done");
    expect((await asAgent(s, "task.resume", { id: "T-1" })).status).toBe("done");
    expect((await asAgent(s, "bus.send", { to: "T-1", text: "carry on" })).status).toBe("done");
    for (const [name, args] of [
      ["task.retry", { id: "T-1" }], ["task.cancel", { id: "T-1" }], ["task.continue", { id: "T-1", text: "x" }],
      ["task.update", { id: "T-2", title: "better" }],
      ["graph.insertNode", { after: "T-1", before: "T-2", title: "mid", role: "developer", write: ["mid/**"], verify: ["test -f mid/a.txt"] }],
      ["graph.replaceTask", { id: "T-3", title: "redo" }], ["run.replan", { task: "T-1", reason: "x" }], ["session.reset", { agent: "T-1" }],
    ] as [string, Record<string, unknown>][]) {
      const res = await asAgent(s, name, args);
      expect(res.status, name).toBe("proposed");
    }
    // nothing changed: T-2 still has its title and the graph has three tasks
    const g = await c.call<{ result: { tasks: { id: string; title: string }[] } }>("command.exec", { name: "graph.show", args: {} });
    expect(g.result.tasks.map((t) => t.title)).toEqual(["task T-1", "task T-2", "task T-3"]);
  }, 90000);

  it("task.update, graph.insertNode and graph.replaceTask edit the running graph when the user applies them", async () => {
    const { s, c } = await boot("propose");
    await c.call("command.exec", { name: "task.update", args: { id: "T-2", title: "task two, renamed" } });
    await c.call("command.exec", { name: "graph.insertNode", args: { after: "T-1", before: "T-3", title: "inserted", role: "developer", write: ["ins/**"], verify: ["test -f ins/a.txt"] } });
    const r = await s.orch.control.exec("graph.replaceTask", { id: "T-3", title: "third, redone" }, "user", true);
    expect(r.status).toBe("done");
    const g = await c.call<{ result: { tasks: { id: string; title: string }[]; edges: { from: string; to: string }[] } }>("command.exec", { name: "graph.show", args: {} });
    const titles = g.result.tasks.map((t) => t.title);
    expect(titles).toEqual(expect.arrayContaining(["task two, renamed", "inserted", "third, redone"]));
    const inserted = g.result.tasks.find((t) => t.title === "inserted")!.id;
    const redone = g.result.tasks.find((t) => t.title === "third, redone")!.id;
    expect(g.result.edges).toEqual(expect.arrayContaining([{ from: "T-1", to: inserted }, { from: inserted, to: redone }]));
    // a task that already started cannot be edited, only replaced
    await expect(c.call("command.exec", { name: "task.update", args: { id: "T-1", title: "x" } })).rejects.toThrow(/already started/);
  }, 90000);

  it("a ping-pong between two tasks becomes a health item, an attention entry and a digest for the Assistant", async () => {
    const { s, c } = await boot("propose");
    const run = s.orch.current!;
    const notices: string[] = [];
    c.on("push", (p) => { if (p.event === "notice") notices.push(p.data.text); });
    await c.subscribe();
    for (let i = 0; i < 6; i++) {
      run.rc.bus.send({ kind: i % 2 ? "answer" : "question", from: i % 2 ? "T-2" : "T-1", to: { agent: i % 2 ? "T-1" : "T-2" }, subject: "which date format?", body: `round ${i}`, record_only: true });
    }
    const items = s.orch.watchTick();
    expect(items.map((i) => i.kind)).toContain("ping_pong");
    const status = await c.call<RunStatus>("run.status");
    expect(status.health?.some((h) => h.kind === "ping_pong")).toBe(true);
    expect(status.attention.some((a) => a.kind === "health" && /exchanged/.test(a.text))).toBe(true);
    await until(async () => notices.some((n) => /^Health: .*exchanged/.test(n)));
    // the same problem is not announced again on the next pass
    const before = notices.length;
    s.orch.watchTick();
    await sleep(100);
    expect(notices.length).toBe(before);
    // the Assistant got the digest as a message
    const snap = await c.call<{ sessions: { id: string; feed: { text: string }[] }[] }>("ui.snapshot");
    await until(async () => (await c.call<typeof snap>("ui.snapshot")).sessions.find((x) => x.id === "control")?.feed.some((f) => f.text.includes("<hexagon_health")));
  }, 90000);
});
