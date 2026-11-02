import { EventEmitter } from "node:events";
import type { AgentState, Effort, Plan, Task } from "../contracts/types.js";
import { TERMINAL_STATES } from "../contracts/types.js";
import { atomicWriteJson } from "../util/fsx.js";
import { applyGraph } from "./commands.js";
import { overlaps } from "./plan.js";
import { roleConfig } from "./config.js";
import { AgentRun, type RunContext } from "./supervisor.js";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const escalate = (e: Effort, steps: number): Effort => EFFORTS[Math.min(EFFORTS.indexOf(e) + steps, EFFORTS.length - 1)]!;

/** State a previous daemon left for a task (restart recovery). */
export interface PriorTask { state: AgentState; attempt: number; identity?: string | null; sessionId?: string | null; nextRetryAt?: string | null }

export interface SchedulerOptions {
  /** Resuming a run after a restart: statuses are already on disk and must not be recreated or duplicated. */
  prior?: Map<string, PriorTask>;
  only?: string[];
  agentOverride?: string | null;
  maxParallel?: number;
}

/** Runs the task DAG: dependencies, file leases, concurrency, retries, budget. */
export class Scheduler extends EventEmitter {
  private active = new Map<string, AgentRun>();
  private attempts = new Map<string, number>();
  private overrides = new Map<string, { agent?: string; effort?: Effort }>();
  private outcome = new Map<string, AgentState>();
  /** Latest attempt per task, kept after it finishes so it can be continued. */
  private last = new Map<string, AgentRun>();
  /** Agents waiting for a task they returned work to. */
  private waiters = new Map<string, ((r: { state: AgentState; summary: string }) => void)[]>();
  private returns = new Map<string, number>();
  /** Tasks held back by the spec gate; they start by themselves once the spec is approved again. */
  private gated = new Set<string>();
  private tasks: Task[];
  paused = false;
  aborted = false;
  private done!: () => void;
  readonly finished: Promise<void>;

  constructor(private rc: RunContext, readonly plan: Plan, private opts: SchedulerOptions = {}) {
    super();
    this.tasks = opts.only?.length ? plan.tasks.filter((t) => opts.only!.includes(t.id)) : plan.tasks;
    this.finished = new Promise((r) => (this.done = r));
    // Not only on the next tick: an agent in the middle of a long segment is stopped at its next model call.
    this.rc.store.on("event", (e: { event: { type: string; step?: boolean } }) => {
      if (e.event.type === "usage" && e.event.step) queueMicrotask(() => this.enforceBudget());
    });
  }

  start(): void {
    for (const t of this.tasks) {
      const p = this.opts.prior?.get(t.id);
      if (p && TERMINAL_STATES.has(p.state)) { this.attempts.set(t.id, p.attempt); this.outcome.set(t.id, p.state); continue; } // never restarted
      if (p && p.state === "waiting_quota") { this.attempts.set(t.id, p.attempt); continue; } // same task, same attempt, same session
      const n = p ? (p.state === "queued" ? p.attempt : p.attempt + 1) : 1; // interrupted mid-run: a new attempt, as /retry would do
      this.attempts.set(t.id, n);
      this.createStatus(t, n);
    }
    this.rc.store.startHeartbeat();
    this.tick();
  }

  get maxParallel(): number {
    return this.opts.maxParallel ?? this.rc.cfg.run.max_parallel;
  }

  run(taskId: string): AgentRun | undefined {
    return this.active.get(taskId);
  }

  activeRuns(): AgentRun[] {
    return [...this.active.values()];
  }

  activeTaskIds(role?: string): string[] {
    return [...this.active.values()].filter((r) => !role || r.task.role === role || `${r.task.role}s` === role).map((r) => r.task.id);
  }

  task(id: string): Task | undefined {
    return this.plan.tasks.find((t) => t.id === id);
  }

  private createStatus(t: Task, attempt: number): void {
    const role = roleConfig(this.rc.cfg, t.role);
    const adapter = this.rc.adapterFor(t.role, this.overrides.get(t.id)?.agent ?? this.opts.agentOverride ?? t.agent_hint);
    this.rc.store.create({
      task: t, attempt, role: t.role,
      agent: {
        id: adapter.id, provider: adapter.provider, model: adapter.model, effort: this.effortFor(t, attempt, role.effort),
        adapter: adapter.adapterId, model_mode: adapter.selection.mode,
      },
      supportsLiveInput: adapter.supportsLiveInput,
    });
  }

