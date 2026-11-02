import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus } from "../src/contracts/types.js";
import { parseMode, recommendMode } from "../src/core/pipeline.js";
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

describe("single-task mode runs end to end", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  it("one task with the whole repository as scope, and the usual checks run on it", async () => {
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
    const reviewed = new Promise((resolve) => c.on("push", (p) => { if (p.event === "spec_review" && p.data) resolve(p.data); }));
    const drafted = new Promise<Draft>((resolve) => c.on("push", (p) => { if (p.event === "draft" && p.data) resolve(p.data); }));
    await c.call("goal.new", { goal: "Greeting and farewell @single-task" });
    await reviewed;
    await c.call("spec.approve", {});
    const draft = await drafted;
    expect(draft.plan.tasks).toHaveLength(1);
    expect(draft.plan.tasks[0]!.files.write).toEqual(["**"]);
    expect(draft.plan.tasks[0]!.requirements.length).toBe(2);
    expect(draft.check.errors).toEqual([]);
    await c.call("draft.approve", {});
    const st = await until(async () => { const x = await c.call<AgentStatus>("agent.status", { task: "T-1" }); return x.state === "done" || x.state === "failed" ? x : null; });
    expect(st.state).toBe("done");
  }, 120000);

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
