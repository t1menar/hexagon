import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Task } from "../contracts/types.js";
import { runShell } from "../util/shell.js";
import { AdapterBase } from "./contracts/base.js";
import { capabilities } from "./contracts/capabilities.js";
import { parseSpec } from "../core/spec.js";
import { COMPACT_TAG } from "../core/compaction.js";
import type { AdapterOutcome, AgentAdapter, AgentRunContext, Injected } from "./types.js";
import { registerAdapter } from "./adapter-registry.js";

/**
 * Scripted, offline agent. Exercises the full pipeline (status, messages, questions,
 * scope, verify, review, merge, planning, init) without any model calls.
 *
 * - Developer/qa: writes each concrete file in the task's write scope.
 * - `@ask: <question>` in a task description asks the user a blocking question first.
 * - Instructions it receives are appended as notes to the files it writes.
 * - Planner: writes spec.md + plan.json for the goal into $HEXAGON_OUT.
 * - Init: writes HEXAGON.md.
 */
export class MockAdapter extends AdapterBase implements AgentAdapter {
  static reviews = new Map<string, number>();
  /** Simulated conversation size per session, so token accounting follows the real shape: cold start vs resume. */
  static contexts = new Map<string, number>();
  /** Test hook: what each turn was sent (the card for a new session, the delta for a resumed one). */
  static turns: { agent: string; resume: boolean; text: string }[] = [];
  readonly adapterId = "mock";
  readonly provider = "mock";
  readonly displayName = "Mock agent";
  readonly capabilities = capabilities({ supportsStreaming: true, supportsLiveInput: true, supportsSessionResume: true, resumeAcrossCwd: true, supportsUsageMetrics: true });
  constructor(id: string, private stepMs = 600) { super(id, ["mock"]); }

  override async detect() {
    return { installed: true, executable: "(built in)", version: null, auth: "ok" as const, authDetail: "offline scripted agent", problems: [] };
  }

  takeoverCommand(): string[] | null {
    return null;
  }

