import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { ClaudeAdapter, askClaude } from "../agents/claude.js";
import { MockAdapter } from "../agents/mock.js";
import { loadRolePrompt, loadSkills, projectContext } from "../agents/prompts.js";
import type { AgentAdapter } from "../agents/types.js";
import type {
  AgentEvent, AgentStatus, Effort, Message, Plan, Role, RunStatus, StampedEvent,
} from "../contracts/types.js";
import { TERMINAL_STATES } from "../contracts/types.js";
import { atomicWriteJson, nowIso, readJson, readJsonl } from "../util/fsx.js";
import { loadConfig, type HexagonConfig } from "../core/config.js";
import * as g from "../core/git.js";
import { checkPlan, type PlanCheck } from "../core/plan.js";
import { ProjectPaths, type RunPaths } from "../core/project.js";
import { MessageRouter } from "../core/router.js";
import { Scheduler } from "../core/scheduler.js";
import { findSpecs, parseSpec, type Spec } from "../core/spec.js";
import { StatusStore } from "../core/status.js";
import { runPlanner, type RunContext } from "../core/supervisor.js";

export interface ActiveRun {
  runId: string;
  run: RunPaths;
  plan: Plan;
  store: StatusStore;
  router: MessageRouter;
  scheduler: Scheduler;
  rc: RunContext;
  base: string;
}

export type Push =
  | { event: "status"; data: AgentStatus }
  | { event: "agent_event"; data: StampedEvent }
  | { event: "message"; data: Message }
  | { event: "run"; data: RunStatus }
  | { event: "notice"; data: { level: "info" | "attention" | "error"; text: string } }
  | { event: "planner"; data: AgentEvent };

/** Owns the project state inside the daemon. All mutations go through here. */
export class Orchestrator extends EventEmitter {
  readonly paths: ProjectPaths;
  cfg: HexagonConfig;
  current: ActiveRun | null = null;
  private adapters = new Map<string, AgentAdapter>();
  private planning = false;

  constructor(readonly root: string) {
    super();
    this.paths = new ProjectPaths(root);
    this.cfg = loadConfig(this.paths.config);
  }

  private push(p: Push) {
    this.emit("push", p);
  }

  notice(level: "info" | "attention" | "error", text: string) {
    this.push({ event: "notice", data: { level, text } });
  }

  // ───────────── adapters ─────────────

  adapter(agentId: string): AgentAdapter {
    let a = this.adapters.get(agentId);
    if (a) return a;
    const conf = this.cfg.agents[agentId];
    if (!conf) throw new Error(`unknown agent "${agentId}" (configured: ${Object.keys(this.cfg.agents).join(", ")})`);
    a = conf.adapter === "mock" ? new MockAdapter(agentId, conf.step_ms ?? 600) : new ClaudeAdapter(agentId, conf.model ?? "claude-sonnet-5-5");
    this.adapters.set(agentId, a);
    return a;
  }

  adapterFor(role: Role, override?: string | null): AgentAdapter {
    const id = override && this.cfg.agents[override] ? override : this.cfg.roles[role].agent;
    return this.adapter(id);
  }

  // ───────────── specs & planning ─────────────

  loadSpecs(files: string[]): Spec[] {
    const specs = findSpecs(this.root, files);
    if (!specs.length) throw new Error("no spec files found (put *.md files in specs/ or pass paths)");
    return specs.map((f) => parseSpec(f));
  }

  async plan(files: string[], agent?: string | null): Promise<{ path: string; plan: Plan; check: PlanCheck }> {
    if (this.planning) throw new Error("a plan is already being generated");
    this.planning = true;
    try {
      this.cfg = loadConfig(this.paths.config);
      const specs = this.loadSpecs(files);
      const adapter = this.adapterFor("planner", agent);
      this.notice("info", `Planning ${specs.length} spec(s) with ${adapter.id}…`);
      const out = await runPlanner({
        root: this.root, paths: this.paths, cfg: this.cfg, specs, skills: loadSkills(this.paths),
        context: projectContext(this.root), adapter, onEvent: (e) => this.push({ event: "planner", data: e }),
      });
      const id = `p-${stamp()}`;
      const plan: Plan = {
        schema: "hexagon.plan/v1", id, created_at: nowIso(),
        specs: specs.map((s) => path.relative(this.root, s.file)), tasks: out.tasks, spec_issues: out.spec_issues,
      };
      const check = checkPlan(plan, specs);
      const file = path.join(this.paths.plans, `${id}.json`);
      atomicWriteJson(file, plan);
      return { path: file, plan, check };
    } finally {
      this.planning = false;
    }
  }

