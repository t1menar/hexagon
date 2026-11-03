import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { MockAdapter } from "../src/agents/mock.js";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan, StampedEvent, Task } from "../src/contracts/types.js";
import { appendEntry, briefTemplate, checkBrief, explainBrief, hasProgress, loadCompact, loadFailure, needsReview, recoveryBlock, saveCompact, saveFailure } from "../src/core/brief.js";
import { loadConfig } from "../src/core/config.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 40000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(50); }
}

const task = { id: "T-1", title: "greet", acceptance: ["REQ-A/AC-1", "REQ-A/AC-2"] };
const good = [
  "# Brief T-1: greet", "## Goal", "Say hello.", "## Files to change", "- src/greet.ts:12 — add greet()", "- test/greet.test.ts (new)",
  "## Approach", "1. add it", "## Decisions and assumptions", "- plain string", "## Risks", "- none",
  "## Verification", "- REQ-A/AC-1: npx vitest run test/greet.test.ts", "- REQ-A/AC-2: npx tsc --noEmit", "## Progress", "## Found", "",
].join("\n");

describe("brief: validation is actionable", () => {
  it("accepts a complete brief and the template shape", () => {
    expect(checkBrief(good, task)).toEqual([]);
    expect(checkBrief(briefTemplate(task), task).join()).toMatch(/empty|no file:line/); // the placeholder text does not count
  });
  it("names each missing part", () => {
    expect(checkBrief("# x\n## Goal\nhi\n", task)).toEqual(expect.arrayContaining(['no "Files to change" section', 'no "Approach" section', 'no "Verification" section']));
    expect(checkBrief(good.replace("src/greet.ts:12", "src/greet.ts").replace(" (new)", ""), task).join()).toMatch(/no file:line anchor/);
    expect(checkBrief(good.replace("- REQ-A/AC-2: npx tsc --noEmit\n", ""), task)).toEqual(['"Verification" does not map REQ-A/AC-2 to a command or test']);
    expect(checkBrief(good.replace("Say hello.", "a\nb\nc\nd\ne\nf"), task).join()).toMatch(/keep it to 1-2/);
    const msg = explainBrief(["no \"Risks\" section"], task);
    expect(msg).toContain("hexagon brief write");
    expect(msg).toContain("## Verification"); // the skeleton is in the message
  });
  it("a bare AC-n counts only when it is unambiguous", () => {
    const t = { id: "T-1", title: "x", acceptance: ["REQ-A/AC-1", "REQ-B/AC-1"] };
    expect(checkBrief(good.replace(/- REQ-A\/AC-1.*\n- REQ-A\/AC-2.*\n/, "- AC-1: x\n"), t).join()).toMatch(/REQ-A\/AC-1, REQ-B\/AC-1/);
    expect(checkBrief(good.replace(/- REQ-A\/AC-1.*\n- REQ-A\/AC-2.*\n/, "- AC-1: x\n- AC-2: y\n"), { ...task, acceptance: ["AC-1", "AC-2"] })).toEqual([]);
  });
});

