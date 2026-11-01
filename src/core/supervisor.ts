import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentEvent, AgentState, Effort, ErrorKind, Message, NeedsInput, ResultEnvelope, ReviewVerdict, Role, Task,
} from "../contracts/types.js";
import { validateResult } from "../contracts/validate.js";
import { systemPrompt, taskCard, type Skill } from "../agents/prompts.js";
import type { AdapterOutcome, AgentAdapter, AgentApi, AgentHost, AgentRunContext, Injected, Reply } from "../agents/types.js";
import { classifyProviderError, recoveryFor } from "../agents/contracts/errors.js";
import { planRetry, waitTooLong, type WaitStore } from "./recovery.js";
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
  /** Persistent retry schedule for provider-limit waits. */
  waits?: WaitStore;
  /** All tasks of the run (for areas of responsibility). */
  tasks: Task[];
  /** Reopen task `to` with a defect report from `from`; resolves when `to` finishes again. */
  returnTask(from: string, to: string, issue: string): { ok: true; done: Promise<{ state: AgentState; summary: string }> } | { ok: false; message: string };
  /** Environment for agent processes: lets them run `hexagon report|ask|…`. */
  agentEnv(agentId: string): Record<string, string>;
}

interface Gate { promise: Promise<void>; resolve: () => void }

