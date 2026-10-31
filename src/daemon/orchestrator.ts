import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { ClaudeCodeAdapter } from "../agents/claude-code.js";
import { ExecAdapter } from "../agents/exec.js";
import { MockAdapter } from "../agents/mock.js";
import { contextFile, loadSkills, projectContext, systemPrompt } from "../agents/prompts.js";
import type { AgentAdapter, Reply } from "../agents/types.js";
import type { AgentStatus, Message, Plan, Role, RunStatus, StampedEvent } from "../contracts/types.js";
import { TERMINAL_STATES } from "../contracts/types.js";
import { atomicWriteJson, nowIso, readJson, readJsonl } from "../util/fsx.js";
import { selfCommand } from "../util/resources.js";
import { allowCommands, loadConfig, setRoleModel, type HexagonConfig } from "../core/config.js";
import { applyToolchainEnv, install as installToolchain, installed as installedToolchains, onPath, toolchainFor, TOOLCHAINS } from "../core/toolchains.js";
import * as g from "../core/git.js";
import { checkPlan, normalizePlan, type PlanCheck } from "../core/plan.js";
import { ProjectPaths, type RunPaths } from "../core/project.js";
import { ApiRegistry, type ApiOp } from "../core/registry.js";
import { MessageRouter } from "../core/router.js";
import { Scheduler } from "../core/scheduler.js";
import { lintSpec, listProjectFiles, parseSpec, type Spec } from "../core/spec.js";
import { SoloSession, type SessionStatus } from "../core/solo.js";
import { StatusStore } from "../core/status.js";
import type { RunContext } from "../core/supervisor.js";

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

/** A plan proposed by the planner, waiting for the user to approve, revise or discard it. */
export interface Draft {
  id: string;
  goal: string;
  out_dir: string;
  spec_path: string;
  plan_path: string;
  plan: Plan;
  check: PlanCheck;
  summary: string;
}

export type Push =
  | { event: "status"; data: AgentStatus }
  | { event: "agent_event"; data: StampedEvent }
  | { event: "message"; data: Message }
  | { event: "run"; data: RunStatus | null }
  | { event: "notice"; data: { level: "info" | "attention" | "error"; text: string } }
  | { event: "session"; data: SessionStatus }
  | { event: "draft"; data: Draft | null }
  | { event: "permissions"; data: PermissionRequest[] };

export interface Snapshot {
  root: string;
  run: RunStatus | null;
  plan: Plan | null;
  agents: AgentStatus[];
  sessions: SessionStatus[];
  draft: Draft | null;
  has_context: boolean;
  permissions: PermissionRequest[];
}

/** An agent was refused a command; the user decides. */
export interface PermissionRequest {
  id: string;
  /** Task id (T-2) or session id (claude, planner, init). */
  agent: string;
  kind: "task" | "session";
  command: string;
  /** Rule to allow (e.g. "brew", "git push"); null for compound commands, which only "allow all" covers. */
  prefix: string | null;
  asked_at: string;
}

const SUBCOMMAND_TOOLS = new Set(["git", "npm", "pnpm", "yarn", "go", "cargo", "docker", "kubectl", "gh"]);

