import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan } from "../src/contracts/types.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";
import { WaitStore } from "../src/core/recovery.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(100); }
}

function project(extraConfig = ""): string {
  const root = fs.mkdtempSync(path.join("/tmp", "hr-"));
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  scaffold(root);
  const cfgFile = path.join(root, ".hexagon/config.toml");
  fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 100") + extraConfig);
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
  return root;
}

function plan(root: string, description: string): string {
  const p: Plan = {
    schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [],
    tasks: [{ id: "T-1", title: "Write a file", role: "implementer", requirements: [], acceptance: ["AC-1"], depends_on: [], files: { write: ["src/a.txt"], read: [] }, skills: [], definition_of_done: ["done"], verify: [], description }],
  };
  const file = path.join(root, "plan.json");
  fs.writeFileSync(file, JSON.stringify(p));
  return file;
}

describe("provider-limit recovery (mock agent)", () => {
  const open: { server?: DaemonServer; client?: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.client?.close(); o.server?.orch.shutdown(); } });

  async function boot(root: string) {
    const server = new DaemonServer(root);
    await server.listen();
    const client = await HexClient.connect(root, { autostart: false });
    open.push({ server, client });
    return { server, client };
  }

  it("a quota wait resumes automatically on the same task, without a fix cycle or new attempt", async () => {
    const root = project();
    const { client } = await boot(root);
    await client.call("run.start", { plan_path: plan(root, "@limit: 5-hour usage limit reached, resets in 2 seconds") });
    const waiting = await until(async () => { const s = await client.call<AgentStatus>("agent.status", { task: "T-1" }); return s.state === "waiting_quota" ? s : null; });
    expect(waiting.recovery?.cls).toBe("quota_exhausted");
    expect(waiting.recovery?.reset_source).toBe("provider");
    expect(waiting.recovery?.next_retry_at).toBeTruthy();
    const done = await until(async () => { const s = await client.call<AgentStatus>("agent.status", { task: "T-1" }); return s.state === "done" ? s : null; });
    expect(done.attempt).toBe(1);
    expect(done.fix_cycle ?? 0).toBe(0);
    expect(done.recovery?.status).toBe("recovered");
    expect(done.recovery?.waits).toBe(1);
    expect(done.agent.model_mode).toBe("cli-default");
    expect(done.agent.runtime_model ?? null).toBeNull(); // the mock reports none: never invented
  }, 60000);

  it("auth failure blocks with an actionable reason and does not retry", async () => {
    const root = project();
    const { client } = await boot(root);
    await client.call("run.start", { plan_path: plan(root, "@limit: 401 Unauthorized: invalid API key") });
    const s = await until(async () => { const x = await client.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "blocked" ? x : null; });
    expect(s.state_reason).toMatch(/credentials|log in/i);
    expect(s.attempt).toBe(1);
  }, 60000);

  it("context overflow starts a fresh session instead of waiting", async () => {
    const root = project();
    const { client } = await boot(root);
    await client.call("run.start", { plan_path: plan(root, "@limit: prompt is too long: context window exceeded") });
    const s = await until(async () => { const x = await client.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "done" ? x : null; });
    expect(s.recovery?.history.some((h) => h.what.startsWith("compacted"))).toBe(true);
    expect(s.recovery?.history.some((h) => h.what.startsWith("waiting"))).toBe(false);
    expect(s.attempt).toBe(1);
  }, 60000);

  it("a daemon restart during a wait resumes the same task exactly once", async () => {
    const root = project();
    const a = await boot(root);
    await a.client.call("run.start", { plan_path: plan(root, "@limit: usage limit reached, resets in 4 seconds") });
    await until(async () => (await a.client.call<AgentStatus>("agent.status", { task: "T-1" })).state === "waiting_quota");
    // The daemon goes away mid-wait.
    a.client.close();
    a.server.orch.shutdown();
    (a.server as unknown as { server: { close(): void } }).server.close();
    open.length = 0;
    const waitsFile = fs.readdirSync(path.join(root, ".hexagon/runs")).map((r) => path.join(root, ".hexagon/runs", r, "waits.json"))[0]!;
    expect(new WaitStore(waitsFile).pending()).toHaveLength(1);
    fs.rmSync(path.join(root, ".hexagon/daemon.sock"), { force: true });

    const b = await boot(root);
    const s = await until(async () => { const x = await b.client.call<AgentStatus>("agent.status", { task: "T-1" }).catch(() => null); return x && x.state === "done" ? x : null; }, 45000);
    expect(s.attempt).toBe(1);
    expect(s.recovery?.status).toBe("recovered");
    expect(s.recovery?.history.filter((h) => h.what.startsWith("resumed"))).toHaveLength(1);
    expect(new WaitStore(waitsFile).pending()).toHaveLength(0);
  }, 90000);
});
