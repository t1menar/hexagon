import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan, StampedEvent } from "../src/contracts/types.js";
import { scaffold } from "../src/core/project.js";
import { MockAdapter } from "../src/agents/mock.js";
import { DaemonServer } from "../src/daemon/server.js";
import { readJsonl } from "../src/util/fsx.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 40000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(100); }
}

describe("scope is enforced on committed changes too", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  it("an agent that commits an out-of-scope file gets it removed, and history is one Hexagon commit", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "hsc-"));
    git(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 30"));
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
    const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [],
      tasks: [{ id: "T-1", title: "Write", role: "developer", requirements: [], acceptance: ["AC-1"], depends_on: [], files: { write: ["src/a.txt"], read: [] }, skills: [], definition_of_done: ["done"], verify: [], verify_exempt: "test fixture", description: "@commit-outside" }] };
    const plan = path.join(root, "plan.json"); fs.writeFileSync(plan, JSON.stringify(p));
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.call("run.start", { plan_path: plan });
    MockAdapter.turns.length = 0;
    const st = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "done" || x.state === "failed" ? x : null; }, 60000);
    expect(st.state).toBe("done");
    const runDir = path.join(root, ".hexagon/runs", fs.readdirSync(path.join(root, ".hexagon/runs"))[0]!);
    const evs = readJsonl<StampedEvent>(path.join(runDir, "events.jsonl"));
    expect(evs.some((e) => e.event.type === "error" && /scope_violation/.test(e.event.kind) && /outside\/leak.txt/.test(e.event.message))).toBe(true);
    // First offense: warned, not reverted. The warning reaches the agent as its next turn and says what and how.
    const messages = evs.filter((e) => e.event.type === "error" && /scope_violation/.test(e.event.kind)).map((e) => (e.event as { message: string }).message).filter((m) => /out-of-scope/.test(m));
    expect(messages[0]).toMatch(/not reverted yet/);
    expect(messages.some((m) => /^reverted out-of-scope/.test(m))).toBe(true);
    const warned = MockAdapter.turns.find((t) => t.agent === "T-1-a1" && /Nothing was reverted yet/.test(t.text));
    expect(warned?.text).toMatch(/outside\/leak\.txt/);
    expect(warned?.text).toMatch(/Write scope: src\/a\.txt/);
    expect(warned?.text).toMatch(/needs_spec_change/);
    // Second offense: reverted, and the reviewer is told which paths.
    const review = MockAdapter.turns.find((x) => /<diffstat/.test(x.text));
    expect(review?.text).toMatch(/<reverted_out_of_scope[^>]*>\s*outside\/leak\.txt/);
    const integ = git(root, "branch", "--list", "hexagon/*/integration", "--format=%(refname:short)").split("\n")[0]!;
    expect(git(root, "ls-tree", "-r", "--name-only", integ)).not.toContain("outside/leak.txt");
    expect(git(root, "ls-tree", "-r", "--name-only", integ)).toContain("src/a.txt");
    const log = git(root, "log", "--format=%s", `main..${integ}`);
    expect(log).not.toContain("agent: sneak in a file");
  }, 90000);
});
