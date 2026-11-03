import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import { checkStage } from "../src/core/pipeline.js";
import { deliveryFromAnswers, dropAnswered, loadQuestions, needsQuestions, parseApproaches, parseConfidence, resolveAnswer, type Question } from "../src/core/clarify.js";
import { loadConfig, setSection } from "../src/core/config.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";
import type { ClarifyState } from "../src/daemon/orchestrator.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(50); }
}

const analysis = (o: { conf?: string; open?: string; approaches?: string[]; delivery?: string } = {}) =>
  `## Current state\nx\n\n## Constraints\nnone\n\n## Risks\nnone\n\n## Open questions\n${o.open ?? "none"}\n\n## Confidence\n${o.conf ?? "high: read it all"}\n\n${o.approaches ? `## Approaches\n${o.approaches.map((a, i) => `- A-${i + 1}: ${a}`).join("\n")}\n\n` : ""}${o.delivery ? `## Delivery\n${o.delivery}\n\n` : ""}## Mode\nsingle-task: x\n\n## Impacted areas\nsrc/a.ts\n`;
const unknown = { ask: "normal" as const, delivery: { remote: "", push: null, pr: null } };
const known = { ask: "normal" as const, delivery: { remote: "origin", push: false, pr: false } };
const Q = (over: Partial<Question>): Question => ({ id: "Q-1", question: "q?", why_it_matters: "w", options: [], default: "d", blocking: true, ...over });

describe("clarify: when the analysis may say 'no questions'", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "hx-cl-"));
  const check = (text: string, ctx = unknown, d = dir()) => { fs.writeFileSync(path.join(d, "analysis.md"), text); return checkStage("analyze", d, undefined, { clarify: ctx }).errors; };

  it("'none' passes only with confidence high AND a known delivery target", () => {
    expect(check(analysis({ delivery: "local branch, no push" }))).toEqual([]);
    expect(check(analysis(), known)).toEqual([]);
    expect(check(analysis()).join()).toMatch(/delivery target is known/); // high confidence, delivery unknown
    expect(check(analysis({ conf: "medium: some gaps" }), known).join()).toMatch(/only allowed with Confidence: high/);
  });

  it("low confidence requires questions.json, and a missing Confidence section is an error", () => {
    const e = check(analysis({ conf: "low: no idea", open: "- what is the scope?" }), known);
    expect(e.join()).toMatch(/questions\.json is required \(confidence is low/);
    expect(check(analysis().replace(/## Confidence\n.*\n\n/, ""), known).join()).toMatch(/no "Confidence" section/);
    expect(parseConfidence(analysis({ conf: "Low." }))).toBe("low");
  });

  it("several approaches require a design question; delivery unknown requires a delivery.push question", () => {
    const d = dir();
    const text = analysis({ conf: "medium", open: "- pick", approaches: ["extend", "new module"] });
    expect(parseApproaches(text)).toHaveLength(2);
    const qs = (list: unknown[]) => fs.writeFileSync(path.join(d, "questions.json"), JSON.stringify(list));
    const base = [{ id: "Q-1", question: "a?", why_it_matters: "w", options: [], default: "x", blocking: true }, { id: "Q-2", question: "b?", why_it_matters: "w", options: [], default: "x", blocking: false }, { id: "Q-3", question: "c?", why_it_matters: "w", options: [], default: "x", blocking: false }];
    qs(base);
    expect(check(text, known, d).join()).toMatch(/topic "design"/);
    expect(check(text, unknown, d).join()).toMatch(/topic "delivery\.push"/);
    qs([...base.slice(0, 1), { ...base[1], topic: "design", options: ["extend", "new module"], default: "extend" }, { ...base[2], topic: "delivery.push", options: ["yes", "no"], default: "no" }]);
    expect(check(text, unknown, d)).toEqual([]);
  });

  it("question files are validated with actionable messages (3-7, default among options)", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "questions.json"), JSON.stringify([{ id: "Q-1", question: "a?" }]));
    expect(loadQuestions(path.join(d, "questions.json")).errors.join()).toMatch(/why_it_matters must be a non-empty string/);
    fs.writeFileSync(path.join(d, "questions.json"), JSON.stringify([Q({ options: ["a", "b"], default: "c" })]));
    const e = check(analysis({ conf: "low", open: "- x" }), known, d).join();
    expect(e).toMatch(/ask 3-7/);
    expect(e).toMatch(/default "c" is not one of its options/);
  });

  it("ask = minimal never asks about delivery; thorough asks below high confidence", () => {
    expect(needsQuestions(analysis(), { ...unknown, ask: "minimal" })).toEqual([]);
    expect(needsQuestions(analysis({ conf: "medium" }), { ...known, ask: "thorough" }).join()).toMatch(/thorough/);
    expect(needsQuestions(analysis({ conf: "medium" }), known)).toEqual([]);
  });
});