/** The allow rule for a command: "brew", "git push", or null when Claude Code can't match it by prefix. */
export function commandPrefix(command: string): string | null {
  const c = command.trim();
  if (!c || /[;&|`$<>()\n]/.test(c) || /^\w+=/.test(c)) return null;
  const w = c.split(/\s+/);
  return SUBCOMMAND_TOOLS.has(w[0]!) && w[1] && !w[1].startsWith("-") ? `${w[0]} ${w[1]}` : w[0]!;
}

const PLANNER_COMMANDS = ["ls", "cat", "find", "grep", "rg", "head", "wc", "git log", "git status", "git ls-files", "mkdir"];

/** Owns the project state inside the daemon. All mutations go through here. */
export class Orchestrator extends EventEmitter {
  readonly paths: ProjectPaths;
  readonly registry = new ApiRegistry();
  cfg: HexagonConfig;
  current: ActiveRun | null = null;
  draft: Draft | null = null;
  private adapters = new Map<string, AgentAdapter>();
  private sessions = new Map<string, SoloSession>();
  private nextSoloQuestion = 1;
  private permissions = new Map<string, PermissionRequest>();
  private nextPermission = 1;

  constructor(readonly root: string) {
    super();
    this.paths = new ProjectPaths(root);
    this.cfg = loadConfig(this.paths.config);
    applyToolchainEnv();
    const d = readJson<Draft>(path.join(this.paths.hex, "drafts", "current.json"));
    if (d && fs.existsSync(d.plan_path)) this.draft = d;
    void this.autoClose();
  }

  // ───────────── closing finished runs ─────────────

  private closedMarker(runId: string) {
    return path.join(this.paths.run(runId).dir, "closed");
  }

  /** A finished run that was merged or cleaned up: no longer shown on the dashboard. */
  private isClosed(runId: string): boolean {
    return fs.existsSync(this.closedMarker(runId)) || !fs.existsSync(path.join(this.paths.worktrees, runId));
  }

  /** Hide the finished run from the dashboard (its records stay in .hexagon/runs/). */
  closeRun(reason: string): boolean {
    const r = this.current;
    if (r && r.store.runState !== "done" && r.store.runState !== "aborted") throw new Error(`run ${r.runId} is still active; /abort it first`);
    const id = r?.runId ?? this.latestRunDir();
    if (!id) return false;
    fs.writeFileSync(this.closedMarker(id), `${nowIso()} ${reason}\n`);
    this.current = null;
    this.push({ event: "run", data: null });
    return true;
  }

  /** On start: a last run whose integration branch is already in its base branch was merged by hand. */
  private async autoClose(): Promise<void> {
    const id = this.latestRunDir();
    if (!id) return;
    const rs = readJson<RunStatus>(this.paths.run(id).status);
    if (!rs || (rs.state !== "done" && rs.state !== "aborted")) return;
    const merged = (await g.git(this.root, ["merge-base", "--is-ancestor", rs.integration_branch, rs.base_branch])).ok;
    if (merged && !this.current) this.closeRun("integration branch already merged");
  }

  private push(p: Push) {
    this.emit("push", p);
  }

  notice(level: "info" | "attention" | "error", text: string) {
    this.push({ event: "notice", data: { level, text } });
  }

  // ───────────── adapters & agent environment ─────────────

  adapter(agentId: string, model?: string | null): AgentAdapter {
    const key = `${agentId}@${model ?? ""}`;
    let a = this.adapters.get(key);
    if (a) return a;
    const conf = this.cfg.agents[agentId];
    if (!conf) throw new Error(`unknown agent "${agentId}" (configured: ${Object.keys(this.cfg.agents).join(", ")})`);
    switch (conf.adapter) {
      case "mock": a = new MockAdapter(agentId, conf.step_ms ?? 600); break;
      case "exec":
        if (!conf.command?.length) throw new Error(`[agents.${agentId}] needs command = ["…"]`);
        a = new ExecAdapter(agentId, conf.command, conf.interactive ?? null);
        break;
      default:
        a = new ClaudeCodeAdapter(agentId, { command: conf.command?.length ? conf.command : ["claude"], model: model || conf.model || null, args: conf.args ?? [] });
    }
    this.adapters.set(key, a);
    return a;
  }

  adapterFor(role: Role, override?: string | null): AgentAdapter {
    if (override && this.cfg.agents[override]) return this.adapter(override);
    return this.adapter(this.cfg.roles[role].agent, this.cfg.roles[role].model);
  }

  /** Role → agent/model/effort, for /model. */
  models(): { role: Role; agent: string; model: string; effort: string }[] {
    return (Object.keys(this.cfg.roles) as Role[]).map((role) => {
      const r = this.cfg.roles[role];
      return { role, agent: r.agent, model: r.model ?? this.cfg.agents[r.agent]?.model ?? "default", effort: r.effort };
    });
  }

  setModel(role: string, model: string | null): void {
    const roles = Object.keys(this.cfg.roles);
    if (!roles.includes(role)) throw new Error(`unknown role "${role}" (roles: ${roles.join(", ")})`);
    setRoleModel(this.paths.config, role as Role, model);
    this.reloadConfig();
    this.notice("info", `${role} now uses ${model ?? "its agent's default model"} (new sessions; running agents keep theirs).`);
  }

  private reloadConfig() {
    this.cfg = loadConfig(this.paths.config);
    this.adapters.clear();
  }

  /** A `hexagon` launcher for agent processes (they run `hexagon report …`). */
  private shim(): string {
    const dir = path.join(this.paths.hex, "bin");
    const file = path.join(dir, "hexagon");
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const body = `#!/bin/sh\nexec ${selfCommand().map(q).join(" ")} "$@"\n`;
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body, { mode: 0o755 });
    }
    return file;
  }

  agentEnv(agentId: string, extra: Record<string, string> = {}): Record<string, string> {
    const bin = this.shim();
    return {
      HEXAGON_ROOT: this.root,
      HEXAGON_AGENT: agentId,
      HEXAGON_BIN: bin,
      PATH: `${path.dirname(bin)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      ...extra,
    };
  }

  /** `hexagon report|ask|note|done|review|plan-check` from an agent process. */
  agentApi(agent: string | null, cwd: string | null, op: ApiOp, args: Record<string, unknown>): Reply {
    let id = agent;
    if (!id && cwd) {
      const m = /\/\.hexagon\/worktrees\/[^/]+\/([^/]+)(?:\/|$)/.exec(cwd);
      if (m) id = m[1]!;
    }
    if (!id) id = [...this.sessions.values()].find((s) => s.status.state === "running" || s.status.state === "waiting_input")?.id ?? null;
    if (!id) return { ok: false, message: "Hexagon could not tell which agent you are (HEXAGON_AGENT is not set)." };
    return this.registry.call(id, op, args);
  }

  // ───────────── snapshot for UIs ─────────────

  snapshot(): Snapshot {
    return {
      root: this.root,
      run: this.status(),
      plan: this.current?.plan ?? this.lastPlan(),
      agents: this.current?.store.all() ?? [],
      sessions: [...this.sessions.values()].map((s) => s.status),
      draft: this.draft,
      has_context: contextFile(this.root) !== null,
      permissions: [...this.permissions.values()],
    };
  }

  private lastPlan(): Plan | null {
    const last = this.latestRunDir();
    return last ? readJson<Plan>(this.paths.run(last).plan) ?? null : null;
  }

  // ───────────── solo sessions: init & planner ─────────────

  private solo(id: "init" | "planner" | "claude", role: Role, opts: { system: string; env: Record<string, string>; allowCommands: string[]; validate?: () => Reply; conversational?: boolean; readOnly?: boolean }): SoloSession {
    const prev = this.sessions.get(id);
    if (prev?.alive) throw new Error(`the ${id} agent is already running`);
    const adapter = this.adapterFor(role);
    const s = new SoloSession(id, role, adapter, {
      cwd: this.root, effort: this.cfg.roles[role].effort, ...opts, nextQuestionId: () => `Q-S${this.nextSoloQuestion++}`,
    });
    s.on("status", (st: SessionStatus) => this.push({ event: "session", data: st }));
    s.on("permission", (command: string, tool: string) => this.requestPermission(id, "session", command, tool));
    s.on("missing", (command: string) => this.toolMissing(command));
    this.sessions.set(id, s);
    this.registry.register(id, s.api());
    return s;
  }

  session(id: string): SoloSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no ${id} session`);
    return s;
  }

  /** Run the init agent: it studies the repository (or asks what you're building) and writes HEXAGON.md. */
  startInit(description: string | null): { id: string; skipped?: boolean } {
    this.reloadConfig();
    // Nothing to study in an empty repository, and nothing to ask: write a stub the first code fills in.
    if (!description?.trim() && isEmptyProject(this.root)) {
      if (!contextFile(this.root)) fs.writeFileSync(path.join(this.root, "HEXAGON.md"), stubContext(this.root));
      this.notice("info", "Empty repository: wrote a stub HEXAGON.md. Tell Claude what to build in the chat (or /sdd <goal>); the stack gets filled in as code lands.");
      return { id: "init", skipped: true };
    }
    const s = this.solo("init", "init", {
      system: systemPrompt(this.paths, "init", "init", loadSkills(this.paths), [], projectContext(this.root)),
      env: this.agentEnv("init"),
      allowCommands: [...new Set([...PLANNER_COMMANDS, ...this.cfg.sandbox.allow_commands])],
      validate: () => (contextFile(this.root) ? { ok: true, message: "ok" } : { ok: false, message: "HEXAGON.md does not exist yet. Write it in the repository root, then run `hexagon done` again." }),
    });
    const existing = contextFile(this.root);
    const prompt = [
      description ? `<project_description>\n${description}\n</project_description>\n` : "",
      existing ? `HEXAGON.md already exists — update it rather than starting over.` : "",
      "Study this repository and write HEXAGON.md in its root, as described in your instructions. Finish with `hexagon done`.",
    ].filter(Boolean).join("\n");
    void s.run(prompt).then(() => {
      if (!s.done) return this.notice("error", `init agent failed: ${s.status.error ?? "unknown error"}`);
      const added = allowCommands(this.paths.config, s.allow);
      this.reloadConfig();
      this.notice("info", `HEXAGON.md ready${added.length ? `; agents may now also run: ${added.join(", ")}` : ""}. ${s.status.summary ?? ""}`);
    });
    return { id: s.id };
  }

  /** Goal → planner agent → spec.md + plan.json draft for approval. */
  newGoal(goal: string): { id: string } {
    if (!goal.trim()) throw new Error("describe what you want built");
    this.reloadConfig();
    const id = `p-${stamp()}`;
    const out = path.join(this.paths.hex, "drafts", id);
    fs.mkdirSync(out, { recursive: true });
    const s = this.solo("planner", "planner", {
      system: systemPrompt(this.paths, "planner", "planner", loadSkills(this.paths), [], projectContext(this.root)),
      env: this.agentEnv("planner", { HEXAGON_OUT: out }),
      allowCommands: [...new Set([...PLANNER_COMMANDS, ...this.cfg.sandbox.allow_commands])],
      validate: () => draftCheck(this.root, out).reply,
    });
    const existingSpecs = fs.existsSync(path.join(this.root, "specs")) ? fs.readdirSync(path.join(this.root, "specs")).filter((f) => f.endsWith(".md")) : [];
    const prompt = [
      `<goal>\n${goal.trim()}\n</goal>`,
      "",
      `Output directory: ${out}`,
      existingSpecs.length ? `Existing specs (for context; don't modify them): ${existingSpecs.map((f) => `specs/${f}`).join(", ")}` : "",
      "",
      "Write spec.md and plan.json into the output directory as described in your instructions, run `hexagon plan-check`, then `hexagon done`.",
    ].filter((l) => l !== "").join("\n");
    this.draft = null;
    this.saveDraft();
    this.push({ event: "draft", data: null });
    void this.runPlanner(s, id, goal.trim(), out, prompt);
    return { id };
  }

  /** Feedback on the current draft (or an answer to the planner's question). */
  revise(feedback: string): void {
    const s = this.sessions.get("planner");
    if (s && (s.status.state === "running" || s.status.state === "waiting_input")) return s.say(feedback);
    const d = this.draft;
    if (!d || !s) throw new Error("no plan to revise — describe a goal first");
    const followUp = `The user reviewed your draft and wants changes:\n<user_message>\n${feedback}\n</user_message>\n\nUpdate spec.md and plan.json in ${d.out_dir}, run \`hexagon plan-check\`, then \`hexagon done\`.`;
    this.registry.register("planner", s.api());
    void this.runPlanner(s, d.id, d.goal, d.out_dir, "", followUp);
  }

  private async runPlanner(s: SoloSession, id: string, goal: string, out: string, prompt: string, followUp?: string) {
    await s.run(prompt, followUp);
    if (!s.done) {
      if (s.status.state !== "cancelled") this.notice("error", `planner failed: ${s.status.error ?? "unknown error"}`);
      return;
    }
    if (s.status.result_status && s.status.result_status !== "completed") {
      this.notice("attention", `The planner stopped without a plan: ${s.status.summary ?? s.status.result_status}`);
      return;
    }
    try {
      this.draft = this.materialize(id, goal, out, s.status.summary ?? "");
      this.saveDraft();
      this.push({ event: "draft", data: this.draft });
    } catch (e) {
      this.notice("error", `planner output is invalid: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private materialize(id: string, goal: string, out: string, summary: string): Draft {
    const check = draftCheck(this.root, out);
    if (!check.plan || !check.spec) throw new Error(check.reply.message);
    const slug = (check.spec.meta.spec || slugify(check.spec.title ?? goal)).replace(/[^a-z0-9-]/gi, "-").toLowerCase() || id;
    const prev = this.draft?.id === id ? this.draft.spec_path : null;
    let specPath = prev ?? path.join(this.root, "specs", `${slug}.spec.md`);
    if (!prev && fs.existsSync(specPath)) specPath = path.join(this.root, "specs", `${slug}-${id.slice(2)}.spec.md`);
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.copyFileSync(path.join(out, "spec.md"), specPath);
    const plan = normalizePlan(readJson(path.join(out, "plan.json")), { id, specs: [path.relative(this.root, specPath)] });
    const planPath = path.join(this.paths.plans, `${id}.json`);
    atomicWriteJson(planPath, plan);
    return { id, goal, out_dir: out, spec_path: specPath, plan_path: planPath, plan, check: checkPlan(plan, [parseSpec(specPath)]), summary };
  }

  private saveDraft() {
    const f = path.join(this.paths.hex, "drafts", "current.json");
    if (this.draft) atomicWriteJson(f, this.draft);
    else fs.rmSync(f, { force: true });
  }

  /** Re-read the draft after the user edited spec/plan by hand. */
  reloadDraft(): Draft {
    const d = this.draft;
    if (!d) throw new Error("no draft");
    const plan = normalizePlan(readJson(d.plan_path), { id: d.id, specs: [path.relative(this.root, d.spec_path)] });
    this.draft = { ...d, plan, check: checkPlan(plan, [parseSpec(d.spec_path)]) };
    this.saveDraft();
    this.push({ event: "draft", data: this.draft });
    return this.draft;
  }

  async approve(opts: { max_parallel?: number; agent?: string | null } = {}): Promise<string> {
    const d = this.draft;
    if (!d) throw new Error("no plan waiting for approval");
    if (d.check.errors.length) throw new Error(`plan has errors: ${d.check.errors.join("; ")}`);
    this.draft = null;
    try {
      const runId = await this.startRun({ plan_path: d.plan_path, ...opts });
      this.saveDraft();
      this.push({ event: "draft", data: null });
      return runId;
    } catch (e) {
      this.draft = d;
      throw e;
    }
  }

  discardDraft(): void {
    const d = this.draft;
    this.sessions.get("planner")?.cancel();
    if (d) {
      fs.rmSync(d.plan_path, { force: true });
      fs.rmSync(d.spec_path, { force: true });
    }
    this.draft = null;
    this.saveDraft();
    this.push({ event: "draft", data: null });
  }

  // ───────────── runs ─────────────

  async startRun(opts: { plan_path: string; only?: string[]; agent?: string | null; max_parallel?: number; budget_tokens?: number | null }): Promise<string> {
    if (this.current && this.current.store.runState !== "done" && this.current.store.runState !== "aborted") {
      throw new Error(`run ${this.current.runId} is still active; /abort it first`);
    }
    this.reloadConfig();
    if (opts.budget_tokens !== undefined) this.cfg.run.budget_tokens = opts.budget_tokens && opts.budget_tokens > 0 ? opts.budget_tokens : null;
    const planFile = path.resolve(this.root, opts.plan_path);
    const raw = readJson<Plan>(planFile);
    if (!raw) throw new Error(`cannot read plan ${opts.plan_path}`);
    const plan = normalizePlan(raw, { id: raw.id ?? path.basename(planFile, ".json"), specs: raw.specs ?? [] });
    let specs: Spec[] = [];
    try { specs = plan.specs.map((s) => parseSpec(path.resolve(this.root, s))); } catch { specs = []; }
    const check = checkPlan(plan, specs);
    if (check.errors.length) throw new Error(`invalid plan: ${check.errors.join("; ")}`);
    if (opts.agent) this.adapter(opts.agent);

    const missing = this.missingForPlan(plan);
    if (missing.length) this.notice("attention", `Verify commands need ${missing.join(", ")}, which ${missing.length > 1 ? "aren't" : "isn't"} installed. Agents will report blocked until then: ${missing.map((m) => `/install ${m}`).join(" · ")}`);
    // Agents work in git worktrees: a new project gets a repository and an initial commit.
    const setup = await g.ensureRepo(this.root);
    if (setup) this.notice("info", `This folder wasn't ready for agents yet: Hexagon ${setup}.`);
    const base = this.cfg.run.base_branch ?? (await g.currentBranch(this.root));
    const runId = `r-${stamp()}`;
    const run = this.paths.run(runId);
    fs.mkdirSync(run.dir, { recursive: true });
    atomicWriteJson(run.plan, plan);

    const integration = { branch: `hexagon/${runId}/integration`, worktree: path.join(this.paths.worktrees, runId, "integration") };
    // Specs written by the planner may be uncommitted: agents still read them from the task card.
    await g.addWorktree(this.root, integration.worktree, integration.branch, base);

    const store = new StatusStore(run, runId, {
      plan_path: path.relative(this.root, planFile), integration_branch: integration.branch, base_branch: base, budget_tokens: this.cfg.run.budget_tokens, started_at: nowIso(),
    });
    let scheduler!: Scheduler;
    const router = new MessageRouter(run, runId, this.cfg.messaging, { activeTasks: (role) => scheduler.activeTaskIds(role) });
    const rc: RunContext = {
      root: this.root, paths: this.paths, run, runId, cfg: this.cfg, store, router, registry: this.registry, specs,
      skills: loadSkills(this.paths), context: projectContext(this.root), integration,
      adapterFor: (role, override) => this.adapterFor(role, override),
      agentEnv: (id) => this.agentEnv(id),
      tasks: plan.tasks,
      returnTask: (from, to, issue) => scheduler.returnTask(from, to, issue),
    };
    scheduler = new Scheduler(rc, plan, { only: opts.only, agentOverride: opts.agent ?? null, maxParallel: opts.max_parallel });

    store.on("status", (s: AgentStatus) => this.push({ event: "status", data: s }));
    store.on("event", (e: StampedEvent) => {
      this.push({ event: "agent_event", data: e });
      if (e.event.type === "permission_denied") this.requestPermission(e.task_id, "task", e.event.command, e.event.tool);
      if (e.event.type === "tool_missing") this.toolMissing(e.event.command);
    });
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
      this.notice(failed ? "attention" : "info", `Run finished: ${rs.counts.done ?? 0} done, ${failed} not done. ${failed ? "/retry T-n, or " : ""}/merge to merge ${integration.branch} into ${base}.`);
    });

    this.current = { runId, run, plan, store, router, scheduler, rc, base };
    scheduler.start();
    this.push({ event: "run", data: store.runStatus() });
    this.notice("info", `Run ${runId} started: ${scheduler.plan.tasks.length} task(s), up to ${scheduler.maxParallel} in parallel.`);
    return runId;
  }

  /** Agents are working (a run in progress or a session mid-turn). */
  busy(): boolean {
    const r = this.current;
    if (r && r.store.runState !== "done" && r.store.runState !== "aborted") return true;
    return [...this.sessions.values()].some((s) => s.status.state === "running" || s.status.state === "waiting_input");
  }

  requireRun(): ActiveRun {
    if (!this.current) throw new Error("no active run");
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
    const last = dirs.at(-1);
    return last && !this.isClosed(last) ? last : null;
  }

  // ───────────── messaging ─────────────

  /** `to`: "T-7" | "@implementers" | "@all" | "@lead" | "blackboard" | "planner" | "init". */
  async send(to: string, body: string): Promise<{ messages: Message[]; answer?: string }> {
    const target = to.trim();
    if (/^@?(lead|claude)$/i.test(target)) { this.chat(body); return { messages: [] }; }
    if (/^@?planner$/i.test(target)) { this.revise(body); return { messages: [] }; }
    if (/^@?init$/i.test(target)) { this.session("init").say(body); return { messages: [] }; }
    const r = this.requireRun();
    let party: Message["to"];
    if (/^@?(all|everyone)$/i.test(target)) party = { kind: "broadcast" };
    else if (/^@?blackboard$/i.test(target)) party = { kind: "blackboard" };
    else if (target.startsWith("@")) party = { kind: "role", id: target.slice(1).toLowerCase().replace(/s$/, "") };
    else {
      const id = target.toUpperCase();
      const s = r.store.byTask(id);
      if (!s) throw new Error(`unknown task ${target}`);
      if (TERMINAL_STATES.has(s.state)) {
        if (r.scheduler.canContinue(id)) { r.scheduler.continueTask(id, body); return { messages: [] }; }
        throw new Error(s.state === "done" ? `${id} is done and merged; /retry ${id} starts a new attempt` : `${id} is ${s.state}; /retry ${id} starts a new attempt`);
      }
      party = { kind: "agent", id };
    }
    const type = party.kind === "blackboard" ? "note" : "instruction";
    const messages = r.router.send({ from: { kind: "user" }, to: party, type, body });
    for (const m of messages) {
      const s = m.to.kind === "agent" && m.to.id ? r.store.byTask(m.to.id) : undefined;
      if (s && m.delivery.state === "queued") r.store.apply(s.agent_run_id, { type: "chat", from: "user", text: body, message_id: m.id });
    }
    return { messages };
  }

  // ───────────── toolchains ─────────────

  private missingNoticed = new Set<string>();

  private toolMissing(command: string): void {
    const tc = toolchainFor(command);
    if (!tc || this.missingNoticed.has(tc) || installedToolchains()[tc]) return;
    this.missingNoticed.add(tc);
    this.notice("attention", `\`${command}\` isn't installed on this machine. /install ${tc} downloads the official ${tc} release for Hexagon's agents (into ~/.hexagon/toolchains, no Homebrew or sudo).`);
  }

  /** Verify commands whose tool isn't installed, as toolchain names. */
  private missingForPlan(plan: Plan): string[] {
    const need = new Set<string>();
    for (const t of plan.tasks) for (const v of t.verify) {
      const cmd = v.trim().split(/\s+/)[0] ?? "";
      const tc = toolchainFor(cmd);
      if (tc && !onPath(cmd)) need.add(tc);
    }
    return [...need];
  }

  toolchains(): { name: string; installed: string | null; on_path: boolean }[] {
    const inst = installedToolchains();
    return Object.entries(TOOLCHAINS).map(([name, s]) => ({ name, installed: inst[name]?.version ?? null, on_path: s.commands.some((c) => onPath(c)) }));
  }

  /** Download a toolchain, then resume agents that were blocked on it and restart the chat with the new PATH. */
  async installToolchain(name: string): Promise<string> {
    const key = toolchainFor(name);
    if (!key) throw new Error(`Hexagon can install: ${Object.keys(TOOLCHAINS).join(", ")}`);
    this.notice("info", `Installing ${key}…`);
    const t = await installToolchain(key, (l) => this.notice("info", l));
    this.missingNoticed.delete(key);
    const words = [key, ...TOOLCHAINS[key]!.commands];
    const note = `${key} ${t.version} is now installed (on PATH: ${t.bin}). Run what needed it again and continue.`;
    const r = this.current;
    if (r) {
      for (const s of r.store.all()) {
        const why = `${s.state_reason ?? ""} ${s.last_error?.message ?? ""} ${s.activity ?? ""}`.toLowerCase();
        if (!words.some((w) => why.includes(w))) continue;
        if (r.scheduler.canContinue(s.task_id)) r.scheduler.continueTask(s.task_id, note);
        else r.scheduler.run(s.task_id)?.restart(note);
      }
    }
    const chat = this.sessions.get("claude");
    if (chat?.alive) chat.restart(note, chat.allowCommands);
    const msg = `${key} ${t.version} installed for agents.`;
    this.notice("info", msg);
    return msg;
  }

  // ───────────── permissions ─────────────

  private pushPermissions() {
    this.push({ event: "permissions", data: [...this.permissions.values()] });
  }

  private requestPermission(agent: string, kind: PermissionRequest["kind"], command: string, tool = "Bash"): void {
    const allowed = this.cfg.sandbox.allow_commands;
    if (allowed.includes("*")) return;
    // Outside-the-project paths can only be lifted by "allow all".
    const prefix = tool === "path" ? null : commandPrefix(command);
    if (prefix && allowed.includes(prefix)) return; // already allowed: the agent's next process has it
    for (const p of this.permissions.values()) if (p.agent === agent && (p.prefix ?? p.command) === (prefix ?? command)) return;
    const req: PermissionRequest = { id: `P-${this.nextPermission++}`, agent, kind, command, prefix, asked_at: nowIso() };
    this.permissions.set(req.id, req);
    this.pushPermissions();
    const text = `${agent} needs approval to run \`${command}\` (${req.id}). Select ${agent} and answer: 1 allow ${prefix ? `\`${prefix}\` commands` : "it"} · 2 allow all commands · 3 deny`;
    if (kind === "task") this.current?.store.apply(this.current.store.byTask(agent)!.agent_run_id, { type: "chat", from: "hexagon", text: `Needs your approval: \`${command}\`` });
    this.notice("attention", text);
  }

  /**
   * `/allow <prefix>…` or `/allow all`: let agents run these commands from now on. Live sessions and
   * working agents restart in their own sessions so the new rules apply right away.
   */
  allow(rules: string[]): string {
    const list = rules.map((r) => (/^(all|everything|\*)$/i.test(r.trim()) ? "*" : r.trim())).filter(Boolean);
    if (!list.length) throw new Error("usage: /allow <command prefix> … | /allow all");
    allowCommands(this.paths.config, list);
    this.reloadConfig();
    if (this.current) this.current.rc.cfg.sandbox.allow_commands = this.cfg.sandbox.allow_commands;
    const what = list.includes("*") ? "every command" : list.map((l) => `\`${l}\``).join(", ");
    const note = `The user now allows ${what}. Retry anything that was refused and continue.`;
    for (const s of this.sessions.values()) if (s.alive) s.restart(note, [...new Set([...s.allowCommands, ...list])]);
    for (const run of this.current?.scheduler.activeRuns() ?? []) run.restart(note);
    for (const p of [...this.permissions.values()]) if (list.includes("*") || (p.prefix && list.includes(p.prefix))) this.permissions.delete(p.id);
    this.pushPermissions();
    const msg = `Agents may now run ${what} (saved in .hexagon/config.toml).`;
    this.notice("info", msg);
    return msg;
  }

  /** "1"/"allow" → the command's prefix · "2"/"all" → every command · "3"/"deny". */
  answerPermission(id: string, answer: string): string {
    const req = this.permissions.get(id.toUpperCase());
    if (!req) throw new Error(`no permission request ${id}`);
    const a = answer.trim().toLowerCase();
    const all = a === "2" || /^(all|allow all|everything|\*)/.test(a);
    const deny = a === "3" || /^(no|deny|n)\b/.test(a);
    const allow = !deny && (all || a === "1" || /^(y|yes|ok|allow|approve)/.test(a));
    if (!allow && !deny) throw new Error("answer 1 (allow), 2 (allow all commands) or 3 (deny)");
    this.permissions.delete(req.id);
    this.pushPermissions();
    let note: string;
    if (allow) {
      const rule = all || !req.prefix ? "*" : req.prefix;
      allowCommands(this.paths.config, [rule]);
      this.reloadConfig();
      if (this.current) this.current.rc.cfg.sandbox.allow_commands = this.cfg.sandbox.allow_commands;
      // Same command again from another agent: nothing more to ask.
      for (const p of [...this.permissions.values()]) if (rule === "*" || p.prefix === rule) this.permissions.delete(p.id);
      this.pushPermissions();
      note = `The user approved \`${req.command}\`: Hexagon now allows ${rule === "*" ? "every command" : `\`${rule}\` commands`}. Run it again and continue.`;
      this.notice("info", `${rule === "*" ? "All commands" : `\`${rule}\``} allowed for agents in this project (.hexagon/config.toml).`);
    } else {
      note = `The user denied \`${req.command}\`. Don't retry it or work around it; continue without it, and say what is left undone.`;
    }
    if (req.kind === "session") {
      const s = this.sessions.get(req.agent);
      if (s) {
        const list = allow ? [...new Set([...s.allowCommands, all || !req.prefix ? "*" : req.prefix])] : s.allowCommands;
        if (allow) s.restart(note, list);
        else if (s.alive) s.inject(note);
      }
      return req.agent;
    }
    const r = this.current;
    if (!r) return req.agent;
    const run = r.scheduler.run(req.agent);
    if (run) {
      if (!allow || !run.restart(note)) r.router.send({ from: { kind: "orchestrator" }, to: { kind: "agent", id: req.agent }, type: "instruction", body: note });
    } else if (allow && r.scheduler.canContinue(req.agent)) {
      r.scheduler.continueTask(req.agent, note);
    }
    return req.agent;
  }

  answer(questionId: string, answer: string): string {
    const qid = questionId.toUpperCase();
    if (qid.startsWith("P-")) return this.answerPermission(qid, answer);
    for (const s of this.sessions.values()) {
      if (s.status.question?.question_id.toUpperCase() === qid) { s.say(answer); return s.id; }
    }
    const r = this.requireRun();
    for (const run of r.scheduler.activeRuns()) {
      if (run.answer(qid, answer)) return run.task.id;
    }
    throw new Error(`no open question ${questionId}`);
  }

  inbox(): { questions: (AgentStatus["needs_input"] & { task_id: string })[]; attention: RunStatus["attention"]; notices: Message[] } {
    const solo = [...this.sessions.values()].filter((s) => s.status.question).map((s) => ({ ...s.status.question!, task_id: s.id }));
    if (!this.current) return { questions: solo, attention: [], notices: [] };
    const r = this.current;
    const questions = r.store.all()
      .filter((s) => s.needs_input && !TERMINAL_STATES.has(s.state))
      .map((s) => ({ ...s.needs_input!, task_id: s.task_id }));
    const notices = r.router.all().filter((m) => m.to.kind === "user" && m.type === "notify").slice(-20);
    return { questions: [...solo, ...questions], attention: r.store.runStatus().attention.filter((a) => a.kind !== "question"), notices };
  }

  /**
   * Talk to Claude: a persistent Claude Code session in the project root (read-only). It
   * answers questions about the code and the run, and starts planning (`hexagon plan`) when
   * you ask for something to be built.
   */
  chat(text: string): void {
    if (!text.trim()) return;
    const context = `<hexagon_state>\n${this.stateSummary()}\n</hexagon_state>`;
    const cur = this.sessions.get("claude");
    if (cur?.alive) return cur.say(text, context);
    this.reloadConfig();
    const s = cur ?? this.solo("claude", "lead", {
      system: systemPrompt(this.paths, "lead", "claude", loadSkills(this.paths), [], projectContext(this.root)),
      env: this.agentEnv("claude"),
      allowCommands: ["hexagon", ...new Set([...this.cfg.sandbox.allow_commands, ...PLANNER_COMMANDS, "git diff", "git show", "git status", "git log", "git add", "git commit"])],
      conversational: true,
      readOnly: false,
    });
    s.logUser(text);
    const first = `${context}\n<user_message>\n${text}\n</user_message>`;
    void s.run(first, first).then(() => {
      if (s.status.state === "failed") this.notice("error", `chat session ended: ${s.status.error ?? "unknown error"}`);
    });
  }

  /** Short state for the chat session: what's running, what's waiting. */
  private stateSummary(): string {
    const lines: string[] = [];
    const r = this.status();
    if (r) {
      const t = r.totals;
      lines.push(`Run ${r.run_id}: ${r.state}; ${r.counts.done ?? 0}/${r.agents.length} done; ${t.input_tokens + t.cache_read_tokens + t.output_tokens} tokens used.`);
      for (const a of r.agents) lines.push(`- ${a.task_id} (${a.role}) ${a.state}${a.activity ? `: ${a.activity}` : ""}${a.needs_input ? " [waiting for the user's answer]" : ""}`);
    } else lines.push("No run yet.");
    if (this.draft) lines.push(`A draft plan "${this.draft.goal}" (${this.draft.plan.tasks.length} tasks) is waiting for the user's approval.`);
    const p = this.sessions.get("planner");
    if (p?.alive) lines.push(`The planner is working on a plan${p.status.question ? ` and asks: ${p.status.question.prompt}` : ""}.`);
    return lines.join("\n");
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
    await g.git(wt, ["add", "-A", "-N"]);
    const out = await g.git(wt, ["diff", ...(stat ? ["--stat"] : []), r.rc.integration.branch]);
    return out.stdout || "(no changes)";
  }

  async mergeToBase(): Promise<string> {
    const r = this.requireRun();
    const active = r.scheduler.activeRuns().length;
    if (active) throw new Error(`${active} agent(s) still active; wait for the run to finish or /abort`);
    const cur = await g.currentBranch(this.root);
    if (cur !== r.base) throw new Error(`check out ${r.base} first (currently on ${cur})`);
    // Hexagon's own config (e.g. commands you approved) doesn't conflict with the merge.
    if (!(await g.isClean(this.root, [".hexagon"]))) throw new Error(`working tree of ${r.base} has uncommitted changes; commit or stash them first`);
    const m = await g.merge(this.root, r.rc.integration.branch, `Merge Hexagon run ${r.runId}`);
    if (!m.ok) throw new Error(m.conflict ? "merge conflict — resolve manually: git merge " + r.rc.integration.branch : m.output);
    this.closeRun("merged");
    return `Merged ${r.rc.integration.branch} into ${r.base}. The run is closed; its worktrees can go with /clean.`;
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
    if (this.current) this.closeRun("cleaned");
    else this.push({ event: "run", data: null });
    return removed;
  }

  shutdown(): void {
    this.current?.scheduler.abort();
    for (const s of this.sessions.values()) if (s.status.state === "running" || s.status.state === "waiting_input") s.cancel();
  }
}

