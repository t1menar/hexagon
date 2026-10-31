import { setTimeout as sleep } from "node:timers/promises";
import type { Task } from "../contracts/types.js";
import type { AdapterOutcome, AgentAdapter, AgentRunContext, Injected } from "./types.js";

/**
 * Scripted, offline agent. Exercises the full pipeline (status, messages, questions,
 * scope, verify, review, merge) without any API calls.
 *
 * - Writes each concrete file in the task's write scope.
 * - If the task description contains `@ask: <question>`, asks the user a blocking question.
 * - Applies user instructions it receives by appending them as notes to the files it writes.
 */
export class MockAdapter implements AgentAdapter {
  readonly provider = "mock";
  readonly model = null;
  readonly supportsLiveInput = true;
  constructor(readonly id: string, private stepMs = 600) {}

  async run(ctx: AgentRunContext): Promise<AdapterOutcome> {
    const { host } = ctx;
    const step = async (activity: string) => {
      if (ctx.signal.aborted) throw new Error("aborted");
      host.emit({ type: "progress", text: activity });
      await sleep(this.stepMs, undefined, { signal: ctx.signal }).catch(() => undefined);
      if (ctx.signal.aborted) throw new Error("aborted");
    };
    const instructions: Injected[] = [];
    const drain = async () => {
      const got = host.drainInbox();
      if (got.length) {
        instructions.push(...got);
        await host.execute("ack", { message_ids: got.map((m) => m.id) });
      }
    };
    host.emit({ type: "usage", input: 1200, output: 300, cache_read: 0, cache_write: 0, cost_usd: 0 });

    try {
      if (ctx.role === "planner") return await this.plan(ctx, step);
      if (ctx.role === "reviewer") {
        await host.execute("report_status", { phase: "reading", activity: "Reading the diff" });
        await step("Checking acceptance evidence");
        await host.execute("submit_review", { verdict: "approve", summary: "Mock review: scope and evidence look fine.", findings: [] });
        return { kind: "finished" };
      }

      const task = ctx.task!;
      await host.execute("report_status", { phase: "reading", activity: `Reading task ${task.id}` });
      if (ctx.followUp) instructions.push({ id: "followup", from: "orchestrator", type: "handoff", body: ctx.followUp });
      await drain();
      await step("Exploring the workspace");
      await host.execute("list_files", { dir: ".", max: 50 });

      const ask = /@ask:\s*(.+)$/m.exec(task.description ?? "");
      if (ask && !ctx.session) {
        await host.execute("report_status", { activity: "Waiting for an answer" });
        const res = await host.execute("ask_user", {
          kind: "choice", prompt: ask[1]!.trim(), blocking: true, default_option: "1",
          options: [{ id: "1", label: "Option A" }, { id: "2", label: "Option B" }],
        });
        instructions.push({ id: "answer", from: "user", type: "answer", body: res.content });
      }

      await host.execute("report_status", { phase: "editing", activity: "Writing files" });
      const files = task.files.write.filter((g) => !/[*?{]/.test(g));
      if (files.length === 0) files.push(defaultFile(task));
      for (const f of files) {
        await step(`Editing ${f}`);
        await drain();
        await host.execute("write_file", { path: f, content: render(task, f, instructions) });
      }

      await host.execute("report_status", {
        phase: "testing", activity: "Running checks",
        checklist: task.acceptance.map((id) => ({ id, status: "done" })),
      });
      const commands: { cmd: string; exit_code: number }[] = [];
      for (const cmd of task.verify) {
        await step(`Running ${cmd}`);
        const r = await host.execute("run_cmd", { cmd });
        commands.push({ cmd, exit_code: r.is_error ? 1 : 0 });
      }
      await drain();
      await host.execute("report_status", { phase: "reporting", activity: "Submitting result" });
      const res = await host.execute("submit_result", {
        task_id: task.id,
        status: "completed",
        summary: `Mock implementation of ${task.title}${instructions.length ? ` (applied ${instructions.length} message(s))` : ""}.`,
        files_changed: files,
        acceptance_evidence: task.acceptance.map((ac) => ({ ac, evidence: "mock agent (no real verification)", verified: false })),
        commands_run: commands,
        blockers: [],
        spec_issues: [],
        assumptions: [],
        follow_ups: [],
      });
      if (res.is_error) return { kind: "error", error: { kind: "invalid_output", message: res.content, retryable: false } };
      return { kind: "finished", session: { ran: true } };
    } catch (e) {
      if (ctx.signal.aborted) return { kind: "error", error: { kind: "internal", message: "cancelled", retryable: false } };
      return { kind: "error", error: { kind: "internal", message: String(e), retryable: true } };
    }
  }

  private async plan(ctx: AgentRunContext, step: (a: string) => Promise<void>): Promise<AdapterOutcome> {
    await ctx.host.execute("report_status", { phase: "planning", activity: "Mapping requirements to tasks" });
    await step("Drafting tasks");
    const reqs = (ctx.specs ?? []).flatMap((s) => s.requirements);
    const tasks = reqs.map((r, i) => ({
      id: `T-${i + 1}`,
      title: r.title,
      role: "implementer",
      requirements: [r.id],
      acceptance: r.acceptance.map((a) => a.id),
      depends_on: [],
      files: { write: r.touches.length ? r.touches : [`hexagon-mock/${r.id.toLowerCase()}.md`], read: [] },
      skills: [],
      definition_of_done: r.acceptance.map((a) => `${a.id}: ${a.text}`).concat(r.acceptance.length ? [] : ["Implemented"]),
      verify: [],
    }));
    const res = await ctx.host.execute("submit_plan", { tasks, spec_issues: [] });
    if (res.is_error) return { kind: "error", error: { kind: "invalid_output", message: res.content, retryable: false } };
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
