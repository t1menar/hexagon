import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus } from "../src/contracts/types.js";
import { checkStage, parseMode, parseSpikes, recommendMode, spikeTriggers } from "../src/core/pipeline.js";
import os from "node:os";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";
import type { Draft } from "../src/daemon/orchestrator.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 60000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(50); }
}

const analysis = (mode: string, impacted: string, current = "(unknown)") => `## Current state\n${current}\n\n## Constraints\nnone\n\n## Risks\nnone\n\n## Open questions\nnone\n\n## Mode\n${mode}\n\n## Impacted areas\n${impacted}\n`;

describe("mode: how much machinery a request gets", () => {
  it("reads the analyst's choice, and falls back to a heuristic that prefers one checked task", () => {
    expect(parseMode(analysis("single-task: the slices share files", "src/a.ts"))).toEqual({ mode: "single-task", reason: "the slices share files" });
    expect(parseMode(analysis("DAG - three independent modules", "x"))?.mode).toBe("dag");
    expect(parseMode("## Current state\nx")).toBeNull();
    // unclear scope → single-task (the safe default), not a graph
    expect(recommendMode(analysis("", "not sure yet")).mode).toBe("single-task");
    // one file with a known cause → solo
    expect(recommendMode(analysis("", "src/core/a.ts", "The root cause is an off-by-one in a.ts.")).mode).toBe("solo");
    // several modules, but nothing says they are independent → still one task
    expect(recommendMode(analysis("", "src/api/a.ts, src/web/b.ts, src/db/c.ts")).mode).toBe("single-task");
    // several modules and independent slices → graph
    expect(recommendMode(analysis("", "src/api/a.ts (independent of the rest), src/web/b.ts, src/db/c.ts; these run in parallel")).mode).toBe("dag");
  });
});

describe("uncertain analysis must plan a spike before a spec", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "hx-spike-"));
  const write = (d: string, text: string) => fs.writeFileSync(path.join(d, "analysis.md"), text);
  const unsure = analysis("single-task: one agent", "src/a.ts", "Requests fail intermittently; the root cause is unknown.");

  it("names why: unknown cause, cross-cutting change, unclear boundaries", () => {
    expect(spikeTriggers(unsure)).toEqual(["the cause is unknown"]);
    expect(spikeTriggers(analysis("dag: x", "src/a.ts", "Cause: off-by-one in a.ts:12.")).length).toBe(0);
    expect(spikeTriggers(analysis("dag: x", "a public API and a schema change in db/")).join()).toMatch(/cross-cutting/);
    expect(spikeTriggers(analysis("dag: x", "src/", "The module boundary between api and core is unclear.")).join()).toMatch(/boundaries are unclear/);
  });

  it("is refused without a Spike section, accepted with one, and the flag can turn it off", () => {
    const d = dir();
    write(d, unsure);
    expect(checkStage("analyze", d).errors.join()).toMatch(/no "Spike" section/);
    expect(checkStage("analyze", d, undefined, { requireSpike: false }).errors).toEqual([]);
    write(d, unsure.replace("## Mode", "## Spike\n- S-1: find where the request is dropped\n\n## Mode"));
    expect(parseSpikes(fs.readFileSync(path.join(d, "analysis.md"), "utf8"))).toEqual([{ id: "S-1", question: "find where the request is dropped" }]);
    expect(checkStage("analyze", d).errors).toEqual([]);
    // Certain analysis needs no spike.
    write(d, analysis("single-task: one agent", "src/a.ts", "Cause: off-by-one in a.ts:12."));
    expect(checkStage("analyze", d).errors).toEqual([]);
  });

  it("spike.md must answer every spike with evidence and end in a decision", () => {
    const d = dir();
    write(d, unsure.replace("## Mode", "## Spike\n- S-1: where is it dropped\n- S-2: who retries\n\n## Mode"));
    fs.writeFileSync(path.join(d, "spike.md"), "## Findings\nS-1: dropped at src/net.ts:40\n\n## Decision\nFix the queue.\n");
    expect(checkStage("spike", d).errors).toEqual(["spike.md does not answer S-2: who retries"]);
    fs.writeFileSync(path.join(d, "spike.md"), "## Findings\nS-1: dropped\nS-2: nobody\n\n## Decision\nFix the queue.\n");
    expect(checkStage("spike", d).errors.join()).toMatch(/cites no evidence/);
  });
});

