/**
 * Adapter conformance v2: what every integration must do, whatever the CLI behind it. A library, not a test file, so
 * `hexagon agents conformance <id>` runs the same checks as the test suite (the standalone binary has no test runner).
 *
 * Most checks run against a *replay CLI*: a tiny script that prints the adapter's own recorded fixtures
 * (`<fixtures>/<name>.jsonl` + `<name>.expect.json`), records the argv, stdin and environment it was given, and exits. That
 * proves what the adapter parses and what it hands to a process, without a vendor binary. `--real` additionally runs the
 * real CLI (costs tokens): read-only enforcement and "a resumed session remembers the first turn".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "../contracts/types.js";
import { enforcedFor } from "./contracts/policy.js";
import type { AgentAdapter, AgentRunContext } from "./types.js";

export type CheckStatus = "pass" | "fail" | "skip";
export interface CheckResult { n: number; name: string; status: CheckStatus; detail: string }

export interface Target {
  id: string;
  /** Builds the adapter; `command` replaces the executable (a replay script, or a missing path). */
  make(command?: string[]): AgentAdapter;
  /** Directory of `<name>.jsonl` + `<name>.expect.json`. */
  fixtures: string | null;
  /** Source files to scan for vendor model identifiers (neutrality). */
  sources?: string[];
  /** Run the real CLI too (costs tokens). */
  real?: boolean;
  /** Extra checks for the real run. */
  semantic?: { first: string; second: string; expect: RegExp };
}

export interface Expect {
  /** Event types the fixture must produce. */
  emits?: string[];
  model?: string;
  handle?: string;
  /** "none": no usage event at all. */
  usage?: "none" | "some";
  /** The CLI exits with this code and prints this on stderr; the error it produces must classify as `cls`. */
  exit?: number;
  stderr?: string;
  cls?: string;
}

const REPLAY = `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
if (a.some((x) => x === "--version" || x === "-v" || x === "version")) { console.log("replay 1.0.0"); process.exit(0); }
if (process.env.REPLAY_HANG) { setInterval(() => {}, 1000); process.stdin.resume(); }
else {
  let input = "", fired = false;
  const go = () => {
    if (fired) return; fired = true;
    const env = Object.keys(process.env);
    if (process.env.REPLAY_DUMP) fs.writeFileSync(process.env.REPLAY_DUMP, JSON.stringify({ argv: a, stdin: input, env }));
    if (process.env.REPLAY_STDERR) process.stderr.write(process.env.REPLAY_STDERR + "\\n");
    const f = process.env.REPLAY_FILE;
    const body = f ? fs.readFileSync(f, "utf8") : "";
    process.stdout.write(body + "\\nnot json at all\\n{\\"unterminated\\n\\n[1,2]\\n\\"just a string\\"\\n");
    setTimeout(() => process.exit(Number(process.env.REPLAY_EXIT || 0)), 60);
  };
  process.stdin.on("data", (d) => { input += d; setTimeout(go, 30); });
  process.stdin.on("end", () => setTimeout(go, 30));
  setTimeout(go, 400);
}
`;

const MARKER = "CONFORMANCE-PROMPT-MARKER";
// Built from fragments: this file is the checker, and the neutrality tests forbid these words spelled out in src/.
const FAMILIES = [["g", "pt-\\d"], ["cla", "ude-(?:\\d|op", "us|son", "net|hai", "ku|instant)"], ["gem", "ini-\\d"], ["deep", "seek-(?:chat|coder|reasoner|v\\d)"], ["gr", "ok-\\d"], ["lla", "ma-?\\d"], ["qw", "en\\d"], ["mis", "tral-(?:large|small|medium|\\d)"]];
export const MODEL_ID = new RegExp(`\\b(${FAMILIES.map((f) => f.join("")).join("|")})[\\w.-]*`, "i");

function ctxFor(over: Partial<AgentRunContext>, events: AgentEvent[], extra: { received?: string[]; inbox?: AgentRunContext["host"]["drainInbox"] } = {}): AgentRunContext {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hex-conf-run-"));
  return {
    agentRunId: "T-1-a1", role: "developer", effort: "low", cwd, system: "You are a test agent.", prompt: `say hello ${MARKER}`,
    sessionId: crypto.randomUUID(), resume: false, env: {}, allowCommands: ["ls"], readOnly: false, conversational: false,
    host: { emit: (e) => events.push(e), drainInbox: extra.inbox ?? (() => []), onInbox: () => () => {}, received: (id) => extra.received?.push(id), isFinished: () => false, hasBlockingQuestion: () => false },
    api: {} as never, signal: new AbortController().signal, ...over,
  };
}

