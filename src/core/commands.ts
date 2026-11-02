import type { Plan, Task } from "../contracts/types.js";
import { checkPlan } from "./plan.js";

/**
 * The control surface of Hexagon, defined once. The daemon executes these, JSON-RPC and the CLI expose
 * them, and the control agent's reference is generated from the same table (`hexagon commands`).
 */
export type CommandKind = "read" | "mutate" | "destructive";

export interface ParamDef { name: string; type: "string" | "string[]" | "number" | "boolean"; required?: boolean; help: string }

export interface CommandDef {
  name: string;
  kind: CommandKind;
  summary: string;
  params: ParamDef[];
}

const p = (name: string, type: ParamDef["type"], help: string, required = false): ParamDef => ({ name, type, required, help });

export const COMMANDS: readonly CommandDef[] = [
  { name: "status.get", kind: "read", summary: "Run state, per-task states and any plan or spec waiting for approval.", params: [] },
  { name: "graph.show", kind: "read", summary: "The task graph being edited: nodes and edges.", params: [] },
  { name: "graph.addNode", kind: "mutate", summary: "Add a task to the draft plan.", params: [
    p("title", "string", "what the task does", true), p("role", "string", "role that does it (developer, qa, …)", true),
    p("id", "string", "task id (default: next free T-n)"), p("depends_on", "string[]", "ids this task waits for"), p("description", "string", "details for the agent"),
    p("write", "string[]", "files/globs the task may change (required: no scope, no work)", true),
    p("verify", "string[]", "commands Hexagon re-runs to check the task (required unless verify_exempt)"),
    p("verify_exempt", "string", "reason this task cannot be verified by a command"), p("read", "string[]", "files/globs it may read"),
  ] },
  { name: "graph.removeNode", kind: "destructive", summary: "Remove a task and its edges from the draft plan.", params: [p("id", "string", "task id", true)] },
  { name: "graph.addEdge", kind: "mutate", summary: "Make `to` wait for `from`. Cycles are refused.", params: [p("from", "string", "task that must finish first", true), p("to", "string", "task that waits", true)] },
  { name: "graph.removeEdge", kind: "destructive", summary: "Remove an ordering between two tasks.", params: [p("from", "string", "task id", true), p("to", "string", "task id", true)] },
  { name: "agent.configure", kind: "mutate", summary: "Choose the agent and/or model a role uses.", params: [p("role", "string", "role name", true), p("agent", "string", "agent id from config.toml"), p("model", "string", "model name; empty string resets")] },
  { name: "agent.setPrompt", kind: "mutate", summary: "Replace a role's prompt with your text (stored in .hexagon/roles/<role>.md).", params: [p("role", "string", "role name", true), p("text", "string", "the full prompt", true)] },
  { name: "run.start", kind: "mutate", summary: "Start the draft plan, or `from` a task onward (that task and everything after it).", params: [p("from", "string", "task id to start from"), p("max_parallel", "number", "parallel agents")] },
  { name: "run.pause", kind: "mutate", summary: "Pause all agents of the run.", params: [] },
  { name: "run.resume", kind: "mutate", summary: "Resume a paused run.", params: [] },
  { name: "run.cancel", kind: "destructive", summary: "Abort the run; running agents are stopped.", params: [] },
  { name: "bus.send", kind: "mutate", summary: "Send a message to a task agent (it is data for them, not a command).", params: [p("to", "string", "task id", true), p("text", "string", "message", true)] },
];

export const commandDef = (name: string): CommandDef | undefined => COMMANDS.find((c) => c.name === name);

/** Check and coerce arguments against the definition. Unknown keys are errors: a typo must not be silently ignored. */
export function parseArgs(def: CommandDef, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) if (!def.params.some((x) => x.name === k)) throw new Error(`${def.name}: unknown parameter "${k}" (known: ${def.params.map((x) => x.name).join(", ") || "none"})`);
  for (const d of def.params) {
    const v = raw[d.name];
    if (v === undefined || v === null) { if (d.required) throw new Error(`${def.name}: missing parameter "${d.name}"`); continue; }
    if (d.type === "string" && typeof v !== "string") throw new Error(`${def.name}: "${d.name}" must be a string`);
    if (d.type === "number" && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(`${def.name}: "${d.name}" must be a number`);
    if (d.type === "boolean" && typeof v !== "boolean") throw new Error(`${def.name}: "${d.name}" must be true or false`);
    if (d.type === "string[]" && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) throw new Error(`${def.name}: "${d.name}" must be a list of strings`);
    if (d.required && v === "") throw new Error(`${def.name}: "${d.name}" must not be empty`);
    out[d.name] = v;
  }
  return out;
}

/** `--name value` flags (repeat a flag for a list) → arguments, using the declared types. */
export function argsFromFlags(def: CommandDef, argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`${def.name}: unexpected "${a}" (use --name value)`);
    const d = def.params.find((x) => x.name === a.slice(2));
    if (!d) throw new Error(`${def.name}: unknown parameter "${a.slice(2)}" (known: ${def.params.map((x) => x.name).join(", ") || "none"})`);
    if (d.type === "boolean") { out[d.name] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${def.name}: --${d.name} needs a value`);
    if (d.type === "number") out[d.name] = Number(v);
    else if (d.type === "string[]") out[d.name] = [...((out[d.name] as string[] | undefined) ?? []), ...v.split(",").filter(Boolean)];
    else out[d.name] = v;
  }
  return out;
}

/** Markdown reference for the control agent and `hexagon commands`, generated from the table. */
export function commandDocs(): string {
  return COMMANDS.map((c) => {
    const args = c.params.map((x) => `${x.name}${x.required ? "" : "?"}: ${x.type}`).join(", ");
    const note = c.kind === "destructive" ? " (destructive: always needs the user's confirmation)" : c.kind === "mutate" ? " (proposed; applies after the user confirms)" : "";
    const ps = c.params.map((x) => `    - ${x.name}: ${x.help}`).join("\n");
    return `- \`${c.name}(${args})\`${note}: ${c.summary}${ps ? `\n${ps}` : ""}`;
  }).join("\n");
}