describe("clarify: answers", () => {
  const q = Q({ options: ["yes", "no"], default: "no", topic: "delivery.push" });
  it("a number picks an option, 'default' picks the default, free text is kept", () => {
    expect(resolveAnswer(q, "1")).toBe("yes");
    expect(resolveAnswer(q, "default")).toBe("no");
    expect(resolveAnswer(Q({}), "use the staging db")).toBe("use the staging db");
    expect(() => resolveAnswer(q, "5")).toThrow(/only 2 options/);
  });
  it("delivery answers become [delivery] settings; answered delivery questions are dropped next time", () => {
    const qs = [q, Q({ id: "Q-2", topic: "delivery.remote" }), Q({ id: "Q-3", topic: "delivery.pr", options: ["yes", "no"] })];
    expect(deliveryFromAnswers(qs, [{ id: "Q-1", answer: "yes", by: "user" }, { id: "Q-2", answer: "origin", by: "user" }, { id: "Q-3", answer: "no", by: "user" }])).toEqual({ push: true, remote: "origin", pr: false });
    expect(dropAnswered(qs, { remote: "origin", push: true, pr: false })).toEqual([]);
    expect(dropAnswered(qs, { remote: "", push: null, pr: null })).toHaveLength(3);
  });
  it("setSection keeps the rest of config.toml and loadConfig reads [sdd] and [delivery]", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hx-cfg-")), "config.toml");
    fs.writeFileSync(f, "[run]\nmax_parallel = 2\n");
    setSection(f, "delivery", { push: true, remote: "origin" });
    setSection(f, "delivery", { pr: false, push: false });
    const text = fs.readFileSync(f, "utf8");
    expect(text).toContain("max_parallel = 2");
    expect(text.match(/\[delivery\]/g)).toHaveLength(1);
    const cfg = loadConfig(f);
    expect(cfg.delivery).toEqual({ remote: "origin", push: false, pr: false });
    expect(cfg.sdd.ask).toBe("normal");
  });
});

