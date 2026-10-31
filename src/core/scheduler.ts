import { EventEmitter } from "node:events";
import type { AgentState, Effort, Plan, Task } from "../contracts/types.js";
import { TERMINAL_STATES } from "../contracts/types.js";
import { globToRegExp } from "../util/fsx.js";
import { AgentRun, type RunContext } from "./supervisor.js";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const escalate = (e: Effort, steps: number): Effort => EFFORTS[Math.min(EFFORTS.indexOf(e) + steps, EFFORTS.length - 1)]!;

export interface SchedulerOptions {
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
  private tasks: Task[];
  paused = false;
  aborted = false;
  private done!: () => void;
  readonly finished: Promise<void>;

  constructor(private rc: RunContext, readonly plan: Plan, private opts: SchedulerOptions = {}) {
    super();
    this.tasks = opts.only?.length ? plan.tasks.filter((t) => opts.only!.includes(t.id)) : plan.tasks;
    this.finished = new Promise((r) => (this.done = r));
  }

  start(): void {
    for (const t of this.tasks) {
      this.attempts.set(t.id, 1);
      this.createStatus(t, 1);
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
    const role = this.rc.cfg.roles[t.role];
    const adapter = this.rc.adapterFor(t.role, this.overrides.get(t.id)?.agent ?? this.opts.agentOverride ?? t.agent_hint);
    this.rc.store.create({
      task: t, attempt, role: t.role,
      agent: { id: adapter.id, provider: adapter.provider, model: adapter.model, effort: this.effortFor(t, attempt, role.effort) },
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

  private leaseConflict(t: Task): string | null {
    for (const r of this.active.values()) {
      if (overlaps(t.files.write, r.task.files.write)) return r.task.id;
    }
    return null;
  }

  tick(): void {
    if (this.aborted) return;
    const budget = this.rc.cfg.run.budget_tokens;
    const t = this.rc.store.totals();
    if (budget !== null && t.input_tokens + t.cache_read_tokens + t.output_tokens >= budget && !this.paused) {
      this.paused = true;
      this.rc.store.runState = "paused";
      this.rc.store.setAttention([{ kind: "budget", task_id: null, text: `token budget of ${budget} reached — /resume to continue or raise [run].budget_tokens` }]);
      this.rc.router.send({ from: { kind: "orchestrator" }, to: { kind: "user" }, type: "notify", body: `Token budget ${budget} reached; scheduling paused.` });
    }
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
    const run = new AgentRun(this.rc, t, attempt, this.effortFor(t, attempt, this.rc.cfg.roles[t.role].effort), adapter);
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
    const s = this.rc.store.get(run.agentRunId);
    const retryable = state === "failed" && s?.last_error?.retryable !== false;
    const attempt = this.attempts.get(t.id)!;
    if (retryable && attempt < this.rc.cfg.run.max_attempts && !this.aborted) {
      this.attempts.set(t.id, attempt + 1);
      this.createStatus(t, attempt + 1);
      this.rc.router.send({ from: { kind: "orchestrator" }, to: { kind: "user" }, type: "notify", body: `${t.id}: retrying (attempt ${attempt + 1}) with more effort` });
    } else {
      this.outcome.set(t.id, state);
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

  /** Dependents that were blocked by this task get another chance. */
  private reviveDependents(taskId: string): void {
    for (const d of this.tasks) {
      if (d.depends_on.includes(taskId) && this.outcome.get(d.id) === "blocked") {
        this.outcome.delete(d.id);
        const n = (this.attempts.get(d.id) ?? 1) + 1;
        this.attempts.set(d.id, n);
        this.createStatus(d, n);
      }
    }
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

/** Two write-scopes overlap if a glob of one matches a glob (as a path) of the other. */
export function overlaps(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (globToRegExp(x).test(y) || globToRegExp(y).test(x)) return true;
      // Both are patterns: overlap when their literal prefixes nest (src/** vs src/auth/*.ts).
      const lx = x.replace(/[*?{].*$/, "");
      const ly = y.replace(/[*?{].*$/, "");
      if (lx !== x && ly !== y && (lx.startsWith(ly) || ly.startsWith(lx))) return true;
    }
  }
  return false;
}
