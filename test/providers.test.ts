import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/agents/claude-code.js";
import { CodexAdapter } from "../src/agents/codex.js";
import { classifyProviderError, recoveryFor } from "../src/agents/contracts/errors.js";
import { CLI_DEFAULT, DiscoveryCache, overrideOf, selectionFrom } from "../src/agents/contracts/model-selection.js";
import { ExecAdapter } from "../src/agents/exec.js";
import { GrokAdapter } from "../src/agents/grok.js";
import { LineBuffer } from "../src/agents/oneshot.js";
import { adapterNames, createAdapter, registerAdapter } from "../src/agents/registry.js";
import type { AgentRunContext } from "../src/agents/types.js";
import { loadConfig } from "../src/core/config.js";
import { DEFAULT_RECOVERY, planRetry, WaitStore } from "../src/core/recovery.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hex-prov-"));

/** A deterministic stand-in CLI: logs argv + stdin, answers --version / models / login status, prints JSONL in awkward chunks. */
function fakeCli(dir: string, name = "fakecli"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const log = process.env.FAKE_LOG;
if (a[0] === "--version") { console.log("fakecli 9.8.7"); process.exit(0); }
if (a[0] === "models") { console.log("Available models\\n- alpha-1  fast\\n- beta-2"); process.exit(0); }
if (a[0] === "login" && a[1] === "status") { console.log("Logged in"); process.exit(0); }
let stdin = "";
process.stdin.on("data", (d) => stdin += d);
process.stdin.on("end", () => {
  if (log) fs.appendFileSync(log, JSON.stringify({ argv: a, stdin }) + "\\n");
  if (process.env.FAKE_FAIL) { console.error(process.env.FAKE_FAIL); process.exit(1); }
  const out = [JSON.stringify({ type: "thread.started", thread_id: process.env.FAKE_THREAD || "th-1" }), "not json {{", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } })].join("\\n") + "\\n";
  // split mid-line to prove chunk-boundary handling
  process.stdout.write(out.slice(0, 20));
  setTimeout(() => { process.stdout.write(out.slice(20)); }, 30);
});
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
`);
  fs.chmodSync(file, 0o755);
  return file;
}

function ctx(over: Partial<AgentRunContext> = {}, events: unknown[] = []): AgentRunContext {
  return {
    agentRunId: "T-1-a1", role: "developer", effort: "medium", cwd: os.tmpdir(), system: "SYS", prompt: "do the thing $(rm -rf /) `x`",
    sessionId: "s-1", resume: false, env: {}, allowCommands: [], readOnly: false,
    host: { emit: (e) => events.push(e), drainInbox: () => [], onInbox: () => () => {}, received: () => {}, isFinished: () => false, hasBlockingQuestion: () => false },
    api: {} as never, signal: new AbortController().signal, ...over,
  };
}

describe("error classification", () => {
  const c = (t: string) => classifyProviderError(t, new Date("2026-01-01T10:00:00Z"));
  it.each([
    ["429 Too Many Requests, retry-after: 30", "rate_limit"],
    ["rate limit exceeded: tokens per minute", "rate_limit"],
    ["Claude AI usage limit reached|1767262800", "quota_exhausted"],
    ["You have reached your weekly limit. Resets Jan 9", "quota_exhausted"],
    ["prompt is too long: 250000 tokens > maximum context", "context_overflow"],
    ["stop_reason: max_tokens — response was truncated", "output_truncated"],
    ["401 Unauthorized: invalid API key", "auth"],
    ["Your credit balance is too low to access the API", "billing"],
    ["503 service unavailable, overloaded", "overloaded"],
    ["segfault", "unknown"],
  ])("%s → %s", (text, cls) => expect(c(text).cls).toBe(cls));

  it("extracts provider-reported times and labels estimates", () => {
    expect(c("usage limit reached|1767262800").resetAt).toBe(new Date(1767262800 * 1000).toISOString());
    expect(c("rate limit, retry-after: 30").retryAfterS).toBe(30);
    expect(c("try again in 2 minutes: rate limit").retryAfterS).toBe(120);
    expect(new Date(c("5-hour limit reached, resets 3pm").resetAt!).getHours()).toBe(15);
    const e = c("usage limit reached");
    expect(e.estimated).toBe(true);
    expect(c("rate limit, retry-after: 5").estimated).toBe(false);
  });

  it("assigns separate recovery policies", () => {
    expect(recoveryFor("quota_exhausted")).toBe("wait_and_resume");
    expect(recoveryFor("context_overflow")).toBe("compact_and_resume");
    expect(recoveryFor("output_truncated")).toBe("continue_output");
    expect(recoveryFor("auth")).toBe("block_for_user");
    expect(recoveryFor("billing")).toBe("block_for_user");
  });
});

describe("retry planning and the persistent wait store", () => {
  const now = new Date("2026-01-01T10:00:00Z");
  const cfg = { ...DEFAULT_RECOVERY, backoff_jitter: false };
  it("prefers the provider's reset; otherwise exponential backoff capped at max", () => {
    const p = planRetry({ cls: "quota_exhausted", message: "", resetAt: "2026-01-01T12:00:00Z", estimated: false }, 0, cfg, now);
    expect(p.source).toBe("provider");
    expect(Date.parse(p.at)).toBeGreaterThanOrEqual(Date.parse("2026-01-01T12:00:00Z"));
    const e = (n: number) => planRetry({ cls: "quota_exhausted", message: "", estimated: true }, n, cfg, now);
    expect(e(0).delayS).toBe(60);
    expect(e(1).delayS).toBe(120);
    expect(e(10).delayS).toBe(3600);
    expect(e(0).source).toBe("estimate");
  });
  it("jitter stays within [50%,100%] of the backoff", () => {
    const lo = planRetry({ cls: "rate_limit", message: "", estimated: true }, 2, { ...cfg, backoff_jitter: true }, now, () => 0).delayS;
    const hi = planRetry({ cls: "rate_limit", message: "", estimated: true }, 2, { ...cfg, backoff_jitter: true }, now, () => 0.999).delayS;
    expect(lo).toBe(120);
    expect(hi).toBeLessThanOrEqual(240);
    expect(hi).toBeGreaterThan(230);
  });
  it("is idempotent: one record per run, claimed once, survives reload, cancelled waits stay cancelled", () => {
    const file = path.join(tmp(), "waits.json");
    const s = new WaitStore(file);
    const base = { key: "T-1-a1", run_id: "r", task_id: "T-1", agent_run_id: "T-1-a1", role: "developer", agent: "a", provider: "p", adapter: "x", execution_id: "e1", cls: "quota_exhausted" as const, error: "e", detected_at: now.toISOString(), next_retry_at: "2026-01-01T09:59:00Z", reset_source: "provider" as const };
    s.schedule(base); s.schedule({ ...base, execution_id: "e2" });
    expect(s.all()).toHaveLength(1);
    expect(s.get("T-1-a1")!.waits).toBe(2);
    const again = new WaitStore(file);
    expect(again.pending()).toHaveLength(1);
    expect(again.claim("T-1-a1", now)).toBeDefined();
    expect(again.claim("T-1-a1", now)).toBeUndefined(); // no duplicate resume
    expect(new WaitStore(file).recoverInterrupted()).toBe(1); // crashed mid-resume → waiting again
    again.finish("T-1-a1", "cancelled");
    expect(new WaitStore(file).pending()).toHaveLength(0);
    expect(again.claim("T-1-a1", now)).toBeUndefined(); // cancelled tasks are never restarted
  });
  it("not yet due → cannot be claimed", () => {
    const s = new WaitStore(path.join(tmp(), "w.json"));
    s.schedule({ key: "k", run_id: "r", task_id: "T-1", agent_run_id: "k", role: "r", agent: "a", provider: "p", adapter: "x", execution_id: "e", cls: "rate_limit", error: "", detected_at: now.toISOString(), next_retry_at: "2026-01-01T11:00:00Z", reset_source: "estimate" });
    expect(s.claim("k", now)).toBeUndefined();
  });
});

describe("model selection: no catalogue, CLI default unless overridden", () => {
  it("normalises config input", () => {
    expect(selectionFrom(undefined)).toEqual(CLI_DEFAULT);
    expect(selectionFrom("default")).toEqual(CLI_DEFAULT);
    expect(selectionFrom("anything-the-user-typed")).toEqual({ mode: "custom", identifier: "anything-the-user-typed" });
    expect(overrideOf(CLI_DEFAULT)).toBeNull();
  });
  it("passes no model flag by default and the exact override when given", () => {
    const none = new ClaudeCodeAdapter("c", { command: ["claude"], model: null, args: [] }).args(ctx());
    expect(none).not.toContain("--model");
    const set = new ClaudeCodeAdapter("c", { command: ["claude"], model: "opaque/ID:1", args: [] }).args(ctx());
    expect(set[set.indexOf("--model") + 1]).toBe("opaque/ID:1");
  });
  it("the shipped sources and templates contain no model identifiers", () => {
    const re = /\b(opus|sonnet|haiku)\b|gpt-\d|grok-\d|claude-(opus|sonnet|haiku)-?\d/i;
    const hits: string[] = [];
    const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(ts|toml)$/.test(f.name) && re.test(fs.readFileSync(p, "utf8"))) hits.push(p); } };
    walk(path.resolve("src")); walk(path.resolve("templates"));
    expect(hits).toEqual([]);
  });
  it("default config assigns no model to any role or agent", () => {
    const cfg = loadConfig(path.join(tmp(), "none.toml"));
    for (const r of Object.values(cfg.roles)) expect(r.model).toBeUndefined();
    for (const a of Object.values(cfg.agents)) expect(a.model).toBeUndefined();
  });
  it("discovery cache is keyed by CLI version and only caches successes", async () => {
    let t = 0, calls = 0;
    const cache = new DiscoveryCache(1000, () => t);
    const load = async () => { calls++; return { supported: true, models: [{ identifier: "x" }] }; };
    await cache.get("cli@1", load); await cache.get("cli@1", load);
    expect(calls).toBe(1);
    await cache.get("cli@2", load); // new CLI version → new key
    expect(calls).toBe(2);
    t = 5000; await cache.get("cli@1", load);
    expect(calls).toBe(3);
    await cache.get("bad", async () => { calls++; return { supported: false }; }); await cache.get("bad", async () => { calls++; return { supported: false }; });
    expect(calls).toBe(5);
  });
});

describe("registry and config", () => {
  it("lists the built-ins and rejects unknown adapters with a clear error (no fallback)", () => {
    expect(adapterNames()).toEqual(expect.arrayContaining(["claude-code", "codex", "grok", "exec", "mock"]));
    expect(() => createAdapter("x", { id: "x", adapter: "nope" })).toThrow(/unknown adapter "nope".*No fallback/);
    const f = path.join(tmp(), "c.toml");
    fs.writeFileSync(f, '[agents.z]\nadapter = "nope"\n');
    expect(() => loadConfig(f)).toThrow(/unknown adapter "nope"/);
    fs.writeFileSync(f, '[roles.analyst]\nagent = "ghost"\n');
    expect(() => loadConfig(f)).toThrow(/ghost/);
  });
  it("a third-party adapter registers without touching core code", async () => {
    registerAdapter("acme-test", (id, c) => new ExecAdapter(id, c.command ?? ["acme"], null, "acme"));
    const a = createAdapter("a", { id: "a", adapter: "acme-test", command: ["acme"] });
    expect(a.provider).toBe("acme");
    expect(a.capabilities.supportsModelDiscovery).toBe(false);
    expect((await a.discoverModels()).supported).toBe(false);
  });
  it("different roles may use different providers, several roles the same one", () => {
    const f = path.join(tmp(), "c.toml");
    fs.writeFileSync(f, `[agents.cx]\nadapter="codex"\nprovider="openai"\n[agents.gk]\nadapter="grok"\n[roles.analyst]\nagent="cx"\n[roles.developer]\nagent="claude"\n[roles.reviewer]\nagent="gk"\n[roles.qa]\nagent="cx"\n`);
    const cfg = loadConfig(f);
    const prov = (r: keyof typeof cfg.roles) => createAdapter(cfg.roles[r].agent, cfg.agents[cfg.roles[r].agent]!).provider;
    expect([prov("analyst"), prov("developer"), prov("reviewer"), prov("qa")]).toEqual(["openai", "anthropic", "xai", "openai"]);
  });
  it("legacy fix_loops still bounds repair cycles; absent, the default is 3", () => {
    const f = path.join(tmp(), "c.toml");
    fs.writeFileSync(f, "[run]\nfix_loops = 4\n");
    expect(loadConfig(f).run.max_fix_cycles).toBe(4);
    expect(loadConfig(path.join(tmp(), "none")).run.max_fix_cycles).toBe(3);
  });
});

describe("one-shot adapters against a fake CLI", () => {
  it("LineBuffer reassembles lines across chunk boundaries", () => {
    const b = new LineBuffer();
    expect([...b.push('{"a":'), ...b.push('1}\n{"b"'), ...b.push(":2}\n"), ...b.flush()]).toEqual(['{"a":1}', '{"b":2}']);
    expect(new LineBuffer().flush()).toEqual([]);
  });

  it("codex: the native thread belongs to the session, not to the adapter instance; a resume sends only the new message", async () => {
    const dir = tmp(); const bin = fakeCli(dir); const log = path.join(dir, "log");
    const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const resumed = (c: { argv: string[] }) => { const i = c.argv.indexOf("resume"); return i < 0 ? null : c.argv[i + 1]; };
    const a = new CodexAdapter("cx", [bin], null); // ONE instance, two agent sessions
    const evA: any[] = [];
    await a.run(ctx({ sessionId: "s-A", env: { FAKE_LOG: log, FAKE_THREAD: "th-A" } }, evA));
    await a.run(ctx({ sessionId: "s-B", env: { FAKE_LOG: log, FAKE_THREAD: "th-B" } }));
    await a.run(ctx({ sessionId: "s-A", resume: true, followUp: "more A", env: { FAKE_LOG: log } }));
    await a.run(ctx({ sessionId: "s-B", resume: true, followUp: "more B", env: { FAKE_LOG: log } }));
    expect(resumed(calls()[2])).toBe("th-A");
    expect(resumed(calls()[3])).toBe("th-B");
    // what the session already knows is not sent again
    expect(calls()[0].stdin).toContain("SYS");
    expect(calls()[2].stdin).toBe("more A");
    // the handle is reported so Hexagon can store it
    expect(evA.find((e) => e.type === "session_handle")).toMatchObject({ handle: "th-A" });
    // a new adapter instance (daemon restart) resumes from the stored handle
    await new CodexAdapter("cx", [bin], null).run(ctx({ sessionId: "s-A", resume: true, handle: "th-A", followUp: "after restart", env: { FAKE_LOG: log } }));
    expect(resumed(calls()[4])).toBe("th-A");
    // no handle known: do not guess; start a new thread with the whole first message
    await new CodexAdapter("cx", [bin], null).run(ctx({ sessionId: "s-A", resume: true, followUp: "lost", prompt: "FULL CARD", env: { FAKE_LOG: log } }));
    expect(resumed(calls()[5])).toBeNull();
    expect(calls()[5].stdin).toContain("SYS");
    expect(calls()[5].stdin).toContain("FULL CARD");
  });

  it("codex: stdin prompt, no shell, no model flag by default, override passthrough, resume by thread id, partial JSONL", async () => {
    const dir = tmp(); const bin = fakeCli(dir); const log = path.join(dir, "log");
    const events: any[] = [];
    const env = { FAKE_LOG: log };
    const a = new CodexAdapter("cx", [bin], null);
    const out = await a.run(ctx({ env }, events));
    expect(out.kind).toBe("finished");
    const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const c1 = calls()[0];
    expect(c1.argv).not.toContain("-m");
    expect(c1.stdin).toContain("do the thing $(rm -rf /) `x`"); // verbatim via stdin, never interpolated
    expect(c1.argv.join(" ")).not.toContain("rm -rf");
    expect(events.find((e) => e.type === "usage")).toMatchObject({ input: 200, cache_read: 800, output: 50, cost_usd: 0 }); // documented shape; unverified on a real codex
    expect(events.some((e) => e.type === "chat" && e.text === "hello")).toBe(true); // survived a mid-line chunk split and a junk line
    // second run resumes the thread
    await a.run(ctx({ env, resume: true, followUp: "more" }, events));
    const c2 = calls()[1];
    expect(c2.argv.slice(c2.argv.indexOf("resume"), c2.argv.indexOf("resume") + 2)).toEqual(["resume", "th-1"]);
    // override is passed through opaquely
    await new CodexAdapter("cx2", [bin], "my/custom:model").run(ctx({ env }, events));
    const c3 = calls()[2];
    expect(c3.argv[c3.argv.indexOf("-m") + 1]).toBe("my/custom:model");
    // read-only role → read-only sandbox
    await new CodexAdapter("cx3", [bin], null).run(ctx({ env, readOnly: true }, events));
    const c4 = calls()[3];
    expect(c4.argv[c4.argv.indexOf("-s") + 1]).toBe("read-only");
  });

  it("failures carry raw output for classification", async () => {
    const dir = tmp(); const bin = fakeCli(dir);
    const out = await new CodexAdapter("cx", [bin], null).run(ctx({ env: { FAKE_FAIL: "usage limit reached, resets in 90 seconds" } }));
    expect(out.kind).toBe("error");
    expect(classifyProviderError(out.error!.raw!).cls).toBe("quota_exhausted");
    const missing = await new CodexAdapter("cx", ["/nonexistent/codex"], null).run(ctx());
    expect(missing.error?.retryable).toBe(false);
  });

  it("cancellation kills the whole process tree", async () => {
    const dir = tmp(); const bin = fakeCli(dir);
    const ac = new AbortController();
    const p = new CodexAdapter("cx", [bin], null).run(ctx({ env: { FAKE_HANG: "1" }, signal: ac.signal }));
    setTimeout(() => ac.abort(), 300);
    expect((await p).kind).toBe("interrupted");
  });

  it("grok: discovers models through the CLI, reports unsupported when it cannot", async () => {
    const dir = tmp(); const bin = fakeCli(dir);
    const r = await new GrokAdapter("g", [bin], null).discoverModels();
    expect(r.supported).toBe(true);
    expect(r.source).toBe("cli");
    expect(r.models!.map((m) => m.identifier)).toEqual(["alpha-1", "beta-2"]);
    const none = await new GrokAdapter("g", ["/nonexistent/grok"], null).discoverModels();
    expect(none.supported).toBe(false);
    expect(none.models).toBeUndefined(); // never an invented list
  });

  it("grok argv: prompt after -p as one argument, session flags, no model by default", async () => {
    const dir = tmp(); const bin = fakeCli(dir); const log = path.join(dir, "log");
    await new GrokAdapter("g", [bin], null).run(ctx({ env: { FAKE_LOG: log } }));
    const c = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n")[0]!);
    expect(c.argv).toContain("--session-id");
    expect(c.argv).not.toContain("--model");
    expect(c.argv[c.argv.indexOf("-p") + 1]).toContain("do the thing $(rm -rf /)");
  });

  it("detect() reports executable and version from the CLI itself; capabilities are declared honestly", async () => {
    const dir = tmp(); const bin = fakeCli(dir);
    const d = await new CodexAdapter("cx", [bin], null).detect();
    expect(d.installed).toBe(true);
    expect(d.version).toBe("9.8.7");
    expect(d.auth).toBe("ok");
    const gone = await new CodexAdapter("cx", ["/nonexistent/codex"], null).detect();
    expect(gone.installed).toBe(false);
    expect(gone.problems[0]).toMatch(/not found/);
    const cc = new ClaudeCodeAdapter("c", { command: ["claude"], model: null, args: [] }).capabilities;
    expect(cc.supportsModelDiscovery).toBe(false); // claude has no listing command; not faked
    expect(new ExecAdapter("e", ["x"], null).capabilities.supportsUsageMetrics).toBe(false);
  });
});

describe("example adapter from docs/ADDING_PROVIDER.md", () => {
  it("registers, discovers, passes overrides and reports the runtime model", async () => {
    const { AcmeAdapter } = await import("../examples/acme-provider.js");
    const dir = tmp();
    const bin = path.join(dir, "acme");
    fs.writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("acme 1.2.3"); process.exit(0); }
if (a[0] === "models") { console.log("m-one\\nm-two"); process.exit(0); }
let s = ""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  require("fs").appendFileSync(process.env.FAKE_LOG, JSON.stringify({ a, s }) + "\\n");
  console.log(JSON.stringify({ type: "model", name: "served-by-acme" })); console.log(JSON.stringify({ type: "text", text: "hi" }));
});
`);
    fs.chmodSync(bin, 0o755);
    expect(adapterNames()).toContain("acme");
    const a = createAdapter("ac", { id: "ac", adapter: "acme", command: [bin] }) as InstanceType<typeof AcmeAdapter>;
    expect((await a.discoverModels()).models!.map((m) => m.identifier)).toEqual(["m-one", "m-two"]);
    const events: any[] = [];
    const log = path.join(dir, "log");
    expect((await a.run(ctx({ env: { FAKE_LOG: log } }, events))).kind).toBe("finished");
    expect(events).toContainEqual({ type: "model", model: "served-by-acme" });
    expect(JSON.parse(fs.readFileSync(log, "utf8").trim()).a).not.toContain("--model");
    const b = createAdapter("ac2", { id: "ac2", adapter: "acme", command: [bin], model: "m-two" });
    await b.run(ctx({ env: { FAKE_LOG: log } }, events));
    const last = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    expect(last.a).toEqual(expect.arrayContaining(["--model", "m-two"]));
  });
});

