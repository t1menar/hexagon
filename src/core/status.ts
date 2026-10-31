import { EventEmitter } from "node:events";
import path from "node:path";
import type {
  AgentEvent, AgentState, AgentStatus, Effort, Role, RunStatus, StampedEvent, Task, Usage,
} from "../contracts/types.js";
import { TERMINAL_STATES } from "../contracts/types.js";
import { appendJsonl, atomicWriteJson, nowIso } from "../util/fsx.js";
import type { RunPaths } from "./project.js";

export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 30_000;

const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, wall_ms: 0, turns: 0 });

export interface NewAgentRun {
  task: Task;
  attempt: number;
  role: Role;
  agent: { id: string; provider: string; model?: string | null; effort?: Effort | null };
  supportsLiveInput: boolean;
}

/**
 * Single writer for status.json files of one run. Every change is an AgentEvent:
 * it is appended to events.jsonl (run + agent level), folded into the snapshot,
 * and the snapshot is written atomically with a monotonic seq.
 */
export class StatusStore extends EventEmitter {
  private agents = new Map<string, AgentStatus>();
  private startedAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private extraAttention: RunStatus["attention"] = [];
  runState: RunStatus["state"] = "running";

  constructor(
    readonly paths: RunPaths,
    readonly runId: string,
    readonly meta: { plan_path: string; integration_branch: string; base_branch: string; budget_usd: number | null },
  ) {
    super();
  }

