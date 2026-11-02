import type { AgentApi, Reply } from "../agents/types.js";

export type ApiOp = "report" | "ask" | "note" | "done" | "review" | "plan_check" | "return" | "bus" | "exec" | "install" | "sudo" | "command" | "goal" | "logs" | "proposals" | "tell";

/** Routes `hexagon report|ask|note|done|review` calls from agent processes to the right supervisor. */
export class ApiRegistry {
  private apis = new Map<string, AgentApi & { plan_check?: () => Reply }>();

  register(id: string, api: AgentApi & { plan_check?: () => Reply }): () => void {
    this.apis.set(id, api);
    return () => {
      if (this.apis.get(id) === api) this.apis.delete(id);
    };
  }

  ids(): string[] {
    return [...this.apis.keys()];
  }

  call(id: string, op: ApiOp, args: Record<string, unknown>): Reply {
    let api = this.apis.get(id);
    // A reviewer shares its implementer's worktree; route reviews to the review session.
    if (op === "review" && this.apis.has(`${id}.review`)) api = this.apis.get(`${id}.review`);
    if (!api) return { ok: false, message: `Hexagon has no active agent "${id}" (it may have been cancelled). Stop working.` };
    switch (op) {
      case "report": return api.report(args as never);
      case "ask": return api.ask({ blocking: true, ...(args as Record<string, unknown>) } as Parameters<typeof api.ask>[0]);
      case "note": return api.note(String(args.body ?? ""));
      case "done": return api.done(args as never);
      case "review": return api.review(args as never);
      case "return": return api.return ? api.return(args as never) : { ok: false, message: "`hexagon return` is only for task agents in a run." };
      case "bus": return api.bus ? api.bus(args) : { ok: false, message: "`hexagon bus` is only for task agents in a run." };
      case "command": case "goal": case "logs": case "proposals": case "tell": case "exec": case "install": case "sudo": return { ok: false, message: `\`hexagon ${op}\` is handled by the daemon, not by this agent.` };
      case "plan_check": return api.plan_check ? api.plan_check() : { ok: false, message: "plan-check is only for the planner" };
    }
  }
}
