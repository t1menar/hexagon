import fs from "node:fs";
import { parse } from "smol-toml";
import type { Effort, Role } from "../contracts/types.js";
import { adapterNames } from "../agents/registry.js";
import { DEFAULT_RECOVERY, type RecoveryConfig } from "./recovery.js";

export interface AgentConfig {
  id: string;
  /** Integration name from the adapter registry: claude-code · codex · grok · exec · mock (or a registered third party). */
  adapter: string;
  /** Vendor label for display and grouping (anthropic, openai, xai, …). Defaults to the adapter's own. */
  provider?: string;
  /** Executable and leading args. claude-code default: ["claude"]. exec: may contain "{prompt}". */
  command?: string[];
  /** Interactive command for takeover (exec adapter). */
  interactive?: string[];
  /** Optional user override passed to the CLI as-is. Omit to keep the CLI's own default. */
  model?: string;
  /** Explicit authorization to run read-only roles (reviewer) on a CLI that cannot enforce read-only itself. */
  allow_weaker_isolation?: boolean;
  args?: string[];
  /** Mock adapter: delay between scripted steps (ms). */
  step_ms?: number;
}

export interface HexagonConfig {
  run: { max_parallel: number; max_attempts: number; fix_loops: number; /** quality repair cycles; 0 = unlimited (safeguards still apply) */ max_fix_cycles: number; /** identical failures in a row before escalating to the user */ max_identical_failures: number; budget_tokens: number | null; base_branch: string | null };
  roles: Record<Role, { agent: string; effort: Effort; model?: string; /** used only when recovery.allow_provider_failover is true */ fallback_agent?: string }>;
  agents: Record<string, AgentConfig>;
  recovery: RecoveryConfig;
  review: { mode: "agent" | "off" };
  messaging: { max_outbound_per_run: number; max_blocking_questions: number };
  sandbox: { allow_commands: string[]; command_timeout_s: number };
  ui: { open_with: "auto" | "tmux" | "iterm" | "terminal" | "print"; /** auto | full | reduced | off */ animation: string; startup_animation: boolean; inspector: boolean };
}

export const DEFAULT_CONFIG: HexagonConfig = {
  run: { max_parallel: 4, max_attempts: 2, fix_loops: 2, max_fix_cycles: 0, max_identical_failures: 3, budget_tokens: null, base_branch: null },
  roles: {
    init: { agent: "claude", effort: "medium" },
    planner: { agent: "claude", effort: "high" },
    implementer: { agent: "claude", effort: "medium" },
    tester: { agent: "claude", effort: "medium" },
    reviewer: { agent: "claude", effort: "high" },
    integrator: { agent: "claude", effort: "high" },
    resolver: { agent: "claude", effort: "high" },
    lead: { agent: "claude", effort: "medium" },
  },
  agents: {
    claude: { id: "claude", adapter: "claude-code", provider: "anthropic", command: ["claude"] },
    mock: { id: "mock", adapter: "mock", step_ms: 600 },
  },
  recovery: DEFAULT_RECOVERY,
  review: { mode: "agent" },
  messaging: { max_outbound_per_run: 10, max_blocking_questions: 2 },
  sandbox: {
    allow_commands: [
      "npm", "npx", "pnpm", "yarn", "node", "tsc", "vitest", "jest", "pytest", "python", "python3", "go", "cargo",
      "make", "mvn", "gradle", "./gradlew", "./mvnw", "java", "sh", "ls", "cat", "grep", "rg", "find", "mkdir", "test",
      "git status", "git diff", "git log",
    ],
    command_timeout_s: 600,
  },
  ui: { open_with: "auto", animation: "auto", startup_animation: true, inspector: true },
};

/** Read-only probes every agent may always run (checking what's installed, looking around). */
export const SAFE_COMMANDS = [
  "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "which", "command -v", "type", "uname", "pwd", "echo", "printenv",
  "date", "tree", "file", "stat", "du", "sort", "uniq", "diff", "test", "git status", "git diff", "git log", "git show", "git ls-files",
  "go version", "go env", "node --version", "npm --version", "python3 --version", "java -version", "mvn -v", "mvn --version",
];

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in out ? merge(out[k], v) : v;
  }
  return out as T;
}

export function loadConfig(file: string): HexagonConfig {
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  const raw = parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const cfg = merge(structuredClone(DEFAULT_CONFIG), raw);
  for (const [id, a] of Object.entries(cfg.agents)) {
    a.id = id;
    // v0.1 configs used the API adapter ("claude" + a full model id); map them onto the CLI wrapper.
    if ((a.adapter as string) === "claude") {
      a.adapter = "claude-code";
      a.command ??= ["claude"];
      // A v0.1 full model id is not portable to the CLI: drop it so the CLI default applies.
      if (a.model?.startsWith("claude-")) delete a.model;
    }
    if (!a.adapter) throw new Error(`[agents.${id}] needs adapter = "…" (available: ${adapterNames().join(", ")})`);
    if (!adapterNames().includes(a.adapter)) throw new Error(`[agents.${id}] unknown adapter "${a.adapter}" (available: ${adapterNames().join(", ")}). No fallback is used.`);
  }
  for (const [role, r] of Object.entries(cfg.roles)) {
    if (!cfg.agents[r.agent]) throw new Error(`[roles.${role}] uses agent "${r.agent}", which is not defined under [agents] (defined: ${Object.keys(cfg.agents).join(", ")})`);
  }
  // fix_loops was the only knob before max_fix_cycles existed: honour it when the new one is not set.
  const rawRun = (raw.run ?? {}) as Record<string, unknown>;
  if ("fix_loops" in rawRun && !("max_fix_cycles" in rawRun)) cfg.run.max_fix_cycles = cfg.run.fix_loops;
  delete (cfg.run as Record<string, unknown>).budget_usd; // v0.1 setting; budgets are in tokens now
  if (cfg.run.budget_tokens !== null && cfg.run.budget_tokens <= 0) cfg.run.budget_tokens = null;
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
