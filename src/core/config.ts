import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import type { Effort, Role } from "../contracts/types.js";
import { adapterNames, defaultAgents, migrateAgentEntry, primaryAgentId } from "../agents/registry.js";
import { BUILTIN_ROLES, ROLE_ALIASES } from "./roles.js";
import { DEFAULT_RECOVERY, type RecoveryConfig } from "./recovery.js";

export interface AgentConfig {
  id: string;
  /** Integration name from the adapter registry (see `hexagon agents list`), or a registered third party. */
  adapter: string;
  /** Vendor label for display and grouping. Defaults to the adapter's own. */
  provider?: string;
  /** Executable and leading args; each integration has its own default. exec: may contain "{prompt}". */
  command?: string[];
  /** Interactive command for takeover (exec adapter). */
  interactive?: string[];
  /** Optional user override passed to the CLI as-is. Omit to keep the CLI's own default. */
  model?: string;
  /** Explicit authorization to run read-only roles (reviewer) on a CLI that cannot enforce read-only itself. */
  allow_weaker_isolation?: boolean;
  /** Environment variables handed to this agent's process besides PATH, HOME, locale, terminal and its own login variables. */
  env_passthrough?: string[];
  args?: string[];
  /** Mock adapter: delay between scripted steps (ms). */
  step_ms?: number;
}

export interface ContextConfig {
  /** auto: compact at the threshold · manual: only on /compact · off: never (overflow recovery still applies). */
  mode: "auto" | "manual" | "off";
  /** Fraction of the model's context window at which a session is compacted. */
  compact_at: number;
  /** Turns that must pass after a compaction before the next one. */
  min_turns_between: number;
  /** Window size used when the runtime reports none. */
  assumed_window_tokens: number;
  /** project: one session per agent identity for the whole project · task: a new session for every task (kept across its fix loops). */
  session_scope: "project" | "task";
  /** project scope, new task in a reused session: note = say that the task changed · compact = summarise the session first. */
  task_boundary: "note" | "compact";
}

export interface ControlConfig {
  /** Apply the control agent's non-destructive proposals without asking. Destructive ones always ask. */
  auto_apply: boolean;
}

export interface RoleConfig {
  agent: string;
  effort: Effort;
  model?: string;
  /** used only when recovery.allow_provider_failover is true */
  fallback_agent?: string;
  /** Custom roles: prompt file (relative to .hexagon/roles/ or the project root), display title, extra skills, UI group. */
  prompt?: string;
  title?: string;
  skills?: string[];
  group?: "analysis" | "implementation" | "review" | "integration";
}

export interface PriceRow { input_per_mtok?: number; cache_read_per_mtok?: number; output_per_mtok?: number }

export interface HexagonConfig {
  run: { max_parallel: number; max_attempts: number; fix_loops: number; /** quality repair cycles; 0 = unlimited (safeguards still apply) */ max_fix_cycles: number; /** tokens one task may use (input + cache reads + output) before it stops and asks; 0 = no cap */ task_budget_tokens: number; /** a graph of 2+ tasks holds the rest of the tasks back after the first one is merged, until the human has looked and says continue */ checkpoint_after_first: boolean; /** analysis that shows unresolved uncertainty (unknown cause, cross-cutting change, unclear boundaries) must list read-only spikes before a spec is written */ require_spike: boolean; /** paths only the integration may change (lockfiles, registries): a task cannot be granted them through `hexagon scope request` */ shared_files: string[]; /** runs ONE test for the mutation check; {file} and {name} are shell-quoted placeholders (e.g. `npx vitest run {file} -t {name}`). Empty = re-run the task's verify commands instead */ test_command: string; /** which verify commands run on the integration branch after each merge: this task's ("task"), plus those of tasks already merged ("merged"), plus final_verify ("full") */ integration_verify: "task" | "merged" | "full"; /** commands that must pass on the integration branch before /merge; empty = every task's verify commands */ final_verify: string[]; /** a merge conflict goes to the release engineer once before the task blocks */ release_on_conflict: boolean; /** identical failures in a row before escalating to the user */ max_identical_failures: number; budget_tokens: number | null; base_branch: string | null; /** run the task's verify commands once before work starts, to know what was already red */ baseline: boolean; /** files that count as tests for the test-integrity check; empty = per-language defaults */ test_globs: string[] };
  roles: Record<Role, RoleConfig>;
  agents: Record<string, AgentConfig>;
  recovery: RecoveryConfig;
  review: { mode: "agent" | "off" };
  context: ContextConfig;
  /** `hexagon bench` / `hexagon eval` spend real tokens; they stop when the reported cost reaches this. */
  bench: { max_cost_usd: number };
  /** Your own prices per million tokens, by agent id. Hexagon ships none: it uses the cost a CLI reports, and only estimates from this table when a CLI reports none. */
  prices: Record<string, PriceRow>;
  control: ControlConfig;
  messaging: { max_outbound_per_run: number; max_blocking_questions: number };
  sandbox: { allow_commands: string[]; command_timeout_s: number };
  ui: { open_with: "auto" | "tmux" | "iterm" | "terminal" | "print"; /** auto | full | reduced | off */ animation: string; startup_animation: boolean; inspector: boolean; /** faint ambient hexagons behind the network (full motion only) */ ambient: boolean; /** wheel scrolling and clicking agents; Shift-drag still selects text in most terminals */ mouse: boolean };
}

