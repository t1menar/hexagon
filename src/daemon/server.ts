import fs from "node:fs";
import { buildId } from "../util/resources.js";
import net from "node:net";
import type { Effort } from "../contracts/types.js";
import type { ApiOp } from "../core/registry.js";
import { atomicWriteJson, nowIso } from "../util/fsx.js";
import { ensureUserToken, METHOD_SCOPES, sameToken } from "./auth.js";
import { Orchestrator, type Push } from "./orchestrator.js";

export const PROTOCOL_VERSION = 3;
const BUILD = buildId();

interface Request { id: number; method: string; params?: Record<string, unknown>; token?: string }

type Handler = (p: Record<string, unknown>, conn: Conn, caller?: string) => unknown | Promise<unknown>;

class Conn {
  subscribed = false;
  constructor(readonly sock: net.Socket) {}
  send(obj: unknown) {
    if (!this.sock.destroyed) this.sock.write(JSON.stringify(obj) + "\n");
  }
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`missing parameter: ${name}`);
  return v;
};

/** JSON-RPC-ish over a unix socket, newline-delimited. Pushes are {event, data}. */
export class DaemonServer {
  private server: net.Server | undefined;
  private conns = new Set<Conn>();
  readonly orch: Orchestrator;
  private handlers: Record<string, Handler>;
  private userToken = "";

  constructor(readonly root: string) {
    this.orch = new Orchestrator(root);
    this.orch.on("push", (p: Push) => {
      for (const c of this.conns) if (c.subscribed) c.send(p);
    });
    const o = this.orch;
    this.handlers = {
      ping: () => ({ pid: process.pid, protocol: PROTOCOL_VERSION, build: BUILD, busy: o.busy(), root, run_id: o.current?.runId ?? null }),
      subscribe: (_p, conn) => { conn.subscribed = true; return { ok: true }; },
      "ui.snapshot": () => o.snapshot(),
      // The caller's identity is its token's: an agent cannot speak as another agent.
      "agent.api": (p, _c, caller) => o.agentApi(caller ?? ((p.agent as string) || null), (p.cwd as string) || null, str(p.op, "op") as ApiOp, (p.args as Record<string, unknown>) ?? {}),
      "init.start": (p) => o.startInit((p.description as string) || null),
      "goal.new": (p) => o.newGoal(str(p.goal, "goal")),
      "chat.send": (p) => { o.chat(str(p.text, "text")); return { ok: true }; },
      "draft.revise": (p) => { o.revise(str(p.feedback, "feedback")); return { ok: true }; },
      "spec.approve": (p) => o.approveSpec(p.spec ? String(p.spec) : undefined),
      "spec.revise": (p) => { o.respec(str(p.feedback, "feedback")); return { ok: true }; },
      "command.exec": async (p) => o.control.exec(str(p.name, "name"), (p.args as Record<string, unknown>) ?? {}, "user", p.confirmed === true),
      "command.confirm": async (p) => ({ result: await o.control.confirm(str(p.id, "id")) }),
      "command.reject": (p) => { o.control.reject(str(p.id, "id")); return { ok: true }; },
      "command.list": () => o.control.list(),
      "draft.reload": () => o.reloadDraft(),
      "draft.approve": async (p) => ({ run_id: await o.approve({ max_parallel: p.max_parallel as number | undefined, agent: (p.agent as string) ?? null }) }),
      "draft.discard": () => { o.discardDraft(); return { ok: true }; },
      "session.say": (p) => { o.session(str(p.id, "id")).say(str(p.text, "text")); return { ok: true }; },
      "session.cancel": (p) => { o.session(str(p.id, "id")).cancel(); return { ok: true }; },
      "run.start": async (p) => ({
        run_id: await o.startRun({
          plan_path: str(p.plan_path, "plan_path"), only: p.only as string[] | undefined, agent: (p.agent as string) ?? null,
          max_parallel: p.max_parallel as number | undefined, budget_tokens: p.budget_tokens as number | null | undefined,
        }),
      }),
      "run.status": () => o.status(),
      "run.changes": () => o.changes(),
      "run.pause": () => { o.requireRun().scheduler.pauseAll(); return { ok: true }; },
      "run.resume": () => { o.requireRun().scheduler.resumeAll(); return { ok: true }; },
      "run.abort": () => { o.requireRun().scheduler.abort(); return { ok: true }; },
      "agent.status": (p) => o.agentStatus(str(p.task, "task")),
      "agent.events": (p) => o.agentEvents(str(p.task, "task"), (p.limit as number) ?? 200),
      "agent.pause": (p) => ({ ok: o.agentRun(str(p.task, "task")).pause() }),
      "agent.resume": (p) => ({ ok: o.agentRun(str(p.task, "task")).resume() }),
      "agent.cancel": (p) => { o.agentRun(str(p.task, "task")).cancel(); return { ok: true }; },
      "agent.retry": (p) => {
        o.requireRun().scheduler.retry(str(p.task, "task").toUpperCase(), { agent: p.agent as string | undefined, effort: p.effort as Effort | undefined });
        return { ok: true };
      },
      "session.compact": (p) => ({ ok: true, agents: o.compactSessions(p.agent ? String(p.agent) : undefined) }),
      "stats.get": () => o.stats(),
      "cost.get": () => o.cost(),
      "agent.takeover": async (p) => o.takeover(str(p.task, "task")),
      "agent.takeover_end": async (p) => {
        await o.takeoverEnd(str(p.task, "task"), (p.action as "handback" | "done" | "discard") ?? "handback");
        return { ok: true };
      },
      "agent.diff": async (p) => ({ diff: await o.diff(str(p.task, "task"), Boolean(p.stat)) }),
      "message.send": async (p) => o.send(str(p.to, "to"), str(p.body, "body")),
      "question.answer": (p) => ({ task_id: o.answer(str(p.question_id, "question_id"), str(p.answer, "answer")) }),
      "inbox.list": () => o.inbox(),
      "notes.get": () => ({ notes: o.requireRun().router.notes() }),
      "messages.list": (p) => {
        const all = o.requireRun().router.all();
        const task = (p.task as string | undefined)?.toUpperCase();
        const filtered = task ? all.filter((m) => m.thread_id === task || m.to.id === task || m.from.id === task) : all;
        return filtered.slice(-((p.limit as number) ?? 50));
      },
      "merge.base": async (p) => ({ text: await o.mergeToBase({ override: typeof p.override === "string" && p.override.trim() ? p.override.trim() : undefined }) }),
      "worktrees.clean": async () => ({ removed: await o.cleanup() }),
      "run.close": () => ({ closed: o.closeRun("closed by user") }),
      "allow": (p) => ({ text: o.allow((p.rules as string[]) ?? []) }),
      "models.list": () => o.models(),
      trace: () => o.traceRun(),
      "agents.list": () => o.agentsInfo(),
      "agents.models": (p) => o.discoverModels(str(p.agent, "agent"), Boolean(p.fresh)),
      "agents.role": (p) => { o.setRoleAgent(str(p.role, "role"), str(p.agent, "agent")); return o.models(); },
      "agents.add": (p) => { o.addAgentConfig({ id: str(p.id, "id"), adapter: str(p.adapter, "adapter"), provider: p.provider as string | undefined, command: p.command as string[] | undefined, model: p.model as string | undefined }); return { ok: true }; },
      "models.set": (p) => { o.setModel(str(p.role, "role"), (p.model as string) || null); return o.models(); },
      "toolchain.list": () => o.toolchains(),
      "toolchain.install": async (p) => ({ text: await o.installToolchain(str(p.name, "name")) }),
      shutdown: () => { setTimeout(() => this.stop(0), 50); return { ok: true }; },
    };
  }