describe("brief: living log, review rule, recovery block", () => {
  it("appends dated lines to Progress and Found and must have progress before done", () => {
    expect(hasProgress(good)).toBe(false);
    const a = appendEntry(good, "progress", "wrote greet()", "10:15");
    const b = appendEntry(a, "found", "tsc is strict here", "10:20");
    const c = appendEntry(b, "progress", "tests pass", "10:30");
    expect(hasProgress(c)).toBe(true);
    expect(c).toMatch(/## Progress\n- 10:15 wrote greet\(\)\n- 10:30 tests pass\n## Found\n- 10:20 tsc is strict here/);
    expect(appendEntry("# b\n", "found", "x", "1:00")).toContain("## Found\n- 1:00 x");
  });
  it("brief_review: off never, user always, auto for risky tasks and interfaces", () => {
    const t = (risk: string, write: string[]) => ({ estimate: { risk }, files: { write, read: [] } });
    expect(needsReview("off", t("high", ["api/**"]))).toBe(false);
    expect(needsReview("user", t("low", ["src/a.ts"]))).toBe(true);
    expect(needsReview("auto", t("low", ["src/a.ts"]))).toBe(false);
    expect(needsReview("auto", t("high", ["src/a.ts"]))).toBe(true);
    expect(needsReview("auto", t("low", ["src/api/users.ts"]))).toBe(true);
    expect(needsReview("auto", t("low", ["schemas/**"]))).toBe(true);
  });
  it("the recovery block carries brief, summary, diffstat and last failure, and says to read the brief first", () => {
    expect(recoveryBlock({ taskId: "T-1", brief: "", summary: "", diffstat: "", failure: "" })).toBe("");
    const r = recoveryBlock({ taskId: "T-1", brief: good, summary: "I decided X", diffstat: " a.ts | 2 +-", failure: "verify failed: exit 1" });
    for (const w of ["Read your brief first", "<brief", "## Approach", "I decided X", "a.ts | 2", "verify failed: exit 1"]) expect(r).toContain(w);
  });
  it("compaction summary and last failure persist on disk for a new Supervisor", () => {
    const dir = fs.mkdtempSync(path.join("/tmp", "hbr-"));
    expect(loadCompact(dir, "T-1")).toBe("");
    saveCompact(dir, "T-1", "kept the layout");
    saveFailure(dir, "T-1", "tests fail");
    expect(loadCompact(dir, "T-1")).toBe("kept the layout");
    expect(loadFailure(dir, "T-1")).toBe("tests fail");
    expect(loadCompact(dir, "T-2")).toBe("");
  });
  it("config: task_brief and brief_review are validated", () => {
    const f = path.join(fs.mkdtempSync(path.join("/tmp", "hbc-")), "config.toml");
    fs.writeFileSync(f, "");
    expect(loadConfig(f).run).toMatchObject({ task_brief: "required", brief_review: "off" });
    fs.writeFileSync(f, '[run]\ntask_brief = "always"\n');
    expect(() => loadConfig(f)).toThrow(/task_brief must be/);
  });
});

describe("brief: the daemon enforces it (mock agent)", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  async function run(description: string, off = false, review = "") {
    MockAdapter.turns.length = 0;
    const root = fs.mkdtempSync(path.join("/tmp", "hbd-"));
    git(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 20").replace('task_brief = "required"', off ? 'task_brief = "off"' : 'task_brief = "required"').replace('brief_review = "off"', `brief_review = "${review || "off"}"`));
    fs.writeFileSync(path.join(root, "HEXAGON.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
    const t: Task = { id: "T-1", title: "write a", role: "developer", requirements: [], acceptance: ["AC-1"], depends_on: [], files: { write: ["src/a.txt"], read: [] }, skills: [], definition_of_done: ["d"], verify: ["test -f src/a.txt"], description };
    const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [], tasks: [t] };
    fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(p));
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.call("run.start", { plan_path: "plan.json" });
    const st = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return ["done", "failed", "blocked"].includes(x.state) ? x : null; });
    return { root, s, c, st };
  }
  const briefs = (root: string) => fs.readdirSync(path.join(root, ".hexagon/runs")).flatMap((r) => { const f = path.join(root, ".hexagon/runs", r, "tasks/T-1/brief.md"); return fs.existsSync(f) ? [fs.readFileSync(f, "utf8")] : []; });

  it("a task with a brief completes, the brief is a living log, and the reviewer saw it", async () => {
    const { root, st } = await run("");
    expect(st.state).toBe("done");
    const [b] = briefs(root);
    expect(b).toContain("## Goal");
    expect(b).toMatch(/## Progress\n- \d\d:\d\d wrote src\/a\.txt/);
    expect(MockAdapter.turns.some((t) => /\.review$/.test(t.agent) && t.text.includes("<brief"))).toBe(true);
  }, 90000);

  it("done is refused without a valid brief: the task does not complete", async () => {
    const { root, st } = await run("@no-brief");
    expect(st.state).toBe("failed");
    expect(briefs(root)).toEqual([]);
  }, 90000);

  it("the same task completes with [run].task_brief = off", async () => {
    const { st } = await run("@no-brief", true);
    expect(st.state).toBe("done");
  }, 90000);

  it("editing a product file before a valid brief is warned about once, then reverted", async () => {
    const { st } = await run("@edit-before-brief");
    const texts = MockAdapter.turns.filter((t) => t.agent === "T-1-a1").map((t) => t.text);
    expect(texts.some((t) => /edited BEFORE your brief was valid: src\/a\.txt/.test(t))).toBe(true); // the warning names the file
    expect(texts.some((t) => /Hexagon reverted these paths/.test(t) && t.includes("src/a.txt"))).toBe(true); // a repeat is reverted
    expect(st.state).toBe("failed"); // nothing is left to verify: the work has to follow the brief
  }, 90000);

  it("brief_review = user: the brief waits for the user's approval before the work goes on", async () => {
    MockAdapter.turns.length = 0;
    const p = run("", false, "user");
    // answer the approval question as soon as it appears
    const answered = (async () => {
      const end = Date.now() + 40000;
      while (Date.now() < end) {
        const o = open.at(-1);
        if (o) {
          const inbox = await o.c.call<{ questions: { question_id: string; prompt: string }[] }>("inbox.list");
          const q = inbox.questions.find((x) => /Approve the brief/.test(x.prompt));
          if (q) { await o.c.call("question.answer", { question_id: q.question_id, answer: "1" }); return q.prompt; }
        }
        await sleep(50);
      }
      return null;
    })();
    const { st } = await p;
    expect(await answered).toMatch(/Approve the brief for T-1/);
    expect(st.state).toBe("done");
  }, 90000);

  it("a retry gets the brief and the last failure in its first prompt, not a blank start", async () => {
    const { c } = await run("@fail-once");
    await until(async () => MockAdapter.turns.some((t) => t.agent === "T-1-a2"));
    const first = MockAdapter.turns.find((t) => t.agent === "T-1-a2")!;
    expect(first.text).toContain("<resume");
    expect(first.text).toContain("Read your brief first");
    expect(first.text).toContain("## Approach"); // the brief itself
    await c.call("agent.status", { task: "T-1" });
  }, 90000);
});
