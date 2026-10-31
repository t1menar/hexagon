import type { AgentEvent, Effort, ErrorKind, Role, Task } from "../contracts/types.js";

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolOutcome {
  content: string;
  is_error?: boolean;
}

/** A user/orchestrator message to inject into an agent's context at a safe point. */
export interface Injected {
  id: string;
  from: string;
  type: string;
  body: string;
}

/**
 * Everything an adapter may do to the outside world goes through the host:
 * tools, inbox draining, and status events. The supervisor implements it.
 */
export interface ToolHost {
  readonly tools: ToolSpec[];
  execute(name: string, input: unknown): Promise<ToolOutcome>;
  /** Called at safe points (between turns). Returns queued messages, now marked delivered. */
  drainInbox(): Injected[];
  /** True once the role's submit_* tool succeeded. */
  isFinished(): boolean;
  emit(event: AgentEvent): void;
}

export interface AgentRunContext {
  role: Role;
  task?: Task;
  effort: Effort;
  cwd: string;
  /** Stable system layers (role prompt, skills, project context) — cache-friendly order. */
  system: string[];
  /** First user message (task card) — used when there is no session yet. */
  firstMessage: string;
  /** Extra user message when continuing a session (fix loop, hand-back). */
  followUp?: string;
  host: ToolHost;
  signal: AbortSignal;
  /** Adapter-owned conversation state from an earlier run of the same attempt. */
  session?: unknown;
  maxTurns: number;
  /** Parsed specs (planner input; also used by the offline mock adapter). */
  specs?: import("../core/spec.js").Spec[];
}

export interface AdapterOutcome {
  kind: "finished" | "error";
  error?: { kind: ErrorKind; message: string; retryable: boolean };
  session?: unknown;
}

export interface AgentAdapter {
  readonly id: string;
  readonly provider: string;
  readonly model: string | null;
  readonly supportsLiveInput: boolean;
  run(ctx: AgentRunContext): Promise<AdapterOutcome>;
}

export function formatInjected(msgs: Injected[]): string {
  return msgs
    .map((m) =>
      m.from === "user"
        ? `<user_message id="${m.id}" type="${m.type}">\n${m.body}\n</user_message>`
        : `<agent_note id="${m.id}" from="${m.from}" type="${m.type}">\n${m.body}\n</agent_note>`,
    )
    .join("\n");
}