describe("real-CLI evidence is stated, not implied", () => {
  it("an integration with no recorded real run says so; a recorded one names the version, and a different installed version is flagged", async () => {
    const { realCliNote } = await import("../src/agents/contracts/verified.js");
    expect(realCliNote("codex", "0.1.0")).toMatch(/NOT run against the real CLI/);
    expect(realCliNote("grok", null)).toMatch(/NOT run against the real CLI/);
    expect(realCliNote("claude-code", "2.1.316 (Claude Code)")).toMatch(/run against the real CLI 2\.1\.316/);
    expect(realCliNote("claude-code", "9.0.0")).toMatch(/different version: untested/);
  });
});

describe("run policy projection", () => {
  it("claude states what it enforces for THIS run: a '*' allow-list lifts the command allow-list", async () => {
    const { ClaudeCodeAdapter } = await import("../src/agents/claude-code.js");
    const { enforcedFor } = await import("../src/agents/contracts/policy.js");
    const a = new ClaudeCodeAdapter("c", { command: ["claude"], model: null, args: [] } as never);
    const base = { hexagonBin: "/x/hexagon", secretDeny: [], effort: "low" as const };
    expect(enforcedFor(a, { ...base, readOnly: true, allowCommands: ["ls"] })).toEqual({ readOnlyEnforced: true, commandAllowList: true });
    expect(enforcedFor(a, { ...base, readOnly: false, allowCommands: ["*"] })).toEqual({ readOnlyEnforced: false, commandAllowList: false });
    const p = a.project({ ...base, readOnly: true, allowCommands: ["ls", "*"] });
    expect(p.args).toContain("--disallowedTools");
    expect(p.args).toContain("Bash(/x/hexagon:*)");
  });
  it("an adapter without a projection is judged by its static claim", async () => {
    const { enforcedFor } = await import("../src/agents/contracts/policy.js");
    expect(enforcedFor({ security: { readOnlyEnforced: false, commandAllowList: false } }, { readOnly: true, allowCommands: [], hexagonBin: null, secretDeny: [], effort: "low" })).toEqual({ readOnlyEnforced: false, commandAllowList: false });
  });
});
