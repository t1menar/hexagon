import type { AgentStatus, Message, RunStatus, StampedEvent } from "../contracts/types.js";
import { c, fmtTokens, pad, STATE_STYLE, stateLabel } from "../util/term.js";

export function runHeader(rs: RunStatus): string {
  const counts = rs.counts;
  const active = (counts.running ?? 0) + (counts.starting ?? 0) + (counts.verifying ?? 0) + (counts.reviewing ?? 0) + (counts.merging ?? 0);
  const waiting = rs.attention.filter((a) => a.kind === "question").length;
  const spent = rs.totals.input_tokens + rs.totals.cache_read_tokens + rs.totals.output_tokens;
  const budget = rs.budget_tokens ? ` / ${fmtTokens(rs.budget_tokens)}` : "";
  const cache = rs.totals.input_tokens + rs.totals.cache_read_tokens > 0
    ? ` · cache ${Math.round((100 * rs.totals.cache_read_tokens) / (rs.totals.input_tokens + rs.totals.cache_read_tokens))}%`
    : "";
  return `${c.bold("HEXAGON")} ${rs.run_id} · ${rs.state} · ${counts.done ?? 0}/${rs.agents.length} done · ${active} active${waiting ? ` · ${c.orange(`${waiting} need${waiting === 1 ? "s" : ""} you`)}` : ""} · ${fmtTokens(spent)}${budget} tokens (${fmtTokens(rs.totals.output_tokens)} out)${cache}`;
}

export function progressBar(done: number, total: number, width = 24): string {
  if (total <= 0) return "";
  const filled = Math.round((done / total) * width);
  return c.blue("█".repeat(filled)) + c.gray("░".repeat(width - filled));
}

export function runTable(rs: RunStatus, focus?: string | null): string {
  const lines = [runHeader(rs)];
  const done = rs.counts.done ?? 0;
  lines.push(`Progress  ${progressBar(done, rs.agents.length)}  ${done}/${rs.agents.length} tasks`);
  lines.push(c.dim(`  ${pad("TASK", 6)} ${pad("ROLE", 11)} ${pad("AGENT", 10)} ${pad("STATE", 15)} ${pad("ACTIVITY", 44)} TOKENS`));
  for (const a of rs.agents) {
    const mark = focus && a.task_id === focus ? c.inverse("▸") : " ";
    const activity = a.needs_input ? c.orange("needs an answer — /inbox") : (a.activity ?? "");
    lines.push(`${mark} ${pad(a.task_id, 6)} ${pad(a.role, 11)} ${pad(a.agent, 10)} ${pad(stateLabel(a.state), 15)} ${pad(truncate(activity, 44), 44)} ${fmtTokens(a.tokens)}`);
  }
  for (const at of rs.attention.filter((x) => x.kind !== "question")) {
    lines.push(c.orange(`  ! ${at.task_id ?? "run"} ${at.kind}: ${truncate(at.text, 100)}`));
  }
  return lines.join("\n");
}

export function agentDetail(s: AgentStatus): string {
  const lines = [
    `${c.bold(s.task_id)} · ${s.role} · ${s.agent.id}${s.agent.model ? ` (${s.agent.model}${s.agent.effort ? `, ${s.agent.effort}` : ""})` : ""} · attempt ${s.attempt}`,
    `${stateLabel(s.state)}${s.state_reason ? c.dim(` — ${s.state_reason}`) : ""}${s.phase ? ` · ${s.phase}` : ""}${s.controller === "user" ? c.magenta(" · you are in control") : ""}`,
  ];
  if (s.activity) lines.push(`activity: ${s.activity}`);
  if (s.progress) lines.push(`progress: ${progressBar(s.progress.done, s.progress.total, 16)} ${s.progress.done}/${s.progress.total} ${s.progress.unit ?? ""}`);
  if (s.checklist?.length) {
    const g = { done: "✔", in_progress: "◐", pending: "○", failed: "✖", skipped: "−" } as const;
    lines.push("checklist: " + s.checklist.map((i) => `${g[i.status]} ${i.id}${i.label ? ` ${i.label}` : ""}`).join("  "));
  }
  if (s.needs_input) lines.push(c.orange(formatQuestion(s.task_id, s.needs_input)));
  if (s.inbox.pending) lines.push(`inbox: ${s.inbox.pending} message(s) waiting for the next safe point`);
  if (s.workspace?.worktree) lines.push(c.dim(`worktree: ${s.workspace.worktree} · branch ${s.workspace.branch}`));
  if (s.files_touched?.length) lines.push(c.dim(`files: ${s.files_touched.join(", ")}`));
  const u = s.usage;
  lines.push(c.dim(`usage: ${fmtTokens(u.input_tokens)} in · ${fmtTokens(u.output_tokens)} out · ${fmtTokens(u.cache_read_tokens)} cached · ${u.turns} steps · ${Math.round(u.wall_ms / 1000)}s`));
  if (s.last_error) lines.push(c.orange(`last error (${s.last_error.kind}): ${truncate(s.last_error.message, 200)}`));
  return lines.join("\n");
}

