/**
 * Example third-party integration for a fictional CLI `acme`:
 *   acme --version            → "acme 1.2.3"
 *   acme models               → one model identifier per line
 *   acme run --json [--model X] [--resume ID]   (prompt on stdin) → JSON lines {"type":"text","text":…} / {"type":"model","name":…}
 * It is registered with `registerAdapter`; nothing in the scheduler, supervisor or TUI changes.
 */
import { capabilities } from "../src/agents/contracts/capabilities.js";
import { selectionFrom, type ModelDiscoveryResult } from "../src/agents/contracts/model-selection.js";
import { probe } from "../src/agents/contracts/adapter.js";
import { OneShotAdapter, safeJson, type OneShotSpec } from "../src/agents/oneshot.js";
import { registerAdapter } from "../src/agents/registry.js";
import type { AgentRunContext } from "../src/agents/types.js";

export class AcmeAdapter extends OneShotAdapter {
  readonly adapterId = "acme";
  readonly provider = "acme-corp";
  readonly displayName = "Acme CLI";
  readonly capabilities = capabilities({ supportsStreaming: true, supportsModelDiscovery: true, supportsRuntimeModelReporting: true, supportsSessionResume: true });
  // This CLI can only be read-only through a flag we do not rely on, so we claim nothing (the default).

  override async discoverModels(): Promise<ModelDiscoveryResult> {
    const r = await probe(this.command.slice(0, 1), ["models"]);
    if (!r.ok) return { supported: false, diagnostic: r.missing ? "acme is not installed" : r.stderr.slice(0, 160) };
    const models = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((identifier) => ({ identifier }));
    return { supported: true, models, source: "cli", discoveredAt: new Date().toISOString() };
  }

  protected build(ctx: AgentRunContext, prompt: string): OneShotSpec {
    // modelArgs() is empty when the user chose no override → the CLI keeps its own default.
    const argv = [...this.command, "run", "--json", ...this.modelArgs(), ...(ctx.resume ? ["--resume", ctx.sessionId] : [])];
    return { argv, stdin: prompt }; // the prompt travels on stdin, never inside a shell string
  }

  protected onLine(line: string, ctx: AgentRunContext): void {
    const e = safeJson(line);
    if (!e) return; // malformed lines are ignored, never fatal
    if (e.type === "model" && typeof e.name === "string") ctx.host.emit({ type: "model", model: e.name }); // runtime identity, as reported
    if (e.type === "text" && typeof e.text === "string") ctx.host.emit({ type: "chat", from: "agent", text: e.text });
  }
}

registerAdapter("acme", (id, conf, override) => new AcmeAdapter(id, conf.command?.length ? conf.command : ["acme"], selectionFrom(override || conf.model)));
