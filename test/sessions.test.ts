import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan, RunStatus } from "../src/contracts/types.js";
import { MockAdapter } from "../src/agents/mock.js";
import { shouldCompact } from "../src/core/compaction.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { scaffold } from "../src/core/project.js";
import { IdentityPool, SessionRegistry, type SessionSpec } from "../src/core/sessions.js";
import { DaemonServer } from "../src/daemon/server.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 40000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(100); }
}

function project(extraConfig = ""): string {
  const root = fs.mkdtempSync(path.join("/tmp", "hs-"));
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  scaffold(root);
  const cfgFile = path.join(root, ".hexagon/config.toml");
  let cfg = fs.readFileSync(cfgFile, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 20");
  if (extraConfig.includes("[context]")) cfg = cfg.replace(/\[context\][\s\S]*?\n\n/, "");
  fs.writeFileSync(cfgFile, cfg + extraConfig);
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
  return root;
}

/** A chain T-1 → T-2 → … for one role. */
function chain(root: string, n: number): string {
  const p: Plan = {
    schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [],
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `T-${i + 1}`, title: `Write file ${i + 1}`, role: "implementer" as const, requirements: [], acceptance: ["AC-1"],
      depends_on: i ? [`T-${i}`] : [], files: { write: [`src/f${i + 1}.txt`], read: [] }, skills: [], definition_of_done: ["done"], verify: [],
    })),
  };
  const file = path.join(root, "plan.json");
  fs.writeFileSync(file, JSON.stringify(p));
  return file;
}

describe("session registry (pure)", () => {
  const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
    agentId: "implementer-1", role: "implementer", adapterId: "mock", model: null, promptHash: "h1", cwd: "/w/a",
    resumeAcrossCwd: true, supportsResume: true, ...over,
  });
  const reg = () => new SessionRegistry(fs.mkdtempSync(path.join("/tmp", "hsr-")));

  it("creates once, then resumes the same native session", () => {
    const r = reg();
    const a = r.resolve(spec());
    expect(a).toMatchObject({ mode: "new", resume: false, reason: "first use of this agent" });
    r.confirm("implementer-1");
    const b = r.resolve(spec({ cwd: "/w/b" }));
    expect(b).toMatchObject({ mode: "resumed", resume: true, sessionId: a.sessionId });
  });

  it("does not resume a session the CLI never confirmed (reuses the id for the create)", () => {
    const r = reg();
    const a = r.resolve(spec());
    const b = r.resolve(spec());
    expect(b).toMatchObject({ resume: false, sessionId: a.sessionId });
  });

  it("starts a new session only for a real reason, and logs it", () => {
    const r = reg();
    const a = r.resolve(spec());
    r.confirm("implementer-1");
    expect(r.resolve(spec({ promptHash: "h2" })).reason).toMatch(/prompt/);
    r.confirm("implementer-1");
    expect(r.resolve(spec({ promptHash: "h2", model: "m" })).reason).toMatch(/model/);
    r.confirm("implementer-1");
    expect(r.resolve(spec({ promptHash: "h2", model: "m", adapterId: "other" })).reason).toMatch(/agent changed/);
    r.confirm("implementer-1");
    r.reset("implementer-1", "reset by the user");
    const c = r.resolve(spec({ promptHash: "h2", model: "m", adapterId: "other" }));
    expect(c.reason).toBe("reset by the user");
    expect(c.sessionId).not.toBe(a.sessionId);
    expect(r.events().filter((e) => e.kind === "created").length).toBe(5);
  });

  it("adapters that cannot resume across directories get one session per directory (stated, never silent)", () => {
    const r = reg();
    r.resolve(spec({ resumeAcrossCwd: false }));
    r.confirm("implementer-1");
    expect(r.resolve(spec({ resumeAcrossCwd: false, cwd: "/w/a" })).mode).toBe("resumed");
    const moved = r.resolve(spec({ resumeAcrossCwd: false, cwd: "/w/b" }));
    expect(moved.mode).toBe("new");
    expect(moved.reason).toMatch(/another working directory/);
  });

  it("survives a restart and tracks context size, turns and the token ledger", () => {
    const dir = fs.mkdtempSync(path.join("/tmp", "hsr-"));
    const r = new SessionRegistry(dir);
    const a = r.resolve(spec());
    r.confirm("implementer-1");
    r.recordUsage("implementer-1", { input: 100, cache_read: 500, output: 20, cause: "prompt", step: true });
    r.recordUsage("implementer-1", { input: 10, cache_read: 620, output: 30, cause: "fix_loop", step: true });
    const again = new SessionRegistry(dir);
    const rec = again.get("implementer-1")!;
    expect(rec).toMatchObject({ turns: 2, contextTokens: 660, nativeSessionId: a.sessionId });
    expect(rec.ledger.fix_loop).toEqual({ input: 10, cache_read: 620, output: 30 });
    expect(again.resolve(spec()).mode).toBe("resumed");
  });

  it("compaction keeps the identity, replaces the native session and counts it", () => {
    const r = reg();
    const a = r.resolve(spec());
    r.confirm("implementer-1");
    const next = r.compacted("implementer-1");
    expect(next).not.toBe(a.sessionId);
    const b = r.resolve(spec());
    expect(b).toMatchObject({ mode: "new", resume: false, reason: "compacted", sessionId: next });
    expect(r.get("implementer-1")!.compactions).toBe(1);
  });

  it("the pool hands out one identity per concurrent task and reuses free ones", () => {
    const pool = new IdentityPool(reg());
    const a = pool.acquire("implementer");
    const b = pool.acquire("implementer");
    expect([a.agentId, b.agentId]).toEqual(["implementer-1", "implementer-2"]);
    a.release();
    expect(pool.acquire("implementer").agentId).toBe("implementer-1");
    expect(pool.acquire("implementer", "implementer-2").agentId).toBe("implementer-3"); // preferred one is busy
    b.release();
    expect(pool.acquire("implementer", "implementer-2").agentId).toBe("implementer-2");
  });
});