export function formatQuestion(taskId: string, q: NonNullable<AgentStatus["needs_input"]>): string {
  const opts = q.options?.length ? "\n      " + q.options.map((o) => `${o.id}) ${o.label}`).join("   ") : "";
  return `? ${taskId}  ${q.question_id}${q.blocking ? " (blocking)" : ""} ${q.prompt}${opts}\n      → /answer ${q.question_id} ${q.options?.[0]?.id ?? "<text>"}`;
}

const time = (ts: string) => c.gray(new Date(ts).toLocaleTimeString("en-GB", { hour12: false }));

/** Feed line for an agent event. `detail` shows tool calls etc. (attached view). */
export function formatEvent(e: StampedEvent, detail: boolean): string | null {
  const ev = e.event;
  const who = c.bold(e.task_id);
  switch (ev.type) {
    case "state": {
      if (!detail && ["queued", "running", "starting"].includes(ev.state)) return null;
      return `${time(e.ts)} ${who} ${stateLabel(ev.state)}${ev.reason ? c.dim(` ${ev.reason}`) : ""}`;
    }
    case "progress":
      return detail ? `${time(e.ts)} ${who} ${c.dim("·")} ${ev.text}` : null;
    case "status_report":
      return detail && ev.activity ? `${time(e.ts)} ${who} ${c.dim("·")} ${ev.phase ? c.cyan(`[${ev.phase}] `) : ""}${ev.activity}` : null;
    case "tool_call":
      return detail ? `${time(e.ts)} ${who} ${c.blue("▸")} ${ev.summary}` : null;
    case "tool_result":
      return detail && !ev.ok ? `${time(e.ts)} ${who}   ${c.orange("✖")} ${c.dim(ev.summary)}` : null;
    case "error":
      return `${time(e.ts)} ${who} ${c.orange(`⚠ ${ev.kind}`)} ${truncate(ev.message, 160)}`;
    case "message_delivered":
      return `${time(e.ts)} ${who} ${c.dim(`↳ delivered ${ev.message_id}`)}`;
    case "message_acked":
      return `${time(e.ts)} ${who} ${c.blue(`✔ acknowledged ${ev.message_id}`)}`;
    case "answered":
      return `${time(e.ts)} ${who} ${c.dim(`answered ${ev.question_id}: ${truncate(ev.answer, 80)}`)}`;
    case "controller":
      return ev.controller === "user" ? `${time(e.ts)} ${who} ${c.magenta("you are in control (takeover)")}` : null;
    case "files":
      return detail ? `${time(e.ts)} ${who} ${c.dim(`files: ${ev.files.join(", ")}`)}` : null;
    default:
      return null;
  }
}

export function formatMessage(m: Message): string | null {
  if (m.to.kind !== "user") return null;
  if (m.type === "question" && m.question) return c.orange(formatQuestion(m.from.id ?? "?", m.question));
  if (m.type === "notify") return `${time(m.ts)} ${c.cyan("◆")} ${m.body}`;
  if (m.type === "request") return `${time(m.ts)} ${c.orange("◆ request")} ${m.from.id}: ${m.body}`;
  return null;
}

export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

export { STATE_STYLE };