  private effortFor(t: Task, attempt: number, base: Effort): Effort {
    return this.overrides.get(t.id)?.effort ?? escalate(base, attempt - 1);
  }

  private depsState(t: Task): { ready: boolean; failedDep?: string; waitingOn?: string } {
    for (const d of t.depends_on) {
      if (!this.tasks.some((x) => x.id === d)) continue; // outside --only selection: assumed satisfied
      const o = this.outcome.get(d);
      if (o === "done") continue;
      if (o && TERMINAL_STATES.has(o)) return { ready: false, failedDep: d };
      return { ready: false, waitingOn: d };
    }
    return { ready: true };
  }

  /**
   * Give a running task more write scope for as long as it runs. The lease is the scope itself: other tasks are held
   * back by `leaseConflict` while this one is active, so a grant is refused while another active task's scope overlaps.
   */
  grantScope(taskId: string, globs: string[]): { ok: true } | { ok: false; heldBy: string } {
    const mine = this.active.get(taskId)?.task ?? this.tasks.find((t) => t.id === taskId);
    if (!mine) return { ok: false, heldBy: "(unknown task)" };
    const holder = this.scopeHolder(taskId, globs);
    if (holder) return { ok: false, heldBy: holder };
    for (const gl of globs) if (!mine.files.write.includes(gl)) mine.files.write.push(gl);
    this.persistGraph();
    return { ok: true };
  }

  /** The running task (other than `taskId`) whose write scope overlaps `globs`, if any. */
  scopeHolder(taskId: string, globs: string[]): string | null {
    for (const r of this.active.values()) if (r.task.id !== taskId && overlaps(globs, r.task.files.write)) return r.task.id;
    return null;
  }

  private leaseConflict(t: Task): string | null {
    for (const r of this.active.values()) {
      if (overlaps(t.files.write, r.task.files.write)) return r.task.id;
    }
    return null;
  }

  /** The run budget, checked at every model call of every agent as well as on each tick: agents in flight stop at their next step. */
  enforceBudget(): void {
    const budget = this.rc.cfg.run.budget_tokens;
    if (budget === null || this.paused || this.aborted) return;
    const t = this.rc.store.totals();
    if (t.input_tokens + t.cache_read_tokens + t.output_tokens < budget) return;
    this.pauseAll();
    this.rc.store.setAttention([{ kind: "budget", task_id: null, text: `token budget of ${budget} reached — /resume to continue or raise [run].budget_tokens` }]);
    this.rc.router.send({ from: { kind: "orchestrator" }, to: { kind: "user" }, type: "notify", body: `Token budget ${budget} reached; running agents paused at their next step.` });
  }

  tick(): void {
    if (this.aborted) return;
    this.enforceBudget();
    let changed = false;
    for (const t of this.tasks) {
      if (this.outcome.has(t.id) || this.active.has(t.id)) continue;
      const id = `${t.id}-a${this.attempts.get(t.id)}`;
      const deps = this.depsState(t);
      if (deps.failedDep) {
        this.rc.store.apply(id, { type: "state", state: "blocked", reason: `dependency ${deps.failedDep} did not complete` });
        this.outcome.set(t.id, "blocked");
        changed = true;
        continue;
      }
      if (!deps.ready) { this.reason(id, `waiting for ${deps.waitingOn}`); continue; }
      if (this.paused) { this.reason(id, "run paused"); continue; }
      const gate = this.rc.gate?.(t);
      if (gate && !gate.ok) {
        const why = `spec gate: ${gate.problems[0]}`;
        this.rc.store.apply(id, { type: "state", state: "blocked", reason: why });
        this.rc.router.send({ from: { kind: "orchestrator" }, to: { kind: "user" }, type: "notify", body: `${t.id} did not start. ${why}. Review and approve the spec (hexagon approve-spec <file>); the task then starts by itself.` });
        this.gated.add(t.id);
        this.outcome.set(t.id, "blocked");
        changed = true;
        continue;
      }
      const lease = this.leaseConflict(t);
      if (lease) { this.reason(id, `waiting for file lease held by ${lease}`); continue; }
      if (this.active.size >= this.maxParallel) { this.reason(id, `waiting for a free slot (${this.maxParallel} max)`); continue; }
      this.launch(t);
    }
    if (changed) this.tick();
    this.checkDone();
  }

  private reason(agentRunId: string, reason: string): void {
    const s = this.rc.store.get(agentRunId);
    if (s && s.state === "queued" && s.state_reason !== reason) this.rc.store.apply(agentRunId, { type: "state", state: "queued", reason });
  }