describe("single-task mode runs end to end", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  it("one task with the whole repository as scope, and the usual checks run on it", async () => {
    const { MockAdapter } = await import("../src/agents/mock.js");
    MockAdapter.turns.length = 0;
    const root = fs.mkdtempSync(path.join("/tmp", "hst-"));
    git(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 30"));
    fs.writeFileSync(path.join(root, "HEXAGON.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.subscribe();
    const reviewed = new Promise<{ spec_path: string; card?: { changes: string[]; verify: string[]; files: string[] } }>((resolve) => c.on("push", (p) => { if (p.event === "spec_review" && p.data) resolve(p.data); }));
    const drafted = new Promise<Draft>((resolve) => c.on("push", (p) => { if (p.event === "draft" && p.data) resolve(p.data); }));
    await c.call("goal.new", { goal: "Greeting and farewell @single-task" });
    const review = await reviewed;
    // The gate shows a short card, derived from the spec, and nothing is approved until the human says so.
    expect(review.card!.changes.length).toBeGreaterThan(0);
    expect(review.card!.changes.length).toBeLessThanOrEqual(5);
    expect(review.card!.verify.some((v) => /AC-1/.test(v))).toBe(true);
    expect(review.card!.files.some((f) => /\.spec\.md$/.test(f))).toBe(true);
    expect(s.orch.approvals.get(review.spec_path)).toBeUndefined();
    await c.call("spec.approve", {});
    expect(s.orch.approvals.get(review.spec_path)).toBeTruthy();
    const draft = await drafted;
    expect((draft as unknown as { card: { changes: string[]; verify: string[] } }).card.verify).toContain("test -f hexagon-mock/t-1.md");
    expect(draft.plan.tasks).toHaveLength(1);
    expect(draft.plan.tasks[0]!.files.write).toEqual(["**"]);
    expect(draft.plan.tasks[0]!.requirements.length).toBe(2);
    expect(draft.check.errors).toEqual([]);
    await c.call("draft.approve", {});
    const st = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "done" || x.state === "failed" ? x : null; });
    expect(st.state).toBe("done");
    // Single-task keeps the whole pipeline: a reviewer turn ran on the task, it was not skipped for being alone.
    expect(MockAdapter.turns.some((t) => /^T-1-a\d+\.review$/.test(t.agent))).toBe(true);
  }, 120000);

  it("an uncertain goal runs a spike before the spec, and the spec step is told to use its decision", async () => {
    const { MockAdapter } = await import("../src/agents/mock.js");
    MockAdapter.turns.length = 0;
    const root = fs.mkdtempSync(path.join("/tmp", "hst-"));
    git(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 30"));
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.subscribe();
    const reviewed = new Promise<{ out_dir: string }>((resolve) => c.on("push", (p) => { if (p.event === "spec_review" && p.data) resolve(p.data); }));
    await c.call("goal.new", { goal: "Find why requests drop @spike" });
    const review = await reviewed;
    expect(fs.existsSync(path.join(review.out_dir, "spike.md"))).toBe(true);
    expect(MockAdapter.turns.some((t) => /<stage>specify<\/stage>[\s\S]*spike\.md are accepted/.test(t.text))).toBe(true);
  }, 60000);

  it("an unknown --mode is refused", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "hst-"));
    git(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await expect(c.call("goal.new", { goal: "x", mode: "wizard" })).rejects.toThrow(/unknown mode/);
  });
});
