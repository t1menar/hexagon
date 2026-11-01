import type { AgentConfig } from "../core/config.js";
import type { AgentAdapter } from "./types.js";

export type AdapterFactory = (id: string, conf: AgentConfig, modelOverride?: string | null) => AgentAdapter;

/** What an integration says about itself when it registers. Everything vendor-specific lives in the integration's own file. */
export interface AdapterMeta {
  /** An agent entry that exists without being written in config.toml (id, and the settings of the entry). */
  defaultAgent?: Omit<AgentConfig, "id">;
  /** The agent id roles use when config.toml says nothing: exactly one integration sets this. */
  primary?: boolean;
  /** Old adapter names that still load, mapped onto this integration. */
  aliases?: string[];
  /** Adjust an entry written for an old alias (drop settings that no longer apply). */
  migrate?(entry: AgentConfig): void;
}

const factories = new Map<string, AdapterFactory>();
const metas = new Map<string, AdapterMeta & { agentId?: string }>();

/**
 * Register an integration. A new CLI needs only this call: the scheduler, supervisor and TUI see the AgentAdapter
 * contract. `agentId` names its default agent entry.
 */
export function registerAdapter(name: string, factory: AdapterFactory, meta: AdapterMeta & { agentId?: string } = {}): void {
  factories.set(name, factory);
  metas.set(name, meta);
}

export const adapterNames = (): string[] => [...factories.keys()].sort();

export function createAdapter(id: string, conf: AgentConfig, modelOverride?: string | null): AgentAdapter {
  const f = factories.get(conf.adapter);
  if (!f) throw new Error(`[agents.${id}] unknown adapter "${conf.adapter}" (available: ${adapterNames().join(", ")}). No fallback is used.`);
  return f(id, conf, modelOverride);
}

/** Agent entries every project has without writing them: one per integration that declares one. */
export function defaultAgents(): Record<string, AgentConfig> {
  const out: Record<string, AgentConfig> = {};
  for (const m of metas.values()) if (m.defaultAgent && m.agentId) out[m.agentId] = { id: m.agentId, ...m.defaultAgent };
  return out;
}

/** The agent roles use unless configured otherwise. */
export function primaryAgentId(): string {
  for (const m of metas.values()) if (m.primary && m.agentId) return m.agentId;
  throw new Error("no integration is registered as the primary agent");
}

/** An entry written with an old adapter name is rewritten to the current one. */
export function migrateAgentEntry(entry: AgentConfig): void {
  for (const [name, m] of metas) {
    if (m.aliases?.includes(entry.adapter)) {
      entry.adapter = name;
      m.migrate?.(entry);
      return;
    }
  }
}
