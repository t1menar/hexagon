import { canonicalRole } from "./roles.js";
import type { Plan, Task } from "../contracts/types.js";
import { validatePlan } from "../contracts/validate.js";
import type { Spec } from "./spec.js";

/**
 * Commands that exit 0 whatever the code does. A verify made only of these checks nothing, which is worse than none:
 * it looks like a check. Compound lines are trivial only when every part is.
 */
export function isTrivialVerify(cmd: string): boolean {
  const parts = cmd.split(/&&|\|\||;|\|/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return true;
  return parts.every((x) => /^(?:true|false\s*\|\|\s*true|:|exit\s+0|echo\b.*|printf\b.*|ls\b.*|pwd|cat\b.*|head\b.*|tail\b.*|sleep\b.*|date|which\b.*|command\s+-v\b.*|git\s+status\b.*|test\s+-[de]\s+\.|node\s+(?:-v|--version)|npm\s+(?:-v|--version))$/.test(x));
}

export interface PlanCheck { errors: string[]; warnings: string[]; order: string[] }

/** Schema + semantic checks: unique ids, known deps, acyclic, AC coverage. */
export function checkPlan(plan: unknown, specs: Spec[] = []): PlanCheck {
  const v = validatePlan(plan);
  if (!v.ok) return { errors: v.errors.map((e) => `schema: ${e}`), warnings: [], order: [] };
  const p = plan as Plan;
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const t of p.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id ${t.id}`);
    ids.add(t.id);
  }
  for (const t of p.tasks) {
    for (const d of t.depends_on) if (!ids.has(d)) errors.push(`${t.id} depends on unknown task ${d}`);
    if (t.depends_on.includes(t.id)) errors.push(`${t.id} depends on itself`);
    if (t.verify.length === 0 && !t.verify_exempt) errors.push(`${t.id} has no verify command, so nothing independent can check it. Add one, or set "verify_exempt": "<reason>" for work that cannot be run (docs, config)`);
    for (const c of t.verify) if (isTrivialVerify(c)) errors.push(`${t.id} verify \`${c}\` proves nothing (it passes whatever the code does). Use a command that fails when the work is wrong, e.g. the test runner for this task, or set "verify_exempt" with a reason.`);
    if (t.verify.length && t.verify_exempt) warnings.push(`${t.id} has both verify and verify_exempt; the exemption is ignored`);
  }
  const order = topoOrder(p.tasks);
  if (order === null) errors.push("dependency cycle detected");

  if (specs.length) {
    const covered = new Set<string>();
    for (const t of p.tasks) {
      const q = qualifyAcceptance(t, specs);
      q.problems.forEach((x) => errors.push(x));
      q.ids.forEach((id) => covered.add(id));
    }
    const knownReqs = new Set<string>();
    for (const s of specs) {
      for (const r of s.requirements) {
        knownReqs.add(r.id);
        for (const ac of r.acceptance) if (!covered.has(`${r.id}/${ac.id}`)) errors.push(`${r.id}/${ac.id} is not covered by any task (a task must list it under "acceptance" and cite ${r.id})`);
      }
    }
    for (const t of p.tasks) for (const r of t.requirements) if (!knownReqs.has(r)) errors.push(`${t.id} references unknown requirement ${r}`);
    for (const t of p.tasks) if (!t.requirements.length) warnings.push(`${t.id} cites no requirement: the spec does not cover it, so the user has to approve it to run`);
  }
  return { errors, warnings, order: order ?? [] };
}

/**
 * Acceptance criteria are `REQ-X/AC-1`. The old bare `AC-1` is accepted when exactly one of the task's requirements has
 * that criterion; if two do, the task must say which (a bare id would count for both).
 */
