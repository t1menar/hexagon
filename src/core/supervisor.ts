import fs from "node:fs";
import path from "node:path";
import type {
  AgentEvent, AgentState, Effort, ErrorKind, NeedsInput, Plan, ResultEnvelope, ReviewVerdict, Role, Task,
} from "../contracts/types.js";
import { validateResult } from "../contracts/validate.js";
import { scopeFiles, systemLayers, taskCard, type Skill } from "../agents/prompts.js";
import { SUBMIT_TOOL, runShell, toolsForRole, validateToolInput, WorkspaceTools } from "../agents/tools.js";
import type { AgentAdapter, Injected, ToolHost, ToolOutcome } from "../agents/types.js";
import { atomicWriteJson, matchesAny, nowIso, truncateMiddle } from "../util/fsx.js";
import type { HexagonConfig } from "./config.js";
import * as g from "./git.js";
import type { ProjectPaths, RunPaths } from "./project.js";
import type { MessageRouter } from "./router.js";
import type { Spec } from "./spec.js";
import { relResult, type StatusStore } from "./status.js";

export interface RunContext {
  root: string;
  paths: ProjectPaths;
  run: RunPaths;
  runId: string;
  cfg: HexagonConfig;
  store: StatusStore;
  router: MessageRouter;
  specs: Spec[];
  skills: Skill[];
  context: string;
  integration: { branch: string; worktree: string };
  adapterFor(role: Role, override?: string | null): AgentAdapter;
}

const MAX_TURNS = 80;

interface Gate { promise: Promise<void>; resolve: () => void }

/** Supervises one attempt of one task. The only writer of its status (through the store). */
export class AgentRun {
  readonly agentRunId: string;
  readonly worktree: string;
  readonly branch: string;
  private abort = new AbortController();
  private gate: Gate | null = null;
  private stateBeforePause: AgentState = "running";
  private questions = new Map<string, { resolve: (a: string) => void; q: NeedsInput; messageId: string }>();
  private openNonBlocking = new Map<string, { q: NeedsInput; messageId: string }>();
  private blockingAsked = 0;
  private finished = false;
  private result: ResultEnvelope | undefined;
  private review: ReviewVerdict | undefined;
  private session: unknown;
  private baseCommit = "";
  private takeoverCommit = "";
  private cancelled = false;
  private userDone = false;
  private verifyLog: { cmd: string; code: number; output: string }[] = [];

  constructor(
    private rc: RunContext,
    readonly task: Task,
    readonly attempt: number,
    readonly effort: Effort,
    readonly adapter: AgentAdapter,
  ) {
    this.agentRunId = `${task.id}-a${attempt}`;
    this.worktree = path.join(rc.paths.worktrees, rc.runId, this.agentRunId);
    this.branch = `hexagon/${rc.runId}/${this.agentRunId}`;
  }

  get state(): AgentState {
    return this.rc.store.get(this.agentRunId)?.state ?? "queued";
  }

  private ev(e: AgentEvent) {
    this.rc.store.apply(this.agentRunId, e);
  }

  private st(state: AgentState, reason?: string) {
    this.ev({ type: "state", state, reason: reason ?? null });
  }

  private notify(body: string) {
    this.rc.router.send({ from: { kind: "orchestrator" }, to: { kind: "user" }, type: "notify", body: `${this.task.id}: ${body}`, thread_id: this.task.id });
  }

  // ───────────────────────────── pipeline ─────────────────────────────

