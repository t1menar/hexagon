import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { HexClient } from "../src/client/client.js";
import type { Plan } from "../src/contracts/types.js";
import { applyGraph, argsFromFlags, commandDef, commandDocs, COMMANDS, fromTask, graphDiff, parseArgs } from "../src/core/commands.js";
import { scaffold } from "../src/core/project.js";
import type { Draft } from "../src/daemon/orchestrator.js";
import { DaemonServer } from "../src/daemon/server.js";

const task = (id: string, deps: string[] = []) => ({ id, title: id, role: "developer", requirements: [], acceptance: [], depends_on: deps, files: { write: [], read: [] }, skills: [], definition_of_done: [], verify: [], verify_exempt: "test fixture" });
const plan = (): Plan => ({ schema: "hexagon.plan/v1", id: "p", created_at: "", specs: [], spec_issues: [], tasks: [task("T-1"), task("T-2", ["T-1"]), task("T-3", ["T-2"])] });

describe("typed commands", () => {
  it("rejects unknown and mistyped parameters", () => {
    const d = commandDef("graph.addEdge")!;
    expect(() => parseArgs(d, { from: "T-1" })).toThrow(/missing parameter "to"/);
    expect(() => parseArgs(d, { from: "T-1", to: "T-2", extra: 1 })).toThrow(/unknown parameter "extra"/);
    expect(() => parseArgs(d, { from: 1, to: "T-2" })).toThrow(/must be a string/);
    expect(parseArgs(d, { from: "T-1", to: "T-2" })).toEqual({ from: "T-1", to: "T-2" });
  });

  it("flags map to typed arguments", () => {
    const d = commandDef("graph.addNode")!;
    expect(argsFromFlags(d, ["--title", "x", "--role", "qa", "--depends_on", "T-1,T-2"])).toEqual({ title: "x", role: "qa", depends_on: ["T-1", "T-2"] });
    expect(() => argsFromFlags(d, ["--nope", "1"])).toThrow(/unknown parameter/);
  });

  it("graph operations work on a copy, refuse cycles and unknown tasks, and describe the diff", () => {
    const p = plan();
    const added = applyGraph(p, "graph.addNode", { title: "docs", role: "developer", depends_on: ["T-3"] });
    expect(p.tasks).toHaveLength(3);
    expect(graphDiff(p, added)).toEqual(["+ task T-4 [developer] docs", "+ edge T-3->T-4"]);
    expect(() => applyGraph(p, "graph.addEdge", { from: "T-3", to: "T-1" })).toThrow(/cycle/);
    expect(() => applyGraph(p, "graph.addEdge", { from: "T-9", to: "T-1" })).toThrow(/no task T-9/);
    const removed = applyGraph(p, "graph.removeNode", { id: "T-2" });
    expect(graphDiff(p, removed)).toEqual(["- task T-2 [developer] T-2", "- edge T-1->T-2", "- edge T-2->T-3"]);
    expect(removed.tasks.find((t) => t.id === "T-3")!.depends_on).toEqual([]);
  });

  it("run from a task selects it and what follows", () => {
    expect(fromTask(plan(), "T-2")).toEqual(["T-2", "T-3"]);
  });

  it("the agent-facing docs list every command", () => {
    const docs = commandDocs();
    for (const c of COMMANDS) expect(docs).toContain(`\`${c.name}(`);
    expect(docs).toMatch(/graph\.removeNode.*destructive/);
  });
});

describe("control service through the daemon", () => {
  let root: string;
  let server: DaemonServer;
  let client: HexClient;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join("/tmp", "hc-"));
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 50"));
    git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon");
    server = new DaemonServer(root);
    await server.listen();
    client = await HexClient.connect(root, { autostart: false });
    await client.subscribe();
  });
  afterAll(() => { client?.close(); server?.orch.shutdown(); });

  const draft = async () => {
    const reviewed = new Promise<void>((r) => client.on("push", (p) => { if (p.event === "spec_review" && p.data) r(); }));
    const drafted = new Promise<Draft>((r) => client.on("push", (p) => { if (p.event === "draft" && p.data) r(p.data); }));
    await client.call("goal.new", { goal: "Greeting and farewell" });
    await reviewed;
    await client.call("spec.approve", {});
    return drafted;
  };

  it("the agent only proposes; the user's confirmation applies; destructive always asks", async () => {
    const d = await draft();
    const n = d.plan.tasks.length;
    const agent = (name: string, args: Record<string, unknown>) => client.call<{ ok: boolean; message: string }>("agent.api", { agent: "control", op: "command", args: { name, args } });

    const r = await agent("graph.addNode", { title: "docs", role: "developer" });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Proposed P-1/);
    expect(JSON.parse(fs.readFileSync(d.plan_path, "utf8")).tasks).toHaveLength(n); // nothing changed yet

    const pending = await client.call<{ id: string; diff: string[] }[]>("command.list");
    expect(pending[0]!.diff[0]).toMatch(/^\+ task T-\d+ \[developer\] docs/);
    await client.call("command.confirm", { id: "P-1" });
    expect(JSON.parse(fs.readFileSync(d.plan_path, "utf8")).tasks).toHaveLength(n + 1);

    // Reads run at once for the agent; a bad command is an error, not a proposal.
    expect((await agent("graph.show", {})).message).toContain("tasks");
    expect((await agent("graph.addEdge", { from: "T-9", to: "T-1" })).ok).toBe(false);
    // Only the control agent may use the API.
    expect((await client.call<{ ok: boolean }>("agent.api", { agent: "T-1-a1", op: "command", args: { name: "status.get", args: {} } })).ok).toBe(false);

    // auto_apply never covers destructive commands.
    server.orch.cfg.control.auto_apply = true;
    const rm = await agent("graph.removeNode", { id: `T-${n + 1}` });
    expect(rm.message).toMatch(/Proposed P-\d/);
    server.orch.cfg.control.auto_apply = false;
    await client.call("command.reject", { id: (await client.call<{ id: string }[]>("command.list"))[0]!.id });
    expect(await client.call("command.list")).toEqual([]);
    await sleep(10);
  });

  it("the user's own call executes at once", async () => {
    const d = server.orch.draft!;
    const before = d.plan.tasks.length;
    const res = await client.call<{ status: string }>("command.exec", { name: "graph.addNode", args: { title: "x", role: "qa" } });
    expect(res.status).toBe("done");
    expect(server.orch.draft!.plan.tasks).toHaveLength(before + 1);
  });
});
