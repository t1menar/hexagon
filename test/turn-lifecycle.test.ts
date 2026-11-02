import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { registerAdapter } from "../src/agents/registry.js";
import { capabilities } from "../src/agents/contracts/capabilities.js";
import { NO_SECURITY } from "../src/agents/contracts/capabilities.js";
import { CLI_DEFAULT } from "../src/agents/contracts/model-selection.js";
import type { AdapterOutcome, AgentAdapter, AgentRunContext } from "../src/agents/types.js";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan, Task } from "../src/contracts/types.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 40000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(50); }
}

/** A one-shot CLI stand-in that resumes, has no live input, and reports only when it is asked to. */
const prompts: { resume: boolean; text: string }[] = [];
let silentRuns = 0;
class Silent implements AgentAdapter {
  readonly adapterId = "silent-test"; readonly provider = "test"; readonly displayName = "Silent";
  readonly capabilities = capabilities({ supportsSessionResume: true, supportsLiveInput: false });
  readonly security = NO_SECURITY; readonly selection = CLI_DEFAULT; readonly model = null; readonly supportsLiveInput = false;
  constructor(readonly id: string, private always: boolean) {}
  async detect() { return { installed: true, executable: "x", version: "1", auth: "ok" as const, problems: [] }; }
  async discoverModels() { return { supported: false }; }
  classifyError() { return { cls: "unknown" as const, message: "", estimated: true }; }
  takeoverCommand() { return null; }
  async run(ctx: AgentRunContext): Promise<AdapterOutcome> {
    silentRuns++;
    prompts.push({ resume: ctx.resume, text: ctx.followUp ?? ctx.prompt });
    ctx.host.emit({ type: "session_handle", handle: "h-1" });
    if (ctx.resume && /without reporting a result/.test(ctx.followUp ?? "") && !this.always) ctx.api.done({ status: "completed", summary: "done after the nudge" });
    return { kind: "finished" };
  }
}
registerAdapter("silent-test", (id, c) => new Silent(id, c.args?.includes("never") ?? false));

describe("the core owns the done-nudge for CLIs that exit without reporting", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  async function run(args: string) {
    prompts.length = 0; silentRuns = 0;
    const root = fs.mkdtempSync(path.join("/tmp", "hg-"));
    git(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "silent"').replace(/^\[review\][\s\S]*?(?=^\[|$(?![\s\S]))/m, "") + `\n[review]\nmode = "off"\n\n[agents.silent]\nadapter = "silent-test"\nargs = [${args}]\n`);
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
    const task: Task = { id: "T-1", title: "x", role: "developer", requirements: [], acceptance: [], depends_on: [], files: { write: ["src/a.txt"], read: [] }, skills: [], definition_of_done: ["d"], verify: [], verify_exempt: "test", description: "" };
    const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [], tasks: [task] };
    fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(p));
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.call("run.start", { plan_path: "plan.json" });
    return until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return ["done", "failed", "blocked"].includes(x.state) ? x : null; });
  }

  it("asks the same session to report, and the task completes", async () => {
    const st = await run("");
    expect(st.state).toBe("done");
    expect(silentRuns).toBe(2);
    expect(prompts[1]!.resume).toBe(true);
    expect(prompts[1]!.text).toMatch(/without reporting a result.*hexagon done/s);
  }, 60000);

  it("gives up after two nudges and fails with the usual reason", async () => {
    const st = await run('"never"');
    expect(st.state).toBe("failed");
    expect(silentRuns % 3).toBe(0); // per attempt: the run itself + two nudges (the failure is retryable, so it may run again)
    expect(silentRuns).toBeGreaterThanOrEqual(3);
  }, 60000);
});
