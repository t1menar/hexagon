import fs from "node:fs";
import path from "node:path";
import type { Plan } from "../contracts/types.js";
import { applyGraph, commandDef, edgesOf, fromTask, graphDiff, parseArgs, type CommandDef } from "../core/commands.js";
import { canonicalRole } from "../core/roles.js";
import { nowIso } from "../util/fsx.js";
import type { Orchestrator } from "./orchestrator.js";

export interface Proposal {
  id: string;
  command: string;
  args: Record<string, unknown>;
  /** What will change, one line each (graph diff or a one-line description). */
  diff: string[];
  destructive: boolean;
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
  async exec(name: string, raw: Record<string, unknown>, via: "user" | "agent"): Promise<CommandResult> {
    const def = commandDef(name);
    if (!def) throw new Error(`unknown command "${name}" (hexagon commands lists them)`);
    const args = parseArgs(def, raw);
    if (def.kind === "read" || via === "user") return { status: "done", result: await this.run(def, args) };
    const diff = this.preview(def, args); // validates against current state before the user is asked
    const destructive = def.kind === "destructive";
    if (!destructive && this.o.cfg.control.auto_apply) return { status: "done", result: await this.run(def, args) };
    const proposal: Proposal = { id: `P-${this.seq++}`, command: name, args, diff, destructive, created_at: nowIso() };
    this.proposals.set(proposal.id, proposal);
    this.onChange(this.list());
    return { status: "proposed", proposal, message: `Proposed ${proposal.id}: ${diff.join("; ")}. Nothing changed yet; the user must confirm it. Tell them what you proposed and stop.` };
  }

  async confirm(id: string): Promise<unknown> {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`no pending proposal ${id}`);
    this.proposals.delete(id);
    this.onChange(this.list());
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

  private draftPlan(): Plan {
    const d = this.o.draft;
    if (!d) throw new Error("there is no draft plan to edit (editing a running graph is not supported yet)");
    return d.plan;
  }

  private preview(def: CommandDef, a: Record<string, unknown>): string[] {
    if (def.name.startsWith("graph.")) {
      const before = this.draftPlan();
      const d = graphDiff(before, applyGraph(before, def.name, a));
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
      const d = o.draft;
      const next = applyGraph(this.draftPlan(), def.name, a);
      fs.writeFileSync(d!.plan_path, JSON.stringify(next, null, 2));
      return { tasks: o.reloadDraft().plan.tasks.length };
    }
    switch (def.name) {
      case "status.get": return { run: o.status(), draft: o.draft ? { goal: o.draft.goal, tasks: o.draft.plan.tasks.length, errors: o.draft.check.errors } : null, spec_review: o.specReview ? { spec: o.specReview.spec_path } : null, proposals: this.list() };
      case "graph.show": {
        const plan = o.current?.plan ?? o.draft?.plan ?? null;
        if (!plan) return { tasks: [], edges: [] };
        return { source: o.current ? "run" : "draft", tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, role: t.role })), edges: edgesOf(plan) };
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