export const DEFAULT_CONFIG: HexagonConfig = {
  run: { max_parallel: 4, max_attempts: 2, fix_loops: 2, max_fix_cycles: 3, task_budget_tokens: 3_000_000, checkpoint_after_first: true, require_spike: true, shared_files: [], test_command: "", integration_verify: "merged", final_verify: [], release_on_conflict: true, max_identical_failures: 3, budget_tokens: null, base_branch: null, baseline: true, test_globs: [] },
  roles: Object.fromEntries(BUILTIN_ROLES.map((r) => [r.id, { agent: primaryAgentId(), effort: r.effort }])),
  agents: defaultAgents(),
  recovery: DEFAULT_RECOVERY,
  review: { mode: "agent" },
  context: { mode: "auto", compact_at: 0.7, min_turns_between: 3, assumed_window_tokens: 200_000, session_scope: "project", task_boundary: "note" },
  bench: { max_cost_usd: 5 },
  prices: {},
  control: { auto_apply: false },
  messaging: { max_outbound_per_run: 10, max_blocking_questions: 2 },
  sandbox: {
    allow_commands: [
      "npm", "pnpm", "yarn", "tsc", "vitest", "jest", "pytest", "go", "cargo", "mvn", "gradle", "./gradlew", "./mvnw",
      "ls", "cat", "grep", "rg", "mkdir", "test", "git status", "git diff", "git log",
    ],
    command_timeout_s: 600,
  },
  ui: { open_with: "auto", animation: "auto", startup_animation: true, inspector: true, ambient: true, mouse: true },
};

/** Read-only probes every agent may always run (checking what's installed, looking around). */
export const SAFE_COMMANDS = [
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "which", "command -v", "type", "uname", "pwd", "echo",
  "date", "tree", "file", "stat", "du", "sort", "uniq", "diff", "test", "git status", "git diff", "git log", "git show", "git ls-files",
  "go version", "go env", "node --version", "npm --version", "python3 --version", "java -version", "mvn -v", "mvn --version",
];

/** Old role names in [roles.*] map onto the current ones; a section written under the new name wins. */
export function migrateRoles(roles: unknown): unknown {
  if (!roles || typeof roles !== "object") return roles;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(roles as Record<string, unknown>);
  for (const [k, v] of entries) if (!(k in ROLE_ALIASES)) out[k] = v;
  for (const [k, v] of entries) if (k in ROLE_ALIASES && !(ROLE_ALIASES[k]! in out)) out[ROLE_ALIASES[k]!] = v;
  return out;
}

/**
 * Rewrite old role section names in config.toml in place ([roles.planner] → [roles.analyst]), keeping every other
 * byte. Both integrator and resolver map to release: the first one found is renamed, the other is left for you.
 * Returns the renames made.
 */
export function migrateConfigFile(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  let text = fs.readFileSync(file, "utf8");
  const done: string[] = [];
  for (const [old, now] of Object.entries(ROLE_ALIASES)) {
    const oldHead = new RegExp(`^\\[roles\\.${old}\\]`, "m");
    const newHead = new RegExp(`^\\[roles\\.${now}\\]`, "m");
    if (oldHead.test(text) && !newHead.test(text)) {
      text = text.replace(oldHead, `[roles.${now}]`);
      done.push(`${old} → ${now}`);
    }
  }
  if (done.length) fs.writeFileSync(file, text);
  return done;
}

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in out ? merge(out[k], v) : v;
  }
  return out as T;
}