/** Supervises one attempt of one task. The only writer of its status (through the store). */
export class AgentRun {
  readonly agentRunId: string;
  readonly worktree: string;
  readonly branch: string;
  sessionId: string = randomUUID();
  /** Provider-limit recovery bookkeeping: none of it touches quality fix cycles or attempts. */
  private waitCount = 0;
  private contextRecoveries = 0;
  private blockedReason: string | null = null;
  private quotaWake: (() => void) | null = null;
  /** The daemon is stopping while this run waits: keep the persisted wait, do not mark it cancelled. */
  private detached = false;
  /** The last instruction that asked for rework (verify output / reviewer findings): survives context compaction. */
  private outstanding: string | null = null;
  private failedOver = false;
  private abort = new AbortController();
  private gate: Gate | null = null;
  private resumeNote: string | null = null;
  private restarting = false;
  /** Set by `hexagon return`: this agent waits until the other task's fix is merged. */
  private waiting: { task: string; issue: string; done: Promise<{ state: AgentState; summary: string }> } | null = null;
  private wake: (() => void) | null = null;
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
    public adapter: AgentAdapter,
    private resumeWait?: { sessionId: string; nextRetryAt: string },
  ) {
    if (resumeWait) { this.sessionId = resumeWait.sessionId; this.started = true; }
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
    if (this.resumeWait) return this.executeResumed();
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

  /** After a daemon restart: same worktree, branch and CLI session; wait out the remaining time, then continue. */
  private async executeResumed(): Promise<AgentState> {
    const w = this.resumeWait!;
    await g.addWorktree(this.rc.root, this.worktree, this.branch, this.rc.integration.branch); // no-op when it exists
    this.baseCommit = await g.revParse(this.worktree, "HEAD").catch(() => "");
    const unregister = this.rc.registry.register(this.agentRunId, this.api());
    try {
      const ec = this.rc.store.get(this.agentRunId)?.recovery;
      this.st("waiting_quota", `daemon restarted; still waiting for the provider (${ec?.cls ?? "limit"}) — resumes automatically`);
      if (!(await this.sleepUntil(w.nextRetryAt))) {
        if (this.detached) return this.state;
        this.rc.waits?.finish(this.agentRunId, "cancelled");
        return this.final("cancelled", "cancelled by user");
      }
      this.rc.waits?.claim(this.agentRunId, new Date(Date.now() + 1000));
      this.rc.waits?.finish(this.agentRunId, "recovered");
      this.ev({ type: "recovery", phase: "resumed", cls: ec?.cls ?? "limit", message: "resumed after daemon restart; continuing the same task and session" });
      return await this.pipeline("The provider limit has cleared (Hexagon was restarted meanwhile). Check the worktree state and continue the task where you left off, then run `hexagon done`.", true);
    } finally {
      unregister();
    }
  }

  /** The agent's CLI session exists, so a finished attempt can be continued in place. */
  /** One line on how the attempt ended (for agents waiting on it). */
  get outcomeSummary(): string {
    return this.result?.summary || this.rc.store.get(this.agentRunId)?.state_reason || this.state;
  }

  get resumable(): boolean {
    return this.started && fs.existsSync(this.worktree);
  }

  /** Continue a blocked/failed/cancelled attempt: same worktree, same session, the user's message as the next turn. */
  async continueWith(text: string, from: "user" | "hexagon" = "user"): Promise<AgentState> {
    this.cancelled = false;
    this.userDone = false;
    this.ev({ type: "chat", from, text });
    const unregister = this.rc.registry.register(this.agentRunId, this.api());
    try {
      const body = from === "user" ? `Message from the user:\n${text}\n\nContinue the task with this in mind. When it is finished, run \`hexagon done\` again.` : text;
      return await this.pipeline(body, true);
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
      if (followUp && !initialFromUser) this.outstanding = followUp;
      const outcome = await this.agentSegment(followUp, quiet);
      followUp = undefined;
      quiet = false;

      if (this.detached) return this.state; // daemon stopping during a limit wait: state stays "waiting_quota" on disk
      if (this.cancelled) return this.final("cancelled", "cancelled by user");
      if (this.waiting) {
        followUp = await this.waitForReturn(this.waiting);
        this.waiting = null;
        if (this.cancelled) return this.final("cancelled", "cancelled by user");
        continue;
      }
      if (this.userDone) {
        this.result = await this.userResult();
      } else if (outcome.kind === "error" && this.blockedReason) {
        this.notify(`blocked: ${this.blockedReason}`);
        return this.final("blocked", this.blockedReason);
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
        const stuck = this.noProgress(`verify:${v.cmd}:${v.code}:${v.output.slice(-600)}`);
        if (stuck) return this.final("failed", stuck);
        if (this.mayFix(++fixLoops) && !this.userDone) {
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
          const stuck = this.noProgress(`review:${rv.summary}:${rv.findings.map((f) => f.issue).join("|")}`);
          if (stuck) return this.final("failed", stuck);
          if (this.mayFix(++fixLoops)) {
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
        prompt: taskCard(this.task, this.rc.specs, this.rc.router.notes(), this.rc.tasks.filter((t) => t.id !== this.task.id)),
        system: systemPrompt(this.rc.paths, this.task.role, this.agentRunId, this.rc.skills, this.task.skills, this.rc.context),
        readOnly: false,
        api: this.api(),
        host: this.host(),
        agentId: this.agentRunId,
      }));
      if (out.kind !== "error") this.started = true;
      if (out.kind === "error" && this.rc.cfg.recovery.enabled && !this.cancelled && !this.userDone) {
        const next = await this.recoverFromLimit(out);
        if (next.retry) { fu = next.followUp; this.restarting = false; continue; }
        return next.outcome ?? out;
      }
      if (this.cancelled || this.userDone) return out;
      if (out.kind === "interrupted" && (this.gate || this.restarting)) {
        this.restarting = false;
        await this.gate?.promise;
        if (this.cancelled || this.userDone) return out;
        fu = this.resumeNote ?? "You were paused by the user. Continue the task where you left off.";
        this.resumeNote = null;
        continue;
      }
      return out;
    }
  }

  /**
   * A provider limit is not a quality failure. Classify what the CLI printed and apply that class's policy:
   * wait (rate limit / quota / overload), compact and start a fresh session (context), continue (truncated output),
   * or block for the user (auth / billing). None of these consumes a fix cycle or an attempt.
   */
  private async recoverFromLimit(out: AdapterOutcome): Promise<{ retry: boolean; followUp?: string; outcome?: AdapterOutcome }> {
    const e = out.error!;
    const c = classifyProviderError(e.raw ?? e.message);
    const action = recoveryFor(c.cls);
    const rec = this.rc.cfg.recovery;
    if (action === "none") return { retry: false };
    const orig = e.message.slice(0, 300);

    if (action === "block_for_user") {
      this.ev({ type: "recovery", phase: "blocked", cls: c.cls, message: orig });
      this.blockedReason = c.cls === "billing"
        ? `billing/plan problem reported by ${this.adapter.displayName}: ${orig}. Fix it, then /retry ${this.task.id}.`
        : `${this.adapter.displayName} rejected its credentials: ${orig}. Log in again, then /retry ${this.task.id}.`;
      return { retry: false };
    }

    if (action === "continue_output") {
      this.ev({ type: "recovery", phase: "resumed", cls: c.cls, message: "output was cut off; asking the agent to continue (result will be verified)" });
      return { retry: true, followUp: "Your previous response was cut off before you finished. Continue exactly where you stopped, then run `hexagon done` when the task is complete." };
    }

    if (action === "compact_and_resume") {
      if (++this.contextRecoveries > rec.max_context_recoveries) return { retry: false };
      this.sessionId = randomUUID();
      this.started = false; // a fresh session with a smaller, reconstructed context
      this.ev({ type: "recovery", phase: "compacted", cls: c.cls, message: `context window exceeded; starting a new session with a compact summary (${this.contextRecoveries}/${rec.max_context_recoveries})` });
      return { retry: true, followUp: this.compactedContext() };
    }

    // wait_and_resume
    if (!rec.auto_resume) {
      this.blockedReason = `${this.adapter.displayName} hit a ${c.cls.replace(/_/g, " ")}: ${orig}. Automatic resume is disabled; /retry ${this.task.id} when it is available.`;
      return { retry: false };
    }
    if (c.cls === "quota_exhausted" && !rec.unlimited_quota_wait && rec.max_wait_seconds === 0) return { retry: false };
    // Optional, explicitly enabled failover to another configured agent for this role.
    const fb = this.rc.cfg.roles[this.task.role].fallback_agent;
    if (rec.allow_provider_failover && fb && fb !== this.adapter.id && c.cls !== "rate_limit") {
      const next = this.rc.adapterFor(this.task.role, fb);
      this.ev({ type: "recovery", phase: "failover", cls: c.cls, message: `${this.adapter.provider}/${this.adapter.id} → ${next.provider}/${next.id} (allow_provider_failover is enabled; verification and review will run again)` });
      this.adapter = next;
      this.failedOver = true;
      this.sessionId = randomUUID();
      this.started = false;
      return { retry: true, followUp: this.compactedContext() };
    }
    const plan = planRetry(c, this.waitCount, rec);
    if (waitTooLong((this.rc.store.get(this.agentRunId)?.recovery?.waited_s ?? 0) + plan.delayS, rec)) return { retry: false };
    this.waitCount++;
    const why = `${c.cls.replace(/_/g, " ")}${c.resetAt ? "" : ""}`;
    this.rc.waits?.schedule({
      key: this.agentRunId, run_id: this.rc.runId, task_id: this.task.id, agent_run_id: this.agentRunId, role: this.task.role,
      agent: this.adapter.id, provider: this.adapter.provider, adapter: this.adapter.adapterId, execution_id: `${this.agentRunId}#${this.waitCount}`,
      cls: c.cls, error: orig, detected_at: nowIso(), next_retry_at: plan.at, reset_source: plan.source,
    });
    this.ev({ type: "recovery", phase: "waiting", cls: c.cls, message: `${why}: ${orig}`, next_retry_at: plan.at, reset_source: plan.source });
    this.st("waiting_quota", `${why} — resumes automatically ~${plan.at.slice(11, 16)}Z (${plan.source === "provider" ? "provider-reported" : "estimated"}); progress and feedback are preserved`);
    const resumed = await this.sleepUntil(plan.at);
    if (!resumed) {
      if (!this.detached) this.rc.waits?.finish(this.agentRunId, "cancelled");
      return { retry: false, outcome: { kind: "interrupted" } };
    }
    this.rc.waits?.claim(this.agentRunId, new Date(Date.now() + 1000));
    this.rc.waits?.finish(this.agentRunId, "recovered");
    this.ev({ type: "recovery", phase: "resumed", cls: c.cls, message: "wait over; continuing the same task and session" });
    return { retry: true, followUp: this.outstanding ?? "The provider limit has cleared. Continue the task where you left off, then run `hexagon done`." };
  }

  /** Sleep in bounded chunks (timers cap near 24 days); false when cancelled meanwhile. */
  private async sleepUntil(iso: string): Promise<boolean> {
    for (;;) {
      if (this.cancelled || this.detached) return false;
      const left = Date.parse(iso) - Date.now();
      if (left <= 0) return true;
      await new Promise<void>((res) => {
        const t = setTimeout(res, Math.min(left, 3_600_000));
        this.quotaWake = () => { clearTimeout(t); res(); };
      });
      this.quotaWake = null;
    }
  }

  /** Quality repair cycles: max_fix_cycles (0 = unlimited). Records the cycle number for the dashboard. */
  private mayFix(cycle: number): boolean {
    const max = this.rc.cfg.run.max_fix_cycles;
    if (max > 0 && cycle > max) return false;
    this.ev({ type: "fix_cycle", n: cycle });
    return true;
  }

  private failSigs: string[] = [];
  /** Unlimited cycles still stop when the same failure repeats: returns the reason to escalate, else null. */
  private noProgress(sig: string): string | null {
    this.failSigs.push(sig);
    const n = this.rc.cfg.run.max_identical_failures;
    if (n > 0 && this.failSigs.length >= n && this.failSigs.slice(-n).every((x) => x === sig)) {
      this.ev({ type: "error", kind: "stuck", message: `the same failure repeated ${n} times with no change`, retryable: false });
      this.notify(`stuck: the same failure repeated ${n} times — needs your attention (/continue ${this.task.id} <message> or /retry)`);
      return `no progress: identical failure ${n} times`;
    }
    return null;
  }

  /** A smaller context for a fresh session: spec/task card are rebuilt in full; history is reduced to facts. */
  private compactedContext(): string {
    const s = this.rc.store.get(this.agentRunId);
    const done = (s?.checklist ?? []).filter((i) => i.status === "done").map((i) => i.id);
    const files = (s?.files_touched ?? []).slice(0, 40);
    return [
      "You are continuing this task in a NEW session (the previous conversation was compacted). The task card above is the full, unchanged specification and acceptance criteria.",
      files.length ? `Files already changed in the worktree (inspect them with git diff / git status): ${files.join(", ")}` : "No files changed yet.",
      done.length ? `Acceptance criteria already reported done: ${done.join(", ")}` : "",
      this.outstanding ? `Outstanding feedback you must still address:\n${truncateMiddle(this.outstanding, 8000)}` : "",
      this.failedOver ? "The previous agent was replaced because its provider was unavailable; verify its work critically." : "",
      "Check the current state of the worktree first, continue from it, then run `hexagon done`.",
    ].filter(Boolean).join("\n\n");
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

  /** Wait for the task we returned to finish, bring its fix into this worktree, and say what happened. */
  private async waitForReturn(w: { task: string; issue: string; done: Promise<{ state: AgentState; summary: string }> }): Promise<string> {
    this.st("paused", `waiting for ${w.task} to fix what it returned`);
    const r = await Promise.race([w.done, new Promise<null>((res) => (this.wake = () => res(null)))]);
    this.wake = null;
    if (!r || this.cancelled) return "";
    if (r.state !== "done") {
      return `${w.task} could not fix what you returned (${r.state}: ${r.summary}). Continue within your own scope: work around it if you can, otherwise finish with \`hexagon done --status blocked\` and the reason.`;
    }
    await this.commit();
    const m = await g.merge(this.worktree, this.rc.integration.branch, `Merge fix from ${w.task} into ${this.task.id}`);
    this.ev({ type: "chat", from: "hexagon", text: `${w.task} fixed it${m.ok ? " and the fix is merged into this worktree" : ", but merging it here failed"}: ${r.summary}` });
    return m.ok
      ? `${w.task} fixed what you returned, and the fix is merged into your worktree. Their summary: ${r.summary}\n\nContinue your task: re-check it, then run \`hexagon done\`.`
      : `${w.task} fixed what you returned, but merging the fix into your worktree failed:\n${truncateMiddle(m.output, 2000)}\nResolve it if it is in your scope, otherwise report blocked.`;
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
      return: (x) => {
        const to = String(x.task ?? "").toUpperCase().replace(/^T(\d)/, "T-$1");
        const issue = String(x.issue ?? "").trim();
        if (!to || !issue) return { ok: false, message: 'Usage: hexagon return <T-n> "<what is wrong, where, and the evidence>"' };
        if (this.waiting) return { ok: false, message: `You already returned work to ${this.waiting.task}. End your turn and wait.` };
        const r = this.rc.returnTask(this.task.id, to, issue);
        if (!r.ok) return { ok: false, message: r.message };
        this.waiting = { task: to, issue, done: r.done };
        this.finished = true; // ends this turn; the pipeline then waits for the fix
        this.ev({ type: "chat", from: "hexagon", text: `↩ Returned to ${to}: ${issue}` });
        return ok(`${to} was reopened with your report. End your turn now; Hexagon resumes you here once ${to}'s fix is merged into your worktree.`);
      },
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

  resume(silent = false): boolean {
    if (!this.gate) return false;
    this.gate.resolve();
    this.gate = null;
    if (!silent) this.ev({ type: "controller", controller: "agent" });
    return true;
  }

  /** Restart the agent CLI in the same session (picks up new permissions), with `note` as its next message. */
  restart(note: string): boolean {
    if (!this.pause("applying new permissions")) return false;
    this.restarting = true;
    this.resumeNote = note;
    return this.resume(true);
  }

  detach(): void {
    this.detached = true;
    this.quotaWake?.();
    this.abort.abort();
  }

  cancel(): void {
    this.cancelled = true;
    this.quotaWake?.();
    this.abort.abort();
    this.gate?.resolve();
    this.wake?.();
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