  // ───────────── runs ─────────────

  async startRun(opts: { plan_path: string; only?: string[]; agent?: string | null; max_parallel?: number; budget_usd?: number | null }): Promise<string> {
    if (this.current && this.current.store.runState !== "done" && this.current.store.runState !== "aborted") {
      throw new Error(`run ${this.current.runId} is still active; /abort it first`);
    }
    this.cfg = loadConfig(this.paths.config);
    if (opts.budget_usd !== undefined) this.cfg.run.budget_usd = opts.budget_usd && opts.budget_usd > 0 ? opts.budget_usd : null;
    const planFile = path.resolve(this.root, opts.plan_path);
    const plan = readJson<Plan>(planFile);
    if (!plan) throw new Error(`cannot read plan ${opts.plan_path}`);
    let specs: Spec[] = [];
    try { specs = plan.specs.length ? plan.specs.map((s) => parseSpec(path.resolve(this.root, s))) : []; } catch { specs = []; }
    const check = checkPlan(plan, specs);
    if (check.errors.length) throw new Error(`invalid plan: ${check.errors.join("; ")}`);
    if (opts.agent) this.adapter(opts.agent); // validate early

    if (!(await g.isRepo(this.root)) || !(await g.hasCommits(this.root))) {
      throw new Error("Hexagon needs a git repository with at least one commit (agents work in git worktrees).");
    }
    const base = this.cfg.run.base_branch ?? (await g.currentBranch(this.root));
    const runId = `r-${stamp()}`;
    const run = this.paths.run(runId);
    fs.mkdirSync(run.dir, { recursive: true });
    atomicWriteJson(run.plan, plan);

    const integration = { branch: `hexagon/${runId}/integration`, worktree: path.join(this.paths.worktrees, runId, "integration") };
    await g.addWorktree(this.root, integration.worktree, integration.branch, base);

    const store = new StatusStore(run, runId, {
      plan_path: path.relative(this.root, planFile), integration_branch: integration.branch, base_branch: base, budget_usd: this.cfg.run.budget_usd,
    });
    let scheduler!: Scheduler;
    const router = new MessageRouter(run, runId, this.cfg.messaging, { activeTasks: (role) => scheduler.activeTaskIds(role) });
    const rc: RunContext = {
      root: this.root, paths: this.paths, run, runId, cfg: this.cfg, store, router, specs,
      skills: loadSkills(this.paths), context: projectContext(this.root), integration,
      adapterFor: (role, override) => this.adapterFor(role, override),
    };
    scheduler = new Scheduler(rc, plan, { only: opts.only, agentOverride: opts.agent ?? null, maxParallel: opts.max_parallel });

    store.on("status", (s: AgentStatus) => this.push({ event: "status", data: s }));
    store.on("event", (e: StampedEvent) => this.push({ event: "agent_event", data: e }));
    const counted = new Set<string>();
    router.on("message", (m: Message) => {
      if (m.to.kind === "agent" && m.to.id && m.delivery.state === "queued" && !counted.has(m.id)) {
        counted.add(m.id);
        const s = store.byTask(m.to.id);
        if (s && !TERMINAL_STATES.has(s.state)) store.patch(s.agent_run_id, (x) => { x.inbox.pending += 1; });
      }
      this.push({ event: "message", data: m });
    });
    let lastRunPush = 0;
    store.on("status", () => {
      const now = Date.now();
      if (now - lastRunPush > 250) { lastRunPush = now; this.push({ event: "run", data: store.runStatus() }); }
    });
    scheduler.on("done", () => {
      const rs = store.runStatus();
      this.push({ event: "run", data: rs });
      const failed = rs.agents.filter((a) => a.state !== "done").length;
      this.notice(failed ? "attention" : "info", `Run ${runId} finished: ${rs.counts.done ?? 0} done, ${failed} not done. Integration branch: ${integration.branch}. /merge to merge into ${base}.`);
    });

    this.current = { runId, run, plan, store, router, scheduler, rc, base };
    scheduler.start();
    this.notice("info", `Run ${runId} started: ${scheduler.plan.tasks.length} task(s), up to ${scheduler.maxParallel} in parallel.`);
    return runId;
  }

