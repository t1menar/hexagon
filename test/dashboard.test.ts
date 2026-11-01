import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/tui/app.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const task = (id: string, title: string, role: string, deps: string[] = []) => ({ id, title, role, requirements: [], acceptance: [], depends_on: deps, files: { write: [], read: [] }, skills: [], definition_of_done: [], verify: [] });
const agent = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  schema: "hexagon.agent-status/v1", seq: 1, updated_at: "", heartbeat_at: "", run_id: "R1", agent_run_id: `${id}-1`, task_id: id, attempt: 1, role: id === "T-1" ? "tester" : id === "T-3" ? "reviewer" : "implementer",
  agent: { id: id === "T-2" ? "codex" : "claude", provider: id === "T-2" ? "openai" : "anthropic", adapter: id === "T-2" ? "codex" : "claude-code", cli_version: "1.2.3", model: null, model_mode: "cli-default", runtime_model: null },
  state, state_since: new Date().toISOString(), controller: "agent", needs_input: null, inbox: { pending: 0 }, usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, turns: 2, wall_ms: 1000 }, last_error: null, result_path: null, ...extra,
});

function makeSnapshot(states: Record<string, string>) {
  const tasks = [task("T-1", "Analyse the API", "tester"), task("T-2", "Build endpoints", "implementer", ["T-1"]), task("T-3", "Build the UI", "reviewer", ["T-1"])];
  const agents = tasks.map((t) => agent(t.id, states[t.id] ?? "queued"));
  return {
    root: "", has_context: true, draft: null, permissions: [], sessions: [], agents,
    plan: { schema: "hexagon.plan/v1", id: "p", created_at: "", specs: [], tasks, spec_issues: [] },
    run: {
      schema: "hexagon.run-status/v1", run_id: "R1", updated_at: new Date().toISOString(), state: "running", plan_path: "", integration_branch: "hexagon/R1", base_branch: "main", started_at: new Date().toISOString(), budget_tokens: null,
      totals: { input_tokens: 30, output_tokens: 15, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, turns: 6, wall_ms: 3000 },
      counts: Object.fromEntries(Object.entries(states).reduce((m, [, s]) => m.set(s, (m.get(s) ?? 0) + 1), new Map<string, number>())),
      agents: agents.map((a) => ({ task_id: a.task_id, agent_run_id: a.agent_run_id, role: a.role, agent: a.agent.id, state: a.state, activity: null, needs_input: false, progress: null, cost_usd: 0, tokens: 15 })), attention: [],
    },
  };
}

class FakeClient extends EventEmitter {
  constructor(public snap: unknown) { super(); }
  calls: { m: string; p: unknown }[] = [];
  reply: Record<string, unknown> = {};
  async call(m: string, p?: unknown) { this.calls.push({ m, p }); if (m in this.reply) return this.reply[m]; if (m === "ui.snapshot") return this.snap; if (m === "agents.list") return []; return []; }
  async subscribe() {}
  close() {}
}

