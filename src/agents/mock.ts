import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Task } from "../contracts/types.js";
import { runShell } from "../util/shell.js";
import type { AdapterOutcome, AgentAdapter, AgentRunContext, Injected } from "./types.js";

/**
 * Scripted, offline agent. Exercises the full pipeline (status, messages, questions,
 * scope, verify, review, merge, planning, init) without any model calls.
 *
 * - Implementer/tester: writes each concrete file in the task's write scope.
 * - `@ask: <question>` in a task description asks the user a blocking question first.
 * - Instructions it receives are appended as notes to the files it writes.
 * - Planner: writes spec.md + plan.json for the goal into $HEXAGON_OUT.
 * - Init: writes HEXAGON.md.
 */
export class MockAdapter implements AgentAdapter {
  readonly provider = "mock";
  readonly model = null;
  readonly supportsLiveInput = true;
  constructor(readonly id: string, private stepMs = 600) {}

  takeoverCommand(): string[] | null {
    return null;
  }

  async run(ctx: AgentRunContext): Promise<AdapterOutcome> {
    const { host, api } = ctx;
    const step = async (activity: string) => {
      if (ctx.signal.aborted) throw new Error("aborted");
      host.emit({ type: "progress", text: activity });
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
    host.emit({ type: "usage", input: 1200, output: 300, cache_read: 0, cache_write: 0, cost_usd: 0, step: true });

    try {
      if (ctx.role === "planner") return await this.plan(ctx, step);
      if (ctx.role === "lead") {
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
      if (ctx.role === "init") {
        api.report({ activity: "Scanning the repository", phase: "reading" });
        await step("Writing HEXAGON.md");
        fs.writeFileSync(path.join(ctx.cwd, "HEXAGON.md"), "# Project\n\nMock project context.\n\n## Commands\n- test: `true`\n");
        api.done({ summary: "Wrote HEXAGON.md (mock)" });
        return { kind: "finished" };
      }
      if (ctx.role === "reviewer") {
        api.report({ phase: "reading", activity: "Reading the diff" });
        await step("Checking acceptance evidence");
        api.review({ verdict: "approve", summary: "Mock review: scope and evidence look fine.", findings: [] });
        return { kind: "finished" };
      }

      const task = ctx.task!;
      api.report({ phase: "reading", activity: `Reading task ${task.id}` });
      if (ctx.resume && ctx.followUp) instructions.push({ id: "followup", from: "orchestrator", type: "handoff", body: ctx.followUp });
      drain();
      await step("Exploring the workspace");

      // `@needs: brew install go`: the command is denied until the user approves it.
      const needs = /@needs:\s*(.+)$/m.exec(task.description ?? "");
      if (needs && !(ctx.followUp ?? "").includes("approved")) {
        host.emit({ type: "tool_call", name: "Bash", summary: `$ ${needs[1]!.trim()}` });
        host.emit({ type: "tool_result", name: "Bash", ok: false, summary: "This command requires approval" });
        host.emit({ type: "permission_denied", tool: "Bash", command: needs[1]!.trim() });
        api.done({ status: "blocked", summary: `needs \`${needs[1]!.trim()}\``, blockers: [`\`${needs[1]!.trim()}\` was denied`] });
        return { kind: "finished" };
      }
      const block = /@block:\s*(.+)$/m.exec(task.description ?? "");
      if (block && !ctx.resume) {
        host.emit({ type: "chat", from: "agent", text: `I can't finish: ${block[1]!.trim()}` });
        api.done({ status: "blocked", summary: block[1]!.trim(), blockers: [block[1]!.trim()] });
        return { kind: "finished" };
      }
      const ask = /@ask:\s*(.+)$/m.exec(task.description ?? "");
      if (ask && !ctx.resume) {
        api.ask({ prompt: ask[1]!.trim(), options: ["Option A", "Option B"], default: "Option A", blocking: true });
        await waitForAnswer();
      }

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
        acceptance_evidence: task.acceptance.map((ac) => ({ ac, evidence: "mock agent (no real verification)", verified: false })),
      });
      if (!r.ok) return { kind: "error", error: { kind: "invalid_output", message: r.message, retryable: false } };
      return { kind: "finished" };
    } catch (e) {
      if (ctx.signal.aborted) return { kind: "interrupted" };
      return { kind: "error", error: { kind: "internal", message: String(e), retryable: true } };
    }
  }

  private async plan(ctx: AgentRunContext, step: (a: string) => Promise<void>): Promise<AdapterOutcome> {
    const out = ctx.env.HEXAGON_OUT!;
    const goal = /<goal>\n?([\s\S]*?)\n?<\/goal>/.exec(ctx.prompt)?.[1]?.trim() ?? "Demo";
    ctx.api.report({ phase: "planning", activity: "Writing the spec" });
    await step("Drafting tasks");
    const parts = goal.split(/\s+(?:and|then)\s+/i).slice(0, 4);
    const reqs = parts.map((p, i) => ({ id: `REQ-GOAL-${String(i + 1).padStart(3, "0")}`, title: p, file: `hexagon-mock/part-${i + 1}.md` }));
    const spec = [
      "---", "spec: goal", "---", `# ${goal}`, "",
      ...reqs.flatMap((r) => [`## ${r.id}: ${r.title}`, `${r.title}.`, "", "**Acceptance**", `- AC-1: ${r.file} exists`, "", `**Touches**: \`${r.file}\``, ""]),
    ].join("\n");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "spec.md"), spec);
    const plan = {
      tasks: reqs.map((r, i) => ({
        id: `T-${i + 1}`, title: r.title, role: "implementer", requirements: [r.id], acceptance: ["AC-1"],
        depends_on: i > 0 ? [`T-${i}`] : [], files: { write: [r.file] }, verify: [`test -f ${r.file}`],
      })),
    };
    fs.writeFileSync(path.join(out, "plan.json"), JSON.stringify(plan, null, 2));
    const r = ctx.api.done({ summary: `${reqs.length} task(s) for: ${goal}` });
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