/** Config of a role; an unknown id is an error with the list of defined roles (never a crash on undefined). */
export function roleConfig(cfg: HexagonConfig, role: string): RoleConfig {
  const r = cfg.roles[role];
  if (!r) throw new Error(`unknown role "${role}" (roles: ${Object.keys(cfg.roles).join(", ")}); define it under [roles.${role}] in config.toml`);
  return r;
}

export function loadConfig(file: string): HexagonConfig {
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  const raw = parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  raw.roles = migrateRoles(raw.roles);
  const cfg = merge(structuredClone(DEFAULT_CONFIG), raw);
  for (const [id, a] of Object.entries(cfg.agents)) {
    a.id = id;
    migrateAgentEntry(a); // an old adapter name maps onto the current integration
    if (!a.adapter) throw new Error(`[agents.${id}] needs adapter = "…" (available: ${adapterNames().join(", ")})`);
    if (!adapterNames().includes(a.adapter)) throw new Error(`[agents.${id}] unknown adapter "${a.adapter}" (available: ${adapterNames().join(", ")}). No fallback is used.`);
  }
  for (const [role, r] of Object.entries(cfg.roles)) {
    // A custom role only has to say what is different: the rest comes from the developer role.
    r.agent ??= cfg.roles.developer!.agent;
    r.effort ??= cfg.roles.developer!.effort;
    if (!cfg.agents[r.agent]) throw new Error(`[roles.${role}] uses agent "${r.agent}", which is not defined under [agents] (defined: ${Object.keys(cfg.agents).join(", ")})`);
  }
  const cx = cfg.context;
  if (!["auto", "manual", "off"].includes(cx.mode)) throw new Error(`[context].mode must be "auto", "manual" or "off" (got "${cx.mode}")`);
  if (!(cx.compact_at > 0 && cx.compact_at <= 1)) throw new Error(`[context].compact_at must be between 0 and 1 (got ${cx.compact_at})`);
  if (!(cx.assumed_window_tokens >= 1000)) throw new Error(`[context].assumed_window_tokens must be at least 1000 (got ${cx.assumed_window_tokens})`);
  cx.min_turns_between = Math.max(0, Math.floor(cx.min_turns_between));
  // fix_loops was the only knob before max_fix_cycles existed: honour it when the new one is not set.
  const rawRun = (raw.run ?? {}) as Record<string, unknown>;
  if ("fix_loops" in rawRun && !("max_fix_cycles" in rawRun)) cfg.run.max_fix_cycles = cfg.run.fix_loops;
  if (!["task", "merged", "full"].includes(cfg.run.integration_verify)) throw new Error(`[run].integration_verify must be "task", "merged" or "full" (got "${cfg.run.integration_verify}")`);
  cfg.run.task_budget_tokens = Math.max(0, Math.floor(cfg.run.task_budget_tokens));
  delete (cfg.run as Record<string, unknown>).budget_usd; // v0.1 setting; budgets are in tokens now
  if (cfg.run.budget_tokens !== null && cfg.run.budget_tokens <= 0) cfg.run.budget_tokens = null;
  // Approvals the user gave while working live in .hexagon/local.toml: personal, never committed.
  const local = path.join(path.dirname(file), "local.toml");
  if (fs.existsSync(local)) {
    try {
      const extra = (parse(fs.readFileSync(local, "utf8")) as { sandbox?: { allow_commands?: string[] } }).sandbox?.allow_commands ?? [];
      cfg.sandbox.allow_commands = [...extra.filter((x) => typeof x === "string"), ...cfg.sandbox.allow_commands];
    } catch { /* a broken local file must not stop the daemon */ }
  }
  cfg.sandbox.allow_commands = [...new Set([...cfg.sandbox.allow_commands, ...SAFE_COMMANDS])];
  return cfg;
}

/** Add command prefixes to [sandbox].allow_commands in config.toml (keeps the rest of the file). */
export function allowCommands(file: string, add: string[]): string[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  // The file's own list (loadConfig adds SAFE_COMMANDS, which shouldn't be written out).
  const raw = (parse(text) as { sandbox?: { allow_commands?: string[] } }).sandbox?.allow_commands ?? DEFAULT_CONFIG.sandbox.allow_commands;
  const fresh = add.map((a) => a.trim()).filter((a) => a && !raw.includes(a));
  if (!fresh.length) return [];
  const list = JSON.stringify([...fresh, ...raw]).replace(/","/g, '", "');
  const next = /^allow_commands\s*=.*$/m.test(text)
    ? text.replace(/^allow_commands\s*=.*$/m, `allow_commands = ${list}`)
    : text.replace(/^\[sandbox\]\s*$/m, `[sandbox]\nallow_commands = ${list}`);
  fs.writeFileSync(file, next);
  return fresh;
}

