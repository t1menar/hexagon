import type { AgentState, Plan, ReviewVerdict } from "../contracts/types.js";
import type { Spec } from "./spec.js";

/** Evidence recorded by Hexagon (not claimed by an agent) for one task. */
export interface TaskEvidence {
  state: AgentState;
  agent?: string;
  provider?: string;
  verify: { cmd: string; code: number }[];
  review?: ReviewVerdict["verdict"] | null;
  merged: boolean;
}

export type ReqStatus = "unplanned" | "planned" | "in_progress" | "verified" | "reviewed" | "complete" | "failed";

export interface TraceRow {
  requirement: string;
  title: string;
  acceptance: string[];
  tasks: { id: string; state: AgentState; agent: string | null; verify: "passed" | "failed" | "none"; review: string | null; merged: boolean }[];
  status: ReqStatus;
}

/**
 * Requirement → task → agent → verification → review → completion. A requirement is complete only when every task that
 * references it is merged with passing Hexagon-run verification and an approving review (when reviews are on).
 * Agent statements never count: only `evidence` does.
 */
export function trace(specs: Spec[], plan: Plan, evidence: Map<string, TaskEvidence>, reviewsOn = true): { rows: TraceRow[]; orphanTasks: string[]; unknownRefs: { task: string; ref: string }[] } {
  const reqs = new Map(specs.flatMap((s) => s.requirements.map((r) => [r.id, r] as const)));
  const rows: TraceRow[] = [...reqs.values()].map((r) => {
    const tasks = plan.tasks.filter((t) => t.requirements.includes(r.id)).map((t) => {
      const e = evidence.get(t.id);
      const verify = !t.verify.length ? "none" : e && e.verify.length && e.verify.every((v) => v.code === 0) ? "passed" : e?.verify.some((v) => v.code !== 0) ? "failed" : "none";
      return { id: t.id, state: e?.state ?? ("queued" as AgentState), agent: e?.agent ? `${e.provider ?? "?"}/${e.agent}` : null, verify: verify as "passed" | "failed" | "none", review: e?.review ?? null, merged: e?.merged ?? false };
    });
    let status: ReqStatus;
    if (!tasks.length) status = "unplanned";
    else if (tasks.some((t) => t.state === "failed" || t.state === "blocked" || t.state === "cancelled" || t.verify === "failed")) status = "failed";
    else if (tasks.every((t) => t.merged && t.state === "done" && (t.verify === "passed" || t.verify === "none") && (!reviewsOn || t.review === "approve"))) status = "complete";
    else if (tasks.every((t) => t.review === "approve")) status = "reviewed";
    else if (tasks.every((t) => t.verify === "passed")) status = "verified";
    else if (tasks.some((t) => t.state !== "queued")) status = "in_progress";
    else status = "planned";
    return { requirement: r.id, title: r.title, acceptance: r.acceptance.map((a) => a.id), tasks, status };
  });
  const orphanTasks = plan.tasks.filter((t) => !t.requirements.length).map((t) => t.id);
  const unknownRefs = plan.tasks.flatMap((t) => t.requirements.filter((q) => !reqs.has(q)).map((ref) => ({ task: t.id, ref })));
  return { rows, orphanTasks, unknownRefs };
}

export function formatTrace(t: ReturnType<typeof trace>): string {
  const out = t.rows.map((r) => `${r.requirement} [${r.status}] ${r.title}\n` + (r.tasks.length ? r.tasks.map((k) => `    ${k.id} ${k.state}${k.agent ? ` by ${k.agent}` : ""} · verify ${k.verify} · review ${k.review ?? "—"}${k.merged ? " · merged" : ""}`).join("\n") : "    (no task covers this requirement)"));
  if (t.orphanTasks.length) out.push(`Tasks without requirements: ${t.orphanTasks.join(", ")}`);
  for (const u of t.unknownRefs) out.push(`${u.task} references unknown requirement ${u.ref}`);
  return out.join("\n");
}