  requireRun(): ActiveRun {
    if (!this.current) throw new Error("no active run — /plan and /run first");
    return this.current;
  }

  agentRun(taskId: string) {
    const r = this.requireRun();
    const run = r.scheduler.run(taskId.toUpperCase());
    if (!run) throw new Error(`${taskId} is not running right now`);
    return run;
  }

  status(): RunStatus | null {
    if (this.current) return this.current.store.runStatus();
    const last = this.latestRunDir();
    return last ? readJson<RunStatus>(this.paths.run(last).status) ?? null : null;
  }

  agentStatus(taskId: string): AgentStatus {
    const s = this.requireRun().store.byTask(taskId.toUpperCase());
    if (!s) throw new Error(`unknown task ${taskId}`);
    return s;
  }

  agentEvents(taskId: string, limit = 200): StampedEvent[] {
    const r = this.requireRun();
    const s = this.agentStatus(taskId);
    const all: StampedEvent[] = [];
    for (let a = 1; a <= s.attempt; a++) all.push(...readJsonl<StampedEvent>(r.run.agentEvents(`${s.task_id}-a${a}`)));
    return all.slice(-limit);
  }

  private latestRunDir(): string | null {
    if (!fs.existsSync(this.paths.runs)) return null;
    const dirs = fs.readdirSync(this.paths.runs).filter((d) => d.startsWith("r-")).sort();
    return dirs.at(-1) ?? null;
  }

  // ───────────── messaging ─────────────

  /** `to`: "T-7" | "@implementers" | "@all" | "@lead" | "blackboard". */
  async send(to: string, body: string): Promise<{ messages: Message[]; answer?: string }> {
    const target = to.trim();
    if (/^@?lead$/i.test(target)) return { messages: [], answer: await this.askLead(body) };
    const r = this.requireRun();
    let party: Message["to"];
    if (/^@?(all|everyone)$/i.test(target)) party = { kind: "broadcast" };
    else if (/^@?blackboard$/i.test(target)) party = { kind: "blackboard" };
    else if (target.startsWith("@")) party = { kind: "role", id: target.slice(1).toLowerCase().replace(/s$/, "") };
    else {
      const id = target.toUpperCase();
      const s = r.store.byTask(id);
      if (!s) throw new Error(`unknown task ${target}`);
      if (TERMINAL_STATES.has(s.state)) throw new Error(`${id} is ${s.state}; use /retry ${id} to start a new attempt with your instructions`);
      party = { kind: "agent", id };
    }
    const type = party.kind === "blackboard" ? "note" : "instruction";
    const messages = r.router.send({ from: { kind: "user" }, to: party, type, body });
    return { messages };
  }

  answer(questionId: string, answer: string): string {
    const r = this.requireRun();
    const qid = questionId.toUpperCase();
    for (const run of r.scheduler.activeRuns()) {
      if (run.answer(qid, answer)) return run.task.id;
    }
    throw new Error(`no open question ${questionId}`);
  }

  inbox(): { questions: (AgentStatus["needs_input"] & { task_id: string })[]; attention: RunStatus["attention"]; notices: Message[] } {
    const r = this.requireRun();
    const questions = r.store.all()
      .filter((s) => s.needs_input && !TERMINAL_STATES.has(s.state))
      .map((s) => ({ ...s.needs_input!, task_id: s.task_id }));
    const notices = r.router.all().filter((m) => m.to.kind === "user" && m.type === "notify").slice(-20);
    return { questions, attention: r.store.runStatus().attention.filter((a) => a.kind !== "question"), notices };
  }

