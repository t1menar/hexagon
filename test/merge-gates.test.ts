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

function project(final = "", stepMs = 30): string {
  const root = fs.mkdtempSync(path.join("/tmp", "hmg-"));
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  scaffold(root);
  const f = path.join(root, ".hexagon/config.toml");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", `step_ms = ${stepMs}`).replace("max_fix_cycles = 3", "max_fix_cycles = 1").replace("final_verify = []", final ? `final_verify = ${final}` : "final_verify = []") + '\n[roles.release]\nagent = "mock"\n');
  fs.appendFileSync(path.join(root, ".gitignore"), "plan.json\n");
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
  return root;
}
const writePlan = (root: string, ...tasks: Task[]): string => {
  const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [], tasks };
  const f = path.join(root, "plan.json"); fs.writeFileSync(f, JSON.stringify(p)); return f;
};

const settled = (c: HexClient, ids: string[]) => until(async () => {
  const sts = await Promise.all(ids.map((id) => c.call<AgentStatus>("agent.status", { task: id })));
  return sts.every((x) => ["done", "failed", "blocked"].includes(x.state)) ? sts : null;
});

describe("merged results are verified again", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });
  async function boot(root: string) {
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c }); return c;
  }

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

  it("a later task that breaks an EARLIER task's check is not merged, and the failure names that task", async () => {
    const { readJsonl } = await import("../src/util/fsx.js");
    const root = project();
    const c = await boot(root);
    // T-2 is green on its own (its check only needs a.txt); once merged, T-1's own check (no b.txt) is red.
    await c.call("run.start", { plan_path: writePlan(root, task("T-1", "src/a.txt", ["test ! -f src/b.txt"]), task("T-2", "src/b.txt", ["test -f src/a.txt"], { depends_on: ["T-1"] })) });
    const [a, b] = await settled(c, ["T-1", "T-2"]);
    expect(a!.state).toBe("done");
    expect(b!.state).toBe("failed");
    const integ = git(root, "branch", "--list", "hexagon/*/integration", "--format=%(refname:short)").split("\n")[0]!;
    expect(git(root, "ls-tree", "-r", "--name-only", integ)).not.toContain("src/b.txt");
    const runDir = path.join(root, ".hexagon/runs", fs.readdirSync(path.join(root, ".hexagon/runs")).filter((d) => d.startsWith("r-"))[0]!);
    const evs = readJsonl<{ event: { type: string; message?: string } }>(path.join(runDir, "events.jsonl")).map((e) => e.event);
    expect(evs.some((e) => e.type === "error" && /post-merge: .*check of T-1/.test(e.message ?? ""))).toBe(true);
  }, 120000);

  it("integration_verify = \"task\" keeps the old, narrower check (the same pair merges)", async () => {
    const root = project();
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('integration_verify = "merged"', 'integration_verify = "task"'));
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "policy");
    const c = await boot(root);
    await c.call("run.start", { plan_path: writePlan(root, task("T-1", "src/a.txt", ["test ! -f src/b.txt"]), task("T-2", "src/b.txt", ["test -f src/a.txt"], { depends_on: ["T-1"] })) });
    const [a, b] = await settled(c, ["T-1", "T-2"]);
    expect([a!.state, b!.state]).toEqual(["done", "done"]);
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

describe("merge conflicts go to the release engineer", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  /** Someone else lands a different src/a.txt on the integration branch while T-1 is working. */
  async function conflicting(root: string, description: string, release = true) {
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.call("run.start", { plan_path: writePlan(root, task("T-1", "src/a.txt", ["test -f src/a.txt"], { description })) });
    // After T-1 has branched from the integration branch, before it merges back.
    await until(async () => git(root, "branch", "--list", "hexagon/*/T-1-a1") || null);
    const integ = git(root, "branch", "--list", "hexagon/*/integration", "--format=%(refname:short)").split("\n")[0]!;
    const wt = path.join(root, ".hexagon/worktrees", integ.split("/")[1]!, "integration");
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
    fs.writeFileSync(path.join(wt, "src/a.txt"), "from somebody else\n");
    git(wt, "add", "-A"); git(wt, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "other work");
    void release;
    const [st] = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return ["done", "failed", "blocked"].includes(x.state) ? [x] : null; });
    return { st: st!, integ };
  }

  it("resolves, verifies and lands it; only the conflicted files are touched", async () => {
    const root = project("", 500);
    const { st, integ } = await conflicting(root, "");
    expect(st.state).toBe("done");
    const a = git(root, "show", `${integ}:src/a.txt`);
    expect(a).toContain("from somebody else");
    expect(git(root, "log", "--format=%B", integ)).toMatch(/Hexagon-Release: conflict in src\/a.txt/);
    expect(git(root, "branch", "--list", "*-release")).toBe(""); // the dedicated branch is cleaned up
  }, 120000);

  it("blocks with the conflict shown when the release engineer cannot decide, leaving the integration branch untouched", async () => {
    const root = project("", 500);
    const { st, integ } = await conflicting(root, "@release-fails");
    expect(st.state).toBe("blocked");
    expect(git(root, "show", `${integ}:src/a.txt`)).toBe("from somebody else");
  }, 120000);

  it("with release_on_conflict = false it blocks as before", async () => {
    const root = project("", 500);
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("release_on_conflict = true", "release_on_conflict = false"));
    const { st } = await conflicting(root, "", false);
    expect(st.state).toBe("blocked");
  }, 120000);
});

describe("a deleted test reaches the reviewer", () => {
  it("flagged by Hexagon in the review request, not by the developer's report", async () => {
    const { MockAdapter } = await import("../src/agents/mock.js");
    MockAdapter.turns.length = 0;
    const root = project();
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "test/old.test.ts"), 'it("old", () => { expect(1).toBe(1); });\n');
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a test");
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false });
    try {
      const t = task("T-1", "src/a.txt", [], { verify_exempt: "fixture", description: "@delete-test: test/old.test.ts" });
      t.files.write.push("test/old.test.ts");
      await c.call("run.start", { plan_path: writePlan(root, t) });
      await settled(c, ["T-1"]);
      const review = MockAdapter.turns.find((x) => /<diffstat/.test(x.text));
      expect(review?.text).toMatch(/<test_integrity[^>]*>[\s\S]*deleted test — test\/old\.test\.ts/);
      expect(review!.text.indexOf("<diff ")).toBeLessThan(review!.text.indexOf("<developer_claim"));
    } finally { c.close(); s.orch.shutdown(); }
  }, 90000);
});
