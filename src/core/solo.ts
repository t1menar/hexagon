import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentEvent, Effort, NeedsInput, Role, SessionInfo } from "../contracts/types.js";
import type { SessionRegistry } from "./sessions.js";
import type { AdapterOutcome, AgentAdapter, AgentApi, AgentHost, Injected, Reply } from "../agents/types.js";
import { nowIso } from "../util/fsx.js";

/** Live snapshot of a run-less agent session (planner, init) for the UI. */
export interface SessionStatus {
  id: string;
  role: Role;
  agent: string;
  /** idle: a chat session waiting for your next message. */
  state: "running" | "waiting_input" | "idle" | "done" | "failed" | "cancelled";
  activity: string | null;
  question: NeedsInput | null;
  cost_usd: number;
  tokens: { input: number; cache_read: number; output: number; steps: number };
  /** Status the agent finished with (`hexagon done --status …`). */
  result_status: string | null;
  summary: string | null;
  error: string | null;
  feed: { ts: string; text: string; kind: "tool" | "text" | "status" | "error" | "user" | "agent" | "usage"; tokens?: { input: number; cache_read: number; output: number } }[];
  /** Lines ever appended to `feed` (it keeps only the last FEED_MAX): lets a reader tell what it has already seen. */
  feed_seq: number;
  /** In a push: `feed` holds only the lines added since the previous push, ending at `feed_seq`. */
  feed_delta?: boolean;
  session_id: string;
  /** The agent identity's session: new or resumed, turn count and context size. */
  session?: SessionInfo;
}

export const FEED_MAX = 400;

/**
 * What to push for a session: the whole status the first time (or after a restart of the session), then the status
 * with only the feed lines added since `sentSeq`. A status carries up to 400 lines; sending them with every tool call
 * made each event ~40 KB.
 */
export function sessionPush(st: SessionStatus, sentSeq: number | undefined): SessionStatus {
  if (sentSeq === undefined || st.feed_seq < sentSeq) return st;
  const fresh = Math.min(st.feed.length, st.feed_seq - sentSeq);
  return { ...st, feed: fresh ? st.feed.slice(-fresh) : [], feed_delta: true };
}

/** Apply a pushed status to what the reader holds. `gap` = lines were missed: fetch the full status again. */
export function mergeSession(cur: SessionStatus | undefined, push: SessionStatus): { status: SessionStatus; gap: boolean } {
  if (!push.feed_delta) return { status: push, gap: false };
  if (!cur) return { status: { ...push, feed_delta: undefined }, gap: true };
  if (push.feed_seq < cur.feed_seq) return { status: { ...push, feed_delta: undefined }, gap: true }; // the session was restarted
  const first = push.feed_seq - push.feed.length; // seq just before the first line of the push
  if (first > cur.feed_seq) return { status: { ...cur, ...push, feed: cur.feed, feed_seq: cur.feed_seq, feed_delta: undefined }, gap: true };
  const skip = Math.max(0, cur.feed_seq - first);
  const feed = [...cur.feed, ...push.feed.slice(skip)].slice(-FEED_MAX);
  return { status: { ...push, feed, feed_delta: undefined }, gap: false };
}