/** Validate a planner output directory (spec.md + plan.json). */
export function draftCheck(root: string, out: string): { reply: Reply; spec?: Spec; plan?: Plan } {
  const specFile = path.join(out, "spec.md");
  const planFile = path.join(out, "plan.json");
  const errors: string[] = [];
  const warnings: string[] = [];
  let spec: Spec | undefined;
  let plan: Plan | undefined;
  if (!fs.existsSync(specFile)) errors.push(`missing ${specFile}`);
  else {
    spec = parseSpec(specFile);
    if (!spec.requirements.length) errors.push("spec.md has no requirements (## REQ-<AREA>-<NNN>: <title>)");
    for (const i of lintSpec(spec)) (i.level === "error" ? errors : warnings).push(`spec.md:${i.line} ${i.message}`);
  }
  if (!fs.existsSync(planFile)) errors.push(`missing ${planFile}`);
  else {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(planFile, "utf8")); } catch (e) { errors.push(`plan.json is not valid JSON: ${(e as Error).message}`); }
    if (raw) {
      plan = normalizePlan(raw, { id: "draft", specs: ["spec.md"] });
      if (!plan.tasks.length) errors.push("plan.json has no tasks");
      const c = checkPlan(plan, spec ? [spec] : []);
      errors.push(...c.errors);
      warnings.push(...c.warnings);
      for (const t of plan.tasks) if (!t.files.write.length) errors.push(`${t.id} has no files.write globs`);
    }
  }
  const lines = [
    errors.length ? `✖ ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}` : "✔ spec.md and plan.json are valid",
    warnings.length ? `! ${warnings.length} warning(s):\n${warnings.map((w) => `  - ${w}`).join("\n")}` : "",
  ].filter(Boolean);
  void root;
  return { reply: { ok: errors.length === 0, message: lines.join("\n") }, spec, plan };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export { nowIso };

/** Only Hexagon's own files so far. */
function isEmptyProject(root: string): boolean {
  const own = /^(\.hexagon\/|specs\/|\.gitignore$|HEXAGON\.md$|README(\.md)?$|LICENSE)/i;
  return listProjectFiles(root, 50).every((f) => own.test(f));
}

function stubContext(root: string): string {
  return `# ${path.basename(root)}
New repository: no code yet, so the stack isn't chosen. Whoever adds the first code (you,
Claude in the chat, or an /sdd run) fills in the sections below.

## Stack
(not chosen yet)

## Commands
- build: (none yet)
- test: (none yet)
- run: (none yet)

## Layout
- \`specs/\`: specs written by Hexagon's planner

## Conventions
(none yet)
`;
}