  startHeartbeat(): void {
    this.timer ??= setInterval(() => this.beat(), HEARTBEAT_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  create(n: NewAgentRun): AgentStatus {
    const agent_run_id = `${n.task.id}-a${n.attempt}`;
    const now = nowIso();
    const s: AgentStatus = {
      schema: "hexagon.agent-status/v1",
      seq: 0,
      updated_at: now,
      heartbeat_at: now,
      run_id: this.runId,
      agent_run_id,
      task_id: n.task.id,
      attempt: n.attempt,
      role: n.role,
      agent: { id: n.agent.id, provider: n.agent.provider, model: n.agent.model ?? null, effort: n.agent.effort ?? null },
      state: "queued",
      state_reason: null,
      state_since: now,
      controller: "none",
      phase: null,
      activity: null,
      progress: n.task.acceptance.length ? { done: 0, total: n.task.acceptance.length, unit: "acceptance criteria" } : null,
      checklist: n.task.acceptance.map((id) => ({ id, status: "pending" as const })),
      needs_input: null,
      inbox: { pending: 0, last_delivered: null, last_acked: null },
      workspace: null,
      files_touched: [],
      attach: { native_session_id: null, takeover_command: null, supports_live_input: n.supportsLiveInput },
      usage: emptyUsage(),
      last_error: null,
      result_path: null,
    };
    this.agents.set(agent_run_id, s);
    this.write(s);
    return s;
  }

  get(agentRunId: string): AgentStatus | undefined {
    return this.agents.get(agentRunId);
  }

  /** Latest attempt for a task id. */
  byTask(taskId: string): AgentStatus | undefined {
    let best: AgentStatus | undefined;
    for (const s of this.agents.values()) if (s.task_id === taskId && (!best || s.attempt > best.attempt)) best = s;
    return best;
  }

  all(): AgentStatus[] {
    return [...this.agents.values()];
  }

  /** Mutate fields that are not expressed as events (workspace, inbox counters, attach info). */
  patch(agentRunId: string, fn: (s: AgentStatus) => void): AgentStatus {
    const s = this.must(agentRunId);
    fn(s);
    this.write(s);
    return s;
  }

  apply(agentRunId: string, event: AgentEvent): AgentStatus {
    const s = this.must(agentRunId);
    const now = nowIso();
    switch (event.type) {
      case "state":
        if (s.state !== event.state) {
          if (event.state === "running" && !this.startedAt.has(agentRunId)) this.startedAt.set(agentRunId, Date.now());
          s.state = event.state;
          s.state_since = now;
        }
        s.state_reason = event.reason ?? null;
        if (event.state === "running" && s.controller === "none") s.controller = "agent";
        if (TERMINAL_STATES.has(event.state)) {
          s.controller = "none";
          s.needs_input = null;
          if (event.state === "done") s.activity = null;
        }
        break;
      case "progress":
        s.activity = event.text.slice(0, 200);
        break;
      case "status_report":
        if (event.phase) s.phase = event.phase;
        if (event.activity) s.activity = event.activity.slice(0, 200);
        if (event.checklist) {
          const byId = new Map((s.checklist ?? []).map((i) => [i.id, i]));
          for (const item of event.checklist) byId.set(item.id, { ...byId.get(item.id), ...item });
          s.checklist = [...byId.values()];
          const acs = s.checklist.filter((i) => i.id.startsWith("AC-"));
          if (acs.length) s.progress = { done: acs.filter((i) => i.status === "done").length, total: acs.length, unit: "acceptance criteria" };
        }
        break;
      case "tool_call":
        s.activity = event.summary.slice(0, 200);
        break;
      case "tool_result":
        break;
      case "usage":
        s.usage.input_tokens += event.input;
        s.usage.output_tokens += event.output;
        s.usage.cache_read_tokens += event.cache_read;
        s.usage.cost_usd = round(s.usage.cost_usd + event.cost_usd);
        s.usage.turns += 1;
        break;
      case "question":
        s.needs_input = event.question;
        break;
      case "answered":
        if (s.needs_input?.question_id === event.question_id) s.needs_input = null;
        break;
      case "message_delivered":
        s.inbox.last_delivered = event.message_id;
        s.inbox.pending = Math.max(0, s.inbox.pending - 1);
        break;
      case "message_acked":
        s.inbox.last_acked = event.message_id;
        break;
      case "files":
        s.files_touched = [...new Set([...(s.files_touched ?? []), ...event.files])].sort();
        break;
      case "error":
        s.last_error = { kind: event.kind, message: event.message.slice(0, 2000), retryable: event.retryable, at: now };
        break;
      case "controller":
        s.controller = event.controller;
        break;
      case "result":
        s.result_path = event.path;
        break;
    }
    const started = this.startedAt.get(agentRunId);
    if (started) s.usage.wall_ms = Date.now() - started;

    const stamped: StampedEvent = { ts: now, run_id: this.runId, agent_run_id: agentRunId, task_id: s.task_id, event };
    appendJsonl(this.paths.events, stamped);
    appendJsonl(this.paths.agentEvents(agentRunId), stamped);
    this.write(s);
    this.emit("event", stamped);
    return s;
  }

  setAttention(items: RunStatus["attention"]): void {
    this.extraAttention = items;
    this.writeRun();
  }

  totals(): Usage {
    const t = emptyUsage();
    for (const s of this.agents.values()) {
      t.input_tokens += s.usage.input_tokens;
      t.output_tokens += s.usage.output_tokens;
      t.cache_read_tokens += s.usage.cache_read_tokens;
      t.cost_usd = round(t.cost_usd + s.usage.cost_usd);
      t.turns += s.usage.turns;
      t.wall_ms = Math.max(t.wall_ms, s.usage.wall_ms);
    }
    return t;
  }

  runStatus(): RunStatus {
    const latest = new Map<string, AgentStatus>();
    for (const s of this.agents.values()) {
      const cur = latest.get(s.task_id);
      if (!cur || s.attempt > cur.attempt) latest.set(s.task_id, s);
    }
    const agents = [...latest.values()].sort((a, b) => taskNum(a.task_id) - taskNum(b.task_id));
    const counts: Partial<Record<AgentState, number>> = {};
    for (const s of agents) counts[s.state] = (counts[s.state] ?? 0) + 1;
    const attention: RunStatus["attention"] = [];
    const now = Date.now();
    for (const s of agents) {
      if (s.needs_input) attention.push({ kind: "question", task_id: s.task_id, text: s.needs_input.prompt, ref: s.needs_input.question_id });
      else if (s.state === "failed") attention.push({ kind: "failure", task_id: s.task_id, text: s.last_error?.message ?? "failed" });
      else if (s.state === "blocked") attention.push({ kind: "blocked", task_id: s.task_id, text: s.state_reason ?? s.last_error?.message ?? "blocked" });
      else if (!TERMINAL_STATES.has(s.state) && s.state !== "queued" && now - Date.parse(s.heartbeat_at) > STALE_MS) {
        attention.push({ kind: "stale", task_id: s.task_id, text: "no heartbeat for >30s" });
      }
    }
    return {
      schema: "hexagon.run-status/v1",
      run_id: this.runId,
      updated_at: nowIso(),
      state: this.runState,
      ...this.meta,
      totals: this.totals(),
      counts,
      agents: agents.map((s) => ({
        task_id: s.task_id, agent_run_id: s.agent_run_id, role: s.role, agent: s.agent.id, state: s.state,
        activity: s.activity ?? null, needs_input: Boolean(s.needs_input), progress: s.progress ?? null, cost_usd: s.usage.cost_usd,
      })),
      attention: [...attention, ...this.extraAttention],
    };
  }

  writeRun(): void {
    atomicWriteJson(this.paths.status, this.runStatus());
  }

  private beat(): void {
    const now = nowIso();
    for (const s of this.agents.values()) {
      if (TERMINAL_STATES.has(s.state) || s.state === "queued") continue;
      s.heartbeat_at = now;
      this.write(s);
    }
  }

  private write(s: AgentStatus): void {
    s.seq += 1;
    s.updated_at = nowIso();
    s.heartbeat_at = s.updated_at;
    atomicWriteJson(this.paths.agentStatus(s.agent_run_id), s);
    this.writeRun();
    this.emit("status", s);
  }

  private must(id: string): AgentStatus {
    const s = this.agents.get(id);
    if (!s) throw new Error(`unknown agent run ${id}`);
    return s;
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
export const taskNum = (id: string) => Number(id.replace(/\D/g, "")) || 0;
export const relResult = (paths: RunPaths, agentRunId: string) => path.relative(paths.dir, paths.agentResult(agentRunId));