  private launch(t: Task): void {
    const attempt = this.attempts.get(t.id)!;
    const ov = this.overrides.get(t.id);
    const adapter = this.rc.adapterFor(t.role, ov?.agent ?? this.opts.agentOverride ?? t.agent_hint);
    const p = this.opts.prior?.get(t.id);
    const resume = p?.state === "waiting_quota" && p.attempt === attempt && p.sessionId ? { sessionId: p.sessionId, identity: p.identity ?? null, nextRetryAt: p.nextRetryAt ?? new Date().toISOString() } : undefined;
    if (resume) this.opts.prior!.delete(t.id); // consumed: a later attempt starts fresh
    const run = new AgentRun(this.rc, t, attempt, this.effortFor(t, attempt, roleConfig(this.rc.cfg, t.role).effort), adapter, resume);
    this.active.set(t.id, run);
    this.last.set(t.id, run);
    this.emit("launch", run);
    this.watch(t, run, run.execute());
  }

  private watch(t: Task, run: AgentRun, p: Promise<AgentState>): void {
    p
      .catch((e) => {
        this.rc.store.apply(run.agentRunId, { type: "error", kind: "internal", message: String(e), retryable: false });
        this.rc.store.apply(run.agentRunId, { type: "state", state: "failed", reason: "internal error" });
        return "failed" as AgentState;
      })
      .then((state) => this.finish(t, run, state));
  }

  private finish(t: Task, run: AgentRun, state: AgentState): void {
    this.active.delete(t.id);
    const waiting = this.waiters.get(t.id);
    const s = this.rc.store.get(run.agentRunId);
    const retryable = state === "failed" && s?.last_error?.retryable !== false;
    const attempt = this.attempts.get(t.id)!;
    if (retryable && attempt < this.rc.cfg.run.max_attempts && !this.aborted) {
      this.attempts.set(t.id, attempt + 1);
      this.createStatus(t, attempt + 1);
      this.rc.router.send({ from: { kind: "orchestrator" }, to: { kind: "user" }, type: "notify", body: `${t.id}: retrying (attempt ${attempt + 1}) with more effort` });
    } else {
      this.outcome.set(t.id, state);
      if (waiting?.length) {
        this.waiters.delete(t.id);
        for (const w of waiting) w({ state, summary: run.outcomeSummary });
      }
    }
    this.tick();
  }

  /** User-initiated retry with optional overrides. */
  retry(taskId: string, ov: { agent?: string; effort?: Effort }): void {
    const t = this.task(taskId);
    if (!t || !this.tasks.includes(t)) throw new Error(`unknown task ${taskId}`);
    const cur = this.active.get(taskId);
    if (cur) cur.cancel();
    this.overrides.set(taskId, { ...this.overrides.get(taskId), ...ov });
    const next = (this.attempts.get(taskId) ?? 0) + 1;
    this.attempts.set(taskId, next);
    this.outcome.delete(taskId);
    this.reviveDependents(taskId);
    this.createStatus(t, next);
    if (!cur) this.tick(); // otherwise finish() of the cancelled run ticks
  }

  /** After a (re-)approval: tasks held back by the spec gate that pass now start again. Finished tasks whose requirement changed are reported, not re-run. */
  reviveGated(): void {
    for (const id of [...this.gated]) {
      const t = this.task(id);
      if (!t || this.rc.gate?.(t).ok === false) continue;
      this.gated.delete(id);
      this.outcome.delete(id);
      this.reviveDependents(id);
      this.rc.store.apply(`${id}-a${this.attempts.get(id)}`, { type: "state", state: "queued", reason: "spec approved" });
    }
    for (const t of this.tasks) {
      if (this.outcome.get(t.id) !== "done") continue;
      const g = this.rc.gate?.(t);
      if (g && !g.ok) this.rc.router.send({ from: { kind: "orchestrator" }, to: { kind: "user" }, type: "notify", body: `${t.id} is done but ${g.problems[0]}. /retry ${t.id} to redo it against the new text.` });
    }
    this.tick();
  }

  // ───────────── live graph editing ─────────────

  /** A task may be changed only while nothing of it exists yet: it never launched, has no outcome, is not running. */
  editable(id: string): boolean {
    const prior = this.opts.prior?.get(id);
    // A task held back only because something it waits for failed (outcome "blocked", never launched) has not started either.
    const unlaunchedBlock = this.outcome.get(id) === "blocked" && !this.last.has(id);
    return this.tasks.some((t) => t.id === id) && !this.active.has(id) && (!this.outcome.has(id) || unlaunchedBlock) && !this.last.has(id) && (!prior || prior.state === "queued");
  }