  async execute(): Promise<AgentState> {
    this.st("starting", "creating worktree");
    try {
      await g.addWorktree(this.rc.root, this.worktree, this.branch, this.rc.integration.branch);
      this.baseCommit = await g.revParse(this.worktree, "HEAD");
      this.rc.store.patch(this.agentRunId, (s) => {
        s.workspace = { worktree: path.relative(this.rc.root, this.worktree), branch: this.branch };
        s.attach = { ...s.attach, takeover_command: [process.env.SHELL ?? "/bin/zsh"] };
      });
    } catch (e) {
      this.ev({ type: "error", kind: "internal", message: String(e), retryable: false });
      return this.final("failed", "could not create worktree");
    }

    let followUp: string | undefined;
    let fixLoops = 0;
    for (;;) {
      // 1. Implement (or fix)
      this.finished = false;
      this.result = undefined;
      this.st("running");
      this.abort = new AbortController();
      const outcome = await this.adapter.run({
        role: this.task.role,
        task: this.task,
        effort: this.effort,
        cwd: this.worktree,
        system: systemLayers(this.rc.paths, this.task.role, this.rc.skills, this.task.skills, this.rc.context),
        firstMessage: taskCard(this.task, this.rc.specs, { notes: this.rc.router.notes(), files: scopeFiles(this.worktree, this.task) }),
        followUp,
        host: this.host(this.task.role, this.task.files.write),
        signal: this.abort.signal,
        session: this.session,
        maxTurns: MAX_TURNS,
        specs: this.rc.specs,
      });
      this.session = outcome.session ?? this.session;
      followUp = undefined;

      if (this.cancelled) return this.final("cancelled", "cancelled by user");
      if (this.userDone) {
        this.result = await this.userResult();
      } else if (outcome.kind === "error") {
        const e = outcome.error!;
        this.ev({ type: "error", ...e });
        return this.final("failed", e.message);
      }
      const r = this.result;
      if (!r) {
        this.ev({ type: "error", kind: "invalid_output", message: "no result submitted", retryable: true });
        return this.final("failed", "no result submitted");
      }
      if (r.status === "needs_spec_change" || r.status === "blocked") {
        this.notify(`${r.status.replace(/_/g, " ")}: ${[...r.blockers, ...r.spec_issues].join("; ") || r.summary}`);
        this.ev({ type: "error", kind: r.status === "blocked" ? "internal" : "needs_spec_change", message: r.summary, retryable: false });
        await this.commit();
        return this.final("blocked", r.status === "blocked" ? r.blockers.join("; ") || r.summary : `needs spec change: ${r.spec_issues.join("; ")}`);
      }
      if (r.status === "failed") {
        this.ev({ type: "error", kind: "internal", message: r.summary, retryable: true });
        return this.final("failed", r.summary);
      }
      if (!this.userDone && this.rc.router.pending(this.task.id) > 0) {
        followUp = "New messages arrived before you finished. Apply them, then call submit_result again.";
        continue;
      }

      // 2. Scope + commit
      await this.commit();

      // 3. Verify
      this.st("verifying", this.task.verify.length ? `running ${this.task.verify.length} command(s)` : "no verify commands");
      const v = await this.verify();
      if (!v.ok) {
        if (fixLoops++ < this.rc.cfg.run.fix_loops && !this.userDone) {
          this.ev({ type: "error", kind: "verify_failed", message: `\`${v.cmd}\` exited ${v.code}`, retryable: true });
          followUp = `The orchestrator re-ran verification and it failed.\n\n$ ${v.cmd}\n(exit ${v.code})\n${truncateMiddle(v.output, 12_000)}\n\nFix the problem, re-run the command yourself, then call submit_result again.`;
          continue;
        }
        this.ev({ type: "error", kind: "verify_failed", message: `\`${v.cmd}\` exited ${v.code}`, retryable: true });
        return this.final("failed", `verification failed: ${v.cmd}`);
      }

      // 4. Review
      if (this.rc.cfg.review.mode === "agent" && !this.userDone) {
        this.st("reviewing");
        const rv = await this.runReview();
        if (this.cancelled) return this.final("cancelled", "cancelled by user");
        if (!rv) return this.final("failed", "review did not complete");
        this.review = rv;
        if (rv.verdict === "request_changes") {
          if (fixLoops++ < this.rc.cfg.run.fix_loops) {
            followUp = `The reviewer requested changes:\n${rv.summary}\n${rv.findings.map((f) => `- [${f.severity}] ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.issue}${f.suggestion ? ` → ${f.suggestion}` : ""}`).join("\n")}\n\nAddress the high and medium findings, then call submit_result again.`;
            continue;
          }
          return this.final("failed", `review rejected: ${rv.summary}`);
        }
      }

      // 5. Merge into the run's integration branch
      this.st("merging");
      const m = await g.merge(
        this.rc.integration.worktree,
        this.branch,
        `Merge ${this.task.id}: ${this.task.title}\n\nHexagon-Task: ${this.task.id}\nRefs: ${refs(this.task)}`,
      );
      if (!m.ok) {
        this.ev({ type: "error", kind: "internal", message: m.output, retryable: false });
        this.notify(m.conflict ? "merge conflict with the integration branch — resolve manually or /retry" : `merge failed: ${m.output}`);
        return this.final("blocked", m.conflict ? "merge conflict with integration branch" : "merge failed");
      }
      return this.final("done");
    }
  }

  private async final(state: AgentState, reason?: string): Promise<AgentState> {
    const file = this.rc.run.agentResult(this.agentRunId);
    atomicWriteJson(file, {
      task_id: this.task.id,
      agent_run_id: this.agentRunId,
      state,
      reason: reason ?? null,
      finished_at: nowIso(),
      branch: this.branch,
      completed_by: this.userDone ? "user" : "agent",
      result: this.result ?? null,
      review: this.review ?? null,
      verify: this.verifyLog.map((v) => ({ ...v, output: truncateMiddle(v.output, 4000) })),
    });
    this.ev({ type: "result", path: relResult(this.rc.run, this.agentRunId) });
    this.st(state, reason);
    for (const q of this.questions.values()) q.resolve("(cancelled)");
    this.questions.clear();
    this.gate?.resolve();
    this.gate = null;
    if (state === "done") this.notify("done ✔ merged into the integration branch");
    else if (state === "failed") this.notify(`failed: ${reason ?? "see logs"}`);
    return state;
  }

  private async commit(): Promise<void> {
    const changed = await g.uncommittedFiles(this.worktree);
    if (!this.userDone) {
      const outside = changed.filter((f) => !matchesAny(f, this.task.files.write));
      for (const f of outside) {
        const tracked = (await g.git(this.worktree, ["ls-files", "--error-unmatch", f])).ok;
        if (tracked) await g.git(this.worktree, ["checkout", "--", f]);
        else fs.rmSync(path.join(this.worktree, f), { force: true, recursive: true });
      }
      if (outside.length) {
        this.ev({ type: "error", kind: "scope_violation", message: `reverted out-of-scope changes: ${outside.join(", ")}`, retryable: false });
      }
    }
    const message = `${this.task.id}: ${this.task.title}\n\n${this.result?.summary ?? ""}\n\nHexagon-Task: ${this.task.id}\nHexagon-Attempt: ${this.attempt}\nRefs: ${refs(this.task)}`;
    await g.commitAll(this.worktree, message);
    const files = await g.changedFiles(this.worktree, this.baseCommit);
    if (files.length) this.ev({ type: "files", files });
  }

  private async verify(): Promise<{ ok: boolean; cmd: string; code: number; output: string }> {
    for (const cmd of this.task.verify) {
      this.ev({ type: "progress", text: `verify: ${cmd}` });
      const r = await runShell(cmd, this.worktree, this.rc.cfg.sandbox.command_timeout_s, this.abort.signal);
      this.verifyLog.push({ cmd, code: r.code, output: r.output });
      if (r.code !== 0) return { ok: false, cmd, code: r.code, output: r.output };
    }
    return { ok: true, cmd: "", code: 0, output: "" };
  }

  private async runReview(): Promise<ReviewVerdict | undefined> {
    const reviewer = this.rc.adapterFor("reviewer");
    this.review = undefined;
    this.finished = false;
    const diff = await g.diff(this.worktree, this.baseCommit);
    const first = [
      taskCard(this.task, this.rc.specs, { notes: "", files: [] }),
      "",
      "<implementer_report>",
      JSON.stringify(this.result, null, 2),
      "</implementer_report>",
      "",
      "<diff>",
      truncateMiddle(diff, 80_000),
      "</diff>",
      "",
      `Review task ${this.task.id} and call submit_review.`,
    ].join("\n");
    this.abort = new AbortController();
    const out = await reviewer.run({
      role: "reviewer",
      task: this.task,
      effort: this.rc.cfg.roles.reviewer.effort,
      cwd: this.worktree,
      system: systemLayers(this.rc.paths, "reviewer", this.rc.skills, [], this.rc.context),
      firstMessage: first,
      host: this.host("reviewer", null, "review: "),
      signal: this.abort.signal,
      maxTurns: 40,
    });
    if (out.kind === "error") this.ev({ type: "error", ...out.error! });
    return this.review;
  }

  private async userResult(): Promise<ResultEnvelope> {
    const files = [...new Set([...(await g.uncommittedFiles(this.worktree)), ...(await g.changedFiles(this.worktree, this.baseCommit))])];
    return {
      task_id: this.task.id, status: "completed", summary: "Completed manually by the user during takeover.",
      files_changed: files, acceptance_evidence: [], commands_run: [], blockers: [], spec_issues: [], assumptions: [], follow_ups: [],
    };
  }

  // ───────────────────────────── tool host ─────────────────────────────

  private host(role: Role, writeGlobs: string[] | null, progressPrefix = ""): ToolHost {
    const ws = new WorkspaceTools({
      cwd: this.worktree,
      writeGlobs,
      allowCommands: this.rc.cfg.sandbox.allow_commands,
      timeoutS: this.rc.cfg.sandbox.command_timeout_s,
      onFileWritten: (f) => this.ev({ type: "files", files: [f] }),
    });
    const submit = SUBMIT_TOOL[role];
    return {
      tools: toolsForRole(role),
      execute: async (name, input) => {
        await this.gate?.promise;
        if (this.abort.signal.aborted) return { content: "cancelled", is_error: true };
        const errors = validateToolInput(name, input);
        if (errors.length) return { content: `invalid input for ${name}: ${errors.join("; ")}`, is_error: true };
        const args = input as Record<string, unknown>;
        if (name !== "report_status" && name !== "ack") this.ev({ type: "tool_call", name, summary: progressPrefix + summarize(name, args) });
        const res = await this.dispatch(name, args, ws, submit);
        if (name !== "report_status" && name !== "ack") {
          this.ev({ type: "tool_result", name, ok: !res.is_error, summary: res.content.split("\n")[0]!.slice(0, 160) });
        }
        return res;
      },
      drainInbox: () => this.drain(),
      isFinished: () => this.finished,
      emit: (e) => this.ev(e.type === "progress" ? { ...e, text: progressPrefix + e.text } : e),
    };
  }

  private async dispatch(name: string, a: Record<string, unknown>, ws: WorkspaceTools, submit?: string): Promise<ToolOutcome> {
    switch (name) {
      case "list_files": case "read_file": case "write_file": case "edit_file": case "run_cmd":
        return ws.run(name, a, this.abort.signal);
      case "git_diff":
        return { content: truncateMiddle(await g.diff(this.worktree, this.baseCommit, Boolean(a.stat_only)), 80_000) || "(no changes)" };
      case "report_status":
        this.ev({ type: "status_report", phase: a.phase as never, activity: a.activity as string | undefined, checklist: a.checklist as never });
        return { content: "ok" };
      case "ask_user":
        return this.ask(a);
      case "post_note":
        this.rc.router.send({ from: { kind: "agent", id: this.task.id }, to: { kind: "blackboard" }, type: "note", body: String(a.body), refs: (a.refs as string[]) ?? [] });
        return { content: "note posted to the blackboard" };
      case "request_change": {
        const body = `Change requested outside scope (${(a.outside_scope as string[]).join(", ")}): ${String(a.why)}`;
        this.rc.router.send({ from: { kind: "agent", id: this.task.id }, to: { kind: "orchestrator" }, type: "request", body });
        this.notify(body);
        return { content: "request recorded; the user has been notified. Continue within your scope or submit status blocked if you cannot." };
      }
      case "ack": {
        const acked = this.rc.router.ack(a.message_ids as string[]);
        for (const m of acked) this.ev({ type: "message_acked", message_id: m.id });
        return { content: `acknowledged ${acked.length}` };
      }
      case "submit_result": {
        if (submit !== "submit_result") return { content: "not available for this role", is_error: true };
        const r = { ...(a as unknown as ResultEnvelope), task_id: this.task.id };
        r.assumptions ??= [];
        const v = validateResult(r);
        if (!v.ok) return { content: `result rejected: ${v.errors.join("; ")}. Fix and call submit_result again.`, is_error: true };
        this.result = r;
        this.finished = true;
        return { content: "result received; the orchestrator will verify it" };
      }
      case "submit_review":
        if (submit !== "submit_review") return { content: "not available for this role", is_error: true };
        this.review = a as unknown as ReviewVerdict;
        this.finished = true;
        return { content: "review received" };
      default:
        return { content: `tool ${name} is not available`, is_error: true };
    }
  }

  private drain(): Injected[] {
    const msgs = this.rc.router.take(this.task.id);
    for (const m of msgs) this.ev({ type: "message_delivered", message_id: m.id });
    return msgs.map((m) => ({ id: m.id, from: m.from.kind === "user" ? "user" : m.from.id ?? m.from.kind, type: m.type, body: m.body }));
  }

  private async ask(a: Record<string, unknown>): Promise<ToolOutcome> {
    const blocking = Boolean(a.blocking);
    if (blocking && this.blockingAsked >= this.rc.cfg.messaging.max_blocking_questions) {
      return { content: "blocking question limit reached for this task; choose the most reasonable option, record it under assumptions, and continue", is_error: true };
    }
    const q: NeedsInput = {
      question_id: this.rc.router.newQuestionId(),
      kind: a.kind as NeedsInput["kind"],
      blocking,
      prompt: String(a.prompt),
      options: (a.options as NeedsInput["options"]) ?? [],
      default_option: (a.default_option as string | undefined) ?? null,
      auto_answer_after_s: null,
      asked_at: nowIso(),
      refs: (a.refs as string[]) ?? [],
    };
    const [msg] = this.rc.router.send({ from: { kind: "agent", id: this.task.id }, to: { kind: "user" }, type: "question", body: q.prompt, question: q, priority: blocking ? "urgent" : "normal" });
    this.ev({ type: "question", question: q });
    if (!blocking) {
      this.openNonBlocking.set(q.question_id, { q, messageId: msg!.id });
      return { content: `Question ${q.question_id} sent. Not answered yet — proceed with ${q.default_option ? `"${q.default_option}"` : "your best judgment"} and record it under assumptions. A later answer arrives as a <user_message>.` };
    }
    this.blockingAsked++;
    const prev = this.state;
    this.st("waiting_input", `${q.question_id}: ${q.prompt.slice(0, 120)}`);
    const answer = await new Promise<string>((resolve) => this.questions.set(q.question_id, { resolve, q, messageId: msg!.id }));
    if (!this.cancelled && this.state === "waiting_input") this.st(prev === "waiting_input" ? "running" : prev);
    return { content: `The user answered ${q.question_id}: ${answer}` };
  }

  // ───────────────────────────── controls ─────────────────────────────

  openQuestionIds(): string[] {
    return [...this.questions.keys(), ...this.openNonBlocking.keys()];
  }

  answer(questionId: string, text: string): boolean {
    const blocking = this.questions.get(questionId);
    const open = blocking ?? this.openNonBlocking.get(questionId);
    if (!open) return false;
    const opt = open.q.options?.find((o) => o.id === text.trim());
    const answer = opt ? `${opt.id}) ${opt.label}` : text;
    this.rc.router.send({
      from: { kind: "user" }, to: { kind: "agent", id: this.task.id }, type: "answer", body: answer, reply_to: open.messageId,
    });
    this.ev({ type: "answered", question_id: questionId, answer });
    if (blocking) {
      this.questions.delete(questionId);
      this.rc.router.take(this.task.id); // delivered via the tool result, not the inbox
      blocking.resolve(answer);
    } else {
      this.openNonBlocking.delete(questionId);
    }
    return true;
  }

  pause(reason = "paused by user"): boolean {
    if (this.gate || ["queued", "done", "failed", "blocked", "cancelled"].includes(this.state)) return false;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    this.gate = { promise, resolve };
    this.stateBeforePause = this.state === "paused" ? "running" : this.state;
    this.st("paused", `${reason} (takes effect at the next safe point)`);
    return true;
  }

  resume(): boolean {
    if (!this.gate) return false;
    this.gate.resolve();
    this.gate = null;
    this.ev({ type: "controller", controller: "agent" });
    this.st(this.stateBeforePause);
    return true;
  }

  cancel(): void {
    this.cancelled = true;
    this.abort.abort();
    for (const q of this.questions.values()) q.resolve("(cancelled)");
    this.gate?.resolve();
  }

  async takeover(): Promise<{ worktree: string; branch: string; command: string[] }> {
    if (!this.pause("user takeover")) {
      if (this.state !== "paused") throw new Error(`${this.task.id} is ${this.state}; nothing to take over`);
    }
    this.takeoverCommit = await g.revParse(this.worktree, "HEAD");
    this.ev({ type: "controller", controller: "user" });
    return { worktree: this.worktree, branch: this.branch, command: [process.env.SHELL ?? "/bin/zsh"] };
  }

  async endTakeover(action: "handback" | "done" | "discard"): Promise<void> {
    if (action === "discard" && this.takeoverCommit) await g.resetHard(this.worktree, this.takeoverCommit);
    if (action === "done") {
      this.userDone = true;
      this.abort.abort();
      this.gate?.resolve();
      this.gate = null;
      return;
    }
    const changed = await g.uncommittedFiles(this.worktree);
    if (action === "handback" && changed.length) {
      this.rc.router.send({
        from: { kind: "orchestrator" }, to: { kind: "agent", id: this.task.id }, type: "handoff",
        body: `The user edited the workspace directly while you were paused. Changed files: ${changed.join(", ")}. Re-read them before continuing.`,
      });
      this.ev({ type: "files", files: changed });
    }
    this.resume();
  }
}

