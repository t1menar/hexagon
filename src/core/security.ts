import type { HexagonConfig } from "./config.js";

/** Programs that run whatever they are given: allowing one of them allows everything, so an approval means nothing. */
const RUNS_ANYTHING = new Set(["sh", "bash", "zsh", "fish", "dash", "node", "deno", "bun", "python", "python3", "ruby", "perl", "php", "npx", "make", "find", "xargs", "env", "eval", "exec", "sudo", "ssh", "*"]);

/** Entries in the user's own allow-list that defeat the approval prompts. Reported, never removed: the list is the user's. */
export function configWarnings(cfg: HexagonConfig): string[] {
  const out: string[] = [];
  for (const rule of cfg.sandbox.allow_commands) {
    const head = rule.trim().split(/\s+/)[0] ?? "";
    if (RUNS_ANYTHING.has(head) && rule.trim() === head) {
      out.push(rule === "*"
        ? `[sandbox] allow_commands contains "*": agents can run any command without asking.`
        : `[sandbox] allow_commands contains "${rule}", which can run any code (e.g. \`${head} -c …\`), so commands you were never asked about can run. Remove it and approve what your verify steps need instead.`);
    }
  }
  return out;
}

export interface AgentSecurityRow { id: string; display_name: string; security?: { readOnlyEnforced: boolean; commandAllowList: boolean } | null }

/** A plain statement of what is enforced, by whom, and what is not. Printed at startup and by `hexagon agents doctor`. */
export function securitySummary(cfg: HexagonConfig, agents: AgentSecurityRow[] = []): string[] {
  const lines = [
    "Enforced by Hexagon:",
    "  - Agents are identified by a per-agent token. They cannot approve a spec, answer a question, merge, change permissions or start runs.",
    "  - Write scope is checked on everything an agent changed, including files it committed itself; out-of-scope paths are reverted and the task's history is folded into one Hexagon commit.",
    "  - Secrets in events, transcripts and status are redacted when written (known key shapes only).",
    "  - Each task works in its own git worktree; agent processes get an allow-listed environment (PATH, HOME, locale, terminal, their own login variables, [agents.x].env_passthrough), not your shell's secrets.",
    "Enforced by the agent's own CLI (only where the integration says so):",
  ];
  for (const a of agents) {
    const s = a.security;
    lines.push(`  - ${a.id} (${a.display_name}): command allow-list ${s?.commandAllowList ? "yes" : "NO"}, read-only roles ${s?.readOnlyEnforced ? "yes" : "NO"}`);
  }
  lines.push(
    "Not enforced:",
    "  - Reading .env files is refused only by integrations that expose a deny rule (not verified against the real CLI); others can read them.",
    "  - There is no OS sandbox. A process running as you can read the Hexagon token file and your files; this protects against confused or prompt-injected agents, not a determined attacker.",
    "  - Allowed build and test tools (npm, go, cargo, …) run project code, which can do anything the project can.",
  );
  for (const w of configWarnings(cfg)) lines.push(`  ! ${w}`);
  return lines;
}