  async askLead(question: string): Promise<string> {
    const lead = this.cfg.roles.lead;
    const adapter = this.adapter(lead.agent);
    const state = this.status();
    if (adapter.provider === "mock") {
      if (!state) return "No run yet. Try /plan specs/<file>.md then /run.";
      const c = state.counts;
      return `Run ${state.run_id}: ${c.done ?? 0} done, ${(c.running ?? 0) + (c.verifying ?? 0) + (c.reviewing ?? 0)} active, ${c.waiting_input ?? 0} waiting for you, ${(c.failed ?? 0) + (c.blocked ?? 0)} failed/blocked. Spent $${state.totals.cost_usd.toFixed(2)}. (mock lead — configure [roles.lead] agent = "claude" for real answers)`;
    }
    const recent = this.current
      ? readJsonl<StampedEvent>(this.current.run.events).slice(-60).map((e) => `${e.ts.slice(11, 19)} ${e.task_id} ${JSON.stringify(e.event)}`).join("\n")
      : "";
    const system = `${loadRolePrompt(this.paths, "lead")}\n\n<run_status>\n${JSON.stringify(state, null, 2)}\n</run_status>\n\n<recent_events>\n${recent}\n</recent_events>\n\n<blackboard>\n${this.current?.router.notes() ?? ""}\n</blackboard>`;
    const model = this.cfg.agents[lead.agent]?.model ?? "claude-sonnet-5-5";
    const { text } = await askClaude(model, lead.effort as Effort, system, question);
    return text;
  }

  // ───────────── controls ─────────────

  async takeover(taskId: string) {
    const run = this.agentRun(taskId);
    const t = await run.takeover();
    return { ...t, task_id: run.task.id, root: this.root };
  }

  async takeoverEnd(taskId: string, action: "handback" | "done" | "discard") {
    await this.agentRun(taskId).endTakeover(action);
  }

  async diff(taskId: string, stat = false): Promise<string> {
    const r = this.requireRun();
    const s = this.agentStatus(taskId);
    const wt = s.workspace?.worktree ? path.join(this.root, s.workspace.worktree) : null;
    if (!wt || !fs.existsSync(wt)) throw new Error(`${taskId} has no worktree yet`);
    const out = await g.git(wt, ["diff", ...(stat ? ["--stat"] : []), r.rc.integration.branch]);
    return out.stdout || "(no changes)";
  }

  async mergeToBase(): Promise<string> {
    const r = this.requireRun();
    const active = r.scheduler.activeRuns().length;
    if (active) throw new Error(`${active} agent(s) still active; wait for the run to finish or /abort`);
    const cur = await g.currentBranch(this.root);
    if (cur !== r.base) throw new Error(`check out ${r.base} first (currently on ${cur})`);
    if (!(await g.isClean(this.root))) throw new Error(`working tree of ${r.base} has uncommitted changes; commit or stash them first`);
    const m = await g.merge(this.root, r.rc.integration.branch, `Merge Hexagon run ${r.runId}`);
    if (!m.ok) throw new Error(m.conflict ? "merge conflict — resolve manually: git merge " + r.rc.integration.branch : m.output);
    return `Merged ${r.rc.integration.branch} into ${r.base}.`;
  }

  async cleanup(): Promise<string[]> {
    const removed: string[] = [];
    const r = this.current;
    if (r && r.store.runState !== "done" && r.store.runState !== "aborted") throw new Error("run still active");
    const dir = path.join(this.paths.worktrees);
    if (!fs.existsSync(dir)) return removed;
    for (const runDir of fs.readdirSync(dir)) {
      for (const wt of fs.readdirSync(path.join(dir, runDir))) {
        await g.removeWorktree(this.root, path.join(dir, runDir, wt));
        removed.push(`${runDir}/${wt}`);
      }
      fs.rmSync(path.join(dir, runDir), { recursive: true, force: true });
    }
    return removed;
  }

  shutdown(): void {
    this.current?.scheduler.abort();
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
