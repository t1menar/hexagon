import fs from "node:fs";
import { parse } from "smol-toml";
import type { Effort, Role } from "../contracts/types.js";

export interface AgentConfig {
  id: string;
  /** claude-code: wraps the `claude` CLI · exec: any one-shot CLI · mock: offline scripted agent. */
  adapter: "claude-code" | "exec" | "mock";
  /** Executable and leading args. claude-code default: ["claude"]. exec: may contain "{prompt}". */
  command?: string[];
  /** Interactive command for takeover (exec adapter). */
  interactive?: string[];
  model?: string;
  args?: string[];
  /** Mock adapter: delay between scripted steps (ms). */
  step_ms?: number;
}

export interface HexagonConfig {
  run: { max_parallel: number; max_attempts: number; fix_loops: number; budget_tokens: number | null; base_branch: string | null };
  roles: Record<Role, { agent: string; effort: Effort; model?: string }>;
  agents: Record<string, AgentConfig>;
  review: { mode: "agent" | "off" };
  messaging: { max_outbound_per_run: number; max_blocking_questions: number };
  sandbox: { allow_commands: string[]; command_timeout_s: number };
  ui: { open_with: "auto" | "tmux" | "iterm" | "terminal" | "print" };
}

export const DEFAULT_CONFIG: HexagonConfig = {
  run: { max_parallel: 4, max_attempts: 2, fix_loops: 2, budget_tokens: null, base_branch: null },
  roles: {
    init: { agent: "claude", effort: "medium" },
    planner: { agent: "claude", effort: "high", model: "opus" },
    implementer: { agent: "claude", effort: "medium" },
    tester: { agent: "claude", effort: "medium" },
    reviewer: { agent: "claude", effort: "high", model: "opus" },
    integrator: { agent: "claude", effort: "high" },
    resolver: { agent: "claude", effort: "high" },
    lead: { agent: "claude", effort: "medium", model: "opus" },
  },
  agents: {
    claude: { id: "claude", adapter: "claude-code", command: ["claude"], model: "sonnet" },
    mock: { id: "mock", adapter: "mock", step_ms: 600 },
  },
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
  ui: { open_with: "auto" },
};

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
      if (a.model?.startsWith("claude-sonnet")) a.model = "sonnet";
    }
  }
  delete (cfg.run as Record<string, unknown>).budget_usd; // v0.1 setting; budgets are in tokens now
  if (cfg.run.budget_tokens !== null && cfg.run.budget_tokens <= 0) cfg.run.budget_tokens = null;
  return cfg;
}

/** Add command prefixes to [sandbox].allow_commands in config.toml (keeps the rest of the file). */
export function allowCommands(file: string, add: string[]): string[] {
  const cfg = loadConfig(file);
  const fresh = add.map((a) => a.trim()).filter((a) => a && !cfg.sandbox.allow_commands.includes(a));
  if (!fresh.length || !fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const list = JSON.stringify([...fresh, ...cfg.sandbox.allow_commands]).replace(/","/g, '", "');
  const next = /^allow_commands\s*=.*$/m.test(text)
    ? text.replace(/^allow_commands\s*=.*$/m, `allow_commands = ${list}`)
    : text.replace(/^\[sandbox\]\s*$/m, `[sandbox]\nallow_commands = ${list}`);
  fs.writeFileSync(file, next);
  return fresh;
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
