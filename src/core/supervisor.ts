import { randomUUID } from "node:crypto";
import { evaluateEvidence, missingEvidence } from "./evidence.js";
import { failureSignature, reviewSignature } from "./signature.js";
import { DEFAULT_TEST_GLOBS, describeFlags, testIntegrity, type IntegrityFlag } from "./integrity.js";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentEvent, AgentState, Effort, ErrorKind, Message, NeedsInput, ResultEnvelope, ReviewVerdict, Role, Task, TokenCause,
} from "../contracts/types.js";
import { validateResult } from "../contracts/validate.js";
import { identityHash, skillsBlock, systemPrompt, taskCard, type Skill } from "../agents/prompts.js";
import type { AdapterOutcome, AgentAdapter, AgentApi, AgentHost, AgentRunContext, Injected, Reply } from "../agents/types.js";
import { classifyProviderError, recoveryFor } from "../agents/contracts/errors.js";
import { planRetry, waitTooLong, type WaitStore } from "./recovery.js";
import { atomicWriteJson, matchesAny, nowIso, truncateMiddle } from "../util/fsx.js";
import { Mutex } from "../util/mutex.js";
import { runShell } from "../util/shell.js";
import { onPath } from "./toolchains.js";
import { roleConfig, type HexagonConfig } from "./config.js";
import * as g from "./git.js";
import type { ProjectPaths, RunPaths } from "./project.js";
import type { ApiRegistry } from "./registry.js";
import type { MessageRouter } from "./router.js";
import { BUS_KINDS, type AgentBus, type BusKind } from "./bus.js";
import { compactRequest, shouldCompact } from "./compaction.js";
import type { IdentityPool, Lease, Resolution, SessionRegistry } from "./sessions.js";
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
  /** Repository file counts: sent with the first message of a new session, not in the system prompt. */
  overview: string;
  integration: { branch: string; worktree: string };
  /** Merges into the integration branch (and the checks that follow) happen one at a time. */
  integrationLock: Mutex;
  adapterFor(role: Role, override?: string | null): AgentAdapter;
  /** Persistent retry schedule for provider-limit waits. */
  waits?: WaitStore;
  /** All tasks of the run (for areas of responsibility). */
  tasks: Task[];
  /** Reopen task `to` with a defect report from `from`; resolves when `to` finishes again. */
  returnTask(from: string, to: string, issue: string): { ok: true; done: Promise<{ state: AgentState; summary: string }> } | { ok: false; message: string };
  /** One session per agent identity, kept for the whole project. */
  sessions: SessionRegistry;
  pool: IdentityPool;
  bus: AgentBus;
  /** May this task start? A task that cites requirements runs only against a spec that still matches its approval. */
  gate?(task: Task): { ok: boolean; problems: string[]; changed: string[] };
  /** Environment for agent processes: lets them run `hexagon report|ask|…`. */
  agentEnv(agentId: string): Record<string, string>;
  /** Ask the user, before the work starts, to allow commands the task will need. Resolves with the ones they denied. */
  preapprove?(taskId: string, commands: string[], reason: string): Promise<string[]>;
}

/** What was settled before the agent started: kept next to the status so a later question ("why did it start red?") has an answer. */
export interface Preparation {
  task: string;
  base_commit: string;
  requirements: string[];
  upstream: string[];
  scope: string[];
  /** Short plan, derived from the acceptance criteria. */
  steps: string[];
  tools: { command: string; found: boolean }[];
  denied_commands: string[];
  baseline: { cmd: string; code: number }[];
  warnings: string[];
}

interface Gate { promise: Promise<void>; resolve: () => void }