/**
 * Remember commands the user approved while working. They go to .hexagon/local.toml (kept out of git through
 * .git/info/exclude), so a personal "allow everything" never lands in the committed project config.
 */
export function allowLocal(configFile: string, add: string[]): string[] {
  const dir = path.dirname(configFile);
  const file = path.join(dir, "local.toml");
  const have = fs.existsSync(file) ? ((parse(fs.readFileSync(file, "utf8")) as { sandbox?: { allow_commands?: string[] } }).sandbox?.allow_commands ?? []) : [];
  const fresh = add.map((a) => a.trim()).filter((a) => a && !have.includes(a));
  if (!fresh.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  const list = JSON.stringify([...fresh, ...have]).replace(/","/g, '", "');
  fs.writeFileSync(file, `# Your personal approvals (not committed). Edit freely.\n[sandbox]\nallow_commands = ${list}\n`);
  try {
    const gitDir = path.join(path.dirname(dir), ".git");
    if (fs.statSync(gitDir).isDirectory()) {
      const ex = path.join(gitDir, "info", "exclude");
      const cur = fs.existsSync(ex) ? fs.readFileSync(ex, "utf8") : "";
      if (!cur.split("\n").includes(".hexagon/local.toml")) {
        fs.mkdirSync(path.dirname(ex), { recursive: true });
        fs.writeFileSync(ex, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}.hexagon/local.toml\n`);
      }
    }
  } catch { /* not a git repo, or a worktree layout: nothing to exclude */ }
  return fresh;
}

/** Set a role's agent in config.toml (the agent must exist under [agents]); keeps the rest of the file. */
export function setRoleAgent(file: string, role: Role, agent: string): void {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const head = new RegExp(`^\\[roles\\.${role}\\]\\s*$`, "m");
  if (!head.test(text)) text += `${text.endsWith("\n") || !text ? "" : "\n"}[roles.${role}]\nagent = ${JSON.stringify(agent)}\n`;
  else {
    const start = text.search(head);
    const bodyStart = text.indexOf("\n", start) + 1;
    const next = text.slice(bodyStart).search(/^\[/m);
    const end = next < 0 ? text.length : bodyStart + next;
    let body = text.slice(bodyStart, end);
    body = /^agent\s*=/m.test(body) ? body.replace(/^agent\s*=.*$/m, `agent = ${JSON.stringify(agent)}`) : `agent = ${JSON.stringify(agent)}\n${body}`;
    text = text.slice(0, bodyStart) + body + text.slice(end);
  }
  fs.writeFileSync(file, text);
}

/** Append an [agents.<id>] block (provider/adapter/command only: never a model unless the user gave one). */
export function addAgent(file: string, a: { id: string; adapter: string; provider?: string; command?: string[]; model?: string }): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (new RegExp(`^\\[agents\\.${a.id}\\]\\s*$`, "m").test(text)) throw new Error(`agent "${a.id}" already exists in config.toml`);
  const lines = [`[agents.${a.id}]`, `adapter = ${JSON.stringify(a.adapter)}`];
  if (a.provider) lines.push(`provider = ${JSON.stringify(a.provider)}`);
  if (a.command?.length) lines.push(`command = ${JSON.stringify(a.command)}`);
  if (a.model) lines.push(`model = ${JSON.stringify(a.model)}`);
  fs.writeFileSync(file, `${text}${text.endsWith("\n") || !text ? "" : "\n"}\n${lines.join("\n")}\n`);
}

/** Set (or with `model` = null, remove) the model of a role in config.toml, keeping the rest of the file. */
export function setRoleModel(file: string, role: Role, model: string | null): void {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const head = new RegExp(`^\\[roles\\.${role}\\]\\s*$`, "m");
  if (!head.test(text)) text += `${text.endsWith("\n") || !text ? "" : "\n"}[roles.${role}]\n`;
  const start = text.search(head);
  const bodyStart = text.indexOf("\n", start) + 1;
  const next = text.slice(bodyStart).search(/^\[/m);
  const end = next < 0 ? text.length : bodyStart + next;
  let body = text.slice(bodyStart, end).replace(/^model\s*=.*\n?/m, "");
  if (model) body = body.replace(/^(agent\s*=.*\n)/m, `$1model = "${model}"\n`) || body;
  if (model && !/^model\s*=/m.test(body)) body = `model = "${model}"\n${body}`;
  fs.writeFileSync(file, text.slice(0, bodyStart) + body + text.slice(end));
}
