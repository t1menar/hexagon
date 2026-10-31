import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Message, Plan, RunStatus } from "../src/contracts/types.js";
import { validateStatus } from "../src/contracts/validate.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";
import { readJsonl } from "../src/util/fsx.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await sleep(100);
  }
}

describe("end to end with the mock agent", () => {
  let root: string;
  let server: DaemonServer;
  let client: HexClient;

  beforeAll(async () => {
    // Short path: unix socket path length limits.
    root = fs.mkdtempSync(path.join("/tmp", "hx-"));
    git(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git(root, "add", "-A");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    fs.appendFileSync(path.join(root, ".hexagon/config.toml"), "");
    // Use the mock agent for every role; fast steps.
    const cfg = fs.readFileSync(path.join(root, ".hexagon/config.toml"), "utf8")
      .replace(/agent = "claude"/g, 'agent = "mock"')
      .replace("step_ms = 600", "step_ms = 250");
    fs.writeFileSync(path.join(root, ".hexagon/config.toml"), cfg);
    git(root, "add", "-A");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
    fs.writeFileSync(
      path.join(root, "specs/demo.spec.md"),
      "---\nspec: demo\n---\n# Demo\n\n## REQ-DEMO-001: Greeting\nA greeting file.\n\n**Acceptance**\n- AC-1: greeting.txt exists\n\n**Touches**: `greeting.txt`\n\n## REQ-DEMO-002: Farewell\nA farewell file.\n\n**Acceptance**\n- AC-1: farewell.txt exists\n",
    );
    server = new DaemonServer(root);
    await server.listen();
    client = await HexClient.connect(root, { autostart: false });
    await client.subscribe();
  });

  afterAll(() => {
    client?.close();
    server?.orch.shutdown();
  });

  it("plans, runs, asks, takes instructions, verifies, reviews and merges", async () => {
    const pushes: Message[] = [];
    client.on("push", (p) => { if (p.event === "message") pushes.push(p.data); });

    // Planner (mock) → plan file
    const planned = await client.call<{ path: string; plan: Plan }>("plan.create", { specs: [] });
    expect(planned.plan.tasks).toHaveLength(2);

    // Customize: T-2 asks a question and has a verify command; T-2 depends on T-1.
    const plan = planned.plan;
    plan.tasks[1]!.description = "@ask: Formal or casual farewell?";
    plan.tasks[1]!.depends_on = ["T-1"];
    plan.tasks[1]!.verify = ["test -f hexagon-mock/req-demo-002.md"];
    fs.writeFileSync(planned.path, JSON.stringify(plan));

    const { run_id } = await client.call<{ run_id: string }>("run.start", { plan_path: planned.path });
    expect(run_id).toMatch(/^r-/);

    // T-1: send an instruction while it runs; it should be delivered and acknowledged.
    await until(async () => (await client.call<AgentStatus>("agent.status", { task: "T-1" })).state === "running");
    const sent = await client.call<{ messages: Message[] }>("message.send", { to: "T-1", body: "Say hello in Russian too" });
    expect(sent.messages[0]!.delivery.state).toBe("queued");

    // T-2 asks a blocking question → waiting_input with needs_input.
    const waiting = await until(async () => {
      const s = await client.call<AgentStatus>("agent.status", { task: "T-2" });
      return s.state === "waiting_input" ? s : null;
    });
    expect(waiting.needs_input?.blocking).toBe(true);
    const inbox = await client.call<{ questions: { question_id: string }[] }>("inbox.list");
    expect(inbox.questions).toHaveLength(1);
    await client.call("question.answer", { question_id: inbox.questions[0]!.question_id, answer: "2" });

    const final = await until(async () => {
      const rs = await client.call<RunStatus>("run.status");
      return rs.state === "done" ? rs : null;
    });
    expect(final.agents.map((a) => a.state)).toEqual(["done", "done"]);

    // Status files on disk are valid against the contract.
    const runDir = path.join(root, ".hexagon/runs", run_id);
    for (const a of final.agents) {
      const s = JSON.parse(fs.readFileSync(path.join(runDir, "agents", a.agent_run_id, "status.json"), "utf8"));
      expect(validateStatus(s).errors).toEqual([]);
      expect(s.result_path).toBeTruthy();
    }

    // Instruction to T-1 was delivered and acked, and applied to its output.
    const msgs = readJsonl<Message>(path.join(runDir, "messages.jsonl"));
    const last = new Map(msgs.map((m) => [m.id, m]));
    expect(last.get(sent.messages[0]!.id)!.delivery.state).toBe("acked");
    const integ = path.join(root, ".hexagon/worktrees", run_id, "integration");
    expect(fs.readFileSync(path.join(integ, "greeting.txt"), "utf8")).toContain("Say hello in Russian too");
    // The answer reached T-2's output.
    expect(fs.readFileSync(path.join(integ, "hexagon-mock/req-demo-002.md"), "utf8")).toContain("Option B");

    // Commits carry trailers; both tasks merged into the integration branch.
    const log = git(integ, "log", "--format=%B", "-n", "10");
    expect(log).toContain("Hexagon-Task: T-1");
    expect(log).toContain("Hexagon-Task: T-2");

    // Merge into main.
    const merged = await client.call<{ text: string }>("merge.base");
    expect(merged.text).toMatch(/Merged/);
    expect(fs.existsSync(path.join(root, "greeting.txt"))).toBe(true);
    expect(pushes.some((m) => m.type === "question")).toBe(true);
  });
});
