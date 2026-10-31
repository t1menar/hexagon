import fs from "node:fs";
import { parse } from "smol-toml";
import type { Effort, Role } from "../contracts/types.js";

export interface AgentConfig {
  id: string;
  adapter: "claude" | "mock";
  model?: string;
  /** Mock adapter: delay between scripted steps (ms). */
  step_ms?: number;
}

export interface HexagonConfig {
  run: { max_parallel: number; max_attempts: number; fix_loops: number; budget_usd: number | null; base_branch: string | null };
  roles: Record<Role, { agent: string; effort: Effort }>;
  agents: Record<string, AgentConfig>;
  review: { mode: "agent" | "off" };
  messaging: { max_outbound_per_run: number; max_blocking_questions: number };
  sandbox: { allow_commands: string[]; command_timeout_s: number };
  ui: { open_with: "auto" | "tmux" | "iterm" | "terminal" | "print" };
}

export const DEFAULT_CONFIG: HexagonConfig = {
  run: { max_parallel: 4, max_attempts: 2, fix_loops: 2, budget_usd: 20, base_branch: null },
  roles: {
    planner: { agent: "claude", effort: "high" },
    implementer: { agent: "claude", effort: "medium" },
    tester: { agent: "claude", effort: "medium" },
    reviewer: { agent: "claude", effort: "high" },
    integrator: { agent: "claude", effort: "high" },
    resolver: { agent: "claude", effort: "high" },
    lead: { agent: "claude", effort: "low" },
  },
  agents: {
    claude: { id: "claude", adapter: "claude", model: "claude-sonnet-5-5" },
    mock: { id: "mock", adapter: "mock", step_ms: 600 },
  },
  review: { mode: "agent" },
  messaging: { max_outbound_per_run: 10, max_blocking_questions: 2 },
  sandbox: {
    allow_commands: ["npm", "npx", "pnpm", "yarn", "node", "tsc", "vitest", "jest", "pytest", "python", "python3", "go", "cargo", "make", "ls", "cat", "grep", "rg", "find", "git status", "git diff", "git log"],
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
  for (const [id, a] of Object.entries(cfg.agents)) a.id = id;
  if (cfg.run.budget_usd !== null && cfg.run.budget_usd <= 0) cfg.run.budget_usd = null;
  return cfg;
}
