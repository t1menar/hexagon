import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentEvent, AgentState, Effort, ErrorKind, Message, NeedsInput, ResultEnvelope, ReviewVerdict, Role, Task,
} from "../contracts/types.js";
import { validateResult } from "../contracts/validate.js";
import { systemPrompt, taskCard, type Skill } from "../agents/prompts.js";
import type { AdapterOutcome, AgentAdapter, AgentApi, AgentHost, AgentRunContext, Injected, Reply } from "../agents/types.js";
import { atomicWriteJson, matchesAny, nowIso, truncateMiddle } from "../util/fsx.js";
import { runShell } from "../util/shell.js";
import type { HexagonConfig } from "./config.js";
import * as g from "./git.js";
import type { ProjectPaths, RunPaths } from "./project.js";
import type { ApiRegistry } from "./registry.js";
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
  registry: ApiRegistry;
  specs: Spec[];
  skills: Skill[];
  context: string;
  integration: { branch: string; worktree: string };
  adapterFor(role: Role, override?: string | null): AgentAdapter;
  /** Environment for agent processes: lets them run `hexagon report|ask|…`. */
  agentEnv(agentId: string): Record<string, string>;
}

interface Gate { promise: Promise<void>; resolve: () => void }

/** Supervises one attempt of one task. The only writer of its status (through the store). */
export class AgentRun {
  readonly agentRunId: string;
  readonly worktree: string;
  readonly branch: string;
  readonly sessionId = randomUUID();
  private abort = new AbortController();
  private gate: Gate | null = null;
  private resumeNote: string | null = null;
  private questions = new Map<string, { q: NeedsInput; messageId: string }>();
  private blockingAsked = 0;
  private finished = false;
  private started = false;
  private result: ResultEnvelope | undefined;
  private review: ReviewVerdict | undefined;
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
        s.attach = {
          native_session_id: this.sessionId,
          takeover_command: this.adapter.takeoverCommand(this.sessionId) ?? [process.env.SHELL ?? "/bin/zsh"],
          supports_live_input: this.adapter.supportsLiveInput,
        };
      });
    } catch (e) {
      this.ev({ type: "error", kind: "internal", message: String(e), retryable: false });
      return this.final("failed", "could not create worktree");
    }
    const unregister = this.rc.registry.register(this.agentRunId, this.api());
    try {
      return await this.pipeline();
    } finally {
      unregister();
    }
  }

  /** The agent's CLI session exists, so a finished attempt can be continued in place. */
  get resumable(): boolean {
    return this.started && fs.existsSync(this.worktree);
  }

  /** Continue a blocked/failed/cancelled attempt: same worktree, same session, the user's message as the next turn. */
  async continueWith(text: string): Promise<AgentState> {
    this.cancelled = false;
    this.userDone = false;
    this.ev({ type: "chat", from: "user", text });
    const unregister = this.rc.registry.register(this.agentRunId, this.api());
    try {
      return await this.pipeline(`Message from the user:\n${text}\n\nContinue the task with this in mind. When it is finished, run \`hexagon done\` again.`, true);
    } finally {
      unregister();
    }
  }

  private async pipeline(initial?: string, initialFromUser = false): Promise<AgentState> {
    let followUp: string | undefined = initial;
    let quiet = initialFromUser;
    let fixLoops = 0;
    for (;;) {
      // 1. Implement (or fix)
      this.finished = false;
      this.result = undefined;
      const outcome = await this.agentSegment(followUp, quiet);
      followUp = undefined;
      quiet = false;

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
        this.ev({ type: "error", kind: "invalid_output", message: "the agent stopped without running `hexagon done`", retryable: true });
        return this.final("failed", "no result reported");
      }
      if (r.status === "needs_spec_change" || r.status === "blocked") {
        this.notify(`${r.status.replace(/_/g, " ")}: ${[...r.blockers, ...r.spec_issues].join("; ") || r.summary}`);
        if (r.status === "needs_spec_change") this.ev({ type: "error", kind: "needs_spec_change", message: r.summary, retryable: false });
        await this.commit();
        return this.final("blocked", r.status === "blocked" ? r.blockers.join("; ") || r.summary : `needs spec change: ${r.spec_issues.join("; ")}`);
      }
      if (r.status === "failed") {
        this.ev({ type: "error", kind: "internal", message: r.summary, retryable: true });
        return this.final("failed", r.summary);
      }
      if (!this.userDone && this.rc.router.pending(this.task.id) > 0) {
        followUp = "New messages arrived before you finished. Apply them, then run `hexagon done` again.";
        continue;
      }

      // 2. Scope + commit
      await this.commit();

      // 3. Verify
      this.st("verifying", this.task.verify.length ? `running ${this.task.verify.length} command(s)` : "no verify commands");
      const v = await this.verify();
      if (this.cancelled) return this.final("cancelled", "cancelled by user");
      if (!v.ok) {
        this.ev({ type: "error", kind: "verify_failed", message: `\`${v.cmd}\` exited ${v.code}`, retryable: true });
        if (fixLoops++ < this.rc.cfg.run.fix_loops && !this.userDone) {
          followUp = `Hexagon re-ran verification and it failed.\n\n$ ${v.cmd}\n(exit ${v.code})\n${truncateMiddle(v.output, 12_000)}\n\nFix the problem, re-run the command yourself, then run \`hexagon done\` again.`;
          continue;
        }
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
            followUp = `The reviewer requested changes:\n${rv.summary}\n${rv.findings.map((f) => `- [${f.severity}] ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.issue}${f.suggestion ? ` → ${f.suggestion}` : ""}`).join("\n")}\n\nAddress the high and medium findings, then run \`hexagon done\` again.`;
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

  /** Run the agent CLI until it finishes. Pause/takeover kill the process; resume continues the same session. */
  private async agentSegment(followUp?: string, quiet = false): Promise<AdapterOutcome> {
    let fu = followUp;
    if (quiet) {
      // already shown in the chat as the user's message
    } else if (!this.started) {
      const acs = this.task.acceptance.length ? ` (${this.task.acceptance.join(", ")})` : "";
      this.ev({ type: "chat", from: "hexagon", text: `Task ${this.task.id}: ${this.task.title}${acs}\nWrite scope: ${this.task.files.write.join(", ")}${this.task.verify.length ? `\nVerify: ${this.task.verify.join(" && ")}` : ""}` });
    } else if (fu) {
      this.ev({ type: "chat", from: "hexagon", text: truncateMiddle(fu, 2000) });
    }
    for (;;) {
      this.st(this.questions.size ? "waiting_input" : "running");
      this.abort = new AbortController();
      const out = await this.adapter.run(this.ctx({
        role: this.task.role,
        sessionId: this.sessionId,
        resume: this.started,
        followUp: fu,
        prompt: taskCard(this.task, this.rc.specs, this.rc.router.notes()),
        system: systemPrompt(this.rc.paths, this.task.role, this.agentRunId, this.rc.skills, this.task.skills, this.rc.context),
        readOnly: false,
        api: this.api(),
        host: this.host(),
        agentId: this.agentRunId,
      }));
      if (out.kind !== "error") this.started = true;
      if (this.cancelled || this.userDone) return out;
      if (out.kind === "interrupted" && this.gate) {
        await this.gate.promise;
        if (this.cancelled || this.userDone) return out;
        fu = this.resumeNote ?? "You were paused by the user. Continue the task where you left off.";
        this.resumeNote = null;
        continue;
      }
      return out;
    }
  }

  private ctx(o: { role: Role; sessionId: string; resume: boolean; followUp?: string; prompt: string; system: string; readOnly: boolean; api: AgentApi; host: AgentHost; agentId: string }): AgentRunContext {
    return {
      agentRunId: o.agentId,
      role: o.role,
      task: this.task,
      effort: o.role === "reviewer" ? this.rc.cfg.roles.reviewer.effort : this.effort,
      cwd: this.worktree,
      system: o.system,
      prompt: o.prompt,
      followUp: o.followUp,
      sessionId: o.sessionId,
      resume: o.resume,
      env: this.rc.agentEnv(o.agentId),
      allowCommands: this.rc.cfg.sandbox.allow_commands,
      readOnly: o.readOnly,
      host: o.host,
      api: o.api,
      signal: this.abort.signal,
      specs: this.rc.specs,
    };
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
      session_id: this.sessionId,
      completed_by: this.userDone ? "user" : "agent",
      result: this.result ?? null,
      review: this.review ?? null,
      verify: this.verifyLog.map((v) => ({ ...v, output: truncateMiddle(v.output, 4000) })),
    });
    const undelivered = this.rc.router.pending(this.task.id);
    if (undelivered) {
      this.rc.router.expire(this.task.id, `agent finished (${state})`);
      this.rc.store.patch(this.agentRunId, (s) => { s.inbox.pending = 0; });
      this.ev({ type: "chat", from: "hexagon", text: `${undelivered} message(s) arrived after the agent finished and were not delivered. To act on them, /retry ${this.task.id} and send them again.` });
    }
    this.ev({ type: "result", path: relResult(this.rc.run, this.agentRunId) });
    this.st(state, reason);
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
    if (this.result) this.result.files_changed = files;
  }

  private async verify(): Promise<{ ok: boolean; cmd: string; code: number; output: string }> {
    this.abort = new AbortController();
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
    const id = `${this.agentRunId}.review`;
    let verdict: ReviewVerdict | undefined;
    const api: AgentApi = {
      report: (r) => { this.ev({ type: "progress", text: `review: ${r.activity ?? ""}` }); return ok("ok"); },
      ask: () => ({ ok: false, message: "Reviewers can't ask the user; put open points in your findings." }),
      note: () => ok("ok"),
      done: () => ({ ok: false, message: "Reviewers finish with `hexagon review approve|changes`." }),
      review: (v) => {
        const verdictName = (v.verdict as string) === "changes" ? "request_changes" : v.verdict;
        verdict = { verdict: verdictName as ReviewVerdict["verdict"], summary: v.summary ?? "", findings: v.findings ?? [] };
        return ok("Review recorded. End your turn now.");
      },
    };
    const unregister = this.rc.registry.register(id, api);
    const diff = await g.diff(this.worktree, this.baseCommit);
    const prompt = [
      taskCard(this.task, this.rc.specs, ""),
      "",
      "<implementer_report>",
      JSON.stringify(this.result, null, 2),
      "</implementer_report>",
      "",
      `<diff base="${this.baseCommit.slice(0, 12)}">`,
      truncateMiddle(diff, 60_000),
      "</diff>",
      "",
      `Review task ${this.task.id} (the diff above is \`git diff ${this.baseCommit.slice(0, 12)}\`; you may read files and run the verify commands). Finish with \`hexagon review\`.`,
    ].join("\n");
    this.abort = new AbortController();
    try {
      const out = await reviewer.run(this.ctx({
        role: "reviewer",
        sessionId: randomUUID(),
        resume: false,
        prompt,
        system: systemPrompt(this.rc.paths, "reviewer", id, this.rc.skills, [], this.rc.context),
        readOnly: true,
        api,
        agentId: id,
        host: {
          emit: (e) => this.ev(e.type === "progress" ? { ...e, text: `review: ${e.text}` } : e.type === "tool_call" ? { ...e, summary: `review: ${e.summary}` } : e),
          drainInbox: () => [],
          onInbox: () => () => undefined,
          received: () => undefined,
          isFinished: () => verdict !== undefined,
          hasBlockingQuestion: () => false,
        },
      }));
      if (out.kind === "error") this.ev({ type: "error", ...out.error! });
    } finally {
      unregister();
    }
    return verdict;
  }

  private async userResult(): Promise<ResultEnvelope> {
    const files = [...new Set([...(await g.uncommittedFiles(this.worktree)), ...(await g.changedFiles(this.worktree, this.baseCommit))])];
    return {
      task_id: this.task.id, status: "completed", summary: "Completed manually by the user during takeover.",
      files_changed: files, acceptance_evidence: [], commands_run: [], blockers: [], spec_issues: [], assumptions: [], follow_ups: [],
    };
  }

  // ───────────────────────────── agent side ─────────────────────────────

  private host(): AgentHost {
    return {
      emit: (e) => this.ev(e),
      drainInbox: () => this.drain(),
      onInbox: (cb) => {
        const listener = (m: Message) => {
          if (m.to.kind === "agent" && m.to.id === this.task.id && m.delivery.state === "queued") cb();
        };
        this.rc.router.on("message", listener);
        return () => this.rc.router.off("message", listener);
      },
      received: (id) => {
        for (const m of this.rc.router.ack([id])) this.ev({ type: "message_acked", message_id: m.id });
      },
      isFinished: () => this.finished,
      hasBlockingQuestion: () => this.questions.size > 0,
    };
  }

  private drain(): Injected[] {
    const msgs = this.rc.router.take(this.task.id);
    for (const m of msgs) this.ev({ type: "message_delivered", message_id: m.id });
    return msgs.map((m) => ({ id: m.id, from: m.from.kind === "user" ? "user" : m.from.id ?? m.from.kind, type: m.type, body: m.body }));
  }

  private api(): AgentApi {
    return {
      report: (r) => {
        const checklist = (r.done ?? []).map((id) => ({ id, status: "done" as const }));
        this.ev({ type: "status_report", phase: r.phase, activity: r.activity, checklist: checklist.length ? checklist : undefined });
        return ok("ok");
      },
      ask: (a) => this.ask(a),
      note: (body) => {
        this.rc.router.send({ from: { kind: "agent", id: this.task.id }, to: { kind: "blackboard" }, type: "note", body });
        return ok("Note shared with the other agents.");
      },
      done: (d) => {
        const r: ResultEnvelope = {
          task_id: this.task.id,
          status: d.status ?? "completed",
          summary: d.summary ?? "",
          files_changed: [],
          acceptance_evidence: d.acceptance_evidence ?? [],
          commands_run: d.commands_run ?? [],
          blockers: d.blockers ?? [],
          spec_issues: d.spec_issues ?? [],
          assumptions: d.assumptions ?? [],
          follow_ups: d.follow_ups ?? [],
        };
        const v = validateResult(r);
        if (!v.ok) return { ok: false, message: `Result rejected: ${v.errors.join("; ")}. Fix it and run \`hexagon done\` again.` };
        if (!r.summary.trim()) return { ok: false, message: "Add --summary \"<what you did>\" and run `hexagon done` again." };
        this.result = r;
        this.finished = true;
        if (r.acceptance_evidence.length) {
          this.ev({ type: "status_report", checklist: r.acceptance_evidence.map((e) => ({ id: e.ac, status: "done" as const })) });
        }
        return ok("Result recorded. Hexagon will now verify, review and merge your work. End your turn now.");
      },
      review: () => ({ ok: false, message: "Only the reviewer can run `hexagon review`." }),
    };
  }

  private ask(a: { prompt: string; options?: string[]; default?: string; blocking: boolean }): Reply {
    if (this.blockingAsked >= this.rc.cfg.messaging.max_blocking_questions) {
      return { ok: false, message: "Question limit reached for this task. Choose the most reasonable option, record it with `--assume` when you finish, and continue." };
    }
    if (!a.prompt?.trim()) return { ok: false, message: "Usage: hexagon ask \"<question>\" [--option \"…\"]" };
    const options = (a.options ?? []).map((label, i) => ({ id: String(i + 1), label }));
    const q: NeedsInput = {
      question_id: this.rc.router.newQuestionId(),
      kind: options.length ? "choice" : "clarification",
      blocking: true,
      prompt: a.prompt.trim(),
      options,
      default_option: a.default ? options.find((o) => o.label === a.default)?.id ?? null : null,
      auto_answer_after_s: null,
      asked_at: nowIso(),
      refs: [],
    };
    const [msg] = this.rc.router.send({ from: { kind: "agent", id: this.task.id }, to: { kind: "user" }, type: "question", body: q.prompt, question: q, priority: "urgent" });
    this.blockingAsked++;
    this.questions.set(q.question_id, { q, messageId: msg!.id });
    this.ev({ type: "question", question: q });
    this.st("waiting_input", `${q.question_id}: ${q.prompt.slice(0, 120)}`);
    return ok(`Question ${q.question_id} was sent to the user. End your turn now; the answer will arrive as your next message.`);
  }

  // ───────────────────────────── controls ─────────────────────────────

  openQuestionIds(): string[] {
    return [...this.questions.keys()];
  }

  answer(questionId: string, text: string): boolean {
    const open = this.questions.get(questionId);
    if (!open) return false;
    const opt = open.q.options?.find((o) => o.id === text.trim() || o.label.toLowerCase() === text.trim().toLowerCase());
    const answer = opt ? `${opt.id}) ${opt.label}` : text;
    this.questions.delete(questionId);
    this.ev({ type: "answered", question_id: questionId, answer });
    this.ev({ type: "chat", from: "user", text: answer });
    if (this.state === "waiting_input" && !this.questions.size) this.st(this.gate ? "paused" : "running");
    // Delivered to the agent through its inbox (live, or when it resumes).
    this.rc.router.send({
      from: { kind: "user" }, to: { kind: "agent", id: this.task.id }, type: "answer",
      body: `Answer to ${questionId} ("${open.q.prompt}"): ${answer}`, reply_to: open.messageId,
    });
    return true;
  }

  pause(reason = "paused by user"): boolean {
    if (this.gate || !["starting", "running", "waiting_input"].includes(this.state)) return false;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    this.gate = { promise, resolve };
    this.st("paused", reason);
    this.abort.abort(); // stops the agent CLI; resume continues the same session
    return true;
  }

  resume(): boolean {
    if (!this.gate) return false;
    this.gate.resolve();
    this.gate = null;
    this.ev({ type: "controller", controller: "agent" });
    return true;
  }

  cancel(): void {
    this.cancelled = true;
    this.abort.abort();
    this.gate?.resolve();
  }

  async takeover(): Promise<{ worktree: string; branch: string; command: string[] }> {
    if (!this.pause("user takeover") && this.state !== "paused") {
      throw new Error(`${this.task.id} is ${this.state}; nothing to take over`);
    }
    this.takeoverCommit = await g.revParse(this.worktree, "HEAD");
    this.ev({ type: "controller", controller: "user" });
    const native = this.started ? this.adapter.takeoverCommand(this.sessionId) : null;
    return { worktree: this.worktree, branch: this.branch, command: native ?? [process.env.SHELL ?? "/bin/zsh"] };
  }

  async endTakeover(action: "handback" | "done" | "discard"): Promise<void> {
    if (action === "discard" && this.takeoverCommit) await g.resetHard(this.worktree, this.takeoverCommit);
    if (action === "done") {
      this.userDone = true;
      this.gate?.resolve();
      this.gate = null;
      return;
    }
    const changed = await g.uncommittedFiles(this.worktree);
    this.resumeNote = changed.length && action === "handback"
      ? `The user took over this session and edited the workspace directly. Changed files: ${changed.join(", ")}. Re-read them, then continue the task.`
      : "The user took over this session and has handed it back to you. Continue the task.";
    if (changed.length) this.ev({ type: "files", files: changed });
    this.resume();
  }
}

const ok = (message: string): Reply => ({ ok: true, message });

function refs(t: Task): string {
  return t.requirements.flatMap((r) => (t.acceptance.length ? t.acceptance.map((a) => `${r}/${a}`) : [r])).join(", ") || t.id;
}

export type { ErrorKind };