/** Supervises one attempt of one task. The only writer of its status (through the store). */
export class AgentRun {
  readonly agentRunId: string;
  readonly worktree: string;
  readonly branch: string;
  /** Native id of the session of the current turn (from the registry). */
  sessionId = "";
  /** Agent identity (developer-1, reviewer-1, …) whose session this attempt uses. */
  identity: string | null = null;
  private lease: Lease | null = null;
  /** Who the tokens of the current turn belong to. */
  private sink: { identity: string; cause: TokenCause } | null = null;
  private cause: TokenCause = "prompt";
  private sessionAnnounced = false;
  /** Summary produced by the last compaction, re-sent as pinned context in the fresh session. */
  private compactSummary = "";
  private reviewerSummary = "";
  /** The first review of a task starts a fresh reviewer context; later reviews (after fixes) resume it. */
  private reviewedOnce = false;
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
  /** The CLI confirmed it created the session, even if the run then ended in an error (a provider limit): resume it, never re-create it. */
  private sessionSeen = false;
  private result: ResultEnvelope | undefined;
  private review: ReviewVerdict | undefined;
  private baseCommit = "";
  /** HEAD after the last commit or merge Hexagon made itself. Anything past it was done by the agent. */
  private checkpoint = "";
  /** Deleted, skipped or weakened tests since base: flagged for the reviewer and the report. */
  private integrity: IntegrityFlag[] = [];
  /** Done runs that found out-of-scope changes. The first is a warning (nothing reverted); a repeat reverts. */
  private scopeStrikes = 0;
  /** Every path Hexagon reverted for being out of scope, shown to the reviewer. */
  private scopeReverts: string[] = [];
  /** Revert explanation not yet shown to the agent; prefixed to its next follow-up. */
  private revertNotice = "";
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
    private resumeWait?: { sessionId: string; nextRetryAt: string; identity?: string | null },
  ) {
    if (resumeWait) { this.sessionId = resumeWait.sessionId; this.started = true; this.identity = resumeWait.identity ?? null; }
    this.agentRunId = `${task.id}-a${attempt}`;
    this.worktree = path.join(rc.paths.worktrees, rc.runId, this.agentRunId);
    this.branch = `hexagon/${rc.runId}/${this.agentRunId}`;
  }

  get state(): AgentState {
    return this.rc.store.get(this.agentRunId)?.state ?? "queued";
  }

  private ev(e: AgentEvent) {
    if (e.type === "usage") {
      const sink = this.sink ?? (this.identity ? { identity: this.identity, cause: this.cause } : null);
      const stamped = { ...e, cause: e.cause ?? sink?.cause ?? this.cause };
      if (sink && e.window) this.rc.sessions.setWindow(sink.identity, e.window);
      if (sink && (e.input || e.output || e.cache_read || e.step)) {
        this.rc.sessions.recordUsage(sink.identity, { input: e.input, cache_read: e.cache_read, output: e.output, cause: stamped.cause, step: Boolean(e.step) });
        if (e.step && sink.identity === this.identity) this.refreshSession();
      }
      this.rc.store.apply(this.agentRunId, stamped);
      if (e.step) this.enforceLimits();
      return;
    }
    this.rc.store.apply(this.agentRunId, e);
  }

  private windowTokens(): number {
    return this.rc.cfg.context.assumed_window_tokens;
  }

  /** Update turns / context size of the session shown for this attempt. */
  private refreshSession(): void {
    if (!this.identity) return;
    const info = this.rc.sessions.info(this.identity, this.rc.sessions.get(this.identity)?.turns ? "resumed" : "new", null, this.windowTokens());
    this.rc.store.patch(this.agentRunId, (s) => { s.session = { ...info, mode: s.session?.mode ?? info.mode, reason: s.session?.reason ?? null }; });
  }

  private announce(res: Resolution): void {
    const info = this.rc.sessions.info(res.record.agentId, res.mode, res.reason, this.windowTokens());
    this.sessionAnnounced = true;
    this.rc.store.apply(this.agentRunId, { type: "session", info });
  }

  private ensureLease(): Lease {
    if (!this.lease) this.lease = this.rc.pool.acquire(this.task.role, this.identity);
    this.identity = this.lease.agentId;
    return this.lease;
  }

  private releaseLease(): void {
    this.lease?.release();
    this.lease = null;
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
    this.st("preparing", "creating worktree");
    try {
      await g.addWorktree(this.rc.root, this.worktree, this.branch, this.rc.integration.branch);
      this.baseCommit = await g.revParse(this.worktree, "HEAD");
      this.checkpoint = this.baseCommit;
      this.rc.store.patch(this.agentRunId, (s) => {
        s.workspace = { worktree: path.relative(this.rc.root, this.worktree), branch: this.branch };
        s.attach = { native_session_id: null, takeover_command: null, supports_live_input: this.adapter.supportsLiveInput };
      });
    } catch (e) {
      this.ev({ type: "error", kind: "internal", message: String(e), retryable: false });
      return this.final("failed", "could not create worktree");
    }
    const unregister = this.rc.registry.register(this.agentRunId, this.api());
    try {
      await this.prepare();
      if (this.cancelled) return this.final("cancelled", "cancelled by user");
      return await this.pipeline();
    } finally {
      unregister();
      this.releaseLease();
    }
  }

  /** Baseline results of the preparation, told to the agent once with its first task card. */
  private baselineNote = "";

  /**
   * Preparing: everything that can be settled before the agent spends tokens. The worktree is on the integration
   * branch head (dependencies are merged), the tools its checks need exist, commands it will need are approved now
   * rather than mid-task, and a baseline run says what was already failing. Nothing here blocks the task except the
   * user cancelling; problems are recorded and shown, and the agent is told.
   */
  private async prepare(): Promise<void> {
    const t = this.task;
    const warnings: string[] = [];
    const step = (text: string) => this.st("preparing", text);

    step("checking tools");
    const words = [...new Set(t.verify.map((v) => v.trim().split(/\s+/)[0] ?? "").filter((w) => w && !/^[.\/~]/.test(w) && !/[=$]/.test(w)))];
    const tools = words.map((command) => ({ command, found: onPath(command) }));
    for (const x of tools.filter((x) => !x.found)) warnings.push(`\`${x.command}\` is not installed (needed by: ${t.verify.filter((v) => v.trim().startsWith(x.command)).join("; ")})`);

    let denied: string[] = [];
    if (this.rc.preapprove && t.verify.length) {
      step("approvals");
      denied = await this.rc.preapprove(t.id, t.verify, `${t.id} verifies with it`);
      for (const d of denied) warnings.push(`you did not allow \`${d}\``);
    }
    if (this.cancelled) return;

    const baseline: Preparation["baseline"] = [];
    if (this.rc.cfg.run.baseline && t.verify.length) {
      this.abort = new AbortController();
      for (const cmd of t.verify) {
        const word = cmd.trim().split(/\s+/)[0] ?? "";
        if (tools.some((x) => x.command === word && !x.found) || denied.includes(cmd)) continue;
        step(`baseline: ${cmd}`);
        const r = await runShell(cmd, this.worktree, this.rc.cfg.sandbox.command_timeout_s, this.abort.signal);
        if (this.cancelled) return;
        baseline.push({ cmd, code: r.code });
      }
    }

    const upstream = this.upstream();
    const prep: Preparation = {
      task: t.id, base_commit: this.baseCommit, requirements: t.requirements, upstream, scope: t.files.write,
      steps: (t.acceptance.length ? t.acceptance : t.definition_of_done).map((a, i) => `${i + 1}. ${a}`),
      tools, denied_commands: denied, baseline, warnings,
    };
    atomicWriteJson(path.join(this.rc.run.agentDir(this.agentRunId), "prepare.json"), prep);
    const red = baseline.filter((b) => b.code !== 0);
    this.baselineNote = baseline.length
      ? `<baseline>\nBefore your change, Hexagon ran the verification commands on the fresh worktree:\n${baseline.map((b) => `- \`${b.cmd}\`: ${b.code === 0 ? "passes" : `exit ${b.code}`}`).join("\n")}${warnings.length ? `\n${warnings.map((w) => `Note: ${w}.`).join("\n")}` : ""}\n</baseline>`
      : warnings.length ? `<baseline>\n${warnings.map((w) => `Note: ${w}.`).join("\n")}\n</baseline>` : "";
    this.ev({
      type: "progress",
      text: `prepared: base ${this.baseCommit.slice(0, 7)}, ${upstream.length} upstream, ${red.length ? `${red.length} check(s) already failing` : baseline.length ? "baseline green" : "no baseline"}${warnings.length ? `, ${warnings.length} warning(s)` : ""}`,
    });
    for (const w of warnings) this.ev({ type: "progress", text: `prepare: ${w}` });
  }

  /** After a daemon restart: same worktree, branch and CLI session; wait out the remaining time, then continue. */
  private async executeResumed(): Promise<AgentState> {
    const w = this.resumeWait!;
    await g.addWorktree(this.rc.root, this.worktree, this.branch, this.rc.integration.branch); // no-op when it exists
    this.baseCommit = await g.revParse(this.worktree, "HEAD").catch(() => "");
    this.checkpoint = this.baseCommit;
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
      this.releaseLease();
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
    if (this.limit) { this.limit = null; this.blockedReason = null; this.capFrom = this.tokensUsed(); }
    this.ev({ type: "chat", from, text });
    const unregister = this.rc.registry.register(this.agentRunId, this.api());
    try {
      const body = from === "user" ? `Message from the user:\n${text}\n\nContinue the task with this in mind. When it is finished, run \`hexagon done\` again.` : text;
      return await this.pipeline(body, true);
    } finally {
      unregister();
      this.releaseLease();
    }
  }

  /** The current segment answers a failed verification or a review rejection. */
  private fixing = false;

  private async pipeline(initial?: string, initialFromUser = false): Promise<AgentState> {
    let followUp: string | undefined = initial;
    let quiet = initialFromUser;
    let fixLoops = 0;
    for (;;) {
      // 1. Implement (or fix)
      this.finished = false;
      this.result = undefined;
      if (followUp && !initialFromUser) this.outstanding = followUp;
      this.cause = followUp && !initialFromUser ? "fix_loop" : "prompt";
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
        await this.commit("final");
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

      // 2. Scope + commit. A first offense is a warning: the agent is told what is outside its mask and nothing is reverted.
      const maxFix = this.rc.cfg.run.max_fix_cycles;
      const scope = await this.commit(maxFix <= 0 || fixLoops + 1 <= maxFix ? "warn" : "final");
      if (scope.warn) {
        this.ev({ type: "fix_cycle", n: ++fixLoops });
        this.fixing = true;
        followUp = this.scopeWarning(scope.warn);
        continue;
      }

      // 3. Verify
      this.fixing = false;
      this.st("verifying", this.task.verify.length ? `running ${this.task.verify.length} command(s)` : "no verify commands");
      const v = await this.verify();
      if (this.cancelled) return this.final("cancelled", "cancelled by user");
      if (!v.ok) {
        this.ev({ type: "error", kind: "verify_failed", message: `\`${v.cmd}\` exited ${v.code}`, retryable: true });
        const stuck = this.noProgress(failureSignature(v.cmd, v.code, v.output));
        if (stuck) return this.final("failed", stuck);
        if (this.mayFix(++fixLoops) && !this.userDone) {
          this.fixing = true;
          followUp = this.withNotice(`Hexagon re-ran verification and it failed.\n\n$ ${v.cmd}\n(exit ${v.code})\n${this.excerpt(v.output, FIX_EXCERPT, "verify output")}\n\nFix the problem, re-run the command yourself, then run \`hexagon done\` again.`);
          continue;
        }
        this.notify(this.escalation(`verification still fails after ${this.rc.cfg.run.max_fix_cycles} repair cycle(s)`, `\`${v.cmd}\` exited ${v.code}`));
        return this.final("failed", `verification failed: ${v.cmd}`);
      }

      // What the agent claimed is checked here: only Hexagon marks evidence as verified.
      if (r.acceptance_evidence.length) {
        const out = this.verifyLog.slice(-Math.max(1, this.task.verify.length)).map((x) => x.output).join("\n");
        r.acceptance_evidence = evaluateEvidence(this.worktree, r.acceptance_evidence, out);
      }

      // 4. Review
      if (this.rc.cfg.review.mode === "agent" && !this.userDone) {
        this.st("reviewing");
        const rv = await this.runReview();
        if (this.cancelled) return this.final("cancelled", "cancelled by user");
        if (!rv) return this.final("failed", "review did not complete");
        this.review = rv;
        if (rv.verdict === "request_changes") {
          this.rc.bus.send({
            kind: "finding", from: "reviewer", to: { agent: this.task.id }, subject: rv.summary.slice(0, 120),
            fields: { high: String(rv.findings.filter((f) => f.severity === "high").length), medium: String(rv.findings.filter((f) => f.severity === "medium").length) },
            body: rv.findings.map((f) => `[${f.severity}] ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.issue}`).join("\n"), record_only: true,
          });
          const stuck = this.noProgress(reviewSignature(rv));
          if (stuck) return this.final("failed", stuck);
          if (this.mayFix(++fixLoops)) {
            this.fixing = true;
            followUp = this.withNotice(`The reviewer requested changes:\n${rv.summary}\n${rv.findings.map((f) => `- [${f.severity}] ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.issue}${f.suggestion ? ` → ${f.suggestion}` : ""}`).join("\n")}\n\nAddress the high and medium findings, then run \`hexagon done\` again.`);
            continue;
          }
          this.notify(this.escalation(`the reviewer still requests changes after ${this.rc.cfg.run.max_fix_cycles} repair cycle(s)`, rv.summary));
          return this.final("failed", `review rejected: ${rv.summary}`);
        }
      }

      // 5. Merge into the run's integration branch, then prove the merged result still passes
      this.st("integrating");
      const integ = await this.integrate();
      if (integ.kind === "blocked") {
        this.ev({ type: "error", kind: "internal", message: integ.detail, retryable: false });
        this.notify(integ.reason);
        return this.final("blocked", integ.short);
      }
      if (integ.kind === "broken") {
        this.ev({ type: "error", kind: "verify_failed", message: `post-merge: \`${integ.v.cmd}\` (${integ.owner === this.task.id ? "this task's check" : `check of ${integ.owner}`}) exited ${integ.v.code} on the integration branch`, retryable: true });
        const stuck = this.noProgress(failureSignature(`post-merge ${integ.v.cmd}`, integ.v.code, integ.v.output));
        if (stuck) return this.final("failed", stuck);
        if (this.mayFix(++fixLoops)) {
          this.fixing = true;
          followUp = this.withNotice(`Your change passed its checks on its own, but after merging it into the integration branch (with what the other tasks delivered) ${integ.owner === this.task.id ? "your own check" : integ.owner === "final_verify" ? "the final check" : `the check of ${integ.owner}, which was already merged,`} failed, so the merge was undone:\n\n$ ${integ.v.cmd}\n(exit ${integ.v.code})\n${this.excerpt(integ.v.output, FIX_EXCERPT, "verify output")}\n\nThe integration branch is now merged into your worktree. Make your change work together with it, re-run the command yourself, then run \`hexagon done\` again.`);
          continue;
        }
        this.notify(this.escalation(`it passes alone but breaks the integration branch, after ${this.rc.cfg.run.max_fix_cycles} repair cycle(s)`, `\`${integ.v.cmd}\` exited ${integ.v.code}`));
        return this.final("failed", `breaks the integration branch${integ.owner === this.task.id ? "" : ` (${integ.owner}'s check)`}: ${integ.v.cmd}`);
      }
      this.publishHandoff();
      return this.final("done");
    }
  }

  /**
   * A merge conflict goes to the Release Engineer once: in a dedicated worktree, limited to the conflicted files, and the
   * result is verified before the integration branch moves. Anything else it touches is thrown away.
   */
  private async resolveConflict(integrationWt: string, message: string): Promise<{ ok: boolean; detail: string }> {
    const relBranch = `${this.branch}-release`;
    const relWt = `${this.worktree}-release`;
    const fail = async (detail: string) => { await g.removeWorktree(this.rc.root, relWt).catch(() => undefined); await g.git(this.rc.root, ["branch", "-D", relBranch]); return { ok: false, detail }; };
    try {
      const adapter = this.rc.adapterFor("release");
      await g.addWorktree(this.rc.root, relWt, relBranch, this.rc.integration.branch);
      const merged = await g.git(relWt, ["-c", "user.name=Hexagon", "-c", "user.email=hexagon@localhost", "merge", "--no-ff", "--no-commit", this.branch]);
      const conflicted = (await g.git(relWt, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
      if (merged.ok || !conflicted.length) return fail(`could not reproduce the conflict: ${merged.stdout}${merged.stderr}`.trim());
      this.ev({ type: "progress", text: `merge conflict in ${conflicted.join(", ")}: the release engineer resolves it` });
      let done: ResultEnvelope | undefined;
      const id = `${this.agentRunId}.release`;
      const api: AgentApi = {
        report: (r) => { this.ev({ type: "progress", text: `release: ${r.activity ?? ""}` }); return ok("ok"); },
        ask: () => ({ ok: false, message: "Nobody can answer now. If you need a product decision, finish with `hexagon done --status blocked --blocker \"<the decision>\"`." }),
        note: () => ok("ok"),
        done: (d) => { done = { task_id: this.task.id, status: d.status ?? "completed", summary: d.summary ?? "", files_changed: [], acceptance_evidence: [], commands_run: [], blockers: d.blockers ?? [], spec_issues: [], assumptions: [], follow_ups: [] }; return ok("Recorded. End your turn now."); },
        review: () => ({ ok: false, message: "Only the reviewer can run `hexagon review`." }),
      };
      const unregister = this.rc.registry.register(id, api);
      const prevSink = this.sink, prevCause = this.cause;
      this.sink = { identity: id, cause: "prompt" };
      try {
        this.abort = new AbortController();
        const prompt = [
          taskCard(this.task, this.rc.specs, "", []),
          `<conflicts note="merging ${this.branch} into the integration branch stopped on these files; the markers are in the files">\n${conflicted.join("\n")}\n</conflicts>`,
          `Resolve only these files. Keep the intent of both sides. Do not touch anything else, and do not commit: Hexagon commits and verifies. Then finish with \`hexagon done\`. If it needs a product decision, finish with \`hexagon done --status blocked --blocker "<decision and options>"\`.`,
        ].join("\n\n");
        const out = await adapter.run(this.ctx({
          role: "release", sessionId: randomUUID(), resume: false, freshTask: true, prompt, cwd: relWt,
          system: systemPrompt(this.rc.paths, "release", this.rc.skills, this.rc.context, this.rc.cfg.roles.release),
          readOnly: false, api, agentId: id,
          host: { emit: (e) => { if (e.type !== "usage" || e.step) this.ev(e.type === "progress" ? { ...e, text: `release: ${e.text}` } : e); }, drainInbox: () => [], onInbox: () => () => undefined, received: () => undefined, isFinished: () => done !== undefined, hasBlockingQuestion: () => false },
        }));
        if (out.kind === "error") this.ev({ type: "error", ...out.error! });
      } finally { this.sink = prevSink; this.cause = prevCause; unregister(); }
      if (!done || done.status !== "completed") return fail(`the release engineer did not resolve it${done?.blockers.length ? `: ${done.blockers.join("; ")}` : ""} (conflict in ${conflicted.join(", ")})`);
      // Only the conflicted files may differ from the merge result.
      const touched = (await g.uncommittedFiles(relWt)).filter((f) => !conflicted.includes(f));
      const staged = (await g.git(relWt, ["diff", "--name-only", "--cached"])).stdout.split("\n").filter(Boolean);
      for (const f of touched.filter((f) => !staged.includes(f))) {
        if ((await g.git(relWt, ["ls-files", "--error-unmatch", f])).ok) await g.git(relWt, ["checkout", "--", f]);
        else fs.rmSync(path.join(relWt, f), { recursive: true, force: true });
      }
      const left = (await g.git(relWt, ["grep", "-lE", "^(<<<<<<<|>>>>>>>) ", "--", ...conflicted])).stdout.split("\n").filter(Boolean);
      if (left.length) return fail(`conflict markers remain in ${left.join(", ")}`);
      await g.must(relWt, ["add", "-A"]);
      await g.must(relWt, ["-c", "user.name=Hexagon", "-c", "user.email=hexagon@localhost", "commit", "-q", "-m", `${message}\n\nHexagon-Release: conflict in ${conflicted.join(", ")} resolved by the release engineer`]);
      const v = await this.verify(relWt);
      if (!v.ok) return fail(`verification failed after resolving the conflict: ${v.cmd} (exit ${v.code})`);
      const ff = await g.git(integrationWt, ["merge", "--ff-only", relBranch]);
      if (!ff.ok) return fail(`could not move the integration branch: ${ff.stderr}`);
      await g.removeWorktree(this.rc.root, relWt).catch(() => undefined);
      await g.git(this.rc.root, ["branch", "-D", relBranch]);
      this.ev({ type: "progress", text: `release engineer resolved ${conflicted.join(", ")}; verified; merged` });
      return { ok: true, detail: "" };
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  /**
   * Merge this task into the integration branch and run its verify commands there. Two tasks that are green on their own
   * can break each other; if the merged result fails, the merge is undone (the integration branch never holds a red
   * state) and the failure goes back to this task, with the integration branch merged into its worktree to reproduce it.
   */
  private integrate(): Promise<
    | { kind: "merged" }
    | { kind: "blocked"; reason: string; short: string; detail: string }
    | { kind: "broken"; v: { cmd: string; code: number; output: string }; owner: string }
  > {
    return this.rc.integrationLock.run(async () => {
      const wt = this.rc.integration.worktree;
      const pre = await g.revParse(wt, "HEAD");
      const message = `Merge ${this.task.id}: ${this.task.title}\n\nHexagon-Task: ${this.task.id}\nRefs: ${refs(this.task)}`;
      let m = await g.merge(wt, this.branch, message);
      if (!m.ok && m.conflict && this.rc.cfg.run.release_on_conflict) {
        const rel = await this.resolveConflict(wt, message);
        if (rel.ok) m = { ok: true, conflict: false, output: "" };
        else m = { ok: false, conflict: true, output: rel.detail };
      }
      if (!m.ok) {
        return { kind: "blocked" as const, short: m.conflict ? "merge conflict with integration branch" : "merge failed", detail: m.output,
          reason: m.conflict ? "merge conflict with the integration branch — resolve manually or /retry" : `merge failed: ${m.output}` };
      }
      // What must still hold on the integration branch. Each command is tagged with the task it belongs to so a failure
      // can say whether this change broke its own check or an earlier task's.
      const policy = this.rc.cfg.run.integration_verify;
      const plan: { cmd: string; owner: string }[] = this.task.verify.map((cmd) => ({ cmd, owner: this.task.id }));
      if (policy !== "task") {
        for (const t of this.rc.tasks) {
          if (t.id === this.task.id || this.rc.store.byTask(t.id)?.state !== "done") continue;
          for (const cmd of t.verify) plan.push({ cmd, owner: t.id });
        }
      }
      if (policy === "full") for (const cmd of this.rc.cfg.run.final_verify) plan.push({ cmd, owner: "final_verify" });
      const seen = new Set<string>();
      let v: { ok: boolean; cmd: string; code: number; output: string } = { ok: true, cmd: "", code: 0, output: "" };
      let owner: string = this.task.id;
      this.abort = new AbortController();
      for (const step of plan) {
        if (seen.has(step.cmd)) continue;
        seen.add(step.cmd);
        this.ev({ type: "progress", text: `verify on integration (${step.owner}): ${step.cmd}` });
        const r = await runShell(step.cmd, wt, this.rc.cfg.sandbox.command_timeout_s, this.abort.signal);
        this.verifyLog.push({ cmd: step.cmd, code: r.code, output: r.output });
        if (r.code !== 0) { v = { ok: false, cmd: step.cmd, code: r.code, output: r.output }; owner = step.owner; break; }
      }
      if (v.ok) return { kind: "merged" as const };
      await g.resetHard(wt, pre);
      const back = await g.merge(this.worktree, this.rc.integration.branch, `Merge integration into ${this.task.id} to reproduce a post-merge failure`);
      if (!back.ok) {
        return { kind: "blocked" as const, short: "breaks the integration branch and cannot be reproduced", detail: back.output,
          reason: `${this.task.id} breaks the integration branch (\`${v.cmd}\`), and merging that branch into its worktree conflicts. Resolve it manually or /retry.` };
      }
      this.checkpoint = await g.revParse(this.worktree, "HEAD");
      return { kind: "broken" as const, v, owner };
    });
  }

  /** Head+tail of a long output; the cut is stated in the text and recorded on the timeline. */
  private excerpt(text: string, max: number, what: string): string {
    if (text.length <= max) return text;
    this.ev({ type: "progress", text: `${what} truncated: ${text.length} → ${max} chars sent to the agent` });
    return truncateMiddle(text, max);
  }

  /** Bring the agent identity's session up for this turn: new, resumed, or compacted first. */
  private async prepareSession(): Promise<Resolution> {
    const lease = this.ensureLease();
    const cap = this.adapter.capabilities;
    const cx = this.rc.cfg.context;
    // A task starts: with task scope its agent gets a new session (the previous task reaches it as a handoff).
    if (!this.started && cx.session_scope === "task") this.rc.sessions.reset(lease.agentId, "session_scope = task: a new session for every task");
    let res = this.rc.sessions.resolve({
      agentId: lease.agentId, role: this.task.role, adapterId: this.adapter.adapterId, model: this.adapter.model,
      promptHash: identityHash(this.rc.paths, this.task.role, this.rc.skills, this.rc.cfg.roles[this.task.role]), cwd: this.worktree,
      resumeAcrossCwd: cap.resumeAcrossCwd, supportsResume: cap.supportsSessionResume,
    });
    if (res.resume) {
      const boundary = !this.started && cx.task_boundary === "compact" && cx.mode !== "off" && res.record.turns > 0;
      const d = boundary ? { compact: true, why: "task boundary (task_boundary = compact)" } : shouldCompact(cx, res.record, Boolean(res.record.compactRequested));
      if (d.compact) {
        const c = await this.compact(res, d.why);
        if (c) res = c;
      }
    }
    this.sessionId = res.sessionId;
    if (!this.sessionAnnounced || res.mode === "new") this.announce(res);
    this.rc.store.patch(this.agentRunId, (s) => {
      s.attach = { ...(s.attach ?? {}), native_session_id: res.sessionId, takeover_command: this.adapter.takeoverCommand(res.sessionId) ?? [process.env.SHELL ?? "/bin/zsh"], supports_live_input: this.adapter.supportsLiveInput };
    });
    return res;
  }

  /**
   * Compact between turns (the previous process has exited, so no tool call is in flight): ask the session for a
   * summary, then continue in a fresh native session seeded with it plus the pinned context.
   */
  private async compact(res: Resolution, why: string, who: { role: Role; adapter: AgentAdapter } = { role: this.task.role, adapter: this.adapter }): Promise<Resolution | null> {
    const id = res.record.agentId;
    this.ev({ type: "progress", text: `compacting ${id}: ${why}` });
    const prev = this.cause;
    const prevSink = this.sink;
    this.cause = "compaction";
    this.sink = { identity: id, cause: "compaction" };
    let summary = "";
    const host: AgentHost = {
      emit: (e) => {
        if (e.type === "chat" && e.from === "agent") summary += `${summary ? "\n" : ""}${e.text}`;
        else if (e.type === "usage") this.ev(e);
      },
      drainInbox: () => [],
      onInbox: () => () => undefined,
      received: () => undefined,
      isFinished: () => summary.length > 0,
      hasBlockingQuestion: () => false,
    };
    const refuse = (): Reply => ({ ok: false, message: "Compaction turn: just reply with the summary." });
    this.abort = new AbortController();
    try {
      const out = await who.adapter.run(this.ctx({
        role: who.role, sessionId: res.sessionId, resume: true, handle: res.record.nativeHandle ?? null, followUp: compactRequest(), prompt: compactRequest(),
        system: systemPrompt(this.rc.paths, who.role, this.rc.skills, this.rc.context, this.rc.cfg.roles[who.role]), readOnly: true,
        api: { report: refuse, ask: refuse, note: refuse, done: refuse, review: refuse }, host, agentId: this.agentRunId,
      }));
      if (out.kind !== "finished" || !summary.trim()) {
        this.rc.sessions.skipCompaction(id);
        this.ev({ type: "progress", text: `compaction of ${id} did not produce a summary; continuing without it` });
        return null;
      }
    } finally {
      this.sink = prevSink;
      this.cause = prev;
    }
    if (who.role === this.task.role) this.compactSummary = truncateMiddle(summary.trim(), 4000);
    else this.reviewerSummary = truncateMiddle(summary.trim(), 4000);
    const sessionId = this.rc.sessions.compacted(id);
    const record = this.rc.sessions.get(id)!;
    return { sessionId, resume: false, mode: "new", reason: "compacted", record };
  }

  /** What the agent receives this turn: the full card for a new session, only what changed for a resumed one. */
  private turnInput(res: Resolution, fu: string | undefined): { prompt: string; followUp?: string; freshTask: boolean } {
    const rec = res.record;
    const fresh = !res.resume;
    if (this.started && res.resume) {
      const msg = fu ?? "Continue the task where you left off.";
      return { prompt: msg, followUp: msg, freshTask: false };
    }
    const seen = fresh ? { skills: [] as string[], others: "", notes: null, state: "" } : rec.seen;
    const others = this.rc.tasks.filter((t) => t.id !== this.task.id);
    const othersKey = others.map((o) => `${o.id}:${o.role}:${o.files.write.join(",")}`).join("|");
    const noteLines = this.rc.router.notes().split("\n").filter(Boolean);
    const cursor = seen.notes?.run === this.rc.runId ? seen.notes.lines : 0;
    const upstream = this.upstream();
    const fresh_notes = noteLines.slice(cursor);
    const relevant = fresh_notes.filter((l) => { const from = /^- \[[^\]]*\] (T-\d+):/.exec(l)?.[1]; return !from || upstream.includes(from); });
    const omitted = fresh_notes.length - relevant.length;
    const notesText = [...relevant, omitted ? `(${omitted} note(s) from unrelated tasks omitted; \`hexagon bus read\` lists everything)` : ""].filter(Boolean).join("\n");
    const digest = this.started ? "" : this.rc.bus.digestFor(this.task.id, upstream);
    const newSkills = this.task.skills.filter((n) => !seen.skills.includes(n));
    const card = [
      taskCard(this.task, this.rc.specs, notesText, seen.others === othersKey ? [] : others),
      digest,
      newSkills.length ? skillsBlock(this.rc.skills, this.task.role, newSkills) : "",
    ].filter(Boolean).join("\n\n");
    this.rc.sessions.markSeen(rec.agentId, {
      skills: [...new Set([...seen.skills, ...newSkills])], others: othersKey, notes: { run: this.rc.runId, lines: noteLines.length },
    });
    if (!this.started) {
      // First turn of this task. In a resumed session the card goes as the next message.
      const carried = fresh && this.compactSummary ? `Summary of your earlier work in this project (written by you before the session was compacted):\n${this.compactSummary}` : "";
      // A resumed session remembers other directories and file contents: say where it is now, and that those are stale.
      const moved = res.resume ? `You are now working on a different task, in ${this.worktree}. Paths and file contents from earlier tasks in this conversation are stale: that work is finished and merged, other worktrees are not yours to edit, and files must be read again here before you rely on them.` : "";
      const text = [moved, res.resume ? "" : this.rc.overview, card, this.baselineNote, carried, fu].filter(Boolean).join("\n\n");
      return { prompt: text, followUp: res.resume ? text : undefined, freshTask: true };
    }
    // Fresh session in the middle of a task (compaction, reset, overflow): card + pinned context.
    const text = [this.rc.overview, card, this.pinnedContext(), fu].filter(Boolean).join("\n\n");
    return { prompt: text, freshTask: true };
  }

  /** Run the agent CLI until it finishes. Pause/takeover kill the process; resume continues the same session. */
  private async agentSegment(followUp?: string, quiet = false): Promise<AdapterOutcome> {
    let fu = followUp;
    let resumedOnce = false;
    if (quiet) {
      // already shown in the chat as the user's message
    } else if (!this.started) {
      const acs = this.task.acceptance.length ? ` (${this.task.acceptance.join(", ")})` : "";
      this.ev({ type: "chat", from: "hexagon", text: `Task ${this.task.id}: ${this.task.title}${acs}\nWrite scope: ${this.task.files.write.join(", ")}${this.task.verify.length ? `\nVerify: ${this.task.verify.join(" && ")}` : ""}` });
    } else if (fu) {
      this.ev({ type: "chat", from: "hexagon", text: truncateMiddle(fu, 2000) });
    }
    for (;;) {
      this.st(this.questions.size ? "waiting_input" : this.fixing ? "fixing" : "working");
      this.abort = new AbortController();
      this.sessionSeen = false;
      const res = await this.prepareSession();
      const input = this.turnInput(res, fu);
      const out = await this.adapter.run(this.ctx({
        role: this.task.role,
        sessionId: res.sessionId,
        resume: res.resume,
        handle: res.record.nativeHandle ?? null,
        followUp: input.followUp,
        freshTask: input.freshTask,
        prompt: input.prompt,
        system: systemPrompt(this.rc.paths, this.task.role, this.rc.skills, this.rc.context, this.rc.cfg.roles[this.task.role]),
        readOnly: false,
        api: this.api(),
        host: this.host(),
        agentId: this.agentRunId,
      }));
      if (out.kind !== "error" || this.sessionSeen) this.rc.sessions.confirm(res.record.agentId);
      if (out.kind !== "error" || this.sessionSeen) this.started = true;
      // Safety net: the CLI says this session exists although we thought it was new → continue it instead of failing the task.
      if (out.kind === "error" && !resumedOnce && /session id .* is already in use/i.test(out.error?.message ?? "")) { resumedOnce = true; this.rc.sessions.confirm(res.record.agentId); this.started = true; continue; }
      if (out.kind === "error" && this.rc.cfg.recovery.enabled && !this.cancelled && !this.userDone) {
        const next = await this.recoverFromLimit(out);
        if (next.retry) { fu = next.followUp; this.restarting = false; continue; }
        return next.outcome ?? out;
      }
      if (this.cancelled || this.userDone) return out;
      if (this.limit) { this.blockedReason = this.limit; return { kind: "error", error: { kind: "internal", message: this.limit, retryable: false } }; }
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
      if (this.identity) this.rc.sessions.compacted(this.identity);
      this.compactSummary = "";
      this.started = false; // a fresh session with a smaller, reconstructed context
      this.ev({ type: "recovery", phase: "compacted", cls: c.cls, message: `context window exceeded; starting a new session with a compact summary (${this.contextRecoveries}/${rec.max_context_recoveries})` });
      return { retry: true };
    }

    // wait_and_resume
    if (!rec.auto_resume) {
      this.blockedReason = `${this.adapter.displayName} hit a ${c.cls.replace(/_/g, " ")}: ${orig}. Automatic resume is disabled; /retry ${this.task.id} when it is available.`;
      return { retry: false };
    }
    if (c.cls === "quota_exhausted" && !rec.unlimited_quota_wait && rec.max_wait_seconds === 0) return { retry: false };
    // Optional, explicitly enabled failover to another configured agent for this role.
    const fb = roleConfig(this.rc.cfg, this.task.role).fallback_agent;
    if (rec.allow_provider_failover && fb && fb !== this.adapter.id && c.cls !== "rate_limit") {
      const next = this.rc.adapterFor(this.task.role, fb);
      this.ev({ type: "recovery", phase: "failover", cls: c.cls, message: `${this.adapter.provider}/${this.adapter.id} → ${next.provider}/${next.id} (allow_provider_failover is enabled; verification and review will run again)` });
      this.adapter = next;
      this.failedOver = true;
      this.compactSummary = ""; // the new agent starts a new session (the registry sees the adapter change)
      this.started = false;
      return { retry: true };
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

  /** Set when a hard limit stopped the agent mid-segment: the reason, shown to the user with the ways forward. */
  private limit: string | null = null;
  /** Tokens already used when the user last allowed more (/continue): the cap counts from there. */
  private capFrom = 0;

  private tokensUsed(): number {
    const u = this.rc.store.get(this.agentRunId)?.usage;
    return u ? u.input_tokens + u.cache_read_tokens + u.output_tokens : 0;
  }

  /** At every model call: a task over its token cap is stopped at this step boundary, not after it finishes. */
  private enforceLimits(): void {
    const cap = this.rc.cfg.run.task_budget_tokens;
    if (!cap || this.limit || this.cancelled) return;
    const used = this.tokensUsed() - this.capFrom;
    if (used < cap) return;
    this.limit = this.escalation(`it used ${used.toLocaleString("en-US")} tokens, over the per-task cap of ${cap.toLocaleString("en-US")}`);
    this.ev({ type: "error", kind: "internal", message: this.limit, retryable: false });
    this.abort.abort();
  }

  /** One paragraph for the user when a loop or budget limit stops a task: what happened, and what they can do. */
  private escalation(why: string, last?: string): string {
    const id = this.task.id;
    return `${id} stopped: ${why}.${last ? ` Last problem: ${last}` : ""} You can: /continue ${id} <guidance> to let it go on with your input (a token cap restarts from here), /retry ${id} for a fresh attempt, change the task or its spec, or raise [run] max_fix_cycles / task_budget_tokens (now ${this.rc.cfg.run.max_fix_cycles} / ${this.rc.cfg.run.task_budget_tokens}).`;
  }

  private failSigs: string[] = [];
  /** Unlimited cycles still stop when the same failure repeats: returns the reason to escalate, else null. */
  private noProgress(sig: string): string | null {
    this.failSigs.push(sig);
    const n = this.rc.cfg.run.max_identical_failures;
    if (n > 0 && this.failSigs.length >= n && this.failSigs.slice(-n).every((x) => x === sig)) {
      this.ev({ type: "error", kind: "stuck", message: `the same failure repeated ${n} times with no change`, retryable: false });
      this.notify(this.escalation(`the same failure repeated ${n} times with no change`));
      return `no progress: identical failure ${n} times`;
    }
    return null;
  }

  /** Transitive dependencies of this task (the agents whose work it builds on). */
  private upstream(): string[] {
    const out = new Set<string>();
    const walk = (id: string) => {
      for (const d of this.rc.tasks.find((t) => t.id === id)?.depends_on ?? []) if (!out.has(d)) { out.add(d); walk(d); }
    };
    walk(this.task.id);
    return [...out];
  }

  /** Tell the dependents what this task delivered: a bounded handoff, with the result file for the details. */
  private publishHandoff(): void {
    const dependents = this.rc.tasks.filter((t) => t.depends_on.includes(this.task.id));
    const r = this.result;
    if (!r) return;
    const artifact = path.relative(this.rc.root, this.rc.run.agentResult(this.agentRunId));
    for (const d of dependents) {
      this.rc.bus.send({
        kind: "handoff", from: this.task.id, to: { agent: d.id }, subject: `${this.task.id} done: ${r.summary.split("\n")[0]}`.slice(0, 120),
        fields: { files: r.files_changed.slice(0, 8).join(", ") + (r.files_changed.length > 8 ? ` (+${r.files_changed.length - 8})` : ""), acceptance: r.acceptance_evidence.map((e) => e.ac).join(", "), branch: this.branch },
        body: [r.summary, r.assumptions.length ? `Assumptions: ${r.assumptions.map((a) => a.text).join("; ")}` : "", r.follow_ups.length ? `Follow-ups: ${r.follow_ups.join("; ")}` : ""].filter(Boolean).join("\n"),
        artifact, refs: this.task.requirements, record_only: true,
      });
    }
  }

  /** `hexagon bus send|read|subscribe` from the agent. */
  private busCall(a: Record<string, unknown>): Reply {
    const me = this.task.id;
    const bus = this.rc.bus;
    switch (a.action) {
      case "subscribe": {
        const topic = String(a.topic ?? "").trim();
        if (!topic) return { ok: false, message: "usage: hexagon bus subscribe <topic>" };
        bus.subscribe(me, topic);
        return ok(`Subscribed to "${topic}".`);
      }
      case "read": {
        const items = bus.read(me, { role: this.task.role, sinceSeq: a.since as number | undefined, kind: a.kind as BusKind | undefined, limit: (a.limit as number | undefined) ?? 20 });
        if (!items.length) return ok("No messages for you.");
        return ok(items.map((e) => `${e.id} [${e.kind}] from ${e.from}: ${e.subject}${Object.keys(e.fields).length ? ` (${Object.entries(e.fields).map(([k, v]) => `${k}=${v}`).join("; ")})` : ""}${e.body && e.body !== e.subject ? `\n  ${e.body.replace(/\n+/g, "\n  ")}` : ""}${e.artifact ? `\n  full: ${e.artifact}` : ""}`).join("\n"));
      }
      case "send": {
        const kind = String(a.kind ?? "broadcast") as BusKind;
        if (!BUS_KINDS.includes(kind)) return { ok: false, message: `unknown kind "${kind}" (use ${BUS_KINDS.join(", ")})` };
        const to = a.to ? normTaskId(String(a.to)) : undefined;
        if (to && !this.rc.tasks.some((t) => t.id === to)) return { ok: false, message: `there is no task ${to} in this run` };
        const r = bus.send({
          kind, from: me, to: { agent: to, role: a.role ? String(a.role) : undefined, topic: a.topic ? String(a.topic) : undefined },
          subject: a.subject ? String(a.subject) : undefined, fields: (a.fields as Record<string, string> | undefined) ?? {}, body: String(a.body ?? ""),
          artifact: a.artifact ? String(a.artifact) : undefined, reply_to: a.reply_to ? String(a.reply_to) : null, blocking: Boolean(a.blocking), timeout_s: a.timeout_s as number | undefined,
        });
        if (!r.ok) return { ok: false, message: r.reason };
        const e = r.envelope;
        const tail = e.blocking ? ` You wait for the answer: end your turn; it arrives as your next message (or a timeout notice after ${e.timeout_s}s).` : "";
        return ok(`${r.duplicate ? "Already sent as" : "Sent as"} ${e.id} (${e.state}${e.truncated ? ", text shortened to the size limit" : ""}).${tail}`);
      }
      default:
        return { ok: false, message: "usage: hexagon bus send|read|subscribe" };
    }
  }

  /**
   * Context that must survive every compaction, rebuilt from files and state, never from the model's memory:
   * the changed files, finished criteria, outstanding feedback and the shared notes. (The task card is sent separately.)
   */
  private pinnedContext(): string {
    const s = this.rc.store.get(this.agentRunId);
    const done = (s?.checklist ?? []).filter((i) => i.status === "done").map((i) => i.id);
    const files = (s?.files_touched ?? []).slice(0, 40);
    const notes = this.rc.router.notes().split("\n").filter(Boolean).slice(-20).join("\n");
    return [
      "You are continuing this task in a NEW session (the earlier conversation was compacted). The task card above is the full, unchanged specification and acceptance criteria.",
      this.compactSummary ? `Summary of the earlier conversation (written by you):\n${this.compactSummary}` : "",
      files.length ? `Files already changed in the worktree (inspect them with git diff / git status): ${files.join(", ")}` : "No files changed yet.",
      done.length ? `Acceptance criteria already reported done: ${done.join(", ")}` : "",
      this.outstanding ? `Outstanding feedback you must still address:\n${this.excerpt(this.outstanding, FIX_EXCERPT, "outstanding feedback")}` : "",
      notes ? `Decisions and notes shared by the other agents:\n${notes}` : "",
      this.failedOver ? "The previous agent was replaced because its provider was unavailable; verify its work critically." : "",
      "Check the current state of the worktree first, continue from it, then run `hexagon done`.",
    ].filter(Boolean).join("\n\n");
  }

  private ctx(o: { role: Role; sessionId: string; resume: boolean; handle?: string | null; followUp?: string; freshTask?: boolean; prompt: string; system: string; readOnly: boolean; api: AgentApi; host: AgentHost; agentId: string; cwd?: string }): AgentRunContext {
    return {
      agentRunId: o.agentId,
      role: o.role,
      task: this.task,
      effort: o.role === "reviewer" ? roleConfig(this.rc.cfg, "reviewer").effort : this.effort,
      cwd: o.cwd ?? this.worktree,
      system: o.system,
      prompt: o.prompt,
      followUp: o.followUp,
      freshTask: o.freshTask,
      sessionId: o.sessionId,
      resume: o.resume,
      handle: o.handle ?? null,
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
      agent_identity: this.identity,
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
    this.releaseLease();
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
    if (m.ok) this.checkpoint = await g.revParse(this.worktree, "HEAD");
    this.ev({ type: "chat", from: "hexagon", text: `${w.task} fixed it${m.ok ? " and the fix is merged into this worktree" : ", but merging it here failed"}: ${r.summary}` });
    return m.ok
      ? `${w.task} fixed what you returned, and the fix is merged into your worktree. Their summary: ${r.summary}\n\nContinue your task: re-check it, then run \`hexagon done\`.`
      : `${w.task} fixed what you returned, but merging the fix into your worktree failed:\n${truncateMiddle(m.output, 2000)}\nResolve it if it is in your scope, otherwise report blocked.`;
  }

  /**
   * Commits the agent made itself (git commit, amend, reset, rebase) are history Hexagon did not write and the scope
   * check would never see. Turn them back into plain changes, so scope is checked on everything the agent did and
   * the branch gets one Hexagon commit.
   */
  private async normaliseHistory(): Promise<void> {
    if (!this.checkpoint) return;
    const head = await g.revParse(this.worktree, "HEAD").catch(() => "");
    if (!head || head === this.checkpoint) return;
    const rewritten = !(await g.isAncestor(this.worktree, this.checkpoint, head));
    await g.uncommitTo(this.worktree, this.checkpoint);
    this.ev({ type: "error", kind: "scope_violation", message: rewritten ? "the agent rewrote git history; its changes were kept as plain edits and checked against the scope" : "the agent made its own git commits; they were folded into one Hexagon commit and checked against the scope", retryable: false });
  }

  /**
   * Commit what the agent did. Changes outside the write mask: the first time they are reported back to the agent and
   * nothing is committed or reverted ("warn"); if they are still there on the next done (or the agent cannot be
   * given another round), they are reverted and the reason goes into the next follow-up and the reviewer's input.
   */
  private async commit(mode: "warn" | "final" = "final"): Promise<{ warn?: string[] }> {
    if (!this.userDone) await this.normaliseHistory();
    const changed = await g.uncommittedFiles(this.worktree);
    if (!this.userDone) {
      const outside = changed.filter((f) => !matchesAny(f, this.task.files.write));
      if (outside.length && mode === "warn" && this.scopeStrikes === 0) {
        this.scopeStrikes++;
        this.ev({ type: "error", kind: "scope_violation", message: `out-of-scope changes (not reverted yet, the agent was told): ${outside.join(", ")}`, retryable: true });
        return { warn: outside };
      }
      for (const f of outside) {
        const tracked = (await g.git(this.worktree, ["ls-files", "--error-unmatch", f])).ok;
        if (tracked) await g.git(this.worktree, ["checkout", "--", f]);
        else fs.rmSync(path.join(this.worktree, f), { force: true, recursive: true });
      }
      if (outside.length) {
        this.scopeReverts.push(...outside.filter((f) => !this.scopeReverts.includes(f)));
        this.revertNotice = `Hexagon reverted these paths because they are outside this task's write scope${this.scopeStrikes ? " and were still there after the earlier warning" : ""}: ${outside.join(", ")}. Write scope: ${this.task.files.write.join(", ") || "(empty)"}. Anything your work needs from them must live inside the scope.`;
        this.ev({ type: "error", kind: "scope_violation", message: `reverted out-of-scope changes: ${outside.join(", ")}`, retryable: false });
      }
    }
    const message = `${this.task.id}: ${this.task.title}\n\n${this.result?.summary ?? ""}\n\nHexagon-Task: ${this.task.id}\nHexagon-Attempt: ${this.attempt}\nRefs: ${refs(this.task)}`;
    await g.commitAll(this.worktree, message);
    this.checkpoint = await g.revParse(this.worktree, "HEAD");
    const tg = this.rc.cfg.run.test_globs;
    this.integrity = await testIntegrity(this.worktree, this.baseCommit, tg.length ? tg : DEFAULT_TEST_GLOBS);
    if (this.integrity.length) this.ev({ type: "progress", text: `test integrity: ${describeFlags(this.integrity).join("; ")}` });
    if (this.result) this.result.test_integrity = this.integrity;
    const files = await g.changedFiles(this.worktree, this.baseCommit);
    if (files.length) this.ev({ type: "files", files });
    if (this.result) this.result.files_changed = files;
    return {};
  }

  /** What the agent is told on the first out-of-scope finding. */
  private scopeWarning(outside: string[]): string {
    return `Hexagon found changes outside this task's write scope. Nothing was reverted yet and nothing was committed.\n\nOutside the scope:\n${outside.map((f) => `- ${f}`).join("\n")}\n\nWrite scope: ${this.task.files.write.join(", ") || "(empty)"}\n\nChoose one:\n1. Drop the changes: restore tracked files with \`git checkout -- <path>\`, delete files you created.\n2. Move the work into a file inside the scope.\n3. If the task cannot be done without these files, finish with \`hexagon done --status needs_spec_change --issue "<paths and why>"\` so the plan can be changed.\n\nThen run \`hexagon done\` again. If these paths are still changed then, Hexagon reverts them and tells you.`;
  }

  /** Prefix a follow-up with a pending explanation of what Hexagon reverted (once). */
  private withNotice(text: string): string {
    const n = this.revertNotice;
    this.revertNotice = "";
    return n ? `${n}\n\n${text}` : text;
  }

  private async verify(cwd = this.worktree): Promise<{ ok: boolean; cmd: string; code: number; output: string }> {
    this.abort = new AbortController();
    for (const cmd of this.task.verify) {
      this.ev({ type: "progress", text: `verify: ${cmd}` });
      const r = await runShell(cmd, cwd, this.rc.cfg.sandbox.command_timeout_s, this.abort.signal);
      this.verifyLog.push({ cmd, code: r.code, output: r.output });
      if (r.code !== 0) return { ok: false, cmd, code: r.code, output: r.output };
    }
    return { ok: true, cmd: "", code: 0, output: "" };
  }

  private async runReview(): Promise<ReviewVerdict | undefined> {
    const reviewer = this.rc.adapterFor("reviewer");
    if (!reviewer.security.readOnlyEnforced && reviewer.adapterId !== "mock" && !this.rc.cfg.agents[reviewer.id]?.allow_weaker_isolation) {
      const m = `the reviewer agent "${reviewer.id}" (${reviewer.displayName}) cannot enforce read-only execution; reviews run read-only. Use another agent for the reviewer role, or set allow_weaker_isolation = true under [agents.${reviewer.id}] to accept weaker isolation.`;
      this.ev({ type: "error", kind: "internal", message: m, retryable: false });
      this.notify(`review blocked: ${m}`);
      return undefined;
    }
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
    const lease = this.rc.pool.acquire("reviewer");
    const prevSink = this.sink;
    const prevCause = this.cause;
    this.sink = { identity: lease.agentId, cause: "review" };
    this.cause = "review";
    try {
      const cap = reviewer.capabilities;
      // Independence: a reviewer that remembers earlier tasks carries their conclusions. Fresh per task, kept across fix loops.
      if (!this.reviewedOnce) { this.rc.sessions.reset(lease.agentId, "independent review: a new context for every task"); this.reviewedOnce = true; }
      let res = this.rc.sessions.resolve({
        agentId: lease.agentId, role: "reviewer", adapterId: reviewer.adapterId, model: reviewer.model,
        promptHash: identityHash(this.rc.paths, "reviewer", this.rc.skills, this.rc.cfg.roles.reviewer), cwd: this.worktree,
        resumeAcrossCwd: cap.resumeAcrossCwd, supportsResume: cap.supportsSessionResume,
      });
      if (res.resume) {
        const d = shouldCompact(this.rc.cfg.context, res.record, Boolean(res.record.compactRequested));
        if (d.compact) res = (await this.compact(res, d.why, { role: "reviewer", adapter: reviewer })) ?? res;
      }
      this.ev({ type: "progress", text: `review by ${lease.agentId}: ${res.mode === "new" ? `new session (${res.reason})` : `resumed session, turn ${res.record.turns}`}` });
      const base = this.baseCommit.slice(0, 12);
      const [stat, diff] = await Promise.all([g.diff(this.worktree, this.baseCommit, true), g.diff(this.worktree, this.baseCommit)]);
      const shown = diff.length > REVIEW_DIFF ? truncateMiddle(diff, REVIEW_DIFF) : diff;
      const prompt = [
        taskCard(this.task, this.rc.specs, "", []),
        res.mode === "new" && this.reviewerSummary ? `Your earlier review notes (compacted):\n${this.reviewerSummary}` : "",
        // The spec and the diff come first: form your own view before reading what the developer says about it.
        `<diffstat base="${base}">\n${stat}\n</diffstat>`,
        `<diff base="${base}"${diff.length > REVIEW_DIFF ? ` truncated="true"` : ""}>\n${shown}\n</diff>`,
        diff.length > REVIEW_DIFF ? `The diff above was cut (${diff.length} chars). Read the rest per file: \`git diff ${base}...HEAD -- <file>\`.` : "",
        this.verifySummary(),
        this.integrity.length ? `<test_integrity note="found by Hexagon; look at each before approving">\n${describeFlags(this.integrity).join("\n")}\n</test_integrity>` : "",
        this.evidenceSummary(),
        `<developer_claim unverified="true" note="what the developer says; nothing in it is checked unless marked above">\n${JSON.stringify(compactReport(this.result))}\n</developer_claim>`,
        `Review task ${this.task.id}. You may read files and run the verify commands. Finish with \`hexagon review\`.`,
      ].filter(Boolean).join("\n\n");
      this.abort = new AbortController();
      const out = await reviewer.run(this.ctx({
        role: "reviewer",
        sessionId: res.sessionId,
        resume: res.resume,
        handle: res.record.nativeHandle ?? null,
        followUp: res.resume ? prompt : undefined,
        freshTask: true,
        prompt,
        system: systemPrompt(this.rc.paths, "reviewer", this.rc.skills, this.rc.context, this.rc.cfg.roles.reviewer),
        readOnly: true,
        api,
        agentId: id,
        host: {
          emit: (e) => {
            if (e.type === "progress" && e.text === "session started") { this.rc.sessions.confirm(lease.agentId); return; }
            if (e.type === "session_handle") { this.rc.sessions.setHandle(lease.agentId, e.handle); return; }
            this.ev(e.type === "progress" ? { ...e, text: `review: ${e.text}` } : e.type === "tool_call" ? { ...e, summary: `review: ${e.summary}` } : e);
          },
          drainInbox: () => [],
          onInbox: () => () => undefined,
          received: () => undefined,
          isFinished: () => verdict !== undefined,
          hasBlockingQuestion: () => false,
        },
      }));
      if (out.kind !== "error") this.rc.sessions.confirm(lease.agentId);
      if (out.kind === "error") this.ev({ type: "error", ...out.error! });
    } finally {
      this.sink = prevSink;
      this.cause = prevCause;
      lease.release();
      unregister();
    }
    return verdict;
  }

  /** What Hexagon ran and saw, as opposed to what the developer says. */
  private verifySummary(): string {
    const reverted = this.scopeReverts.length ? `\n<reverted_out_of_scope note="Hexagon reverted these paths: the developer changed files outside the write scope">\n${this.scopeReverts.join("\n")}\n</reverted_out_of_scope>` : "";
    return this.verifyBody() + reverted;
  }

  private verifyBody(): string {
    const last = this.verifyLog.slice(-Math.max(1, this.task.verify.length));
    if (!this.task.verify.length) return `<verification>no verify command${this.task.verify_exempt ? ` (exempt: ${this.task.verify_exempt})` : ""}: nothing independent was run</verification>`;
    return `<verification note="run by Hexagon after the developer finished">\n${last.map((v) => `${v.code === 0 ? "pass" : "FAIL"} (exit ${v.code}): ${v.cmd}`).join("\n")}\n</verification>`;
  }

  private evidenceSummary(): string {
    const ev = this.result?.acceptance_evidence ?? [];
    if (!ev.length) return "";
    return `<evidence note="verified = Hexagon confirmed it; claimed = only the developer said so">\n${ev.map((e) => `${e.ac} [${e.verified ? "verified" : "claimed"}] ${e.basis ?? ""} :: ${truncateMiddle(e.evidence, 200)}`).join("\n")}\n</evidence>`;
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
      emit: (e) => {
        // "session started" fires on every CLI start, resumed or not: it only confirms the session exists.
        if (e.type === "progress" && e.text === "session started") { this.sessionSeen = true; if (this.identity) this.rc.sessions.confirm(this.identity); return; }
        if (e.type === "session_handle") { if (this.identity) this.rc.sessions.setHandle(this.identity, e.handle); return; }
        this.ev(e);
      },
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
        this.rc.bus.send({ kind: "broadcast", from: this.task.id, to: {}, body, record_only: true });
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
        if (r.status === "completed" && this.task.acceptance.length) {
          const missing = missingEvidence(this.task.acceptance, r.acceptance_evidence);
          if (missing.length) return { ok: false, message: `No evidence for ${missing.join(", ")}. Add one per criterion: hexagon done --evidence "${missing[0]}: test:<file>::<test name>" (a test that proves it; any other text is recorded as a claim) and run \`hexagon done\` again.` };
        }
        if (!r.summary.trim()) return { ok: false, message: "Add --summary \"<what you did>\" and run `hexagon done` again." };
        this.result = r;
        this.finished = true;
        if (r.acceptance_evidence.length) {
          this.ev({ type: "status_report", checklist: r.acceptance_evidence.map((e) => ({ id: e.ac, status: "done" as const })) });
        }
        return ok("Result recorded. Hexagon will now verify, review and merge your work. End your turn now.");
      },
      review: () => ({ ok: false, message: "Only the reviewer can run `hexagon review`." }),
      bus: (a) => this.busCall(a),
      return: (x) => {
        const to = String(x.task ?? "").toUpperCase().replace(/^T(\d)/, "T-$1");
        const issue = String(x.issue ?? "").trim();
        if (!to || !issue) return { ok: false, message: 'Usage: hexagon return <T-n> "<what is wrong, where, and the evidence>"' };
        if (this.waiting) return { ok: false, message: `You already returned work to ${this.waiting.task}. End your turn and wait.` };
        const r = this.rc.returnTask(this.task.id, to, issue);
        if (!r.ok) return { ok: false, message: r.message };
        this.rc.bus.send({ kind: "request", from: this.task.id, to: { agent: to }, subject: issue.split("\n")[0]!.slice(0, 120), body: issue, record_only: true });
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
    if (this.state === "waiting_input" && !this.questions.size) this.st(this.gate ? "paused" : this.fixing ? "fixing" : "working");
    // Delivered to the agent through its inbox (live, or when it resumes).
    this.rc.router.send({
      from: { kind: "user" }, to: { kind: "agent", id: this.task.id }, type: "answer",
      body: `Answer to ${questionId} ("${open.q.prompt}"): ${answer}`, reply_to: open.messageId,
    });
    return true;
  }

  pause(reason = "paused by user"): boolean {
    if (this.gate || !["preparing", "working", "fixing", "waiting_input"].includes(this.state)) return false;
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
    this.checkpoint = this.takeoverCommit;
    this.ev({ type: "controller", controller: "user" });
    const native = this.started ? this.adapter.takeoverCommand(this.sessionId) : null;
    return { worktree: this.worktree, branch: this.branch, command: native ?? [process.env.SHELL ?? "/bin/zsh"] };
  }

  async endTakeover(action: "handback" | "done" | "discard"): Promise<void> {
    if (action === "discard" && this.takeoverCommit) await g.resetHard(this.worktree, this.takeoverCommit);
    this.checkpoint = await g.revParse(this.worktree, "HEAD").catch(() => this.checkpoint); // what the user committed is theirs
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
const normTaskId = (s: string) => s.toUpperCase().replace(/^T(\d)/, "T-$1");

/** Largest piece of failure output / feedback sent back to an agent (head + tail). */
const FIX_EXCERPT = 6000;
/** Largest diff embedded in a review prompt; the reviewer reads the rest per file. */
const REVIEW_DIFF = 24_000;

/** The developer's report without fields the reviewer re-derives from the diff. */
function compactReport(r: ResultEnvelope | undefined): unknown {
  if (!r) return null;
  const { files_changed: _f, ...rest } = r;
  return rest;
}

function refs(t: Task): string {
  return t.requirements.flatMap((r) => (t.acceptance.length ? t.acceptance.map((a) => `${r}/${a}`) : [r])).join(", ") || t.id;
}

export type { ErrorKind };
