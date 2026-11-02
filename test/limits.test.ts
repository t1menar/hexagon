import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { MockAdapter } from "../src/agents/mock.js";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan } from "../src/contracts/types.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 40000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(100); }
}
function project(edit: (cfg: string) => string): string {
  const root = fs.mkdtempSync(path.join("/tmp", "hlim-"));
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  scaffold(root);
  const f = path.join(root, ".hexagon/config.toml");
  fs.writeFileSync(f, edit(fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"')));
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
  return root;
}
function plan(root: string, description: string): string {
  const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [],
    tasks: [{ id: "T-1", title: "Write", role: "developer", requirements: [], acceptance: ["AC-1"], depends_on: [], files: { write: ["src/a.txt"], read: [] }, skills: [], definition_of_done: ["done"], verify: [], verify_exempt: "fixture", description }] };
  const f = path.join(root, "plan.json"); fs.writeFileSync(f, JSON.stringify(p)); return f;
}

describe("runaway loops stop", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });
  async function boot(root: string) {
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c }); return { s, c };
  }

  it("an endless review loop stops (3 cycles by default, or sooner when the same findings repeat) and says what to do", async () => {
    MockAdapter.reviews.clear();
    const root = project((c) => c.replace("step_ms = 600", "step_ms = 20"));
    const { c } = await boot(root);
    await c.call("run.start", { plan_path: plan(root, "@reject: always") });
    const st = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "failed" ? x : null; }, 60000);
    expect(st.fix_cycle).toBeLessThanOrEqual(3);
    const msgs = await c.call<{ body: string }[]>("messages.list", { task: "T-1", limit: 50 });
    expect(msgs.map((m) => m.body).join("\n")).toMatch(/T-1 stopped: (the same failure repeated 3 times with no change|the reviewer still requests changes after 3 repair cycle\(s\)).*\/continue T-1.*\/retry T-1/s);
  }, 90000);

  it("a per-task token cap stops an agent that is still working, at its next model call", async () => {
    MockAdapter.reviews.clear();
    const root = project((c) => c.replace("step_ms = 600", "step_ms = 400").replace("task_budget_tokens = 3000000", "task_budget_tokens = 100"));
    const { c } = await boot(root);
    await c.call("run.start", { plan_path: plan(root, "") });
    const st = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return ["blocked", "failed", "done"].includes(x.state) ? x : null; }, 30000);
    expect(st.state).toBe("blocked");
    expect(st.state_reason).toMatch(/per-task cap of 100/);
    const wt = path.join(root, ".hexagon/worktrees");
    const written = fs.readdirSync(wt).flatMap((r) => fs.readdirSync(path.join(wt, r))).some((d) => fs.existsSync(path.join(wt, fs.readdirSync(wt)[0]!, d, "src/a.txt")));
    expect(written).toBe(false); // it was stopped before it got to write
  }, 60000);

  it("a run budget pauses agents that are already running", async () => {
    MockAdapter.reviews.clear();
    const root = project((c) => c.replace("step_ms = 600", "step_ms = 400"));
    const { c } = await boot(root);
    await c.call("run.start", { plan_path: plan(root, ""), budget_tokens: 100 });
    const st = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "paused" ? x : null; }, 30000);
    expect(st.state).toBe("paused");
  }, 60000);
});