describe("clarify: the pipeline waits for the user", () => {
  const open: { s: DaemonServer; c: HexClient }[] = [];
  afterEach(() => { for (const o of open.splice(0)) { o.c.close(); o.s.orch.shutdown(); } });

  async function boot() {
    const root = fs.mkdtempSync(path.join("/tmp", "hcl-"));
    git(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    const f = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 20"));
    fs.writeFileSync(path.join(root, "HEXAGON.md"), "# demo\n");
    git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");
    const s = new DaemonServer(root); await s.listen();
    const c = await HexClient.connect(root, { autostart: false }); open.push({ s, c });
    await c.subscribe();
    return { root, s, c, cfg: f };
  }
  const waitClarify = (c: HexClient) => new Promise<ClarifyState>((resolve) => c.on("push", (p) => { if (p.event === "clarify" && p.data && p.data.answers.length === 0) resolve(p.data); }));
  const waitSpec = (c: HexClient) => new Promise<{ spec_path: string }>((resolve) => c.on("push", (p) => { if (p.event === "spec_review" && p.data) resolve(p.data); }));

  it("asks, waits (no spec), takes answers, remembers delivery, and never asks it twice", async () => {
    const { root, s, c, cfg } = await boot();
    const asked = waitClarify(c);
    let specSeen = false;
    c.on("push", (p) => { if (p.event === "spec_review" && p.data) specSeen = true; });
    await c.call("goal.new", { goal: "Greeting @ask @approaches" });
    const cl = await asked;
    expect(cl.questions.map((q) => q.id)).toEqual(["Q-1", "Q-2", "Q-3", "Q-4"]);
    await sleep(400);
    expect(specSeen).toBe(false); // held until the user answers
    expect(fs.existsSync(path.join(cl.out_dir, "spec.md"))).toBe(false);
    // free-text feedback is not an answer
    await expect(c.call("draft.revise", { feedback: "hmm" })).rejects.toThrow(/question\(s\) are waiting/);

    const spec = waitSpec(c);
    await c.call("question.answer", { question_id: "Q-1", answer: "2" });
    await c.call("question.answer", { question_id: "Q-2", answer: "1" });
    await c.call("question.answer", { question_id: "Q-3", answer: "upstream" });
    expect(s.orch.clarify).not.toBeNull();
    await c.call("question.answer", { question_id: "Q-4", answer: "add a new module" });
    await spec;
    const answers = fs.readFileSync(path.join(cl.out_dir, "answers.md"), "utf8");
    expect(answers).toContain("Answer: wide");
    expect(answers).toContain("add a new module");
    expect(s.orch.clarify).toBeNull();
    const conf = loadConfig(cfg);
    expect(conf.delivery).toMatchObject({ push: true, remote: "upstream" });

    // A second goal: the delivery questions are filtered out because the project already answered them.
    const again = waitClarify(c);
    await c.call("goal.new", { goal: "Another @ask" });
    const second = await again;
    expect(second.questions.map((q) => q.id)).toEqual(["Q-1"]);
  }, 60000);

  it("'accept defaults' proceeds with the defaults marked as such", async () => {
    const { c, s } = await boot();
    const asked = waitClarify(c);
    await c.call("goal.new", { goal: "Greeting @ask" });
    const cl = await asked;
    const spec = waitSpec(c);
    await c.call("question.answer", { question_id: "defaults", answer: "defaults" });
    await spec;
    const answers = fs.readFileSync(path.join(cl.out_dir, "answers.md"), "utf8");
    expect(answers).toMatch(/Answer: narrow \(default\)/);
    expect(s.orch.cfg.delivery.push).toBe(false);
  }, 60000);

  it("a goal with high confidence and a stated delivery goes straight to the spec", async () => {
    const { c } = await boot();
    let asked = false;
    c.on("push", (p) => { if (p.event === "clarify" && p.data) asked = true; });
    const spec = waitSpec(c);
    await c.call("goal.new", { goal: "Greeting" });
    await spec;
    expect(asked).toBe(false);
  }, 60000);

  it("after /merge, delivery is shown first and pushes only on an explicit yes", async () => {
    const { root, s } = await boot();
    const bare = fs.mkdtempSync(path.join("/tmp", "hcl-remote-"));
    git(bare, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", bare);
    await expect(s.orch.deliver(false)).rejects.toThrow(/nothing to deliver/);
    setSection(path.join(root, ".hexagon/config.toml"), "delivery", { push: true, remote: "origin", pr: false });
    s.orch.cfg = loadConfig(path.join(root, ".hexagon/config.toml"));
    fs.writeFileSync(path.join(root, ".hexagon/delivery-pending.json"), JSON.stringify({ run: "r-1", base: "main", branch: "hexagon/r-1/integration" }));
    const plan = await s.orch.deliver(false);
    expect(plan).toMatchObject({ done: false, steps: ["git push origin main"] });
    expect(() => git(bare, "rev-parse", "main")).toThrow(); // nothing was pushed without the yes
    const r = await s.orch.deliver(true);
    expect(r.done).toBe(true);
    expect(git(bare, "rev-parse", "main")).toBe(git(root, "rev-parse", "main"));
    await expect(s.orch.deliver(true)).rejects.toThrow(/nothing to deliver/);
  }, 60000);
});