  async run(ctx: AgentRunContext): Promise<AdapterOutcome> {
    const { host, api } = ctx;
    const step = async (activity: string) => {
      if (ctx.signal.aborted) throw new Error("aborted");
      host.emit({ type: "progress", text: activity });
      spend(40, 60); // one model call per step: re-reads the cached conversation
      await sleep(this.stepMs, undefined, { signal: ctx.signal }).catch(() => undefined);
      if (ctx.signal.aborted) throw new Error("aborted");
    };
    const instructions: Injected[] = [];
    const drain = () => {
      for (const m of host.drainInbox()) {
        instructions.push(m);
        host.received(m.id);
      }
    };
    const waitForAnswer = async () => {
      while (host.hasBlockingQuestion()) {
        if (ctx.signal.aborted) throw new Error("aborted");
        await sleep(50);
      }
      drain();
    };
    // A cold session pays for the whole prompt; a resumed one only for the new message and re-reads the cached conversation.
    const tok = (t: string) => Math.ceil(t.length / 4);
    let context = ctx.resume ? MockAdapter.contexts.get(ctx.sessionId) ?? 0 : 0;
    const spend = (input: number, output: number) => {
      host.emit({ type: "usage", input, output, cache_read: context, cache_write: 0, cost_usd: 0, step: true });
      context += input + output;
      MockAdapter.contexts.set(ctx.sessionId, context);
    };
    spend(ctx.resume ? tok(ctx.followUp ?? ctx.prompt) : tok(ctx.system) + tok(ctx.prompt), 300);
    MockAdapter.turns.push({ agent: ctx.agentRunId, resume: ctx.resume, text: ctx.resume ? ctx.followUp ?? ctx.prompt : ctx.prompt });
    if (MockAdapter.turns.length > 500) MockAdapter.turns.shift();
    const firstOfTask = !ctx.resume || ctx.freshTask === true;
    if (ctx.resume && (ctx.followUp ?? "").includes(COMPACT_TAG)) {
      host.emit({ type: "chat", from: "agent", text: "## Decisions\n(mock) kept the module layout.\n## Done\n(mock) earlier work.\n## Open\nnothing\n## Gotchas\nnone" });
      spend(0, 120);
      return { kind: "finished" };
    }

    try {
      if (ctx.role === "analyst") return await this.plan(ctx, step);
      if (ctx.role === "control") {
        if (ctx.resume && ctx.followUp) host.emit({ type: "chat", from: "agent", text: `(mock) ${ctx.followUp.includes("approved") ? "Approved, running it now." : ctx.followUp}` });
        else host.emit({ type: "chat", from: "agent", text: `(mock) You said: ${ctx.prompt.replace(/<hexagon_state>[\s\S]*?<\/hexagon_state>\s*/g, "").replace(/<\/?user_message>/g, "").trim()}` });
        host.emit({ type: "progress", text: "ready" });
        while (!ctx.signal.aborted) {
          await sleep(50);
          for (const m of host.drainInbox()) {
            const needs = /@needs:\s*(.+)$/m.exec(m.body);
            if (needs) host.emit({ type: "permission_denied", tool: "Bash", command: needs[1]!.trim() });
            host.emit({ type: "usage", input: 200, output: 20, cache_read: 0, cache_write: 0, cost_usd: 0, step: true });
            host.emit({ type: "chat", from: "agent", text: `(mock) You said: ${m.body.replace(/<hexagon_state>[\s\S]*?<\/hexagon_state>\s*/g, "").trim()}` });
            host.emit({ type: "progress", text: "ready" });
          }
        }
        return { kind: "interrupted" };
      }
      if (ctx.role === "bootstrap") {
        api.report({ activity: "Scanning the repository", phase: "reading" });
        await step("Writing HEXAGON.md");
        fs.writeFileSync(path.join(ctx.cwd, "HEXAGON.md"), "# Project\n\nMock project context.\n\n## Commands\n- test: `true`\n");
        api.done({ summary: "Wrote HEXAGON.md (mock)" });
        return { kind: "finished" };
      }
      if (ctx.role === "release") {
        // Keep both sides of every conflict (test double for the release engineer).
        const list = /<conflicts[^>]*>\n([\s\S]*?)\n<\/conflicts>/.exec(ctx.prompt)?.[1]?.split("\n").filter(Boolean) ?? [];
        for (const f of list) {
          await step(`Resolving ${f}`);
          const abs = path.join(ctx.cwd, f);
          fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").split("\n").filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join("\n"));
        }
        if (/@release-fails/.test(ctx.task?.description ?? "")) { api.done({ status: "blocked", summary: "needs a decision", blockers: ["which behavior wins"] }); return { kind: "finished" }; }
        api.done({ status: "completed", summary: `Resolved ${list.join(", ")}`, acceptance_evidence: [] });
        return { kind: "finished" };
      }

      if (ctx.role === "reviewer") {
        api.report({ phase: "reading", activity: "Reading the diff" });
        await step("Checking acceptance evidence");
        // `@reject: N` (or `always`) in the task description: request changes N times, with a different finding each
        // time unless `@reject-same` is also present (to exercise no-progress detection).
        const rj = /@reject:\s*(\d+|always)/.exec(ctx.task?.description ?? "");
        const n = (MockAdapter.reviews.get(ctx.task?.id ?? "") ?? 0) + 1;
        MockAdapter.reviews.set(ctx.task?.id ?? "", n);
        if (rj && (rj[1] === "always" || n <= Number(rj[1]))) {
          const same = /@reject-same/.test(ctx.task?.description ?? "");
          api.review({ verdict: "request_changes", summary: same ? "Mock review: not good enough." : `Mock review #${n}: please improve.`, findings: [{ severity: "high", issue: same ? "still wrong" : `issue ${n}`, file: same ? "src/a.txt" : `src/a-${n}.txt` }] });
          return { kind: "finished" };
        }
        api.review({ verdict: "approve", summary: "Mock review: scope and evidence look fine.", findings: [] });
        return { kind: "finished" };
      }

      const task = ctx.task!;
      api.report({ phase: "reading", activity: `Reading task ${task.id}` });
      if (ctx.resume && ctx.followUp && !ctx.freshTask) instructions.push({ id: "followup", from: "orchestrator", type: "handoff", body: ctx.followUp });
      drain();
      await step("Exploring the workspace");

      // `@limit: <provider text>`: fail once with that text (test hook for provider-limit recovery). Fires once per
      // worktree, remembered on disk so it survives a daemon restart.
      const lim = /@limit:\s*(.+)$/m.exec(task.description ?? "");
      if (lim) {
        const mark = path.join(os.tmpdir(), `hexagon-mock-limit-${createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 16)}`);
        fs.appendFileSync(`${mark}.runs`, `${ctx.resume ? "resume" : "new"}\n`); // test hook: did the retry continue the session?
        if (!fs.existsSync(mark)) {
          fs.writeFileSync(mark, "1");
          host.emit({ type: "progress", text: "session started" }); // like the real CLI: the session exists even though the run fails
          return { kind: "error", error: { kind: "transient", message: lim[1]!.trim(), retryable: true, raw: lim[1]!.trim() } };
        }
      }

      // `@needs: brew install go`: the command is denied until the user approves it.
      const needs = /@needs:\s*(.+)$/m.exec(task.description ?? "");
      if (needs && !(ctx.followUp ?? "").includes("approved")) {
        host.emit({ type: "tool_call", name: "Bash", summary: `$ ${needs[1]!.trim()}` });
        host.emit({ type: "tool_result", name: "Bash", ok: false, summary: "This command requires approval" });
        host.emit({ type: "permission_denied", tool: "Bash", command: needs[1]!.trim() });
        api.done({ status: "blocked", summary: `needs \`${needs[1]!.trim()}\``, blockers: [`\`${needs[1]!.trim()}\` was denied`] });
        return { kind: "finished" };
      }
      // `@return: T-1 <issue>`: send a defect back to T-1, then continue once its fix is merged.
      const ret = /@return:\s*(T-\d+)\s+(.+)$/m.exec(task.description ?? "");
      if (ret && !(ctx.followUp ?? "").includes("fixed what you returned")) {
        const r = api.return?.({ task: ret[1]!, issue: ret[2]!.trim() });
        if (r?.ok) return { kind: "finished" };
      }
      const block = /@block:\s*(.+)$/m.exec(task.description ?? "");
      if (block && firstOfTask) {
        host.emit({ type: "chat", from: "agent", text: `I can't finish: ${block[1]!.trim()}` });
        api.done({ status: "blocked", summary: block[1]!.trim(), blockers: [block[1]!.trim()] });
        return { kind: "finished" };
      }
      const ask = /@ask:\s*(.+)$/m.exec(task.description ?? "");
      if (ask && firstOfTask) {
        api.ask({ prompt: ask[1]!.trim(), options: ["Option A", "Option B"], default: "Option A", blocking: true });
        await waitForAnswer();
      }

      // `@decide: <text>`: record an architectural decision on the bus for downstream agents.
      const decide = /@decide:\s*(.+)$/m.exec(task.description ?? "");
      if (decide && firstOfTask) api.bus?.({ action: "send", kind: "decision", subject: decide[1]!.trim(), body: decide[1]!.trim() });

      api.report({ phase: "editing", activity: "Writing files" });
      const files = task.files.write.filter((g) => !/[*?{]/.test(g));
      if (files.length === 0) files.push(defaultFile(task));
      for (const f of files) {
        await step(`Editing ${f}`);
        drain();
        const abs = path.join(ctx.cwd, f);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, render(task, f, instructions));
      }

      // `@commit-outside`: commit a file outside the write scope, as an agent that runs `git commit` itself would (test hook).
      if (/@commit-outside/.test(task.description ?? "")) {
        fs.mkdirSync(path.join(ctx.cwd, "outside"), { recursive: true });
        fs.writeFileSync(path.join(ctx.cwd, "outside/leak.txt"), "out of scope\n");
        const gitq = (...a: string[]) => execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@localhost", ...a], { cwd: ctx.cwd, stdio: "ignore" });
        gitq("add", "-A");
        gitq("commit", "-qm", "agent: sneak in a file");
      }

      // `@delete-test: <file>`: delete a test file, as an agent that "fixes" a failing test by removing it would (test hook).
      const dt = /@delete-test:\s*(\S+)/.exec(task.description ?? "");
      if (dt) fs.rmSync(path.join(ctx.cwd, dt[1]!), { force: true });

      api.report({ phase: "testing", activity: "Running checks", done: task.acceptance });
      for (const cmd of task.verify) {
        await step(`Running ${cmd}`);
        await runShell(cmd, ctx.cwd, 60, ctx.signal);
      }
      drain();
      host.emit({ type: "chat", from: "agent", text: `I wrote ${files.join(", ")}${instructions.length ? ` and applied ${instructions.length} message(s)` : ""}. Reporting the result now.` });
      const r = api.done({
        status: "completed",
        summary: `Mock implementation of ${task.title}${instructions.length ? ` (applied ${instructions.length} message(s))` : ""}.`,
        // `@evidence: <file>::<test name>` claims that test for every criterion (test hook for the mutation check).
        acceptance_evidence: /@no-evidence/.test(task.description ?? "") ? [] : task.acceptance.map((ac) => ({ ac, evidence: /@evidence:\s*(\S+::[^\n]+)/.exec(task.description ?? "")?.[1] ? `test:${/@evidence:\s*(\S+::[^\n]+)/.exec(task.description ?? "")![1]!.trim()}` : "mock agent (no real verification)", verified: false })),
      });
      if (!r.ok) return { kind: "error", error: { kind: "invalid_output", message: r.message, retryable: false } };
      return { kind: "finished" };
    } catch (e) {
      if (ctx.signal.aborted) return { kind: "interrupted" };
      return { kind: "error", error: { kind: "internal", message: String(e), retryable: true } };
    }
  }

