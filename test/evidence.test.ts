import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import type { AgentStatus, Plan } from "../src/contracts/types.js";
import { confirmByMutation, evaluateEvidence, missingEvidence, parseEvidenceFlag } from "../src/core/evidence.js";
import { checkPlan, isTrivialVerify } from "../src/core/plan.js";
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
    fs.writeFileSync(path.join(wt, "test/a.test.ts"), 'it("adds two numbers", () => { expect(add(1, 2)).toBe(3); });\n// it("only in a comment", () => { expect(1).toBe(1); });\nit("asserts nothing", () => {});');
    const out = " ✓ test/a.test.ts (1 test)";
    const r = evaluateEvidence(wt, [
      ev("AC-1", "test:test/a.test.ts::adds two numbers"),
      ev("AC-2", "test:test/missing.test.ts::x"),
      ev("AC-3", "test:test/a.test.ts::no such name"),
      ev("AC-4", "I tested it by hand"),
      ev("AC-5", "test:../../etc/passwd::root"),
      ev("AC-6", "test:test/a.test.ts::only in a comment"),
      ev("AC-7", "test:test/a.test.ts::asserts nothing"),
    ], out);
    // The string check only nominates candidates ("weak:"); confirmByMutation decides.
    expect(r.map((x) => x.verified)).toEqual([true, false, false, false, false, false, false]);
    expect(r[0]!.basis).toMatch(/^weak:/);
    expect(r[5]!.basis).toMatch(/only in comments/);
    expect(r[6]!.basis).toMatch(/no assertion/);
    expect(r[1]!.basis).toMatch(/not in the worktree/);
    expect(r[2]!.basis).toMatch(/does not occur/);
    expect(r[3]!.basis).toMatch(/not a test reference/);
    // exists but nothing shows it ran
    expect(evaluateEvidence(wt, [ev("AC-1", "test:test/a.test.ts::adds two numbers")], "ok")[0]).toMatchObject({ verified: false, basis: expect.stringMatching(/does not show it ran/) });
  });

  it("a candidate is verified only if the test fails once the product change is reverted", async () => {
    const cand = [{ ac: "AC-1", evidence: "test:test/a.test.ts::adds two numbers", verified: true, basis: "weak: …" }];
    const host = (exit: number, product = ["src/add.ts"]) => ({
      productFiles: product, how: "t", runTest: async () => exit, withoutChange: async (run: () => Promise<number>) => run(),
    });
    const independent = await confirmByMutation(cand, host(0));
    expect(independent[0]).toMatchObject({ verified: false, basis: expect.stringMatching(/does not depend on the change/) });
    const dependent = await confirmByMutation(cand, host(1));
    expect(dependent[0]).toMatchObject({ verified: true, basis: expect.stringMatching(/fails \(exit 1\)/) });
    expect((await confirmByMutation(cand, host(1, [])))[0]).toMatchObject({ verified: false, basis: expect.stringMatching(/changes no product file/) });
    // Claims that were never candidates are left alone.
    const claimed = [{ ac: "AC-2", evidence: "by hand", verified: false, basis: "claimed" }];
    expect(await confirmByMutation(claimed, host(0))).toEqual(claimed);
  });

  it("a verify command that passes whatever the code does is refused by the plan check", () => {
    for (const c of ["true", "echo ok", "ls", "exit 0", "true && echo done", ": ", "cat README.md"]) expect(isTrivialVerify(c), c).toBe(true);
    for (const c of ["npm test", "go test -v ./...", "pytest -v tests/a.py", "test -s README.md", "node --test && echo done"]) expect(isTrivialVerify(c), c).toBe(false);
    const plan = { schema: "hexagon.plan/v1", id: "p", created_at: "2026-01-01T00:00:00Z", specs: [], spec_issues: [], tasks: [{ id: "T-1", title: "x", role: "developer", requirements: [], acceptance: [], depends_on: [], files: { write: ["a"], read: [] }, skills: [], definition_of_done: ["d"], verify: ["echo ok"] }] };
    expect(checkPlan(plan).errors.join()).toMatch(/proves nothing/);
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

describe("mutation check against a real worktree", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  /** A test that exists in the base commit and a task that adds product code; `testCommand` decides what "the test" runs. */
  async function run(testCommand: string) {
    const { MockAdapter } = await import("../src/agents/mock.js");
    MockAdapter.turns.length = 0;
    const root = fs.mkdtempSync(path.join("/tmp", "hmu-"));
    git(root, "init", "-q", "-b", "main");
    fs.mkdirSync(path.join(root, "test"));
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    fs.writeFileSync(path.join(root, "test/impl.test.txt"), 'it("impl check", () => { expect(read("src/impl.txt")).toContain("mock"); });\n');
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 30").replace('test_command = ""', `test_command = ${JSON.stringify(testCommand)}`));
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
    const p: Plan = { schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [],
      tasks: [{ id: "T-1", title: "Impl", role: "developer", requirements: [], acceptance: ["AC-1"], depends_on: [], files: { write: ["src/impl.txt"], read: [] }, skills: [], definition_of_done: ["done"],
        verify: ['grep -l "impl check" test/impl.test.txt'], description: "@evidence: test/impl.test.txt::impl check" }] };
    const plan = path.join(root, "plan.json"); fs.writeFileSync(plan, JSON.stringify(p));
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.call("run.start", { plan_path: plan });
    let st: AgentStatus | undefined;
    for (let i = 0; i < 300 && !(st && (st.state === "failed" || st.state === "done")); i++) { await sleep(100); st = await c.call<AgentStatus>("agent.status", { task: "T-1" }); }
    const review = MockAdapter.turns.find((x) => /<diffstat/.test(x.text));
    return { st, evidence: /<evidence[\s\S]*?<\/evidence>/.exec(review?.text ?? "")?.[0] ?? "", root };
  }

  it("a test that needs the product change is verified (it fails with the change reverted)", async () => {
    const r = await run("test -f src/impl.txt");
    expect(r.st?.state).toBe("done");
    expect(r.evidence).toMatch(/\[verified\] verified by mutation: the test fails/);
  }, 90000);

  it("a test that still passes with the change reverted is not verified, and the worktree is left as it was", async () => {
    const r = await run("test -f README.md");
    expect(r.st?.state).toBe("done");
    expect(r.evidence).toMatch(/\[claimed\] claimed: test does not depend on the change/);
    // The mutation only touched the worktree temporarily: the task's product file still reached the integration branch.
    const integ = git(r.root, "branch", "--list", "hexagon/*/integration", "--format=%(refname:short)").split("\n")[0]!;
    expect(git(r.root, "ls-tree", "-r", "--name-only", integ)).toContain("src/impl.txt");
  }, 90000);
});
