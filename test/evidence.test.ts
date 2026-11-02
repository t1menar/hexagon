import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan } from "../src/contracts/types.js";
import { evaluateEvidence, missingEvidence, parseEvidenceFlag } from "../src/core/evidence.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";

const ev = (ac: string, evidence: string) => ({ ac, evidence, verified: true }); // an agent that lies about "verified"

describe("evidence", () => {
  it("parses plain and qualified criteria", () => {
    expect(parseEvidenceFlag("AC-1: test:a.test.ts::adds")).toEqual({ ac: "AC-1", evidence: "test:a.test.ts::adds" });
    expect(parseEvidenceFlag("REQ-A-001/ac-2 = looked at it")).toEqual({ ac: "REQ-A-001/AC-2", evidence: "looked at it" });
  });

  it("every criterion needs evidence (bare and qualified ids match)", () => {
    expect(missingEvidence(["REQ-A-001/AC-1", "REQ-A-001/AC-2"], [{ ac: "AC-1", evidence: "x" }])).toEqual(["REQ-A-001/AC-2"]);
    expect(missingEvidence(["AC-1"], [{ ac: "AC-1", evidence: "  " }])).toEqual(["AC-1"]);
  });

  it("only a test that exists and ran is verified; the agent's own flag is ignored", () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "hx-ev-"));
    fs.mkdirSync(path.join(wt, "test"));
    fs.writeFileSync(path.join(wt, "test/a.test.ts"), 'it("adds two numbers", () => {})');
    const out = " ✓ test/a.test.ts (1 test)";
    const r = evaluateEvidence(wt, [
      ev("AC-1", "test:test/a.test.ts::adds two numbers"),
      ev("AC-2", "test:test/missing.test.ts::x"),
      ev("AC-3", "test:test/a.test.ts::no such name"),
      ev("AC-4", "I tested it by hand"),
      ev("AC-5", "test:../../etc/passwd::root"),
    ], out);
    expect(r.map((x) => x.verified)).toEqual([true, false, false, false, false]);
    expect(r[1]!.basis).toMatch(/not in the worktree/);
    expect(r[2]!.basis).toMatch(/does not occur/);
    expect(r[3]!.basis).toMatch(/not a test reference/);
    // exists but nothing shows it ran
    expect(evaluateEvidence(wt, [ev("AC-1", "test:test/a.test.ts::adds two numbers")], "ok")[0]).toMatchObject({ verified: false, basis: expect.stringMatching(/does not show it ran/) });
  });
});

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
describe("done without evidence", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  it("is rejected, so the task cannot pass on the agent's word", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "hev-"));
    git(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 30"));
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
    const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [],
      tasks: [{ id: "T-1", title: "Write", role: "developer", requirements: [], acceptance: ["AC-1"], depends_on: [], files: { write: ["src/a.txt"], read: [] }, skills: [], definition_of_done: ["done"], verify: [], verify_exempt: "fixture", description: "@no-evidence" }] };
    const plan = path.join(root, "plan.json"); fs.writeFileSync(plan, JSON.stringify(p));
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.call("run.start", { plan_path: plan });
    let st: AgentStatus | undefined;
    for (let i = 0; i < 200 && !(st && (st.state === "failed" || st.state === "done")); i++) { await sleep(100); st = await c.call<AgentStatus>("agent.status", { task: "T-1" }); }
    expect(st?.state).toBe("failed");
    const events = await c.call<{ event: { type: string; message?: string } }[]>("agent.events", { task: "T-1", limit: 500 });
    expect(JSON.stringify(events)).toMatch(/No evidence for AC-1/);
  }, 60000);
});