  /** The analyst's three stages, driven by the `<stage>` tag Hexagon puts in each message. */
  private async plan(ctx: AgentRunContext, step: (a: string) => Promise<void>): Promise<AdapterOutcome> {
    const out = ctx.env.HEXAGON_OUT!;
    const text = `${ctx.followUp ?? ""}\n${ctx.prompt}`;
    const stage = /<stage>(\w+)<\/stage>/.exec(text)?.[1] ?? "analyze";
    const goal = /<goal>\n?([\s\S]*?)\n?<\/goal>/.exec(text)?.[1]?.trim() ?? (fs.existsSync(path.join(out, "goal.txt")) ? fs.readFileSync(path.join(out, "goal.txt"), "utf8") : "Demo");
    const parts = goal.split(/\s+(?:and|then)\s+/i).slice(0, 4);
    const reqs = parts.map((p, i) => ({ id: `REQ-GOAL-${String(i + 1).padStart(3, "0")}`, title: p, file: `hexagon-mock/part-${i + 1}.md` }));
    fs.mkdirSync(out, { recursive: true });
    ctx.api.report({ phase: "planning", activity: `Stage: ${stage}` });
    if (stage === "analyze") {
      await step("Reading the codebase");
      fs.writeFileSync(path.join(out, "analysis.md"), [`# Analysis: ${goal}`, "", "## Current state", "(mock) empty repository", "", "## Constraints", "none", "", "## Risks", "none", "", "## Open questions", "none", "", "## Impacted areas", ...reqs.map((r) => `- ${r.file}`), ""].join("\n"));
    } else if (stage === "specify") {
      await step("Writing the spec");
      fs.writeFileSync(path.join(out, "spec.md"), [
        "---", "spec: goal", "---", `# ${goal}`, "",
        ...reqs.flatMap((r) => [`## ${r.id}: ${r.title}`, `${r.title}.`, "", "**Acceptance**", `- AC-1: ${r.file} exists`, "", `**Touches**: \`${r.file}\``, ""]),
      ].join("\n"));
    } else {
      await step("Drafting tasks");
      const spec = parseSpec(path.join(out, "spec.md"));
      const plan = {
        tasks: spec.requirements.map((r, i) => ({
          id: `T-${i + 1}`, title: r.title, role: "developer", requirements: [r.id], acceptance: ["AC-1"],
          depends_on: i > 0 ? [`T-${i}`] : [], files: { write: r.touches }, verify: [`test -f ${r.touches[0]}`],
        })),
      };
      fs.writeFileSync(path.join(out, "plan.json"), JSON.stringify(plan, null, 2));
    }
    const r = ctx.api.done({ summary: `${stage} done for: ${goal}` });
    if (!r.ok) return { kind: "error", error: { kind: "invalid_output", message: r.message, retryable: false } };
    return { kind: "finished" };
  }
}

function defaultFile(task: Task): string {
  return `hexagon-mock/${task.id.toLowerCase()}.md`;
}

function render(task: Task, file: string, instructions: Injected[]): string {
  const lines = [
    `Mock output for ${task.id}: ${task.title}`,
    `Requirements: ${task.requirements.join(", ")}`,
    `Acceptance: ${task.acceptance.join(", ")}`,
    ...instructions.map((m) => `Note from ${m.from} (${m.id}): ${m.body}`),
  ];
  const comment = /\.(ts|js|tsx|jsx|go|java|c|cpp|rs|swift|kt)$/.test(file) ? "// " : /\.(py|sh|rb|toml|ya?ml)$/.test(file) ? "# " : "";
  return lines.map((l) => comment + l).join("\n") + "\n";
}

registerAdapter("mock", (id, c) => new MockAdapter(id, c.step_ms ?? 600), { agentId: "mock", defaultAgent: { adapter: "mock", step_ms: 600 } });
