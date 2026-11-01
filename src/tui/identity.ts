import type { AgentStatus } from "../contracts/types.js";

type A = Pick<AgentStatus, "agent" | "state" | "recovery" | "fix_cycle">;

/** "<provider> · <cli> <version>": provider and CLI, never a model. */
export function agentIdentity(a: A): string {
  const g = a.agent;
  return `${g.provider} · ${g.adapter ?? g.id}${g.cli_version ? ` ${g.cli_version}` : ""}`;
}

/**
 * The four model concepts, kept apart:
 *  - runtime: what the process reported (the only thing shown as "the model"),
 *  - override: what the user configured, if anything,
 *  - otherwise the CLI decides, and we say so instead of guessing.
 */
export function modelLine(a: A): string {
  const g = a.agent;
  const runtime = g.runtime_model ? `model ${g.runtime_model}` : "model unknown (CLI-managed)";
  const sel = g.model_mode === "cli-default" || !g.model ? "CLI default" : `${g.model_mode} override ${g.model}`;
  return `${runtime} · selection: ${sel}${a.fix_cycle ? ` · fix cycle ${a.fix_cycle}` : ""}`;
}

export function quotaLabel(a: A): string {
  const r = a.recovery;
  if (!r) return "waiting";
  const t = r.next_retry_at ? new Date(r.next_retry_at) : null;
  const hhmm = t ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}` : "?";
  return `resumes ${hhmm}${r.reset_source === "estimate" ? "~" : ""}`;
}

/** Why execution stopped, whether it resumes by itself, and what was preserved. */
export function recoveryLine(a: A): string {
  const r = a.recovery;
  if (!r) return "";
  const label = r.cls.replace(/_/g, " ");
  if (a.state === "waiting_quota") return `⏳ ${label} — resumes automatically ${quotaLabel(a).replace("resumes ", "")}${r.reset_source === "estimate" ? " (estimated)" : " (provider-reported)"} · work and feedback preserved`;
  if (r.status === "blocked") return `⊘ ${label} — needs you: fix it, then /retry`;
  return `↻ recovered from ${label}${r.waits ? ` (${r.waits} wait${r.waits === 1 ? "" : "s"}, ${Math.round(r.waited_s)}s)` : ""}`;
}