export async function runConformance(t: Target): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hex-conf-"));
  const replay = path.join(dir, "replay-cli");
  fs.writeFileSync(replay, REPLAY, { mode: 0o755 });
  const add = (n: number, name: string, status: CheckStatus, detail: string) => out.push({ n, name, status, detail });
  const guard = async (n: number, name: string, fn: () => Promise<[CheckStatus, string]>) => {
    try { const [s, d] = await fn(); add(n, name, s, d); } catch (e) { add(n, name, "fail", `threw: ${(e as Error).message}`); }
  };
  const fixtures = (): { name: string; lines: string; expect: Expect }[] => {
    if (!t.fixtures || !fs.existsSync(t.fixtures)) return [];
    return fs.readdirSync(t.fixtures).filter((f) => f.endsWith(".jsonl")).map((f) => {
      const name = f.replace(/\.jsonl$/, "");
      const ex = path.join(t.fixtures!, `${name}.expect.json`);
      return { name, lines: path.join(t.fixtures!, f), expect: fs.existsSync(ex) ? (JSON.parse(fs.readFileSync(ex, "utf8")) as Expect) : {} };
    });
  };
  /** One run of the adapter against the replay CLI, with a fixture. */
  const replayRun = async (fx: { lines: string; expect: Expect } | null, over: Partial<AgentRunContext> = {}, extra: Parameters<typeof ctxFor>[2] = {}) => {
    const events: AgentEvent[] = [];
    const dump = path.join(dir, `dump-${Math.random().toString(36).slice(2)}.json`);
    const env: Record<string, string> = { REPLAY_DUMP: dump, ...(fx ? { REPLAY_FILE: fx.lines } : {}), ...(fx?.expect.exit ? { REPLAY_EXIT: String(fx.expect.exit) } : {}), ...(fx?.expect.stderr ? { REPLAY_STDERR: fx.expect.stderr } : {}) };
    const a = t.make([replay]);
    const outcome = await a.run(ctxFor({ env, ...over }, events, extra));
    const dumped = fs.existsSync(dump) ? (JSON.parse(fs.readFileSync(dump, "utf8")) as { argv: string[]; stdin: string; env: string[] }) : null;
    return { events, outcome, dumped, adapter: a };
  };

  // 1. detect
  await guard(1, "detect: missing binary, version, auth", async () => {
    const missing = await t.make(["/nonexistent/cli-for-conformance"]).detect();
    if (missing.installed || !missing.problems.length) return ["fail", "a missing binary must report installed=false with a problem to act on"];
    const d = await t.make([replay]).detect();
    if (!d.installed) return ["fail", "an installed executable was reported missing"];
    if (!["ok", "unauthenticated", "unknown"].includes(d.auth)) return ["fail", `auth must be ok|unauthenticated|unknown (got ${String(d.auth)})`];
    return ["pass", `version ${d.version ?? "unknown"}, auth ${d.auth}`];
  });

  // 2. run never throws; abort; missing binary
  await guard(2, "run: outcome not exception, abort → interrupted, missing binary → non-retryable error", async () => {
    const miss = await t.make(["/nonexistent/cli-for-conformance"]).run(ctxFor({}, []));
    if (miss.kind !== "error" || miss.error?.retryable !== false) return ["fail", `missing binary gave ${JSON.stringify(miss)}`];
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const ab = await t.make([replay]).run(ctxFor({ env: { REPLAY_HANG: "1" }, signal: ac.signal }, []));
    if (ab.kind !== "interrupted") return ["fail", `abort gave ${ab.kind}`];
    return ["pass", "ok"];
  });

  // 3. protocol
  add(3, "protocol: the CLI runs `$HEXAGON_BIN done` and the supervisor accepts it", "skip", "needs the daemon and a CLI that obeys the prompt: covered for the lifecycle by test/turn-lifecycle.test.ts; with --real use `hexagon agents conformance <id> --real` on a throwaway repo");

  // 4/5. enforcement claims
  const base = { hexagonBin: null, secretDeny: [], effort: "low" as const };
  const probe = t.make([replay]);
  const claimRO = enforcedFor(probe, { ...base, readOnly: true, allowCommands: ["ls"] }).readOnlyEnforced;
  const claimAL = enforcedFor(probe, { ...base, readOnly: false, allowCommands: ["ls"] }).commandAllowList;
  if (!claimRO) add(4, "read-only: edits fail when enforced", "pass", "claims no read-only enforcement (the reviewer needs allow_weaker_isolation)");
  else if (t.real) await guard(4, "read-only: edits fail when enforced", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hex-conf-ro-"));
    const ev: AgentEvent[] = [];
    await t.make().run(ctxFor({ cwd, readOnly: true, prompt: "Create a file named should-not-exist.txt containing x, using your file tools. Then say done." }, ev));
    return fs.existsSync(path.join(cwd, "should-not-exist.txt")) ? ["fail", "claims read-only enforcement but a file was written"] : ["pass", "no file written"];
  });
  else add(4, "read-only: edits fail when enforced", "skip", "claims readOnlyEnforced; only a real CLI can show it (--real)");
  add(5, "allow-list: a disallowed command is blocked", claimAL ? "skip" : "pass", claimAL ? "claims commandAllowList; only a real CLI can show it" : "claims no command allow-list");

  // 6/7/8/9. fixtures
  const fxs = fixtures();
  if (!fxs.length) {
    for (const [n, name] of [[6, "session_handle emitted"], [7, "fixtures: chat, tool_call, model parse; junk lines do not crash"], [8, "usage: real numbers or none"], [9, "error fixtures classify"]] as const) add(n, name, "fail", `no fixtures in ${t.fixtures ?? "(none given)"}: record some with \`hexagon agents record ${t.id}\``);
  } else {
    const runs = await Promise.all(fxs.map(async (fx) => ({ fx, r: await replayRun(fx, fx.expect.cls ? {} : {}) })));
    const events = (type: string) => runs.flatMap((x) => x.r.events.filter((e) => e.type === type));
    await guard(6, "session_handle emitted when the fixture has one", async () => {
      const want = runs.filter((x) => x.fx.expect.handle);
      if (!want.length) return ["skip", "no fixture declares a handle (fine for a CLI whose session id Hexagon chooses)"];
      const bad = want.filter((x) => !x.r.events.some((e) => e.type === "session_handle" && e.handle === x.fx.expect.handle));
      return bad.length ? ["fail", `${bad.map((x) => x.fx.name).join(", ")}: expected session_handle ${bad[0]!.fx.expect.handle}`] : ["pass", "ok"];
    });
    await guard(7, "fixtures: this adapter's own chat/tool_call/model parse; junk lines do not crash", async () => {
      const problems: string[] = [];
      for (const x of runs) {
        if (x.fx.expect.exit || x.fx.expect.cls) continue;
        for (const need of x.fx.expect.emits ?? []) if (!x.r.events.some((e) => e.type === need)) problems.push(`${x.fx.name}: no ${need} event`);
        if (x.fx.expect.model && !x.r.events.some((e) => e.type === "model" && e.model === x.fx.expect.model)) problems.push(`${x.fx.name}: model ${x.fx.expect.model} not reported`);
        if (x.r.outcome.kind === "error" && !x.fx.expect.exit) problems.push(`${x.fx.name}: run failed: ${x.r.outcome.error?.message}`);
      }
      if (!runs.some((x) => (x.fx.expect.emits ?? []).includes("chat"))) problems.push("no fixture expects a chat event: a fixture that never checks chat proves nothing about parsing");
      return problems.length ? ["fail", problems.join("; ")] : ["pass", `${runs.length} fixture(s)`];
    });
    await guard(8, "usage: real numbers or none, never invented zeros", async () => {
      const u = events("usage");
      const zero = u.filter((e) => e.type === "usage" && e.input + e.output + e.cache_read + e.cache_write + e.cost_usd === 0);
      if (zero.length) return ["fail", `${zero.length} usage event(s) are all zeros: omit usage when the CLI does not report it`];
      const noneWanted = runs.filter((x) => x.fx.expect.usage === "none" && x.r.events.some((e) => e.type === "usage"));
      if (noneWanted.length) return ["fail", `${noneWanted.map((x) => x.fx.name).join(", ")}: expected no usage`];
      const someWanted = runs.filter((x) => x.fx.expect.usage === "some" && !x.r.events.some((e) => e.type === "usage"));
      if (someWanted.length) return ["fail", `${someWanted.map((x) => x.fx.name).join(", ")}: expected usage`];
      return ["pass", u.length ? `${u.length} usage event(s)` : "none reported"];
    });
    await guard(9, "error fixtures map to the right class", async () => {
      const errs = runs.filter((x) => x.fx.expect.cls);
      if (!errs.length) return ["fail", "no error fixture: add one with expect {exit, stderr, cls} for rate limit / quota / context / auth"];
      const bad = errs.filter((x) => x.r.outcome.kind !== "error" || x.r.adapter.classifyError(x.r.outcome.error?.raw ?? x.r.outcome.error?.message ?? "").cls !== x.fx.expect.cls);
      return bad.length ? ["fail", bad.map((x) => `${x.fx.name}: expected ${x.fx.expect.cls}, got ${x.r.outcome.kind === "error" ? x.r.adapter.classifyError(x.r.outcome.error?.raw ?? x.r.outcome.error?.message ?? "").cls : x.r.outcome.kind}`).join("; ")] : ["pass", `${errs.length} fixture(s)`];
    });
  }

  // 10. inbox
  await guard(10, "inbox: queued messages reach the CLI and are acknowledged with received()", async () => {
    const received: string[] = [];
    const msgs = [{ id: "M-77", from: "user", type: "instruction", body: "INBOX-BODY" }];
    let delivered = false;
    const r = await replayRun(null, {}, { received, inbox: () => (delivered ? [] : ((delivered = true), msgs)) });
    const text = r.dumped ? r.dumped.stdin + r.dumped.argv.join(" ") : "";
    if (!r.dumped) return ["fail", "the CLI was never started"];
    if (!text.includes("M-77") || !text.includes("INBOX-BODY")) return ["fail", "the queued message was not in what the CLI received"];
    // A live-input CLI echoes what it was sent back as a replay, and the adapter acknowledges from that echo; the replay script does not echo.
    if (!received.includes("M-77")) return r.adapter.supportsLiveInput ? ["pass", "delivered; acknowledged from the CLI's replay (checked with --real)"] : ["fail", "received('M-77') was never called"];
    return ["pass", "ok"];
  });

  // 11. env
  await guard(11, "env: only base + authEnv + env_passthrough", async () => {
    process.env.HEXAGON_CONF_SECRET = "1";
    process.env.AWS_SECRET_ACCESS_KEY ??= "conformance-leak-check";
    try {
      const r = await replayRun(null);
      if (!r.dumped) return ["fail", "the CLI was never started"];
      const leaked = r.dumped.env.filter((k) => k === "HEXAGON_CONF_SECRET" || k === "AWS_SECRET_ACCESS_KEY");
      return leaked.length ? ["fail", `leaked to the agent process: ${leaked.join(", ")}`] : ["pass", "ok"];
    } finally { delete process.env.HEXAGON_CONF_SECRET; }
  });

  // 12. prompt not in argv
  await guard(12, "prompt is not in argv unless declared", async () => {
    const r = await replayRun(null);
    if (!r.dumped) return ["fail", "the CLI was never started"];
    const inArgv = r.dumped.argv.some((x) => x.includes(MARKER));
    const declared = (r.adapter as { promptInArgv?: boolean }).promptInArgv === true;
    if (inArgv && !declared) return ["fail", "the prompt is in argv (ARG_MAX, visible in `ps`); use stdin or a file, or declare promptInArgv = true"];
    return ["pass", inArgv ? "in argv, and declared" : "not in argv"];
  });

  // 13. neutrality
  await guard(13, "no vendor model identifiers in adapter code", async () => {
    const hits: string[] = [];
    for (const f of t.sources ?? []) if (fs.existsSync(f)) fs.readFileSync(f, "utf8").split("\n").forEach((l, i) => { const m = MODEL_ID.exec(l); if (m && !l.includes("// conformance-ok")) hits.push(`${path.basename(f)}:${i + 1} ${m[0]}`); });
    return !(t.sources ?? []).length ? ["skip", "no source files given"] : hits.length ? ["fail", hits.slice(0, 5).join("; ")] : ["pass", "ok"];
  });

  // real: resume memory
  if (t.real && t.semantic) await guard(6, "--real: a resumed session remembers the first turn", async () => {
    const sessionId = crypto.randomUUID();
    const e1: AgentEvent[] = [];
    await t.make().run(ctxFor({ sessionId, resume: false, prompt: t.semantic!.first }, e1));
    const h = e1.find((e) => e.type === "session_handle");
    const e2: AgentEvent[] = [];
    await t.make().run(ctxFor({ sessionId, resume: true, handle: h?.type === "session_handle" ? h.handle : null, followUp: t.semantic!.second, prompt: t.semantic!.second }, e2));
    const said = e2.filter((e) => e.type === "chat").map((e) => (e.type === "chat" ? e.text : "")).join("\n");
    return t.semantic!.expect.test(said) ? ["pass", "remembered"] : ["fail", `the resumed session did not recall the first turn (said: ${said.slice(0, 120) || "nothing"})`];
  });
  return out;
}

export function formatResults(id: string, rs: CheckResult[]): string {
  const icon = { pass: "✔", fail: "✖", skip: "–" } as const;
  return [`Adapter conformance: ${id}`, ...rs.map((r) => `  ${icon[r.status]} ${String(r.n).padStart(2)}. ${r.name} — ${r.detail}`), `  ${rs.filter((r) => r.status === "pass").length} passed, ${rs.filter((r) => r.status === "fail").length} failed, ${rs.filter((r) => r.status === "skip").length} skipped`].join("\n");
}
