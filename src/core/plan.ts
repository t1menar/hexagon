import { canonicalRole } from "./roles.js";
import type { Plan, Task } from "../contracts/types.js";
import { validatePlan } from "../contracts/validate.js";
import type { Spec } from "./spec.js";

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
    if (t.verify.length === 0) warnings.push(`${t.id} has no verify commands; only the agent's own report will be checked`);
  }
  const order = topoOrder(p.tasks);
  if (order === null) errors.push("dependency cycle detected");

  if (specs.length) {
    const covered = new Set<string>();
    for (const t of p.tasks) for (const req of t.requirements) for (const ac of t.acceptance) covered.add(`${req}/${ac}`);
    const knownReqs = new Set<string>();
    for (const s of specs) {
      for (const r of s.requirements) {
        knownReqs.add(r.id);
        for (const ac of r.acceptance) if (!covered.has(`${r.id}/${ac.id}`)) warnings.push(`${r.id}/${ac.id} is not covered by any task`);
      }
    }
    for (const t of p.tasks) for (const r of t.requirements) if (!knownReqs.has(r)) warnings.push(`${t.id} references unknown requirement ${r}`);
  }
  return { errors, warnings, order: order ?? [] };
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