/** Feed lines of `st` that come after sequence number `seq`. */
export function feedAfter(st: SessionStatus, seq: number): SessionStatus["feed"] {
  const n = Math.max(0, Math.min(st.feed.length, st.feed_seq - seq));
  return n ? st.feed.slice(-n) : [];
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
  private restartNote: string | null = null;

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
      /** Extra validation before `hexagon done` (status completed) is accepted (e.g. plan-check). */
      validate?: () => Reply;
      /** Chat session (the lead): stays open between messages, never "done". */
      conversational?: boolean;
      readOnly?: boolean;
      /** One session per agent identity for the whole project (shared with task agents' registry). */
      sessions?: SessionRegistry;
      promptHash?: string;
      windowTokens?: number;
      nextQuestionId: () => string;
    },
  ) {
    super();
    this.status = {
      id, role, agent: adapter.id, state: "running", activity: "starting", question: null, cost_usd: 0,
      tokens: { input: 0, cache_read: 0, output: 0, steps: 0 }, result_status: null, summary: null, error: null, feed: [], feed_seq: 0, session_id: randomUUID(),
    };
  }

  private changed() {
    this.emit("status", this.status);
  }

  private log(kind: SessionStatus["feed"][number]["kind"], text: string, tokens?: SessionStatus["feed"][number]["tokens"]) {
    this.status.feed.push({ ts: nowIso(), kind, text, ...(tokens ? { tokens } : {}) });
    this.status.feed_seq++;
    if (this.status.feed.length > FEED_MAX) this.status.feed.splice(0, this.status.feed.length - FEED_MAX);
  }

  private onEvent(e: AgentEvent) {
    switch (e.type) {
      case "session_handle":
        this.opts.sessions?.setHandle(this.id, e.handle);
        return;
      case "progress":
        // Fires on every CLI start, resumed or not: it only confirms the session exists.
        if (e.text === "session started") { this.opts.sessions?.confirm(this.id); return; }
        if (this.opts.conversational && e.text === "ready") {
          if (this.status.state === "running") this.status.state = "idle";
          this.status.activity = null;
          break;
        }
        this.status.activity = e.text; this.log("text", e.text); break;
      case "chat":
        this.status.activity = e.text.split("\n").find((l) => l.trim()) ?? "";
        this.log(e.from === "agent" ? "agent" : "user", e.text);
        break;
      case "tool_call": this.status.activity = e.summary; this.log("tool", e.summary); break;
      case "tool_result": if (!e.ok) this.log("error", e.summary); break;
      case "permission_denied": this.emit("permission", e.command, e.tool); return;
      case "tool_missing": this.emit("missing", e.command); return;
      case "status_report": if (e.activity) { this.status.activity = e.activity; this.log("status", e.activity); } break;
      case "usage": {
        this.status.cost_usd = Math.round((this.status.cost_usd + e.cost_usd) * 1e6) / 1e6;
        if (e.window) this.opts.sessions?.setWindow(this.id, e.window);
        if (!e.step) break;
        const t = this.status.tokens;
        t.input += e.input; t.cache_read += e.cache_read; t.output += e.output; t.steps += 1;
        if (this.opts.sessions) {
          this.opts.sessions.recordUsage(this.id, { input: e.input, cache_read: e.cache_read, output: e.output, cause: e.cause ?? "prompt", step: true });
          this.status.session = this.opts.sessions.info(this.id, this.status.session?.mode ?? "resumed", this.status.session?.reason ?? null, this.opts.windowTokens ?? 200_000);
        }
        this.log("usage", "", { input: e.input, cache_read: e.cache_read, output: e.output });
        break;
      }
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
        // An agent may always stop as blocked/failed; only a "completed" result must validate.
        const status = d.status ?? "completed";
        if (status === "completed") {
          const v = this.opts.validate?.();
          if (v && !v.ok) return v;
        }
        this.status.result_status = status;
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
  say(text: string, context = ""): void {
    const q = this.status.question;
    let body = context ? `${context}\n${text}` : text;
    if (q) {
      const opt = q.options?.find((o) => o.id === text.trim() || o.label.toLowerCase() === text.trim().toLowerCase());
      body = `Answer to ${q.question_id} ("${q.prompt}"): ${opt ? opt.label : text}`;
      this.status.question = null;
      this.status.state = "running";
    }
    if (this.status.state === "idle") this.status.state = "running";
    this.log("user", text);
    this.inbox.push({ id: `S-${this.nextMsg++}`, from: "user", type: q ? "answer" : "instruction", body });
    this.changed();
    this.emit("inbox");
  }

  /** Record your message in the transcript (used when it starts a new run of the session). */
  logUser(text: string): void {
    this.log("user", text);
    this.changed();
  }

  get alive(): boolean {
    return ["running", "waiting_input", "idle"].includes(this.status.state);
  }

  get allowCommands(): string[] {
    return this.opts.allowCommands;
  }

  /** Restart the CLI process in the same session (new permissions apply), with `note` as the next message. */
  restart(note: string, allowCommands: string[]): boolean {
    this.opts.allowCommands = allowCommands;
    if (!this.alive) return false;
    this.restartNote = note;
    if (this.status.state === "idle") this.status.state = "running";
    this.abort.abort();
    this.changed();
    return true;
  }

  /** A message from Hexagon (not shown as the user's). */
  inject(body: string): void {
    this.inbox.push({ id: `S-${this.nextMsg++}`, from: "orchestrator", type: "instruction", body });
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
    let fu = followUp;
    let out: AdapterOutcome;
    for (;;) {
    const cap = this.adapter.capabilities;
    const res = this.opts.sessions?.resolve({
      agentId: this.id, role: this.role, adapterId: this.adapter.adapterId, model: this.adapter.model, promptHash: this.opts.promptHash ?? "",
      cwd: this.opts.cwd, resumeAcrossCwd: cap.resumeAcrossCwd, supportsResume: cap.supportsSessionResume,
    });
    if (res) {
      this.status.session_id = res.sessionId;
      this.status.session = this.opts.sessions!.info(this.id, res.mode, res.reason, this.opts.windowTokens ?? 200_000);
      this.changed();
    }
    out = await this.adapter.run({
      agentRunId: this.id,
      role: this.role,
      effort: this.opts.effort,
      cwd: this.opts.cwd,
      system: this.opts.system,
      prompt,
      followUp: fu,
      sessionId: this.status.session_id,
      resume: res ? res.resume : this.started,
      handle: res?.record.nativeHandle ?? null,
      env: this.opts.env,
      allowCommands: this.opts.allowCommands,
      readOnly: this.opts.readOnly ?? false,
      conversational: this.opts.conversational,
      host,
      api: this.api(),
      signal: this.abort.signal,
    });
    if (out.kind !== "error") { this.started = true; this.opts.sessions?.confirm(this.id); }
    if (this.restartNote !== null && (this.status.state as SessionStatus["state"]) !== "cancelled") {
      fu = this.restartNote;
      this.restartNote = null;
      this.abort = new AbortController();
      continue;
    }
    break;
    }
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
