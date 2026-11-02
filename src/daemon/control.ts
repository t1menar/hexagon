import fs from "node:fs";
import path from "node:path";
import type { Plan } from "../contracts/types.js";
import { isUntraced } from "../core/pipeline.js";
import { applyGraph, commandDef, edgesOf, fromTask, graphDiff, parseArgs, type CommandDef } from "../core/commands.js";
import { canonicalRole } from "../core/roles.js";
import { nowIso } from "../util/fsx.js";
import type { ActiveRun, Orchestrator } from "./orchestrator.js";

export interface Proposal {
  id: string;
  command: string;
  args: Record<string, unknown>;
  /** What will change, one line each (graph diff or a one-line description). */
  diff: string[];
  destructive: boolean;
  /** Who asked: the control agent, or you (a destructive command of your own waits for a yes too). */
  by: "agent" | "user";
  created_at: string;
}

export type CommandResult =
  | { status: "done"; result: unknown }
  | { status: "proposed"; proposal: Proposal; message: string };

/**
 * The one implementation of the typed command API. Direct callers (the user's CLI and TUI) execute at once; the
 * control agent only proposes mutations, which run after the user confirms. Destructive commands always wait.
 */
export class ControlService {
  private proposals = new Map<string, Proposal>();
  private seq = 1;

  constructor(private o: Orchestrator, private onChange: (list: Proposal[]) => void) {}

  list(): Proposal[] {
    return [...this.proposals.values()];
  }

  /** `via: "agent"` is the control agent; anything else is the user acting directly. */
  async exec(name: string, raw: Record<string, unknown>, via: "user" | "agent", confirmed = false): Promise<CommandResult> {
    const def = commandDef(name);
    if (!def) throw new Error(`unknown command "${name}" (hexagon commands lists them)`);
    const args = parseArgs(def, raw);
    // Destructive commands wait for a yes from the user, whoever types them: your own call is a proposal until `confirmed`.
    const needsYes = def.kind === "destructive" && !confirmed;
    if (def.kind === "read" || (via === "user" && !needsYes)) return { status: "done", result: await this.run(def, args) };
    const diff = this.preview(def, args); // validates against current state before the user is asked
    const destructive = def.kind === "destructive";
    if (!destructive && this.o.cfg.control.auto_apply) return { status: "done", result: await this.run(def, args) };
    const proposal: Proposal = { id: `P-${this.seq++}`, command: name, args, diff, destructive, by: via, created_at: nowIso() };
    this.proposals.set(proposal.id, proposal);
    this.onChange(this.list());
    return { status: "proposed", proposal, message: `Proposed ${proposal.id}: ${diff.join("; ")}. Nothing changed yet; the user must confirm it. Tell them what you proposed and stop.` };
  }

  /** A replan from the analyst: one proposal holding the spec patch and the graph edits. Nothing changes until it is confirmed. */
  proposeReplan(args: Record<string, unknown>, diff: string[]): Proposal {
    const proposal: Proposal = { id: `P-${this.seq++}`, command: "replan.apply", args, diff, destructive: false, by: "agent", created_at: nowIso() };
    this.proposals.set(proposal.id, proposal);
    this.onChange(this.list());
    this.o.notice("attention", `${String(args.task)} needs a plan change (${proposal.id}): ${diff[0] ?? ""}. Review it, then /apply ${proposal.id} or /reject ${proposal.id}.`);
    return proposal;
  }

  /** Confirming applies the spec patch (and re-approves it: you just read the diff), edits the not-yet-started graph, then retries the blocked task. */
  private async applyReplan(a: Record<string, unknown>): Promise<unknown> {
    const o = this.o;
    const live = this.o.current && this.o.current.store.runState !== "aborted" ? this.o.current : null; // a run that ended on a blocked task is still repairable
    if (!live) throw new Error("the run was aborted; the replan can no longer be applied");
    const bundle = a.bundle as { graph: { command: string; args: Record<string, unknown> }[] };
    if (typeof a.spec_rel === "string" && typeof a.new_spec === "string") {
      const file = path.join(o.root, a.spec_rel);
      fs.writeFileSync(file, a.new_spec);
      o.approvals.approve(file, "user");
    }
    for (const op of bundle.graph) live.scheduler.editGraph(op.command as Parameters<typeof live.scheduler.editGraph>[0], op.args);
    o.approveUntraced(live.plan, "by this replan");
    live.scheduler.reviveGated();
    const task = String(a.task);
    live.scheduler.releaseReplan(task);
    if (live.plan.tasks.some((t) => t.id === task) && live.store.byTask(task)?.state === "blocked") live.scheduler.retry(task, {});
    live.scheduler.resumeScheduling();
    return { tasks: live.plan.tasks.length, retried: live.plan.tasks.some((t) => t.id === task) ? task : null };
  }

