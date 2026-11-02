import type { PriceRow } from "./config.js";
import type { AgentStatus } from "../contracts/types.js";

export interface CostRow {
  key: string;
  attempts: number;
  tokens: { input: number; cache_read: number; output: number };
  /** Cost the CLIs reported, plus estimates from the user's own price table where a CLI reported none. */
  cost_usd: number;
  estimated_usd: number;
  /** Runs that reported nothing and have no price row: their cost is unknown, not zero. */
  unknown_runs: number;
  /** cache_read / (cache_read + input); null when nothing was read. */
  cache_hit: number | null;
}

export interface CostReport {
  by_task: CostRow[];
  by_role: CostRow[];
  by_agent: CostRow[];
  total: CostRow;
  warnings: string[];
}

/** Below this share of cached input, a session is paying full price for context it keeps resending. */
export const LOW_CACHE_HIT = 0.5;

function add(rows: Map<string, CostRow>, key: string, s: AgentStatus, price: PriceRow | undefined): void {
  const r = rows.get(key) ?? { key, attempts: 0, tokens: { input: 0, cache_read: 0, output: 0 }, cost_usd: 0, estimated_usd: 0, unknown_runs: 0, cache_hit: null };
  const u = s.usage;
  r.attempts += 1;
  r.tokens.input += u.input_tokens; r.tokens.cache_read += u.cache_read_tokens; r.tokens.output += u.output_tokens;
  const tokens = u.input_tokens + u.output_tokens + u.cache_read_tokens;
  const ran = u.wall_ms > 0 || u.turns > 0 || tokens > 0;
  if (u.cost_usd > 0) r.cost_usd += u.cost_usd;
  else if (ran && tokens === 0) r.unknown_runs += 1; // it ran and the CLI told us nothing: unknown, not free
  else if (tokens > 0) {
    if (price && (price.input_per_mtok !== undefined || price.output_per_mtok !== undefined)) {
      const est = (u.input_tokens * (price.input_per_mtok ?? 0) + u.cache_read_tokens * (price.cache_read_per_mtok ?? 0) + u.output_tokens * (price.output_per_mtok ?? 0)) / 1e6;
      r.cost_usd += est; r.estimated_usd += est;
    } else r.unknown_runs += 1;
  }
  rows.set(key, r);
}

function finish(rows: Map<string, CostRow>): CostRow[] {
  return [...rows.values()].map((r) => {
    const seen = r.tokens.input + r.tokens.cache_read;
    return { ...r, cost_usd: Math.round(r.cost_usd * 1e6) / 1e6, estimated_usd: Math.round(r.estimated_usd * 1e6) / 1e6, cache_hit: seen > 0 ? r.tokens.cache_read / seen : null };
  });
}

/** Cost of one run, per task (every attempt and every role that touched it), per role and per agent. Pure: no prices of its own. */
export function costReport(statuses: AgentStatus[], prices: Record<string, PriceRow> = {}): CostReport {
  const task = new Map<string, CostRow>(), role = new Map<string, CostRow>(), agent = new Map<string, CostRow>(), all = new Map<string, CostRow>();
  for (const s of statuses) {
    const price = prices[s.agent.id];
    add(task, s.task_id, s, price); add(role, s.role, s, price); add(agent, s.agent.id, s, price); add(all, "total", s, price);
  }
  const by_agent = finish(agent);
  const warnings: string[] = [];
  for (const a of by_agent) {
    if (a.cache_hit !== null && a.cache_hit < LOW_CACHE_HIT && a.tokens.input + a.tokens.cache_read > 20_000) {
      warnings.push(`${a.key}: only ${Math.round(a.cache_hit * 100)}% of its input came from cache. Its sessions are not being reused, or the cache expired between turns.`);
    }
    if (a.unknown_runs) warnings.push(`${a.key}: ${a.unknown_runs} run(s) reported no cost and there is no [prices.${a.key}] row, so their cost is unknown (not zero).`);
  }
  return { by_task: finish(task), by_role: finish(role), by_agent, total: finish(all)[0] ?? { key: "total", attempts: 0, tokens: { input: 0, cache_read: 0, output: 0 }, cost_usd: 0, estimated_usd: 0, unknown_runs: 0, cache_hit: null }, warnings };
}
