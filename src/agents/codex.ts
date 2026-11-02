import { probe } from "./contracts/adapter.js";
import { capabilities } from "./contracts/capabilities.js";
import { selectionFrom, type ModelSelection } from "./contracts/model-selection.js";
import { OneShotAdapter, safeJson, type OneShotSpec } from "./oneshot.js";
import type { AgentAdapter, AgentRunContext } from "./types.js";
import { registerAdapter } from "./adapter-registry.js";

/**
 * OpenAI Codex CLI (`codex exec --json`). Flags used are those in the public documentation (exec, --json, -m/--model,
 * -s/--sandbox, -C, `exec resume <thread>`); this environment had no `codex` binary, so the integration is covered by
 * mock-CLI tests only and has NOT been run against the real CLI. No model listing command is documented → discovery
 * is reported unsupported rather than guessed.
 */
export class CodexAdapter extends OneShotAdapter implements AgentAdapter {
  protected override readonly authEnv = ["OPENAI_*", "CODEX_*"];
  readonly adapterId = "codex";
  readonly provider = "openai";
  readonly displayName = "OpenAI Codex CLI";
  readonly capabilities = capabilities({
    supportsStreaming: true, supportsSessionResume: true, supportsStructuredOutput: true, supportsNativePermissions: true,
    supportsRuntimeModelReporting: false, supportsUsageMetrics: false,
  });
  // `-s read-only` is Codex's own sandbox; it has no per-command allow-list.
  override readonly security = { readOnlyEnforced: true, commandAllowList: false };
  /** Thread ids by Hexagon session id. Only a cache: the stored copy (ctx.handle) wins after a restart. */
  private threads = new Map<string, string>();

  constructor(id: string, command: string[], selection: ModelSelection | string | null, private extra: string[] = []) {
    super(id, command, typeof selection === "object" && selection ? selection : selectionFrom(selection));
  }

  protected override async authStatus() {
    const r = await probe(this.command.slice(0, 1), ["login", "status"]);
    if (r.missing) return { auth: "unknown" as const };
    return r.ok
      ? { auth: "ok" as const, authDetail: (r.stdout + r.stderr).trim().split("\n")[0]?.slice(0, 120) }
      : { auth: "unauthenticated" as const, authDetail: "Codex reports it is not logged in — run `codex login`" };
  }

  private thread(ctx: AgentRunContext): string | null {
    return ctx.handle ?? this.threads.get(ctx.sessionId) ?? null;
  }

  protected override continues(ctx: AgentRunContext): boolean { return ctx.resume && this.thread(ctx) !== null; }

  protected build(ctx: AgentRunContext, prompt: string): OneShotSpec {
    const sandbox = ctx.readOnly ? "read-only" : "workspace-write";
    const head = [...this.command, "exec", "--json", "-C", ctx.cwd, "-s", sandbox, ...this.modelArgs("-m"), ...this.extra];
    const thread = this.continues(ctx) ? this.thread(ctx) : null;
    const argv = thread ? [...head, "resume", thread, "-"] : [...head, "-"];
    return { argv, stdin: prompt }; // "-" = read the prompt from stdin
  }

  protected onLine(line: string, ctx: AgentRunContext): void {
    const e = safeJson(line);
    if (!e) return;
    if (e.type === "thread.started" && typeof e.thread_id === "string") {
      this.threads.set(ctx.sessionId, e.thread_id);
      ctx.host.emit({ type: "session_handle", handle: e.thread_id });
    }
    // Documented shape of `turn.completed` (NOT verified against a real codex: none was available). Missing or odd
    // numbers produce no usage event, so the run is reported as "usage unknown", never as zero.
    const u = e.type === "turn.completed" ? (e.usage as Record<string, unknown> | undefined) : undefined;
    if (u && Number.isFinite(Number(u.input_tokens)) && Number.isFinite(Number(u.output_tokens))) {
      const cached = Math.max(0, Number(u.cached_input_tokens ?? 0) || 0);
      ctx.host.emit({ type: "usage", input: Math.max(0, Number(u.input_tokens) - cached), output: Number(u.output_tokens), cache_read: cached, cache_write: 0, cost_usd: 0, step: true });
    }
    const item = e.item as Record<string, any> | undefined;
    if (e.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") ctx.host.emit({ type: "chat", from: "agent", text: item.text.slice(0, 8000) });
    else if (e.type === "item.started" && item?.type === "command_execution") ctx.host.emit({ type: "tool_call", name: "shell", summary: `$ ${String(item.command ?? "").split("\n")[0]!.slice(0, 140)}` });
    else if (e.type === "error" || e.type === "turn.failed") ctx.host.emit({ type: "progress", text: String(e.message ?? e.error?.message ?? "error").slice(0, 200) });
  }
}

registerAdapter("codex", (id, c, o) => new CodexAdapter(id, c.command?.length ? c.command : ["codex"], selectionFrom(o || c.model), c.args ?? []));