  /** Why `id` cannot be edited, or null. */
  whyNotEditable(id: string): string | null {
    if (!this.tasks.some((t) => t.id === id)) return `no task ${id} in this run`;
    if (this.editable(id)) return null;
    const o = this.outcome.get(id);
    return o ? `${id} already finished (${o}); /retry ${id} runs it again` : `${id} already started; cancel it first (agent.cancel), then edit`;
  }

  private persistGraph(): void {
    atomicWriteJson(this.rc.run.plan, this.plan);
    this.emit("graph", this.plan);
  }

  /**
   * Apply a graph command to the running graph. Tasks and edges can be added any time; a task can be removed, and
   * its incoming edges changed, only while it has not started. The result is validated first (unknown ids, cycles).
   */
  editGraph(name: "graph.addNode" | "graph.removeNode" | "graph.addEdge" | "graph.removeEdge", a: Record<string, unknown>): void {
    if (this.aborted || this.rc.store.runState === "aborted") throw new Error("the run was aborted");
    // A run that ended only because tasks are blocked is not over: the plan can still be repaired (replan). Reopen it.
    if (this.rc.store.runState === "done") {
      if (!this.tasks.some((t) => this.outcome.get(t.id) === "blocked")) throw new Error("the run is finished; start a new one");
      this.rc.store.runState = "running";
      this.rc.store.startHeartbeat();
    }
    const next = applyGraph(this.plan, name, a); // throws on unknown ids and cycles
    if (name === "graph.removeNode") { const why = this.whyNotEditable(String(a.id)); if (why) throw new Error(why); }
    if (name === "graph.addEdge" || name === "graph.removeEdge") { const why = this.whyNotEditable(String(a.to)); if (why) throw new Error(why); }
    if (name === "graph.addNode") roleConfig(this.rc.cfg, String(a.role)); // unknown role: error with the list
    if (name === "graph.removeNode") {
      const started = this.plan.tasks.find((t) => t.depends_on.includes(String(a.id)) && !this.editable(t.id));
      if (started) throw new Error(`${started.id} depends on ${String(a.id)} and has already started or finished`);
    }
    const before = new Set(this.plan.tasks.map((t) => t.id));
    // Edit in place: the plan, the run context and running agents all hold these task objects.
    const keep = this.plan.tasks;
    const nextById = new Map(next.tasks.map((t) => [t.id, t]));
    for (let i = keep.length - 1; i >= 0; i--) if (!nextById.has(keep[i]!.id)) keep.splice(i, 1);
    for (const t of keep) t.depends_on = nextById.get(t.id)!.depends_on;
    for (const t of next.tasks) if (!before.has(t.id)) keep.push(t);
    this.tasks = this.tasks === keep ? keep : [...this.tasks.filter((t) => nextById.has(t.id)), ...next.tasks.filter((t) => !before.has(t.id))];
    for (const t of keep) {
      if (!before.has(t.id)) { this.attempts.set(t.id, 1); this.createStatus(t, 1); }
    }
    if (name === "graph.removeNode") {
      const id = String(a.id);
      this.rc.store.apply(`${id}-a${this.attempts.get(id)}`, { type: "state", state: "cancelled", reason: "removed from the graph" });
      this.attempts.delete(id);
    }
    this.persistGraph();
    this.tick();
  }

  /** Dependents that were blocked by this task get another chance. */
  private reviveDependents(taskId: string): void {
    for (const d of this.tasks) {
      if (d.depends_on.includes(taskId) && this.outcome.get(d.id) === "blocked") {
        this.outcome.delete(d.id);
        if (this.last.has(d.id)) {
          // It really ran before: a new attempt, as /retry would do.
          const n = (this.attempts.get(d.id) ?? 1) + 1;
          this.attempts.set(d.id, n);
          this.createStatus(d, n);
        } else {
          // It never started (only its dependency failed): same attempt, waiting again. No empty attempts piling up.
          this.rc.store.apply(`${d.id}-a${this.attempts.get(d.id)}`, { type: "state", state: "queued", reason: `waiting for ${taskId}` });
        }
      }
    }
  }