  async confirm(id: string): Promise<unknown> {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`no pending proposal ${id}`);
    this.proposals.delete(id);
    this.onChange(this.list());
    if (p.command === "replan.apply") {
      try { return await this.applyReplan(p.args); } catch (e) {
        this.o.notice("error", `${p.id} (replan) failed: ${(e as Error).message}`);
        throw e;
      }
    }
    const def = commandDef(p.command)!;
    try { return await this.run(def, p.args); } catch (e) {
      this.o.notice("error", `${p.id} (${p.command}) failed: ${(e as Error).message}`);
      throw e;
    }
  }

  reject(id: string): void {
    if (!this.proposals.delete(id)) throw new Error(`no pending proposal ${id}`);
    this.onChange(this.list());
  }

  /** A running graph is edited live; otherwise the draft plan. */
  private liveRun() {
    const c = this.o.current;
    return c && c.store.runState !== "done" && c.store.runState !== "aborted" ? c : null;
  }

  private draftPlan(): Plan {
    const live = this.liveRun();
    if (live) return live.plan;
    const d = this.o.draft;
    if (!d) throw new Error("there is no graph to edit: no run is active and there is no draft plan");
    return d.plan;
  }

  /** The same checks the scheduler makes, so a proposal that could never apply is refused when it is made. */
  private checkLive(s: ActiveRun["scheduler"], name: string, a: Record<string, unknown>): void {
    const bad = name === "graph.removeNode" ? s.whyNotEditable(String(a.id)) : name === "graph.addEdge" || name === "graph.removeEdge" ? s.whyNotEditable(String(a.to)) : null;
    if (bad) throw new Error(bad);
  }

  private preview(def: CommandDef, a: Record<string, unknown>): string[] {
    if (def.name.startsWith("graph.") && def.kind !== "read") {
      const before = this.draftPlan();
      const live = this.liveRun();
      if (live) this.checkLive(live.scheduler, def.name, a);
      const after = applyGraph(before, def.name, a);
      const d = graphDiff(before, after);
      // Applying approves a task that the spec does not cover: say so in the diff the user confirms.
      for (const t of after.tasks) if (isUntraced(t, after.specs) && !before.tasks.some((b) => b.id === t.id && isUntraced(b, before.specs))) d.push(`! ${t.id} cites no requirement: applying this lets it run outside the approved spec`);
      return d.length ? d : ["no change"];
    }
    switch (def.name) {
      case "agent.configure": return [`${canonicalRole(String(a.role))}: ${a.agent ? `agent ${a.agent}` : ""}${a.agent && a.model !== undefined ? ", " : ""}${a.model !== undefined ? `model ${a.model || "default"}` : ""}`.trim()];
      case "agent.setPrompt": return [`replace the prompt of ${canonicalRole(String(a.role))} (${String(a.text).length} chars)`];
      case "run.start": {
        const plan = this.draftPlan();
        const ids = a.from ? fromTask(plan, String(a.from)) : plan.tasks.map((t) => t.id);
        return [`start ${ids.join(", ")}`];
      }
      case "run.pause": return ["pause all agents"];
      case "run.resume": return ["resume all agents"];
      case "run.cancel": return ["abort the run and stop its agents"];
      case "bus.send": return [`message ${String(a.to)}: ${String(a.text).slice(0, 80)}`];
      default: return [def.summary];
    }
  }

  private async run(def: CommandDef, a: Record<string, unknown>): Promise<unknown> {
    const o = this.o;
    if (def.name.startsWith("graph.") && def.kind !== "read") {
      const live = this.liveRun();
      if (live) {
        live.scheduler.editGraph(def.name as Parameters<typeof live.scheduler.editGraph>[0], a);
        o.approveUntraced(live.plan, "by this edit");
        return { tasks: live.plan.tasks.length, live: true };
      }
      const d = o.draft;
      const next = applyGraph(this.draftPlan(), def.name, a);
      fs.writeFileSync(d!.plan_path, JSON.stringify(next, null, 2));
      o.approveUntraced(next, "by this edit");
      return { tasks: o.reloadDraft().plan.tasks.length };
    }
    switch (def.name) {
      case "status.get": return { run: o.status(), draft: o.draft ? { goal: o.draft.goal, tasks: o.draft.plan.tasks.length, errors: o.draft.check.errors } : null, spec_review: o.specReview ? { spec: o.specReview.spec_path } : null, proposals: this.list() };
      case "graph.show": {
        const live = this.liveRun();
        const plan = live?.plan ?? o.draft?.plan ?? o.current?.plan ?? null;
        if (!plan) return { tasks: [], edges: [] };
        return {
          source: live ? "run" : o.draft ? "draft" : "last run",
          tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, role: t.role, ...(live ? { editable: live.scheduler.editable(t.id) } : {}) })),
          edges: edgesOf(plan),
        };
      }
      case "agent.configure": {
        if (a.agent) o.setRoleAgent(String(a.role), String(a.agent));
        if (a.model !== undefined) o.setModel(String(a.role), String(a.model) || null);
        return { ok: true };
      }
      case "agent.setPrompt": {
        const role = canonicalRole(String(a.role));
        if (!Object.keys(o.cfg.roles).includes(role)) throw new Error(`unknown role "${role}" (roles: ${Object.keys(o.cfg.roles).join(", ")})`);
        fs.mkdirSync(o.paths.roles, { recursive: true });
        fs.writeFileSync(path.join(o.paths.roles, `${role}.md`), String(a.text).trim() + "\n");
        return { ok: true, note: "applies to new sessions" };
      }
      case "run.start": {
        const d = o.draft;
        if (!d) throw new Error("there is no draft plan to start");
        const only = a.from ? fromTask(d.plan, String(a.from)) : undefined;
        return { run_id: await o.approve({ max_parallel: a.max_parallel as number | undefined, only }) };
      }
      case "run.pause": o.requireRun().scheduler.pauseAll(); return { ok: true };
      case "run.resume": o.requireRun().scheduler.resumeAll(); return { ok: true };
      case "run.cancel": o.requireRun().scheduler.abort(); return { ok: true };
      case "bus.send": return o.send(String(a.to), String(a.text));
    }
    throw new Error(`command ${def.name} has no implementation`);
  }
}
