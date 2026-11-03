import type { AgentEvent, Effort, ErrorKind, Phase, ResultEnvelope, ReviewVerdict, Role, Task } from "../contracts/types.js";
import type { Spec } from "../core/spec.js";
import type { AdapterDiscovery, AdapterIdentity } from "./contracts/adapter.js";

/** A message to inject into an agent's conversation. */
export interface Injected {
  id: string;
  from: string;
  type: string;
  body: string;
}

/**
 * What an agent can tell Hexagon. CLI agents reach it by running `hexagon report|ask|note|done|review`
 * (the daemon routes the call here); the mock adapter calls it directly.
 */
export interface AgentApi {
  report(r: { activity?: string; phase?: Phase; done?: string[] }): Reply;
  ask(q: { prompt: string; options?: string[]; default?: string; blocking: boolean }): Reply;
  note(body: string): Reply;
  done(r: Partial<ResultEnvelope> & { allow?: string[] }): Reply;
  review(v: ReviewVerdict): Reply;
  /** Send a defect back to the task that owns the code (`hexagon return T-1 "…"`). */
  return?(r: { task: string; issue: string }): Reply;
  /** `hexagon bus send|read|subscribe` (task agents in a run). */
  bus?(r: Record<string, unknown>): Reply;
  /** `hexagon brief write|append|check|show`: the per-task brief (task agents in a run). */
  brief?(r: Record<string, unknown>): Reply;
}

export interface Reply { ok: boolean; message: string }

/** Supervisor side of a running adapter. */
export interface AgentHost {
  emit(event: AgentEvent): void;
  /** Take queued messages (marks them delivered). */
  drainInbox(): Injected[];
  /** Called when new messages are queued; returns an unsubscribe function. */
  onInbox(cb: () => void): () => void;
  /** The agent confirmed it received a message (replayed by the CLI). */
  received(messageId: string): void;
  isFinished(): boolean;
  hasBlockingQuestion(): boolean;
}

export interface AgentRunContext {
  agentRunId: string;
  role: Role;
  task?: Task;
  effort: Effort;
  cwd: string;
  /** Role prompt + skills + protocol + project context, appended to the CLI's own system prompt. */
  system: string;
  /** First user message (task card) for a new session. */
  prompt: string;
  /** User message when resuming an existing session (fix loop, hand-back, resume after pause). */
  followUp?: string;
  /** `followUp` is the card of a task new to this (resumed) session, not an instruction about earlier work. */
  freshTask?: boolean;
  /** Stable conversation id; `resume` continues it. */
  sessionId: string;
  resume: boolean;
  /** The CLI's own session id as stored by Hexagon (null until the CLI reported one). */
  handle?: string | null;
  env: Record<string, string>;
  /** Shell commands the agent may run (prefixes). "*" = anything. */
  allowCommands: string[];
  readOnly: boolean;
  /** The same limits as one object, built by the core; an adapter projects it onto its CLI (see contracts/policy.ts). */
  policy?: import("./contracts/policy.js").RunPolicy;
  /** Chat session: never nudged to finish; stays open for the next message. */
  conversational?: boolean;
  host: AgentHost;
  api: AgentApi;
  /** Security policy for this execution (same for first run, retries after limits, and failover). */
  /** Aborting ends the process; the outcome is "interrupted". */
  signal: AbortSignal;
  specs?: Spec[];
}

export interface AdapterOutcome {
  kind: "finished" | "interrupted" | "error";
  error?: { kind: ErrorKind; message: string; retryable: boolean; raw?: string };
}

export interface AgentAdapter extends AdapterIdentity, AdapterDiscovery {
  /** The user's explicit override (null = the CLI picks; nothing is passed). Not the runtime model. */
  readonly model: string | null;
  readonly supportsLiveInput: boolean;
  readonly security: import("./contracts/capabilities.js").SecurityCapabilities;
  run(ctx: AgentRunContext): Promise<AdapterOutcome>;
  /** Command that opens the agent's session interactively (takeover), if the CLI supports it. */
  takeoverCommand(sessionId: string): string[] | null;
}

export function formatInjected(msgs: Injected[]): string {
  return msgs
    .map((m) =>
      m.from === "user"
        ? `<user_message id="${m.id}" type="${m.type}">\n${m.body}\n</user_message>`
        : `<hexagon_message id="${m.id}" from="${m.from}" type="${m.type}">\n${m.body}\n</hexagon_message>`,
    )
    .join("\n");
}

export const MESSAGE_ID_RE = /<(?:user|hexagon)_message id="(M-\d+)"/g;
