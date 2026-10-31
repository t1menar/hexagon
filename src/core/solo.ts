import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentEvent, Effort, NeedsInput, Role } from "../contracts/types.js";
import type { AdapterOutcome, AgentAdapter, AgentApi, AgentHost, Injected, Reply } from "../agents/types.js";
import { nowIso } from "../util/fsx.js";

/** Live snapshot of a run-less agent session (planner, init) for the UI. */
export interface SessionStatus {
  id: string;
  role: Role;
  agent: string;
  state: "running" | "waiting_input" | "done" | "failed" | "cancelled";
  activity: string | null;
  question: NeedsInput | null;
  cost_usd: number;
  summary: string | null;
  error: string | null;
  feed: { ts: string; text: string; kind: "tool" | "text" | "status" | "error" | "user" | "agent" }[];
  session_id: string;
}

/**
 * One agent session outside a run: the planner turning a goal into spec + plan,
 * or the init agent writing HEXAGON.md. Same CLI protocol as task agents.
 */
export class SoloSession extends EventEmitter {
  readonly status: SessionStatus;
  private inbox: Injected[] = [];
  private nextMsg = 1;
  private finished = false;
  private abort = new AbortController();
  private started = false;
  allow: string[] = [];

  constructor(
    readonly id: string,
    readonly role: Role,
    private adapter: AgentAdapter,
    private opts: {
      cwd: string;
      effort: Effort;
      system: string;
      env: Record<string, string>;
      allowCommands: string[];
      /** Extra validation before `hexagon done` is accepted (e.g. plan-check). */
      validate?: () => Reply;
      nextQuestionId: () => string;
    },
  ) {
    super();
    this.status = {
      id, role, agent: adapter.id, state: "running", activity: "starting", question: null, cost_usd: 0,
      summary: null, error: null, feed: [], session_id: randomUUID(),
    };
  }

  private changed() {
    this.emit("status", this.status);
  }

  private log(kind: SessionStatus["feed"][number]["kind"], text: string) {
    this.status.feed.push({ ts: nowIso(), kind, text });
    if (this.status.feed.length > 300) this.status.feed.splice(0, this.status.feed.length - 300);
  }

  private onEvent(e: AgentEvent) {
    switch (e.type) {
      case "progress": this.status.activity = e.text; this.log("text", e.text); break;
      case "chat":
        this.status.activity = e.text.split("\n").find((l) => l.trim()) ?? "";
        this.log(e.from === "agent" ? "agent" : "user", e.text);
        break;
      case "tool_call": this.status.activity = e.summary; this.log("tool", e.summary); break;
      case "tool_result": if (!e.ok) this.log("error", e.summary); break;
      case "status_report": if (e.activity) { this.status.activity = e.activity; this.log("status", e.activity); } break;
      case "usage": this.status.cost_usd = Math.round((this.status.cost_usd + e.cost_usd) * 1e6) / 1e6; break;
      default: return;
    }
    this.changed();
  }

  api(): AgentApi & { plan_check?: () => Reply } {
    return {
      report: (r) => { this.onEvent({ type: "status_report", activity: r.activity, phase: r.phase }); return { ok: true, message: "ok" }; },
      ask: (a) => {
        const options = (a.options ?? []).map((label, i) => ({ id: String(i + 1), label }));
        this.status.question = {
          question_id: this.opts.nextQuestionId(), kind: options.length ? "choice" : "clarification", blocking: true,
          prompt: a.prompt, options, default_option: null, auto_answer_after_s: null, asked_at: nowIso(),
        };
        this.status.state = "waiting_input";
        this.log("status", `asks: ${a.prompt}`);
        this.changed();
        return { ok: true, message: `Question ${this.status.question.question_id} was sent to the user. End your turn now; the answer will arrive as your next message.` };
      },
      note: () => ({ ok: true, message: "ok" }),
      done: (d) => {
        const v = this.opts.validate?.();
        if (v && !v.ok) return v;
        this.status.summary = d.summary ?? "";
        this.allow = d.allow ?? [];
        this.finished = true;
        this.changed();
        return { ok: true, message: "Done. End your turn now." };
      },
      review: () => ({ ok: false, message: "not available" }),
      plan_check: this.opts.validate ? () => this.opts.validate!() : undefined,
    };
  }

  /** User reply: answers the open question or adds an instruction. */
  say(text: string): void {
    const q = this.status.question;
    let body = text;
    if (q) {
      const opt = q.options?.find((o) => o.id === text.trim() || o.label.toLowerCase() === text.trim().toLowerCase());
      body = `Answer to ${q.question_id} ("${q.prompt}"): ${opt ? opt.label : text}`;
      this.status.question = null;
      this.status.state = "running";
    }
    this.log("user", text);
    this.inbox.push({ id: `S-${this.nextMsg++}`, from: "user", type: q ? "answer" : "instruction", body });
    this.changed();
    this.emit("inbox");
  }

  cancel(): void {
    this.status.state = "cancelled";
    this.abort.abort();
    this.changed();
  }

  /** Run (or continue, with `followUp`) the session until the agent reports done. */
  async run(prompt: string, followUp?: string): Promise<AdapterOutcome> {
    this.finished = false;
    this.status.state = "running";
    this.status.error = null;
    this.abort = new AbortController();
    this.changed();
    const host: AgentHost = {
      emit: (e) => this.onEvent(e),
      drainInbox: () => this.inbox.splice(0),
      onInbox: (cb) => { this.on("inbox", cb); return () => this.off("inbox", cb); },
      received: () => undefined,
      isFinished: () => this.finished,
      hasBlockingQuestion: () => this.status.question !== null,
    };
    const out = await this.adapter.run({
      agentRunId: this.id,
      role: this.role,
      effort: this.opts.effort,
      cwd: this.opts.cwd,
      system: this.opts.system,
      prompt,
      followUp,
      sessionId: this.status.session_id,
      resume: this.started,
      env: this.opts.env,
      allowCommands: this.opts.allowCommands,
      readOnly: false,
      host,
      api: this.api(),
      signal: this.abort.signal,
    });
    if (out.kind !== "error") this.started = true;
    if ((this.status.state as SessionStatus["state"]) === "cancelled") return out;
    if (out.kind === "error") {
      this.status.state = "failed";
      this.status.error = out.error?.message ?? "failed";
      this.log("error", this.status.error);
    } else if (!this.finished) {
      this.status.state = "failed";
      this.status.error = "the agent stopped without running `hexagon done`";
    } else {
      this.status.state = "done";
    }
    this.changed();
    return out;
  }

  get done(): boolean {
    return this.finished;
  }
}
