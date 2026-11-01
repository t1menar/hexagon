import readline from "node:readline/promises";
import type { AgentCapabilities } from "../agents/contracts/capabilities.js";
import type { ModelDiscoveryResult } from "../agents/contracts/model-selection.js";
import { describeSelection } from "../agents/contracts/model-selection.js";
import type { AgentInfo } from "../daemon/orchestrator.js";

const yn = (b: boolean) => (b ? "yes" : "no");

export function capabilityLines(c: AgentCapabilities): string[] {
  return [
    `streaming ${yn(c.supportsStreaming)} · session resume ${yn(c.supportsSessionResume)} · live input ${yn(c.supportsLiveInput)} · takeover ${yn(c.supportsInteractiveTakeover)}`,
    `model discovery ${yn(c.supportsModelDiscovery)} · runtime model reporting ${yn(c.supportsRuntimeModelReporting)} · usage metrics ${yn(c.supportsUsageMetrics)}`,
    `structured output ${yn(c.supportsStructuredOutput)} · native permissions ${yn(c.supportsNativePermissions)}`,
  ];
}

/** One agent as the multi-line block shown by `hexagon agents list|doctor`. */
export function formatAgent(a: AgentInfo, verbose: boolean): string {
  const d = a.diagnostics;
  const out: string[] = [];
  out.push(`${a.id}  —  ${a.display_name}`);
  if (a.error) { out.push(`  ✖ configuration error: ${a.error}`); return out.join("\n"); }
  out.push(`  Provider:         ${a.provider}`);
  out.push(`  Adapter:          ${a.adapter}${a.command ? `   command: ${a.command.join(" ")}` : ""}`);
  out.push(`  Executable:       ${d?.installed ? d.executable : "not found"}`);
  out.push(`  CLI version:      ${d?.version ?? "unknown"}`);
  out.push(`  Authentication:   ${d ? `${d.auth}${d.authDetail ? ` (${d.authDetail})` : ""}` : "unknown"}`);
  out.push(`  Model selection:  ${a.selection ? describeSelection(a.selection) : "—"}`);
  out.push(`  Model discovery:  ${a.capabilities?.supportsModelDiscovery ? "supported (hexagon agents models " + a.id + ")" : "unsupported — the CLI manages its own model configuration"}`);
  out.push(`  Runtime model:    reported per execution (shown on the dashboard); Unknown when the CLI does not say`);
  out.push(`  Used by roles:    ${a.roles.length ? a.roles.map((r) => r.role + (r.model_override ? ` [override ${r.model_override}]` : "")).join(", ") : "—"}`);
  if (verbose && a.capabilities) for (const l of capabilityLines(a.capabilities)) out.push(`  Capabilities:     ${l}`);
  for (const p of d?.problems ?? []) out.push(`  ⚠ ${p}`);
  return out.join("\n");
}

export function formatModels(agent: string, r: ModelDiscoveryResult): string {
  if (!r.supported) return `${agent}: model discovery unsupported. ${r.diagnostic ?? ""}\nThe CLI's own default is used unless you set a custom identifier (hexagon model <role> <identifier>).`;
  const list = r.models ?? [];
  return `${agent}: ${list.length} model(s) reported by the CLI${r.discoveredAt ? ` at ${r.discoveredAt}` : ""}\n${list.map((m) => `  - ${m.identifier}${m.label ? `  (${m.label})` : ""}`).join("\n") || "  (none)"}`;
}

/** Interactive role → agent → model menu. Options come from the live adapter; nothing is built in. */
export async function configureInteractive(
  call: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const rl = readline.createInterface(io);
  const say = (s: string) => io.output.write(s + "\n");
  const pick = async (title: string, options: string[]): Promise<number> => {
    say(`\n${title}`);
    options.forEach((o, i) => say(`  ${i + 1}) ${o}`));
    for (;;) {
      const n = Number((await rl.question("> ")).trim());
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      say(`Enter a number 1-${options.length}.`);
    }
  };
  try {
    const roles = (await call<{ role: string; agent: string }[]>("models.list")).map((m) => m.role);
    const role = roles[await pick("Role:", roles)]!;
    const agents = await call<AgentInfo[]>("agents.list");
    const ai = await pick("Agent (provider · CLI · version):", agents.map((a) => `${a.id} — ${a.provider} · ${a.display_name} · ${a.diagnostics?.version ?? "version unknown"}${a.diagnostics?.installed === false ? "  [not installed]" : ""}${a.error ? "  [config error]" : ""}`));
    const agent = agents[ai]!;
    say("\n" + formatAgent(agent, true));
    await call("agents.role", { role, agent: agent.id });
    const disc = await call<ModelDiscoveryResult>("agents.models", { agent: agent.id });
    const opts = ["Use the CLI's own default (recommended)", ...(disc.supported ? (disc.models ?? []).map((m) => `${m.identifier}${m.label ? `  (${m.label})` : ""}`) : []), "Enter a custom model identifier…"];
    if (!disc.supported) say(`\nModel discovery: unsupported${disc.diagnostic ? ` — ${disc.diagnostic}` : ""}`);
    const mi = await pick(`Model for ${role}:`, opts);
    if (mi === 0) await call("models.set", { role, model: null });
    else if (mi === opts.length - 1) {
      const id = (await rl.question("Custom model identifier: ")).trim();
      if (id) await call("models.set", { role, model: id });
    } else await call("models.set", { role, model: disc.models![mi - 1]!.identifier });
    say(`\nSaved. ${role} → ${agent.id}. New sessions use it; running agents keep theirs.`);
  } finally {
    rl.close();
  }
}