function refs(t: Task): string {
  return t.requirements.flatMap((r) => (t.acceptance.length ? t.acceptance.map((a) => `${r}/${a}`) : [r])).join(", ");
}

function summarize(name: string, a: Record<string, unknown>): string {
  switch (name) {
    case "read_file": case "write_file": case "edit_file": return `${name} ${String(a.path)}`;
    case "list_files": return `list_files ${String(a.dir)}`;
    case "run_cmd": return `run ${String(a.cmd)}`;
    case "ask_user": return `ask user: ${String(a.prompt).slice(0, 100)}`;
    case "post_note": return `note: ${String(a.body).slice(0, 100)}`;
    default: return name;
  }
}

/** Light-weight host for the planner (no task, no worktree writes). */
export async function runPlanner(opts: {
  root: string; paths: ProjectPaths; cfg: HexagonConfig; specs: Spec[]; skills: Skill[]; context: string;
  adapter: AgentAdapter; onEvent: (e: AgentEvent) => void; signal?: AbortSignal;
}): Promise<{ tasks: Task[]; spec_issues: string[] }> {
  const ws = new WorkspaceTools({ cwd: opts.root, writeGlobs: null, allowCommands: [], timeoutS: 60 });
  let submitted: { tasks: Task[]; spec_issues: string[] } | undefined;
  const host: ToolHost = {
    tools: toolsForRole("planner"),
    execute: async (name, input) => {
      const errors = validateToolInput(name, input);
      if (errors.length) return { content: `invalid input for ${name}: ${errors.join("; ")}`, is_error: true };
      const a = input as Record<string, unknown>;
      if (name === "report_status") { opts.onEvent({ type: "status_report", activity: a.activity as string, phase: a.phase as never }); return { content: "ok" }; }
      if (name === "ask_user") return { content: "The user is not available during planning; record the question in spec_issues instead.", is_error: true };
      if (name === "submit_plan") {
        const tasks = a.tasks as Task[];
        const { checkPlan } = await import("./plan.js");
        const draft: Plan = { schema: "hexagon.plan/v1", id: "draft", created_at: nowIso(), specs: [], tasks, spec_issues: (a.spec_issues as string[]) ?? [] };
        const check = checkPlan(draft, opts.specs);
        if (check.errors.length) return { content: `plan rejected: ${check.errors.join("; ")}`, is_error: true };
        submitted = { tasks, spec_issues: draft.spec_issues };
        return { content: `plan accepted${check.warnings.length ? ` with warnings: ${check.warnings.join("; ")}` : ""}` };
      }
      opts.onEvent({ type: "tool_call", name, summary: summarize(name, a) });
      return ws.run(name, a);
    },
    drainInbox: () => [],
    isFinished: () => submitted !== undefined,
    emit: opts.onEvent,
  };
  const specText = opts.specs.map((s) => `<spec file="${path.relative(opts.root, s.file)}">\n${s.raw}\n</spec>`).join("\n\n");
  const out = await opts.adapter.run({
    role: "planner",
    effort: opts.cfg.roles.planner.effort,
    cwd: opts.root,
    system: systemLayers(opts.paths, "planner", opts.skills, [], opts.context),
    firstMessage: `${specText}\n\nPlan these specifications and call submit_plan.`,
    host,
    signal: opts.signal ?? new AbortController().signal,
    maxTurns: 60,
    specs: opts.specs,
  });
  if (!submitted) throw new Error(out.error?.message ?? "planner did not submit a plan");
  return submitted;
}

export type { ErrorKind };
