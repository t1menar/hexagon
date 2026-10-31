// Contract types. JSON Schemas in /schemas are the source of truth; these mirror them.

export type Role = "planner" | "implementer" | "tester" | "reviewer" | "integrator" | "resolver" | "lead" | "init";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentState =
  | "queued" | "starting" | "running" | "waiting_input" | "paused"
  | "verifying" | "reviewing" | "merging"
  | "done" | "failed" | "blocked" | "cancelled";

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
  agent: { id: string; provider: string; model?: string | null; effort?: Effort | null };
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
  last_error: { kind: ErrorKind; message: string; retryable: boolean; at?: string } | null;
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
  counts: Partial<Record<AgentState, number>>;
  agents: {
    task_id: string; agent_run_id: string; role: Role; agent: string; state: AgentState;
    activity: string | null; needs_input: boolean; progress: AgentStatus["progress"] | null; cost_usd: number; tokens: number;
  }[];
  attention: { kind: "question" | "failure" | "blocked" | "budget" | "stale"; task_id: string | null; text: string; ref?: string }[];
}

export type PartyKind = "user" | "agent" | "role" | "orchestrator" | "blackboard" | "broadcast" | "lead";
export interface Party { kind: PartyKind; id?: string | null }

export type MessageType = "instruction" | "question" | "answer" | "note" | "request" | "handoff" | "notify" | "ack";
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
  acceptance_evidence: { ac: string; evidence: string; verified: boolean }[];
  commands_run: { cmd: string; exit_code: number }[];
  blockers: string[];
  spec_issues: string[];
  assumptions: { text: string; question_id?: string | null }[];
  follow_ups: string[];
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
  /** Conversation: what the agent said, what you sent it, what Hexagon told it. */
  | { type: "chat"; from: "agent" | "user" | "hexagon"; text: string; message_id?: string }
  | { type: "status_report"; phase?: Phase; activity?: string; checklist?: { id: string; label?: string; status: ChecklistStatus }[] }
  | { type: "tool_call"; name: string; summary: string }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  /** Token usage. `step`: one model call (counts as a turn); otherwise a correction (e.g. cost only). */
  | { type: "usage"; input: number; output: number; cache_read: number; cache_write: number; cost_usd: number; step?: boolean }
  | { type: "question"; question: NeedsInput }
  | { type: "answered"; question_id: string; answer: string }
  | { type: "message_delivered"; message_id: string }
  | { type: "message_acked"; message_id: string }
  | { type: "files"; files: string[] }
  | { type: "error"; kind: ErrorKind; message: string; retryable: boolean }
  | { type: "controller"; controller: "agent" | "user" | "none" }
  | { type: "result"; path: string };

export interface StampedEvent { ts: string; run_id: string; agent_run_id: string; task_id: string; event: AgentEvent }
