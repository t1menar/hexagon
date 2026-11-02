import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan, Task } from "../src/contracts/types.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 60000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(100); }
}
const task = (id: string, file: string, verify: string[], over: Partial<Task> = {}): Task => ({ id, title: id, role: "developer", requirements: [], acceptance: ["AC-1"], depends_on: [], files: { write: [file], read: [] }, skills: [], definition_of_done: ["done"], verify, ...over });

function project(final = ""): string {
  const root = fs.mkdtempSync(path.join("/tmp", "hmg-"));
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  scaffold(root);
  const f = path.join(root, ".hexagon/config.toml");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 30").replace("max_fix_cycles = 3", "max_fix_cycles = 1").replace("final_verify = []", final ? `final_verify = ${final}` : "final_verify = []"));
  fs.appendFileSync(path.join(root, ".gitignore"), "plan.json\n");
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
  return root;
}
const writePlan = (root: string, ...tasks: Task[]): string => {
  const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [], tasks };
  const f = path.join(root, "plan.json"); fs.writeFileSync(f, JSON.stringify(p)); return f;
};

describe("merged results are verified again", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });
  async function boot(root: string) {
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c }); return c;
  }
  const settled = (c: HexClient, ids: string[]) => until(async () => {
    const sts = await Promise.all(ids.map((id) => c.call<AgentStatus>("agent.status", { task: id })));
    return sts.every((x) => ["done", "failed", "blocked"].includes(x.state)) ? sts : null;
  });

  it("two tasks that pass alone but break each other: the second merge is undone, not landed", async () => {
    const root = project();
    const c = await boot(root);
    // Each is green in its own worktree (the other's file does not exist there) and red once both are merged.
    await c.call("run.start", { plan_path: writePlan(root, task("T-1", "src/a.txt", ["test ! -f src/b.txt"]), task("T-2", "src/b.txt", ["test ! -f src/a.txt"])) });
    const [a, b] = await settled(c, ["T-1", "T-2"]);
    expect([a!.state, b!.state].sort()).toEqual(["done", "failed"]);
    const integ = git(root, "branch", "--list", "hexagon/*/integration", "--format=%(refname:short)").split("\n")[0]!;
    const files = git(root, "ls-tree", "-r", "--name-only", integ).split("\n");
    expect(files.filter((f) => f === "src/a.txt" || f === "src/b.txt")).toHaveLength(1); // never both: the integration branch was never red
  }, 120000);

  it("/merge is refused when the final check fails, and an override is recorded", async () => {
    const root = project('["test -f src/never-written.txt"]');
    const c = await boot(root);
    await c.call("run.start", { plan_path: writePlan(root, task("T-1", "src/a.txt", ["test -f src/a.txt"])) });
    await settled(c, ["T-1"]);
    await until(async () => (await c.call<{ state: string }>("run.status")).state === "done" || null);
    await expect(c.call("merge.base")).rejects.toThrow(/fails its final check.*never-written.*hexagon merge --override/s);
    expect(git(root, "log", "--oneline", "main")).not.toContain("Merge Hexagon run");
    const r = await c.call<{ text: string }>("merge.base", { override: "ship the hotfix" });
    expect(r.text).toMatch(/Merged/);
    const runs = path.join(root, ".hexagon/runs");
    const runDir = path.join(runs, fs.readdirSync(runs)[0]!);
    expect(fs.readFileSync(path.join(runDir, "overrides.jsonl"), "utf8")).toMatch(/ship the hotfix/);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "final-gate.json"), "utf8"))).toMatchObject({ passed: false, override: "ship the hotfix" });
  }, 120000);
});