export function qualifyAcceptance(t: Pick<Task, "id" | "requirements" | "acceptance">, specs: Spec[]): { ids: string[]; problems: string[] } {
  const ids: string[] = [];
  const problems: string[] = [];
  const reqs = new Map(specs.flatMap((s) => s.requirements).map((r) => [r.id, r]));
  for (const ac of t.acceptance) {
    if (ac.includes("/")) {
      const [req, id] = ac.split("/") as [string, string];
      if (!t.requirements.includes(req)) problems.push(`${t.id} lists ${ac}, but does not cite ${req}`);
      else if (reqs.has(req) && !reqs.get(req)!.acceptance.some((a) => a.id === id)) problems.push(`${t.id} lists ${ac}, but ${req} has no ${id}`);
      else ids.push(ac);
      continue;
    }
    const owners = t.requirements.filter((r) => reqs.get(r)?.acceptance.some((a) => a.id === ac));
    if (owners.length === 1) ids.push(`${owners[0]}/${ac}`);
    else if (owners.length > 1) problems.push(`${t.id} lists ${ac}, which ${owners.join(" and ")} both define. Write ${owners.map((o) => `${o}/${ac}`).join(" or ")}`);
    else if (t.requirements.length) problems.push(`${t.id} lists ${ac}, which none of its requirements (${t.requirements.join(", ")}) define`);
  }
  return { ids, problems };
}

export function topoOrder(tasks: Task[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, new Set(t.depends_on)]));
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < tasks.length) {
    const ready = tasks.filter((t) => !done.has(t.id) && [...deps.get(t.id)!].every((d) => done.has(d) || !deps.has(d)));
    if (ready.length === 0) return null;
    for (const t of ready) { done.add(t.id); order.push(t.id); }
  }
  return order;
}

/** Render a plan as an indented dependency tree for the terminal. */
export function planTree(plan: Plan): string {
  const lines: string[] = [];
  const children = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const t of plan.tasks) {
    if (t.depends_on.length === 0) roots.push(t);
    for (const d of t.depends_on) children.set(d, [...(children.get(d) ?? []), t]);
  }
  const seen = new Set<string>();
  const walk = (t: Task, prefix: string, last: boolean, depth: number) => {
    const again = seen.has(t.id);
    seen.add(t.id);
    const branch = depth === 0 ? "" : last ? "└─ " : "├─ ";
    lines.push(`${prefix}${branch}${t.id} [${t.role}] ${t.title}${again ? " (see above)" : `  ← ${t.requirements.join(",")} ${t.acceptance.join(",")}`}`);
    if (again) return;
    const kids = children.get(t.id) ?? [];
    kids.forEach((k, i) => walk(k, depth === 0 ? prefix : prefix + (last ? "   " : "│  "), i === kids.length - 1, depth + 1));
  };
  roots.forEach((r) => walk(r, "", true, 0));
  return lines.join("\n");
}

/** Fill optional task fields so a hand- or agent-written plan only needs the essentials. */
export function normalizePlan(raw: unknown, meta: { id: string; specs: string[] }): Plan {
  const r = (raw ?? {}) as Partial<Plan> & { tasks?: Partial<Task>[] };
  const tasks = (r.tasks ?? []).map((t, i) => {
    const files = (t.files ?? {}) as Partial<Task["files"]>;
    const acceptance = t.acceptance ?? [];
    return {
      ...t,
      id: t.id ?? `T-${i + 1}`,
      title: t.title ?? `Task ${i + 1}`,
      role: canonicalRole(t.role ?? "developer"),
      requirements: t.requirements ?? [],
      acceptance,
      depends_on: t.depends_on ?? [],
      files: { write: files.write ?? [], read: files.read ?? [] },
      skills: t.skills ?? [],
      definition_of_done: t.definition_of_done?.length ? t.definition_of_done : acceptance.length ? acceptance.map((a) => `${a} holds`) : ["Implemented as described"],
      verify: t.verify ?? [],
    } as Task;
  });
  return {
    schema: "hexagon.plan/v1",
    id: meta.id,
    created_at: r.created_at ?? new Date().toISOString(),
    specs: meta.specs,
    tasks,
    spec_issues: r.spec_issues ?? [],
  };
}