// ───────────── graph operations (pure) ─────────────

export interface GraphEdge { from: string; to: string }
export const edgesOf = (plan: Plan): GraphEdge[] => plan.tasks.flatMap((t) => t.depends_on.map((d) => ({ from: d, to: t.id })));

function hasCycle(tasks: Task[]): boolean {
  const deps = new Map(tasks.map((t) => [t.id, t.depends_on]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) if (deps.has(d) && visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return tasks.some((t) => visit(t.id));
}

const need = (plan: Plan, id: string): Task => {
  const t = plan.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id} in the plan (tasks: ${plan.tasks.map((x) => x.id).join(", ") || "none"})`);
  return t;
};

/** Apply one graph command to a copy of the plan. Throws when the result would be invalid (unknown task, cycle). */
export function applyGraph(plan: Plan, name: string, a: Record<string, unknown>): Plan {
  const next = structuredClone(plan);
  switch (name) {
    case "graph.addNode": {
      const used = new Set(next.tasks.map((t) => t.id));
      let id = a.id as string | undefined;
      if (id) { if (used.has(id)) throw new Error(`task ${id} already exists`); }
      else { let n = next.tasks.length + 1; while (used.has(`T-${n}`)) n++; id = `T-${n}`; }
      const deps = (a.depends_on as string[] | undefined) ?? [];
      for (const d of deps) need(next, d);
      const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).map(String).map((x) => x.trim()).filter(Boolean);
      const write = list(a.write), verify = list(a.verify);
      const exempt = typeof a.verify_exempt === "string" ? a.verify_exempt.trim() : "";
      // A task with no write scope cannot change anything (every edit would be out of scope); one with no verify has no independent check.
      if (!write.length) throw new Error("graph.addNode needs `write`: the files or globs the task may change (an empty scope would make every change out of scope)");
      if (!verify.length && !exempt) throw new Error("graph.addNode needs `verify` (commands Hexagon re-runs) or `verify_exempt` (why none can exist)");
      next.tasks.push({
        id, title: a.title as string, role: a.role as string, requirements: [], acceptance: [], depends_on: deps,
        files: { write, read: list(a.read) }, skills: [], definition_of_done: [`${a.title as string}: the change is made and its verify commands pass`], verify,
        ...(exempt && !verify.length ? { verify_exempt: exempt } : {}), ...(a.description ? { description: a.description as string } : {}),
      });
      break;
    }
    case "graph.removeNode": {
      const id = a.id as string;
      need(next, id);
      next.tasks = next.tasks.filter((t) => t.id !== id);
      for (const t of next.tasks) t.depends_on = t.depends_on.filter((d) => d !== id);
      break;
    }
    case "graph.addEdge": {
      const from = a.from as string, to = a.to as string;
      need(next, from);
      const t = need(next, to);
      if (from === to) throw new Error("a task cannot wait for itself");
      if (!t.depends_on.includes(from)) t.depends_on.push(from);
      break;
    }
    case "graph.removeEdge": {
      const from = a.from as string, to = a.to as string;
      const t = need(next, to);
      if (!t.depends_on.includes(from)) throw new Error(`${to} does not wait for ${from}`);
      t.depends_on = t.depends_on.filter((d) => d !== from);
      break;
    }
    default: throw new Error(`not a graph command: ${name}`);
  }
  if (hasCycle(next.tasks)) throw new Error("that would create a cycle");
  // The edited graph must still be a valid plan. Only problems this edit introduces count, so a draft that was already
  // imperfect can still be repaired one edit at a time.
  const had = new Set(checkPlan(plan).errors);
  const introduced = checkPlan(next).errors.filter((e) => !had.has(e));
  if (introduced.length) throw new Error(`that edit would leave the plan invalid: ${introduced.join("; ")}`);
  return next;
}

/** What changes, in words: added/removed tasks and edges. */
export function graphDiff(before: Plan, after: Plan): string[] {
  const out: string[] = [];
  const b = new Map(before.tasks.map((t) => [t.id, t]));
  const af = new Map(after.tasks.map((t) => [t.id, t]));
  for (const t of after.tasks) if (!b.has(t.id)) out.push(`+ task ${t.id} [${t.role}] ${t.title}`);
  for (const t of before.tasks) if (!af.has(t.id)) out.push(`- task ${t.id} [${t.role}] ${t.title}`);
  const key = (e: GraphEdge) => `${e.from}->${e.to}`;
  const be = new Set(edgesOf(before).map(key)), ae = new Set(edgesOf(after).map(key));
  for (const k of ae) if (!be.has(k)) out.push(`+ edge ${k}`);
  for (const k of be) if (!ae.has(k)) out.push(`- edge ${k}`);
  return out;
}

/** `from` and every task that (transitively) waits for it. */
export function fromTask(plan: Plan, from: string): string[] {
  need(plan, from);
  const set = new Set([from]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of plan.tasks) if (!set.has(t.id) && t.depends_on.some((d) => set.has(d))) { set.add(t.id); grew = true; }
  }
  return plan.tasks.map((t) => t.id).filter((id) => set.has(id));
}
