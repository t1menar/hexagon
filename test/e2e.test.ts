import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Message, Plan, RunStatus } from "../src/contracts/types.js";
import type { Draft } from "../src/daemon/orchestrator.js";
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
    server = new DaemonServer(root);
    await server.listen();
    client = await HexClient.connect(root, { autostart: false });
    await client.subscribe();
  });

  afterAll(() => {
    client?.close();
    server?.orch.shutdown();
  });

  it("init agent writes HEXAGON.md", async () => {
    await client.call("init.start", {});
    await until(async () => fs.existsSync(path.join(root, "HEXAGON.md")) && (await client.call<{ sessions: { id: string; state: string }[] }>("ui.snapshot")).sessions.find((s) => s.id === "init")?.state === "done");
    const snap = await client.call<{ has_context: boolean }>("ui.snapshot");
    expect(snap.has_context).toBe(true);
    git(root, "add", "-A");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "context");
  });

  it("chats with Claude (persistent session, tokens per step)", async () => {
    type Snap = { sessions: { id: string; state: string; feed: { kind: string; text: string }[]; tokens: { output: number; steps: number } }[] };
    await client.call("chat.send", { text: "how are you doing" });
    const s1 = await until(async () => (await client.call<Snap>("ui.snapshot")).sessions.find((s) => s.id === "claude" && s.state === "idle" && s.feed.some((f) => f.text.includes("how are you doing") && f.kind === "agent")));
    expect(s1.tokens.steps).toBeGreaterThan(0);
    await client.call("chat.send", { text: "second message" });
    await until(async () => (await client.call<Snap>("ui.snapshot")).sessions.find((s) => s.id === "claude" && s.feed.some((f) => f.kind === "agent" && f.text.includes("second message"))));
  });

  it("rejects protocol calls from unknown agents", async () => {
    const r = await client.call<{ ok: boolean }>("agent.api", { agent: "T-9-a1", op: "report", args: { activity: "x" } });
    expect(r.ok).toBe(false);
  });

  it("goal → draft plan → approve → run: asks, takes instructions, verifies, reviews and merges", async () => {
    const pushes: Message[] = [];
    client.on("push", (p) => { if (p.event === "message") pushes.push(p.data); });

    // Planner (mock) turns the goal into a spec + plan draft.
    const drafted = new Promise<Draft>((resolve) => client.on("push", (p) => { if (p.event === "draft" && p.data) resolve(p.data); }));
    await client.call("goal.new", { goal: "Greeting and farewell" });
    const draft = await drafted;
    expect(draft.plan.tasks).toHaveLength(2);
    expect(fs.existsSync(draft.spec_path)).toBe(true);
    expect(draft.check.errors).toEqual([]);

    // The user edits the plan: T-2 asks a question.
    const plan = JSON.parse(fs.readFileSync(draft.plan_path, "utf8")) as Plan;
    plan.tasks[1]!.description = "@ask: Formal or casual farewell?";
    fs.writeFileSync(draft.plan_path, JSON.stringify(plan));
    await client.call("draft.reload");

    const { run_id } = await client.call<{ run_id: string }>("draft.approve", {});

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
    expect(fs.readFileSync(path.join(integ, "hexagon-mock/part-1.md"), "utf8")).toContain("Say hello in Russian too");
    // The answer reached T-2's output.
    expect(fs.readFileSync(path.join(integ, "hexagon-mock/part-2.md"), "utf8")).toContain("Option B");

    // Commits carry trailers; both tasks merged into the integration branch.
    const log = git(integ, "log", "--format=%B", "-n", "10");
    expect(log).toContain("Hexagon-Task: T-1");
    expect(log).toContain("Hexagon-Task: T-2");

    // Merge into main.
    const merged = await client.call<{ text: string }>("merge.base");
    expect(merged.text).toMatch(/Merged/);
    expect(fs.existsSync(path.join(root, "hexagon-mock/part-1.md"))).toBe(true);
    expect(pushes.some((m) => m.type === "question")).toBe(true);
  });
  it("a blocked agent continues its own session when the user replies", async () => {
    const planFile = path.join(root, ".hexagon/blocked-plan.json");
    fs.writeFileSync(planFile, JSON.stringify({
      tasks: [{ id: "T-1", title: "Build it", role: "implementer", description: "@block: mvn is not installed", acceptance: ["AC-1"], files: { write: ["hexagon-mock/blk.md"] }, verify: ["test -f hexagon-mock/blk.md"] }],
    }));
    await client.call("run.start", { plan_path: planFile });
    const blocked = await until(async () => {
      const s = await client.call<AgentStatus>("agent.status", { task: "T-1" });
      return s.state === "blocked" ? s : null;
    });
    expect(blocked.last_error).toBeFalsy(); // blocked is not an "internal" error
    await until(async () => (await client.call<RunStatus>("run.status")).state === "done");
    await client.call("message.send", { to: "T-1", body: "mvn is installed now, try again" });
    const done = await until(async () => {
      const s = await client.call<AgentStatus>("agent.status", { task: "T-1" });
      return s.state === "done" ? s : null;
    });
    expect(done.attempt).toBe(1); // same attempt, same session
    const rs = await until(async () => { const r = await client.call<RunStatus>("run.status"); return r.state === "done" ? r : null; });
    expect(rs.agents[0]!.state).toBe("done");
  });
});
