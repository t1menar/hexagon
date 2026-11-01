import type { AgentConfig } from "../core/config.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { selectionFrom } from "./contracts/model-selection.js";
import { ExecAdapter } from "./exec.js";
import { GrokAdapter } from "./grok.js";
import { MockAdapter } from "./mock.js";
import type { AgentAdapter } from "./types.js";

export type AdapterFactory = (id: string, conf: AgentConfig, modelOverride?: string | null) => AgentAdapter;

const factories = new Map<string, AdapterFactory>();

/** Register an integration. A new CLI needs only this call: the scheduler, supervisor and TUI see the AgentAdapter contract. */
export function registerAdapter(name: string, factory: AdapterFactory): void {
  factories.set(name, factory);
}

export const adapterNames = (): string[] => [...factories.keys()].sort();

export function createAdapter(id: string, conf: AgentConfig, modelOverride?: string | null): AgentAdapter {
  const f = factories.get(conf.adapter);
  if (!f) throw new Error(`[agents.${id}] unknown adapter "${conf.adapter}" (available: ${adapterNames().join(", ")}). No fallback is used.`);
  return f(id, conf, modelOverride);
}

const cmd = (c: AgentConfig, dflt: string) => (c.command?.length ? c.command : [dflt]);
const sel = (c: AgentConfig, o?: string | null) => selectionFrom(o || c.model);

registerAdapter("claude-code", (id, c, o) => new ClaudeCodeAdapter(id, { command: cmd(c, "claude"), model: null, selection: sel(c, o), args: c.args ?? [] }));
registerAdapter("codex", (id, c, o) => new CodexAdapter(id, cmd(c, "codex"), sel(c, o), c.args ?? []));
registerAdapter("grok", (id, c, o) => new GrokAdapter(id, cmd(c, "grok"), sel(c, o), c.args ?? []));
registerAdapter("mock", (id, c) => new MockAdapter(id, c.step_ms ?? 600));
registerAdapter("exec", (id, c) => {
  if (!c.command?.length) throw new Error(`[agents.${id}] needs command = ["…"]`);
  return new ExecAdapter(id, c.command, c.interactive ?? null, c.provider ?? "unknown");
});
