// Contract types. JSON Schemas in /schemas are the source of truth; these mirror them.

/** A role id from the registry (src/core/roles.ts) or a custom role defined in config.toml. */
export type Role = string;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentState =
  | "queued" | "preparing" | "working" | "waiting_input" | "paused" | "waiting_quota"
  | "verifying" | "reviewing" | "fixing" | "integrating"
  | "done" | "failed" | "blocked" | "cancelled";

/** State names written by Hexagon before the lifecycle was named after its stages; read from old status files. */
export const LEGACY_STATES: Readonly<Record<string, AgentState>> = { starting: "preparing", running: "working", merging: "integrating" };
export const canonicalState = (s: string): AgentState => LEGACY_STATES[s] ?? (s as AgentState);

export const TERMINAL_STATES: ReadonlySet<AgentState> = new Set(["done", "failed", "blocked", "cancelled"]);

export type Phase = "reading" | "planning" | "editing" | "testing" | "reporting";
export type ChecklistStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";

export type ErrorKind =
  | "transient" | "refusal" | "truncated" | "invalid_output" | "verify_failed"
  | "scope_violation" | "stuck" | "needs_spec_change" | "internal";

export interface QuestionOption { id: string; label: string }

export interface NeedsInput {
  question_id: string;
  kind: "clarification" | "choice" | "approval" | "spec_change";
  blocking: boolean;
  prompt: string;
  options?: QuestionOption[];
  default_option?: string | null;
  auto_answer_after_s?: number | null;
  asked_at: string;
  refs?: string[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  wall_ms: number;
  turns: number;
}

export type TokenCause = "prompt" | "fix_loop" | "review" | "compaction";
export interface TokenCounts { input: number; cache_read: number; output: number }

export interface SessionInfo {
  /** Agent identity that owns the session (e.g. developer-1). */
  agent: string;
  mode: "new" | "resumed";
  /** Why a new session was created (null when resumed). */
  reason: string | null;
  turns: number;
  ctx_tokens: number;
  /** Share of the model window in use (0..1). */
  ctx_pct: number;
  compactions: number;
}

export interface AgentStatus {
  schema: "hexagon.agent-status/v1";
  seq: number;
  updated_at: string;
  heartbeat_at: string;
  run_id: string;
  agent_run_id: string;
  task_id: string;
  attempt: number;
  role: Role;
  agent: {
    id: string; provider: string; model?: string | null; effort?: Effort | null;
    /** Adapter id from the integration registry. */
    adapter?: string | null;
    /** "cli-default" (no override passed) | "custom" | "discovered". */
    model_mode?: "cli-default" | "custom" | "discovered" | null;
    /** What the running process reported about itself; null = not reported (never assumed). */
    runtime_model?: string | null;
    cli_version?: string | null;
  };
  state: AgentState;
  state_reason?: string | null;
  state_since: string;
  controller: "agent" | "user" | "none";
  phase?: Phase | null;
  activity?: string | null;
  progress?: { done: number; total: number; unit?: string } | null;
  checklist?: { id: string; label?: string; status: ChecklistStatus }[];
  needs_input: NeedsInput | null;
  inbox: { pending: number; last_delivered?: string | null; last_acked?: string | null };
  workspace?: { worktree?: string; branch?: string } | null;
  files_touched?: string[];
  attach?: { native_session_id?: string | null; takeover_command?: string[] | null; supports_live_input?: boolean } | null;
  usage: Usage;
  /** Tokens by what caused them (prompt, tool results, fix loop, review, compaction). */
  usage_by_cause?: Partial<Record<TokenCause, TokenCounts>>;
  /** The logical agent session this attempt runs in (shared across tasks of one agent identity). */
  session?: SessionInfo | null;
  last_error: { kind: ErrorKind; message: string; retryable: boolean; at?: string } | null;
  /** Provider limit recovery (rate limit / quota wait). Does not count as a fix cycle or attempt. */
  recovery?: {
    cls: string; status: "waiting" | "resuming" | "recovered" | "blocked";
    next_retry_at?: string | null; reset_source?: "provider" | "estimate" | null;
    waits: number; waited_s: number; message: string; history: { at: string; what: string }[];
  } | null;
  /** Quality repair cycle (verify/review rounds) this run is in. */
  fix_cycle?: number;
  result_path: string | null;
}

export interface RunStatus {
  schema: "hexagon.run-status/v1";
  run_id: string;
  updated_at: string;
  state: "running" | "paused" | "done" | "aborted";
  plan_path: string;
  integration_branch: string;
  base_branch: string;
  started_at: string;
  budget_tokens: number | null;
  totals: Usage;
  /** Tokens of the whole run by cause (prompt, fix loop, review, compaction). */
  ledger?: Partial<Record<TokenCause, TokenCounts>>;
  /** Agent bus: counts, who waits for whom, the latest messages. */
  bus?: {
    total: number; by_kind: Record<string, number>; by_state: Record<string, number>;
    waiting: { from: string; for: string }[];
    recent: { id: string; kind: string; from: string; to: string; subject: string; state: string; size: number }[];
  };
  counts: Partial<Record<AgentState, number>>;
  agents: {
    task_id: string; agent_run_id: string; role: Role; agent: string; state: AgentState;
    activity: string | null; needs_input: boolean; progress: AgentStatus["progress"] | null; cost_usd: number; tokens: number;
  }[];
  attention: { kind: "question" | "failure" | "blocked" | "budget" | "stale"; task_id: string | null; text: string; ref?: string }[];
}

export type PartyKind = "user" | "agent" | "role" | "orchestrator" | "blackboard" | "broadcast" | "lead";
export interface Party { kind: PartyKind; id?: string | null }

export type MessageType = "instruction" | "question" | "answer" | "note" | "request" | "handoff" | "notify" | "ack" | "decision" | "finding";
export type DeliveryState = "queued" | "delivered" | "acked" | "expired" | "rejected";

export interface Message {
  schema: "hexagon.message/v1";
  id: string;
  ts: string;
  run_id: string;
  thread_id?: string | null;
  from: Party;
  to: Party;
  type: MessageType;
  body: string;
  question?: NeedsInput | null;
  refs?: string[];
  reply_to?: string | null;
  priority?: "low" | "normal" | "urgent";
  requires_ack?: boolean;
  /** Envelope on the agent bus (bus.jsonl) this message carries. */
  bus_id?: string;
  delivery: { state: DeliveryState; delivered_at?: string | null; acked_at?: string | null; reason?: string | null };
}

export interface Task {
  id: string;
  title: string;
  role: Role;
  requirements: string[];
  acceptance: string[];
  depends_on: string[];
  files: { write: string[]; read: string[] };
  skills: string[];
  definition_of_done: string[];
  verify: string[]; // shell commands the orchestrator re-runs
  /** Why this task has no verify command (docs, config). Shown to the user at approval. */
  verify_exempt?: string;
  estimate?: { size?: string; risk?: string };
  agent_hint?: string | null;
  description?: string;
}

export interface Plan {
  schema: "hexagon.plan/v1";
  id: string;
  created_at: string;
  specs: string[];
  tasks: Task[];
  spec_issues: string[];
}

export interface ResultEnvelope {
  task_id: string;
  status: "completed" | "blocked" | "failed" | "needs_spec_change";
  summary: string;
  files_changed: string[];
  acceptance_evidence: { ac: string; evidence: string; /** set by Hexagon only */ verified: boolean; /** why it is verified or only claimed */ basis?: string }[];
  commands_run: { cmd: string; exit_code: number }[];
  blockers: string[];
  spec_issues: string[];
  assumptions: { text: string; question_id?: string | null }[];
  follow_ups: string[];
  /** Deleted, skipped or weakened tests found by Hexagon (not the agent). Flags for the reviewer, never an automatic failure. */
  test_integrity?: { kind: string; file: string; detail: string }[];
}

export interface ReviewVerdict {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: { file?: string; line?: number; severity: "high" | "medium" | "low"; ac?: string; issue: string; suggestion?: string }[];
}

/** Events folded by the supervisor into status.json and appended to events.jsonl. */
export type AgentEvent =
  | { type: "state"; state: AgentState; reason?: string | null }
  | { type: "progress"; text: string }
  /** The agent CLI refused a tool call that needs approval (e.g. a command outside allow_commands). */
  | { type: "permission_denied"; tool: string; command: string }
  /** A command the agent ran isn't installed (exit 127 / "command not found"). */
  | { type: "tool_missing"; command: string }
  /** Conversation: what the agent said, what you sent it, what Hexagon told it. */
  | { type: "chat"; from: "agent" | "user" | "hexagon"; text: string; message_id?: string }
  | { type: "status_report"; phase?: Phase; activity?: string; checklist?: { id: string; label?: string; status: ChecklistStatus }[] }
  | { type: "tool_call"; name: string; summary: string }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  /** Token usage. `step`: one model call (counts as a turn); otherwise a correction (e.g. cost only). */
  | { type: "usage"; input: number; output: number; cache_read: number; cache_write: number; cost_usd: number; step?: boolean; cause?: TokenCause }
  /** The session this attempt runs in: created, resumed, or compacted. Emitted only when something really happened. */
  | { type: "session"; info: SessionInfo }
  | { type: "question"; question: NeedsInput }
  | { type: "answered"; question_id: string; answer: string }
  | { type: "message_delivered"; message_id: string }
  | { type: "message_acked"; message_id: string }
  | { type: "files"; files: string[] }
  | { type: "error"; kind: ErrorKind; message: string; retryable: boolean }
  | { type: "controller"; controller: "agent" | "user" | "none" }
  /** The CLI reported the model actually serving this execution. */
  | { type: "model"; model: string }
  | { type: "cli_info"; version: string | null }
  | { type: "fix_cycle"; n: number }
  /** Provider-limit recovery lifecycle. */
  | { type: "recovery"; phase: "waiting" | "resumed" | "blocked" | "compacted" | "failover"; cls: string; message: string; next_retry_at?: string | null; reset_source?: "provider" | "estimate" | null }
  | { type: "result"; path: string };

export interface StampedEvent { ts: string; run_id: string; agent_run_id: string; task_id: string; event: AgentEvent }