  async listen(): Promise<void> {
    const sock = this.orch.paths.socket;
    if (fs.existsSync(sock)) {
      const alive = await new Promise<boolean>((resolve) => {
        const c = net.connect(sock, () => { c.end(); resolve(true); });
        c.on("error", () => resolve(false));
      });
      if (alive) throw new Error("a Hexagon daemon is already running for this project");
      fs.rmSync(sock, { force: true });
    }
    this.userToken = ensureUserToken(this.root);
    this.server = net.createServer((s) => this.onConnection(s));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(sock, () => resolve());
    });
    fs.chmodSync(sock, 0o600);
    atomicWriteJson(this.orch.paths.daemonInfo, { pid: process.pid, protocol: PROTOCOL_VERSION, socket: sock, started_at: nowIso(), root: this.root });
    // Runs that were waiting for a provider limit when the previous daemon stopped continue on their own.
    this.orch.recoverRuns().catch((e) => console.error("recoverRuns:", e));
  }

  private onConnection(sock: net.Socket) {
    const conn = new Conn(sock);
    this.conns.add(conn);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) void this.handle(conn, line);
      }
    });
    sock.on("close", () => this.conns.delete(conn));
    sock.on("error", () => this.conns.delete(conn));
  }

  private async handle(conn: Conn, line: string) {
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      conn.send({ id: null, error: { message: "invalid JSON" } });
      return;
    }
    const h = this.handlers[req.method];
    if (!h) {
      conn.send({ id: req.id, error: { message: `unknown method ${req.method}` } });
      return;
    }
    const scope = METHOD_SCOPES[req.method];
    const isUser = sameToken(req.token, this.userToken);
    const agent = isUser ? undefined : this.orch.tokens.agentOf(req.token);
    if (scope !== "open") {
      if (!isUser && !agent) { conn.send({ id: req.id, error: { message: "not authenticated: this client has no valid Hexagon token" } }); return; }
      if (agent && scope !== "any") { conn.send({ id: req.id, error: { message: `${req.method} is not allowed for agents: it needs the user` } }); return; }
    }
    try {
      conn.send({ id: req.id, result: (await h(req.params ?? {}, conn, agent)) ?? null });
    } catch (e) {
      conn.send({ id: req.id, error: { message: e instanceof Error ? e.message : String(e) } });
    }
  }

  stop(code = 0): void {
    this.orch.shutdown();
    for (const c of this.conns) c.sock.end();
    this.server?.close();
    fs.rmSync(this.orch.paths.socket, { force: true });
    fs.rmSync(this.orch.paths.daemonInfo, { force: true });
    setTimeout(() => process.exit(code), 100).unref();
  }
}
