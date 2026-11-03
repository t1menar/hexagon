import { randomBytes } from "node:crypto";
export { ensureUserToken, readUserToken, sameToken } from "../util/token.js";

/**
 * Who may call which RPC method.
 *  open: anyone who can reach the socket (liveness only, no secrets).
 *  any:  the user and agents. Agents are identified by their token, never by what the request claims.
 *  user: the user only. Everything that approves, answers, merges, widens permissions or starts work.
 * A method that is not listed here is refused (deny by default), and a test fails until it is listed.
 */
export type Scope = "open" | "any" | "user";

export const METHOD_SCOPES: Record<string, Scope> = {
  ping: "open",
  "agent.api": "any",
  subscribe: "user", "ui.snapshot": "user", "init.start": "user", "goal.new": "user", "chat.send": "user",
  "draft.revise": "user", "spec.approve": "user", "spec.revise": "user",
  "command.exec": "user", "command.confirm": "user", "command.reject": "user", "command.list": "user",
  "draft.reload": "user", "draft.approve": "user", "draft.discard": "user",
  "session.say": "user", "session.cancel": "user", "session.compact": "user",
  "run.start": "user", "run.status": "user", "run.changes": "user", "run.pause": "user", "run.resume": "user", "run.abort": "user", "run.close": "user",
  "agent.status": "user", "agent.events": "user", "agent.pause": "user", "agent.resume": "user", "agent.cancel": "user", "agent.retry": "user",
  "agent.takeover": "user", "agent.takeover_end": "user", "agent.diff": "user",
  "stats.get": "user", "cost.get": "user", "message.send": "user", "question.answer": "user", "inbox.list": "user", "notes.get": "user", "messages.list": "user",
  "merge.base": "user", "delivery.run": "user", "worktrees.clean": "user", allow: "user",
  "models.list": "user", trace: "user", "agents.list": "user", "agents.models": "user", "agents.role": "user", "agents.add": "user", "models.set": "user",
  "toolchain.list": "user", "toolchain.install": "user", shutdown: "user",
};

/** Per-agent tokens the daemon puts in an agent process's environment. They live in memory only. */
export class AgentTokens {
  private byToken = new Map<string, string>();
  private byAgent = new Map<string, string>();

  /** One token per agent identity for the life of the daemon (a restarted daemon issues new ones). */
  issue(agentId: string): string {
    let t = this.byAgent.get(agentId);
    if (!t) {
      t = randomBytes(24).toString("hex");
      this.byAgent.set(agentId, t);
      this.byToken.set(t, agentId);
    }
    return t;
  }

  agentOf(token: string | undefined): string | undefined {
    return token ? this.byToken.get(token) : undefined;
  }
}
