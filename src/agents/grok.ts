import { probe } from "./contracts/adapter.js";
import { capabilities } from "./contracts/capabilities.js";
import type { DiscoveredModel, ModelDiscoveryResult, ModelSelection } from "./contracts/model-selection.js";
import { selectionFrom } from "./contracts/model-selection.js";
import { OneShotAdapter, safeJson, type OneShotSpec } from "./oneshot.js";
import type { AgentAdapter, AgentRunContext } from "./types.js";
import { registerAdapter } from "./adapter-registry.js";

/**
 * xAI Grok CLI headless mode (`grok -p … --output-format streaming-json`). Flags follow docs.x.ai (-p/--single,
 * -m/--model, -s/--session-id, -r/--resume, --output-format, --cwd, --always-approve). No `grok` binary was available
 * here, so this is tested against a mock CLI only. `grok models` is the documented listing command; its output
 * format is not documented, so identifiers are taken as the first token of each non-empty line and shown as-is.
 */
export class GrokAdapter extends OneShotAdapter implements AgentAdapter {
  protected override readonly authEnv = ["XAI_*", "GROK_*"];
  readonly adapterId = "grok";
  readonly provider = "xai";
  readonly displayName = "xAI Grok CLI";
  /** Grok's headless mode takes the prompt as `-p <text>`: declared, because it is limited by ARG_MAX and visible in `ps`. */
  readonly promptInArgv = true;
  readonly capabilities = capabilities({
    supportsStreaming: true, supportsSessionResume: true, supportsModelDiscovery: true, supportsStructuredOutput: true,
    supportsNativePermissions: false,
  });

  constructor(id: string, command: string[], selection: ModelSelection | string | null, private extra: string[] = []) {
    super(id, command, typeof selection === "object" && selection ? selection : selectionFrom(selection));
  }

  override async discoverModels(): Promise<ModelDiscoveryResult> {
    const r = await probe(this.command.slice(0, 1), ["models"], 15000);
    if (!r.ok) return { supported: false, diagnostic: r.missing ? "grok is not installed" : `\`grok models\` failed: ${(r.stderr || r.stdout).trim().slice(0, 160)}` };
    // Output format is undocumented: if the CLI prints a bulleted list, only bullets are models (headers are skipped);
    // otherwise each non-empty, non-separator line contributes its first token.
    const lines = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !/^[-=─_]{3,}$/.test(l));
    const bullets = lines.filter((l) => /^[-*•]\s+/.test(l));
    const models: DiscoveredModel[] = (bullets.length ? bullets : lines)
      .map((l) => ({ identifier: l.replace(/^[-*•]\s*/, "").split(/\s+/)[0]! })).filter((m) => m.identifier);
    return { supported: true, models, source: "cli", discoveredAt: new Date().toISOString() };
  }

  protected build(ctx: AgentRunContext, prompt: string): OneShotSpec {
    // The sandbox: Grok's headless mode has no documented read-only switch, so the read-only policy is NOT natively
    // enforced; the orchestrator reports that limitation (see security capability reporting).
    const argv = [...this.command, "--cwd", ctx.cwd, "--output-format", "streaming-json", ...this.modelArgs(), ...(ctx.resume ? ["--resume", ctx.sessionId] : ["--session-id", ctx.sessionId]), ...this.extra, "-p", prompt];
    return { argv, stdin: null };
  }

  protected onLine(line: string, ctx: AgentRunContext): void {
    const e = safeJson(line);
    if (!e) { ctx.host.emit({ type: "progress", text: line.slice(0, 200) }); return; }
    if (typeof e.model === "string" && e.type !== "assistant") ctx.host.emit({ type: "model", model: e.model });
    const text = typeof e.text === "string" ? e.text : typeof e.content === "string" ? e.content : null;
    if (text && /assistant|message|text/.test(String(e.type ?? e.role ?? ""))) ctx.host.emit({ type: "chat", from: "agent", text: text.slice(0, 8000) });
  }
}

registerAdapter("grok", (id, c, o) => new GrokAdapter(id, c.command?.length ? c.command : ["grok"], selectionFrom(o || c.model), c.args ?? []), { cli: "grok" });
