import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { Message, MessageType, NeedsInput, Party } from "../contracts/types.js";
import { appendJsonl, nowIso, readJsonl } from "../util/fsx.js";
import type { RunPaths } from "./project.js";

export interface SendInput {
  from: Party;
  to: Party;
  type: MessageType;
  body: string;
  refs?: string[];
  reply_to?: string | null;
  question?: NeedsInput | null;
  requires_ack?: boolean;
  priority?: "low" | "normal" | "urgent";
  thread_id?: string | null;
  bus_id?: string;
}

export interface RouterHooks {
  /** Task ids of agents that are currently active, optionally filtered by role. */
  activeTasks(role?: string): string[];
}

/**
 * Hub-and-spoke message router. Single writer of messages.jsonl: every create and
 * every delivery-state change appends the full message (readers keep the last line per id).
 */
export class MessageRouter extends EventEmitter {
  private messages = new Map<string, Message>();
  private queues = new Map<string, string[]>(); // task id -> message ids awaiting delivery
  private outbound = new Map<string, number>(); // agent task id -> messages sent this run
  private nextId = 1;
  private nextQuestion = 1;

  constructor(
    readonly paths: RunPaths,
    readonly runId: string,
    readonly limits: { max_outbound_per_run: number },
    readonly hooks: RouterHooks,
  ) {
    super();
    for (const m of readJsonl<Message>(paths.messages)) {
      this.messages.set(m.id, m);
      this.nextId = Math.max(this.nextId, Number(m.id.slice(2)) + 1);
      if (m.question) this.nextQuestion = Math.max(this.nextQuestion, Number(m.question.question_id.slice(2)) + 1);
    }
  }

  newQuestionId(): string {
    return `Q-${this.nextQuestion++}`;
  }

  send(input: SendInput): Message[] {
    if (input.from.kind === "agent" && input.from.id && input.type !== "ack") {
      const n = (this.outbound.get(input.from.id) ?? 0) + 1;
      this.outbound.set(input.from.id, n);
      if (n > this.limits.max_outbound_per_run) {
        return [this.persist(this.make(input, input.to, { state: "rejected", reason: `outbound limit ${this.limits.max_outbound_per_run} reached` }))];
      }
    }
    const targets = this.resolve(input.to);
    const out: Message[] = [];
    for (const to of targets) {
      const immediate = to.kind === "user" || to.kind === "blackboard" || to.kind === "orchestrator" || to.kind === "lead";
      const m = this.make(input, to, immediate ? { state: "delivered", delivered_at: nowIso() } : { state: "queued" });
      if (to.kind === "agent" && to.id) {
        const q = this.queues.get(to.id) ?? [];
        q.push(m.id);
        this.queues.set(to.id, q);
      }
      if (to.kind === "blackboard") {
        fs.appendFileSync(this.paths.notes, `- [${m.ts}] ${input.from.id ?? input.from.kind}: ${input.body.replace(/\n/g, " ")}\n`);
      }
      out.push(this.persist(m));
    }
    if (targets.length === 0) {
      out.push(this.persist(this.make(input, input.to, { state: "rejected", reason: "no active recipient" })));
    }
    return out;
  }

  /** Dequeue messages for a task at a safe point, marking them delivered. */
  take(taskId: string): Message[] {
    const ids = this.queues.get(taskId) ?? [];
    this.queues.set(taskId, []);
    const out: Message[] = [];
    for (const id of ids) {
      const m = this.messages.get(id);
      if (!m || m.delivery.state !== "queued") continue;
      m.delivery = { ...m.delivery, state: "delivered", delivered_at: nowIso() };
      out.push(this.persist(m));
    }
    return out;
  }

  pending(taskId: string): number {
    return (this.queues.get(taskId) ?? []).length;
  }

  ack(ids: string[]): Message[] {
    const out: Message[] = [];
    for (const id of ids) {
      const m = this.messages.get(id);
      if (!m || m.delivery.state === "acked") continue;
      m.delivery = { ...m.delivery, state: "acked", acked_at: nowIso() };
      out.push(this.persist(m));
    }
    return out;
  }

  /** Re-queue undelivered messages of a task onto a new attempt (same task id, so a no-op today). */
  expire(taskId: string, reason: string): void {
    for (const id of this.queues.get(taskId) ?? []) {
      const m = this.messages.get(id);
      if (m) {
        m.delivery = { ...m.delivery, state: "expired", reason };
        this.persist(m);
      }
    }
    this.queues.set(taskId, []);
  }

  get(id: string): Message | undefined {
    return this.messages.get(id);
  }

  all(): Message[] {
    return [...this.messages.values()];
  }

  notes(): string {
    return fs.existsSync(this.paths.notes) ? fs.readFileSync(this.paths.notes, "utf8") : "";
  }

  private resolve(to: Party): Party[] {
    switch (to.kind) {
      case "role":
        return this.hooks.activeTasks(to.id ?? undefined).map((id) => ({ kind: "agent", id }));
      case "broadcast":
        return this.hooks.activeTasks().map((id) => ({ kind: "agent", id }));
      case "agent":
        return to.id ? [to] : [];
      default:
        return [to];
    }
  }

  private make(input: SendInput, to: Party, delivery: Message["delivery"]): Message {
    return {
      schema: "hexagon.message/v1",
      id: `M-${this.nextId++}`,
      ts: nowIso(),
      run_id: this.runId,
      thread_id: input.thread_id ?? (to.kind === "agent" ? to.id ?? null : input.from.kind === "agent" ? input.from.id ?? null : null),
      from: input.from,
      to,
      type: input.type,
      body: input.body,
      question: input.question ?? null,
      refs: input.refs ?? [],
      reply_to: input.reply_to ?? null,
      priority: input.priority ?? "normal",
      requires_ack: input.requires_ack ?? input.type === "instruction",
      ...(input.bus_id ? { bus_id: input.bus_id } : {}),
      delivery,
    };
  }

  private persist(m: Message): Message {
    this.messages.set(m.id, m);
    appendJsonl(this.paths.messages, m);
    this.emit("message", m);
    return m;
  }
}
