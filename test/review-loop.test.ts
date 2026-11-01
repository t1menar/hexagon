import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { MockAdapter } from "../src/agents/mock.js";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan, StampedEvent } from "../src/contracts/types.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";
import { readJsonl } from "../src/util/fsx.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 40000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(100); }
}

function project(maxCycles = 0): string {
  const root = fs.mkdtempSync(path.join("/tmp", "hl-"));
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  scaffold(root);
  const f = path.join(root, ".hexagon/config.toml");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 30").replace("max_fix_cycles = 0", `max_fix_cycles = ${maxCycles}`));
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
  return root;
}
function plan(root: string, description: string): string {
  const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [],
    tasks: [{ id: "T-1", title: "Write", role: "developer", requirements: [], acceptance: ["AC-1"], depends_on: [], files: { write: ["src/a.txt"], read: [] }, skills: [], definition_of_done: ["done"], verify: [], description }] };
  const f = path.join(root, "plan.json"); fs.writeFileSync(f, JSON.stringify(p)); return f;
}

describe("implementation → verification → review loop", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });
  async function boot(root: string) {
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c }); return c;
  }

  it("repeats fix cycles without a cap (5 rejections), re-reviews every change, then merges", async () => {
    MockAdapter.reviews.clear();
    const root = project();
    const c = await boot(root);
    await c.call("run.start", { plan_path: plan(root, "@reject: 5") });
    const s = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "done" ? x : null; }, 60000);
    expect(s.fix_cycle).toBe(5);
    expect(s.attempt).toBe(1); // repair cycles are not attempts
    expect(MockAdapter.reviews.get("T-1")).toBe(6); // a fresh review of every revision; no approval carried over
    const runDir = path.join(root, ".hexagon/runs", fs.readdirSync(path.join(root, ".hexagon/runs"))[0]!);
    const evs = readJsonl<StampedEvent>(path.join(runDir, "events.jsonl"));
    expect(evs.filter((e) => e.event.type === "fix_cycle")).toHaveLength(5);
    const result = JSON.parse(fs.readFileSync(path.join(runDir, "agents/T-1-a1/result.json"), "utf8"));
    expect(result.review.verdict).toBe("approve");
    expect(git(root, "log", "--all", "--oneline")).toContain("Merge T-1");
  }, 90000);

  it("max_fix_cycles caps the loop when set", async () => {
    MockAdapter.reviews.clear();
    const root = project(2);
    const c = await boot(root);
    await c.call("run.start", { plan_path: plan(root, "@reject: always") });
    const s = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "failed" || x.state === "done" ? x : null; }, 40000);
    expect(s.state).toBe("failed");
    expect(s.fix_cycle).toBe(2);
  }, 60000);

  it("unlimited cycles still stop on an identical repeated failure (no progress)", async () => {
    MockAdapter.reviews.clear();
    const root = project();
    const c = await boot(root);
    await c.call("run.start", { plan_path: plan(root, "@reject: always @reject-same") });
    const s = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "failed" ? x : null; }, 40000);
    expect(s.state_reason).toMatch(/no progress/);
    expect(s.last_error?.kind).toBe("stuck");
    expect(s.fix_cycle ?? 0).toBeLessThan(5);
  }, 60000);

  it("cancelling mid-loop stops it for good", async () => {
    MockAdapter.reviews.clear();
    const root = project();
    const c = await boot(root);
    await c.call("run.start", { plan_path: plan(root, "@reject: always") });
    await until(async () => ((await c.call<AgentStatus>("agent.status", { task: "T-1" })).fix_cycle ?? 0) >= 1);
    await c.call("agent.cancel", { task: "T-1" });
    const s = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "cancelled" ? x : null; });
    await sleep(500);
    expect((await c.call<AgentStatus>("agent.status", { task: "T-1" })).state).toBe("cancelled");
    expect(s.attempt).toBe(1);
  }, 60000);
});