describe("compaction trigger (pure)", () => {
  const cx = { ...DEFAULT_CONFIG.context, assumed_window_tokens: 1000 };
  const rec = (contextTokens: number, turns = 10, lastCompactionTurn = 0) => ({ contextTokens, turns, lastCompactionTurn });
  it("compacts at the threshold, not below it", () => {
    expect(shouldCompact(cx, rec(699), false).compact).toBe(false);
    expect(shouldCompact(cx, rec(700), false).compact).toBe(true);
  });
  it("waits min_turns_between after a compaction", () => {
    expect(shouldCompact(cx, rec(900, 11, 9), false).compact).toBe(false);
    expect(shouldCompact(cx, rec(900, 12, 9), false).compact).toBe(true);
  });
  it("respects mode: manual/off never compact by themselves; /compact always can", () => {
    expect(shouldCompact({ ...cx, mode: "manual" }, rec(990), false).compact).toBe(false);
    expect(shouldCompact({ ...cx, mode: "off" }, rec(990), false).compact).toBe(false);
    expect(shouldCompact({ ...cx, mode: "off" }, rec(1), true).compact).toBe(true);
  });
});

describe("one session per agent identity (mock agent)", () => {
  const open: { server?: DaemonServer; client?: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.client?.close(); o.server?.orch.shutdown(); } });
  async function boot(root: string) {
    const server = new DaemonServer(root);
    await server.listen();
    const client = await HexClient.connect(root, { autostart: false });
    open.push({ server, client });
    return { server, client };
  }
  const finished = (client: HexClient) => until(async () => { const r = await client.call<RunStatus>("run.status"); return r.state === "done" ? r : null; });

  it("3 sequential tasks of one role: exactly 1 session created, 2 resumed — and the same for reviews", async () => {
    const root = project();
    const { client, server } = await boot(root);
    await client.call("run.start", { plan_path: chain(root, 3) });
    const run = await finished(client);
    expect(run.agents.map((a) => a.state)).toEqual(["done", "done", "done"]);
    const events = server.orch.agentSessions.events();
    const dev = events.filter((e) => e.agent === "implementer-1");
    expect(dev.map((e) => e.kind)).toEqual(["created", "resumed", "resumed"]);
    const rev = events.filter((e) => e.agent === "reviewer-1");
    expect(rev.map((e) => e.kind)).toEqual(["created", "resumed", "resumed"]);
    expect(events.some((e) => e.agent === "implementer-2")).toBe(false);
    const t3 = await client.call<AgentStatus>("agent.status", { task: "T-3" });
    expect(t3.session).toMatchObject({ agent: "implementer-1", mode: "resumed" });
    expect(fs.existsSync(path.join(root, ".hexagon/sessions/implementer-1.json"))).toBe(true);
    // the ledger separates what the tokens were spent on
    expect(run.ledger?.prompt?.input).toBeGreaterThan(0);
    expect(run.ledger?.review?.input).toBeGreaterThan(0);
  }, 90000);

  it("compacts a session that fills its (small, simulated) window and re-sends the pinned context", async () => {
    const root = project('\n[context]\nmode = "auto"\ncompact_at = 0.5\nmin_turns_between = 1\nassumed_window_tokens = 5000\n');
    const { client, server } = await boot(root);
    await client.call("run.start", { plan_path: chain(root, 4) });
    const run = await finished(client);
    expect(run.agents.map((a) => a.state)).toEqual(["done", "done", "done", "done"]);
    const events = server.orch.agentSessions.events();
    const compacted = events.filter((e) => e.kind === "compacted");
    expect(compacted.length).toBeGreaterThan(0);
    expect(run.ledger?.compaction?.output).toBeGreaterThan(0);
    // the task after a compaction ran in a fresh native session, and the agent identity is unchanged
    const rec = server.orch.agentSessions.get(compacted[0]!.agent)!;
    expect(rec.compactions).toBeGreaterThan(0);
    const statuses = await Promise.all(["T-1", "T-2", "T-3", "T-4"].map((t) => client.call<AgentStatus>("agent.status", { task: t })));
    expect(statuses.every((s) => s.state === "done")).toBe(true);
    expect(statuses.some((s) => (s.session?.compactions ?? 0) > 0)).toBe(true);
    // After a compaction the fresh session got the whole task card plus the summary the old session wrote.
    const t = MockAdapter.turns.filter((x) => /^T-\d-a1$/.test(x.agent) && !x.resume && x.text.includes("Summary of your earlier work"));
    expect(t.length).toBeGreaterThan(0);
    expect(t[0]!.text).toContain("<acceptance>");
    expect(t[0]!.text).toContain("(mock) kept the module layout");
  }, 90000);
});