  /** `hexagon return`: reopen task `to` (its own session) with a defect report from `from`. */
  returnTask(from: string, to: string, issue: string): { ok: true; done: Promise<{ state: AgentState; summary: string }> } | { ok: false; message: string } {
    const t = this.task(to);
    if (from === to) return { ok: false, message: "That's your own task: fix it yourself." };
    if (!t || !this.tasks.includes(t)) return { ok: false, message: `There is no task ${to} in this run.` };
    const key = `${from}>${to}`;
    const n = this.returns.get(key) ?? 0;
    if (n >= this.rc.cfg.run.fix_loops) return { ok: false, message: `You already returned ${to} ${n} time(s). Work around it within your scope, or finish with \`hexagon done --status blocked\` and the reason.` };
    const active = this.active.get(to);
    const last = this.last.get(to);
    const body = `↩ ${from} returned this task to you:\n${issue}\n\nThis is your area of responsibility (your write scope). Fix it, re-run your verify commands, then run \`hexagon done\` again. Hexagon verifies, reviews and merges it, and ${from} continues with your fix.`;
    if (active) {
      this.rc.router.send({ from: { kind: "agent", id: from }, to: { kind: "agent", id: to }, type: "instruction", body });
    } else if (last && last.resumable && ["done", "blocked", "failed", "cancelled"].includes(last.state)) {
      this.outcome.delete(to);
      if (this.rc.store.runState === "done") { this.rc.store.runState = "running"; this.rc.store.startHeartbeat(); }
      this.active.set(to, last);
      this.watch(t, last, last.continueWith(body, "hexagon"));
    } else {
      return { ok: false, message: `${to} hasn't run yet, so there is nothing to return. Share what it needs with \`hexagon note\`.` };
    }
    this.returns.set(key, n + 1);
    const done = new Promise<{ state: AgentState; summary: string }>((resolve) => {
      this.waiters.set(to, [...(this.waiters.get(to) ?? []), resolve]);
    });
    this.rc.router.send({ from: { kind: "orchestrator" }, to: { kind: "user" }, type: "notify", body: `${from} returned ${to}: ${issue}` });
    return { ok: true, done };
  }

  canContinue(taskId: string): boolean {
    const run = this.last.get(taskId);
    return !!run && !this.active.has(taskId) && !this.aborted && ["blocked", "failed", "cancelled"].includes(run.state) && run.resumable;
  }

  /** Send the user's message to a finished (blocked/failed/cancelled) agent: it resumes its own session. */
  continueTask(taskId: string, text: string): void {
    const t = this.task(taskId);
    const run = this.last.get(taskId);
    if (!t || !run || !this.canContinue(taskId)) throw new Error(`${taskId} can't be continued; /retry ${taskId} starts a new attempt`);
    this.outcome.delete(taskId);
    this.reviveDependents(taskId);
    if (this.rc.store.runState === "done") { this.rc.store.runState = "running"; this.rc.store.startHeartbeat(); }
    this.active.set(taskId, run);
    this.watch(t, run, run.continueWith(text));
    this.tick();
  }

  pauseAll(): void {
    this.paused = true;
    this.rc.store.runState = "paused";
    for (const r of this.active.values()) r.pause("run paused");
    this.rc.store.writeRun();
  }

  resumeAll(): void {
    this.paused = false;
    this.rc.store.runState = "running";
    this.rc.store.setAttention([]);
    for (const r of this.active.values()) r.resume();
    this.tick();
  }

  /**
   * The daemon is stopping (not a user abort): tasks waiting for a provider limit and tasks not yet started keep their
   * persisted state so the next daemon continues them; anything actually executing is cancelled.
   */
  shutdown(): void {
    this.aborted = true;
    for (const r of this.active.values()) {
      if (r.state === "waiting_quota") r.detach(); else r.cancel();
    }
  }

  abort(): void {
    this.aborted = true;
    for (const r of this.active.values()) r.cancel();
    for (const t of this.tasks) {
      if (!this.outcome.has(t.id) && !this.active.has(t.id)) {
        this.rc.store.apply(`${t.id}-a${this.attempts.get(t.id)}`, { type: "state", state: "cancelled", reason: "run aborted" });
        this.outcome.set(t.id, "cancelled");
      }
    }
    this.rc.store.runState = "aborted";
    this.rc.store.writeRun();
    this.checkDone();
  }

  private checkDone(): void {
    if (this.active.size === 0 && this.tasks.every((t) => this.outcome.has(t.id))) {
      if (this.rc.store.runState !== "aborted") this.rc.store.runState = "done";
      this.rc.store.writeRun();
      this.rc.store.stop();
      this.emit("done");
      this.done();
    }
  }
}

export { overlaps } from "./plan.js";
