import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { MockAdapter } from "../src/agents/mock.js";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan, StampedEvent } from "../src/contracts/types.js";
import type { Preparation } from "../src/core/supervisor.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";
import { readJsonl } from "../src/util/fsx.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 40000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(100); }
}

function project(): string {
  const root = fs.mkdtempSync(path.join("/tmp", "hs-"));
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  scaffold(root);
  const f = path.join(root, ".hexagon/config.toml");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 30"));
  git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
  return root;
}
function plan(root: string, description: string, verify: string[]): string {
  const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [],
    tasks: [{ id: "T-1", title: "Write", role: "developer", requirements: [], acceptance: ["AC-1: it writes", "AC-2: it reads"], depends_on: [], files: { write: ["src/a.txt"], read: [] }, skills: [], definition_of_done: ["done"], verify, description }] };
  const f = path.join(root, "plan.json"); fs.writeFileSync(f, JSON.stringify(p)); return f;
}

describe("task lifecycle", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });
  async function boot(root: string) {
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c }); return c;
  }
  const runDir = (root: string) => path.join(root, ".hexagon/runs", fs.readdirSync(path.join(root, ".hexagon/runs"))[0]!);

  it("goes preparing → working → verifying → reviewing → fixing → … → integrating → done", async () => {
    MockAdapter.reviews.clear();
    const root = project();
    const c = await boot(root);
    await c.call("run.start", { plan_path: plan(root, "@reject: 1", ["test -f README.md"]) });
    await until(async () => (await c.call<AgentStatus>("agent.status", { task: "T-1" })).state === "done", 60000);
    const states = readJsonl<StampedEvent>(path.join(runDir(root), "events.jsonl"))
      .filter((e) => e.event.type === "state").map((e) => (e.event as { state: string }).state);
    const squashed = states.filter((s, i) => s !== states[i - 1]);
    expect(squashed).toEqual(["preparing", "working", "verifying", "reviewing", "fixing", "verifying", "reviewing", "integrating", "done"]);
  }, 90000);

  it("preparing records the plan, the tools and a baseline before the agent starts", async () => {
    MockAdapter.reviews.clear();
    const root = project();
    const c = await boot(root);
    await c.call("run.start", { plan_path: plan(root, "", ["test -f README.md", "test -f nothing-here"]) });
    await until(async () => ["done", "failed"].includes((await c.call<AgentStatus>("agent.status", { task: "T-1" })).state), 60000);
    const prep = JSON.parse(fs.readFileSync(path.join(runDir(root), "agents/T-1-a1/prepare.json"), "utf8")) as Preparation;
    expect(prep.steps).toEqual(["1. AC-1: it writes", "2. AC-2: it reads"]);
    expect(prep.baseline).toEqual([{ cmd: "test -f README.md", code: 0 }, { cmd: "test -f nothing-here", code: 1 }]);
    expect(prep.tools).toEqual([{ command: "test", found: true }]);
    expect(prep.base_commit).toMatch(/^[0-9a-f]{40}$/);
    const evs = readJsonl<StampedEvent>(path.join(runDir(root), "events.jsonl")).map((e) => e.event);
    expect(evs.some((e) => e.type === "progress" && /prepared: base .*1 check\(s\) already failing/.test(e.text))).toBe(true);
  }, 90000);
});