let tmp: string;
let screen: string[];
let writes = 0;
const saved: Record<string, unknown> = {};
function setTerm(cols: number, rows: number, env: Record<string, string | undefined> = {}) {
  Object.assign(process.env, { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8", HEXAGON_STARTUP: "off", HEXAGON_ANIMATION: "auto", HEXAGON_AMBIENT: "off" }, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
}
const text = () => screen.map((l) => strip(l ?? "").replace(/\s+$/, "")).join("\n");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hex-dash-"));
  fs.mkdirSync(path.join(tmp, ".hexagon"));
  screen = [];
  writes = 0;
  for (const k of ["TERM", "COLORTERM", "LANG", "HEXAGON_STARTUP", "HEXAGON_ANIMATION", "HEXAGON_AMBIENT", "NO_MOTION", "NO_COLOR", "HEXAGON_ASCII", "SSH_CONNECTION"]) saved[k] = process.env[k];
  saved.isTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
    writes++;
    for (const m of String(chunk).matchAll(/\x1b\[(\d+);1H([^\x1b]*(?:\x1b\[[0-9;]*m[^\x1b]*)*)/g)) screen[Number(m[1]) - 1] = m[2]!;
    return true;
  }) as never);
  vi.spyOn(process.stdin, "resume").mockImplementation((() => process.stdin) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) { if (k === "isTTY") Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true }); else if (v === undefined) delete process.env[k]; else process.env[k] = v as string; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const CHANGES = {
  run_id: "R1", base_branch: "main", integration_branch: "hexagon/R1/integration", integration_worktree: ".hexagon/worktrees/R1/integration", merged: false, commits: 3, files: 2, insertions: 138, deletions: 4,
  file_list: [{ path: "go.mod", added: 3, deleted: 0 }, { path: "internal/server/server.go", added: 135, deleted: 4 }],
  agents: [{ task_id: "T-1", state: "done", branch: "hexagon/R1/T-1-a1", worktree: ".hexagon/worktrees/R1/T-1-a1", files: 1 }],
};
async function boot(states: Record<string, string>, cols = 160, rows = 45, env: Record<string, string | undefined> = {}, reply: Record<string, unknown> = { "run.changes": CHANGES }) {
  setTerm(cols, rows, env);
  const client = new FakeClient(makeSnapshot(states));
  client.reply = reply;
  const app = new App(client as never, tmp);
  void app.start();
  await vi.waitFor(() => expect(text()).toContain("HEXAGON"));
  const exit = () => client.emit("close");
  return { app, client, exit };
}
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe("dashboard (real App, fake daemon)", () => {
  it("large layout: header, grouped navigator, network, inspector, activity, input, shortcut bar", async () => {
    const { exit } = await boot({ "T-1": "done", "T-2": "running", "T-3": "queued" });
    if (process.env.DUMP_SCREEN) console.log(text());
    const t = text();
    for (const w of ["HEXAGON", "AGENTS", "AGENT NETWORK", "INSPECTOR", "ACTIVITY", "ANALYSIS", "IMPLEMENTATION", "REVIEW", "T-1", "T-2", "T-3", "openai", "codex 1.2.3", "CLI-managed", "F1 help"]) expect(t, w).toContain(w);
    expect(t).toContain("1 running");
    expect(screen.length).toBeLessThanOrEqual(45);
    exit();
  });
  it("selecting an agent shows its identity in the inspector with configured vs runtime model apart", async () => {
    const { app, exit } = await boot({ "T-1": "done", "T-2": "running" });
    (app as never as { select(id: string): void }).select("T-2");
    await settle();
    const t = text();
    expect(t).toContain("Selection");
    expect(t).toContain("native CLI default");
    expect(t).toMatch(/Runtime\s+unknown \(CLI-managed\)/);
    exit();
  });
  it.each([[160, 45], [124, 30], [100, 28], [90, 22], [80, 24], [60, 20], [40, 16]])("%ix%i: nothing overflows the terminal", async (c, r) => {
    const { exit } = await boot({ "T-1": "done", "T-2": "running", "T-3": "reviewing" }, c, r);
    expect(screen.length).toBeLessThanOrEqual(r);
    for (const l of screen) expect([...strip(l ?? "")].length).toBeLessThanOrEqual(c);
    expect(text()).toContain("T-2");
    exit();
  });
  it("quota wait is labelled in text, not just colour", async () => {
    const { exit } = await boot({ "T-1": "done", "T-2": "waiting_quota" });
    expect(text()).toMatch(/WAITING/i);
    exit();
  });
  it("idle renderer: no frames are produced when nothing is happening and animations are off", async () => {
    const { exit } = await boot({ "T-1": "done", "T-2": "done", "T-3": "done" }, 120, 32);
    await settle(100);
    const before = writes;
    await settle(400);
    expect(writes).toBe(before);
    exit();
  });
  it("NO_MOTION and NO_COLOR and ASCII modes render", async () => {
    const { exit } = await boot({ "T-1": "done", "T-2": "running" }, 140, 40, { NO_MOTION: "1", NO_COLOR: "1", HEXAGON_ASCII: "1" });
    expect(text()).toContain("T-2");
    expect(screen.join("")).not.toMatch(/\x1b\[(3[0-7]|4[0-7]|38;|48;)/);
    expect(/[^\x00-\x7f]/.test(text())).toBe(false);
    exit();
  });
  it("exit leaves no timers armed", async () => {
    const { exit } = await boot({ "T-2": "running" });
    exit();
    await settle(50);
    const before = writes;
    await settle(300);
    expect(writes).toBe(before);
  });

  const push = (c: FakeClient, event: string, data: unknown) => c.emit("push", { event, data });
  const statusOf = (id: string, state: string, extra: Record<string, unknown> = {}) => agent(id, state, extra);

  it("rejection and approval appear in the activity timeline, driven by real events", async () => {
    const { client, exit } = await boot({ "T-1": "done", "T-2": "running" });
    push(client, "status", statusOf("T-2", "reviewing"));
    push(client, "agent_event", { task_id: "T-2", ts: new Date().toISOString(), event: { type: "fix_cycle", n: 1 } });
    await settle(120);
    expect(text()).toMatch(/review rejected/);
    push(client, "status", statusOf("T-2", "merging"));
    await settle(120);
    expect(text()).toMatch(/review approved/);
    exit();
  });
  it("quota wait and recovery are explained in text", async () => {
    const { client, exit } = await boot({ "T-1": "done", "T-2": "running" });
    push(client, "status", statusOf("T-2", "waiting_quota", { recovery: { cls: "quota_exhausted", status: "waiting", next_retry_at: "2026-01-01T15:04:00Z", reset_source: "estimate", waits: 1, waited_s: 0, message: "", history: [] } }));
    await settle(120);
    expect(text()).toMatch(/waiting for quota/);
    expect(text()).toMatch(/exhausted/);
    expect(text()).toMatch(/15:04/);
    push(client, "status", statusOf("T-2", "running"));
    await settle(120);
    expect(text()).toMatch(/limit cleared/);
    exit();
  });
  it("animation settles: frames stop after an event's effects finish and no agent is active", async () => {
    const { client, exit } = await boot({ "T-1": "done", "T-2": "running" });
    push(client, "status", statusOf("T-2", "done"));
    push(client, "run", { ...makeSnapshot({}).run, state: "done" }); // a finished run has no live clock
    await settle(2800); // flash + sweep end (generous: the full suite runs in parallel)
    const before = writes;
    await settle(500);
    expect(writes).toBe(before);
    exit();
  });
  it("an active agent keeps animating at a bounded frame rate", async () => {
    const { exit } = await boot({ "T-1": "done", "T-2": "running" });
    const a = writes;
    await settle(500);
    const n = writes - a;
    expect(n).toBeGreaterThan(2);
    expect(n).toBeLessThanOrEqual(16); // ≤ ~24 fps ceiling over 0.5 s, with slack for timers
    exit();
  });
  it("F2 toggles the inspector, F3 turns motion off (and nothing animates afterwards)", async () => {
    const { app, client, exit } = await boot({ "T-1": "done", "T-2": "running" });
    push(client, "run", { ...makeSnapshot({}).run, state: "done" });
    const key = (name: string) => (app as never as { onKey(s: undefined, k: { name: string }): void }).onKey(undefined, { name });
    key("f2"); await settle(80);
    expect(text()).not.toContain("INSPECTOR");
    key("f2"); await settle(80);
    expect(text()).toContain("INSPECTOR");
    key("f3"); await settle(500);
    const before = writes;
    await settle(400);
    expect(writes).toBe(before);
    expect(text()).toContain("motion: off");
    exit();
  });
  it("startup sequence can be skipped with any key and disabled by config/env", async () => {
    setTerm(120, 36, { HEXAGON_STARTUP: undefined });
    const client = new FakeClient(makeSnapshot({ "T-2": "running" }));
    const app = new App(client as never, tmp);
    void app.start();
    await vi.waitFor(() => expect(screen.length).toBeGreaterThan(5));
    expect((app as never as { startup: unknown }).startup).not.toBeNull();
    (app as never as { onKey(s: string, k: { name: string }): void }).onKey("x", { name: "x" });
    expect((app as never as { startup: unknown }).startup).toBeNull();
    await settle(100);
    expect(text()).toContain("AGENT NETWORK");
    client.emit("close");
  });

  it("ambient hexagons: only in full motion, never over content, and they stop when motion is off", async () => {
    const { app, exit } = await boot({ "T-1": "done", "T-2": "running" }, 160, 45, { HEXAGON_AMBIENT: undefined });
    const level = () => (app as never as { ambientLevel(): number }).ambientLevel();
    expect(level()).toBe(1);
    await settle(400);
    expect(text()).toContain("T-2"); // content intact
    const key = (name: string) => (app as never as { onKey(s: undefined, k: { name: string }): void }).onKey(undefined, { name });
    key("f3"); // motion off
    await settle(100);
    expect(level()).toBe(0);
    const before = writes;
    await settle(400);
    expect(writes).toBe(before);
    exit();
  });
  it("ambient is reduced after 60 s of inactivity and gone after 5 min", async () => {
    const { app, exit } = await boot({ "T-1": "done" }, 160, 45, { HEXAGON_AMBIENT: undefined });
    const a = app as never as { ambientLevel(): number; lastInput: number };
    a.lastInput = Date.now() - 90_000;
    expect(a.ambientLevel()).toBeLessThan(1);
    expect(a.ambientLevel()).toBeGreaterThan(0);
    a.lastInput = Date.now() - 400_000;
    expect(a.ambientLevel()).toBe(0);
    exit();
  });
  it("adding a task to the plan animates the graph and settles back to idle", async () => {
    const { client, exit } = await boot({ "T-1": "done", "T-2": "done", "T-3": "done" });
    const snap = makeSnapshot({ "T-1": "done", "T-2": "done", "T-3": "done" });
    const run = { ...snap.run, state: "done" };
    client.snap = { ...snap, run };
    (client as FakeClient).emit("push", { event: "run", data: { ...run, run_id: "R2" } });
    await settle(1200);
    const before = writes;
    await settle(400);
    expect(writes).toBe(before);
    exit();
  });

  const execReq = (over: Record<string, unknown> = {}) => ({
    id: "P-1", agent: "T-2", kind: "task", command: "go vet ./...", prefix: "go vet", asked_at: new Date().toISOString(), action: "exec", reason: "verify the server",
    choices: [{ id: "once", label: "run it this once", key: "y" }, { id: "always", label: "always allow `go vet`", key: "a" }, { id: "all", label: "allow every command", key: "*" }, { id: "deny", label: "deny", key: "n" }], ...over,
  });
  const key = (app: unknown, s: string | undefined, name?: string) => (app as { onKey(s: string | undefined, k: { name?: string }): void }).onKey(s, { name: name ?? s });

  it("a waiting approval opens a dialog with the exact command, who asks and why; a key answers it", async () => {
    const { app, client, exit } = await boot({ "T-1": "done", "T-2": "running" });
    push(client, "permissions", [execReq()]);
    await settle(120);
    const t = text();
    for (const w of ["APPROVAL NEEDED", "go vet ./...", "verify the server", "T-2", "run it this once", "always allow `go vet`", "deny"]) expect(t, w).toContain(w);
    key(app, "a");
    await settle(50);
    const answered = client.calls.find((c) => c.m === "question.answer");
    expect(answered?.p).toEqual({ question_id: "P-1", answer: "always" });
    expect(text()).not.toContain("APPROVAL NEEDED");
    exit();
  });
  it("the dialog swallows other keys (typing cannot answer by accident), Esc postpones it, F5 brings it back", async () => {
    const { app, client, exit } = await boot({ "T-2": "running" });
    push(client, "permissions", [execReq({ action: "sudo", command: "sudo brew install go", choices: [{ id: "terminal", label: "run it in a terminal (you type the password)", key: "t" }, { id: "deny", label: "deny", key: "n" }] })]);
    await settle(100);
    expect(text()).toContain("as ROOT");
    expect(text()).toContain("never sees it");
    key(app, "x"); key(app, "q");
    expect(client.calls.some((c) => c.m === "question.answer")).toBe(false);
    key(app, undefined, "escape");
    await settle(100);
    expect(text()).not.toContain("APPROVAL NEEDED");
    expect(text()).toMatch(/1 approval waiting/);
    key(app, undefined, "f5");
    await settle(100);
    expect(text()).toContain("APPROVAL NEEDED");
    key(app, undefined, "return"); // primary choice
    await settle(50);
    expect(client.calls.find((c) => c.m === "question.answer")?.p).toEqual({ question_id: "P-1", answer: "terminal" });
    exit();
  });
  it("native refusals (no choices from the daemon) still get a dialog", async () => {
    const { app, client, exit } = await boot({ "T-2": "running" });
    push(client, "permissions", [{ id: "P-3", agent: "T-2", kind: "task", command: "brew install go", prefix: "brew", asked_at: new Date().toISOString() }]);
    await settle(100);
    expect(text()).toContain("allow `brew` commands");
    key(app, "n");
    await settle(50);
    expect(client.calls.find((c) => c.m === "question.answer")?.p).toEqual({ question_id: "P-3", answer: "3" });
    exit();
  });
  it("small terminals still fit the dialog", async () => {
    const { client, exit } = await boot({ "T-2": "running" }, 60, 20);
    push(client, "permissions", [execReq({ command: "a-very-long-command --with --many --arguments ".repeat(3) })]);
    await settle(100);
    expect(text()).toContain("APPROVAL NEEDED");
    for (const l of screen) expect([...strip(l ?? "")].length).toBeLessThanOrEqual(60);
    exit();
  });

  it("says where the work is: header badge, run-level inspector and /changes", async () => {
    const { app, exit } = await boot({ "T-1": "done", "T-2": "running" });
    await vi.waitFor(() => expect(text()).toContain("not in main yet"));
    expect(text()).toMatch(/2 files \+138/);
    await vi.waitFor(() => expect(text()).toContain("WHERE THE WORK IS"));
    for (const w of ["untouched", "hexagon/R1/integration", "Folder"]) expect(text(), w).toContain(w);
    await (app as never as { command(c: string): Promise<void> }).command("/changes");
    await settle(100);
    const t = text();
    for (const w of ["server.go"]) expect(t, w).toContain(w);
    exit();
  });
  it("an agent's inspector shows its folder and branch", async () => {
    const { app, client, exit } = await boot({ "T-1": "done", "T-2": "running" });
    push(client, "status", agent("T-2", "running", { workspace: { worktree: ".hexagon/worktrees/R1/T-2-a1", branch: "hexagon/R1/T-2-a1" }, files_touched: ["a.go", "b.go"] }));
    (app as never as { select(id: string): void }).select("T-2");
    await settle(120);
    for (const w of ["WORKSPACE", ".hexagon/worktrees/R1/T-2-a1", "hexagon/R1/T-2-a1", "2 files"]) expect(text(), w).toContain(w);
    exit();
  });
});
