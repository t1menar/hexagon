import Anthropic from "@anthropic-ai/sdk";
import type { Effort, ErrorKind } from "../contracts/types.js";
import type { AdapterOutcome, AgentAdapter, AgentRunContext, ToolSpec } from "./types.js";
import { formatInjected } from "./types.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

// $ per million tokens: input, output, cache read, cache write (5-minute TTL = 1.25x input).
const PRICING: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-1": { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

// Server-side refusal fallback ("default" routing) + progress-update thinking display.
const BETAS = ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"];

export function costUsd(model: string, u: { input: number; output: number; cache_read: number; cache_write: number }): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (u.input * p.in + u.output * p.out + u.cache_read * p.cacheRead + u.cache_write * p.cacheWrite) / 1_000_000;
}

interface Session { messages: MessageParam[] }

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = "anthropic";
  readonly supportsLiveInput = true;
  private client: Anthropic | undefined;

  constructor(readonly id: string, readonly model: string = "claude-sonnet-5-5") {}

  private api(): Anthropic {
    this.client ??= new Anthropic(); // resolves ANTHROPIC_API_KEY / auth token / `ant auth login` profile
    return this.client;
  }

  async run(ctx: AgentRunContext): Promise<AdapterOutcome> {
    const { host } = ctx;
    const session: Session = (ctx.session as Session | undefined) ?? { messages: [] };
    const messages = session.messages;

    // Opening (or continuation) user turn, with any queued messages appended.
    const opening: ContentBlockParam[] = [];
    if (messages.length === 0) opening.push({ type: "text", text: ctx.firstMessage });
    if (ctx.followUp) opening.push({ type: "text", text: ctx.followUp });
    const queued = host.drainInbox();
    if (queued.length) opening.push({ type: "text", text: formatInjected(queued) });
    if (opening.length) messages.push({ role: "user", content: opening });

    const system: Anthropic.Beta.BetaTextBlockParam[] = ctx.system.map((text, i) => ({
      type: "text",
      text,
      ...(i === ctx.system.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const tools = ctx.host.tools.map(toApiTool);

    let nudges = 0;
    let jsonRetries = 0;
    for (let turn = 0; turn < ctx.maxTurns; turn++) {
      if (ctx.signal.aborted) return { kind: "error", error: err("internal", "cancelled", false), session };

      let msg: Anthropic.Beta.BetaMessage;
      try {
        const stream = this.api().beta.messages.stream(
          {
            model: this.model,
            max_tokens: 64000,
            betas: BETAS,
            fallbacks: "default",
            thinking: { type: "adaptive", display: "updates" },
            output_config: { effort: ctx.effort as Effort },
            system,
            tools,
            tool_choice: { type: "auto" },
            messages,
          },
          { signal: ctx.signal },
        );
        msg = await stream.finalMessage();
        jsonRetries = 0;
      } catch (e) {
        if (ctx.signal.aborted) return { kind: "error", error: err("internal", "cancelled", false), session };
        const mapped = mapError(e);
        if (mapped) return { kind: "error", error: mapped, session };
        // Not an API error: a tool input that could not be parsed. Re-issue the turn.
        if (jsonRetries++ < 2) continue;
        return { kind: "error", error: err("invalid_output", `unparseable tool input: ${String(e)}`, true), session };
      }

      const u = msg.usage;
      const usage = {
        input: u.input_tokens,
        output: u.output_tokens,
        cache_read: u.cache_read_input_tokens ?? 0,
        cache_write: u.cache_creation_input_tokens ?? 0,
      };
      host.emit({ type: "usage", ...usage, cost_usd: costUsd(this.model, usage) });

      for (const b of msg.content) {
        if (b.type === "thinking" && b.thinking.trim()) host.emit({ type: "progress", text: firstLine(b.thinking) });
        if (b.type === "text" && b.text.trim()) host.emit({ type: "progress", text: firstLine(b.text) });
      }

      if (msg.stop_reason === "refusal") {
        const cat = msg.stop_details?.category ?? "unspecified";
        return { kind: "error", error: err("refusal", `model declined (category: ${cat})`, false), session };
      }
      if (msg.stop_reason === "max_tokens") {
        return { kind: "error", error: err("truncated", "response hit max_tokens", true), session };
      }

      // Append-only history: the assistant turn is kept exactly as returned (thinking blocks included).
      messages.push({ role: "assistant", content: msg.content as unknown as ContentBlockParam[] });
      if (msg.stop_reason === "pause_turn") continue;

      const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        if (host.isFinished()) return { kind: "finished", session };
        const inbox = host.drainInbox();
        if (inbox.length) {
          messages.push({ role: "user", content: [{ type: "text", text: formatInjected(inbox) }] });
          continue;
        }
        if (nudges++ >= 2) return { kind: "error", error: err("invalid_output", "agent stopped without calling its submit tool", true), session };
        messages.push({
          role: "user",
          content: [{ type: "text", text: "You ended your turn without calling your submit tool. Continue the task, then call it exactly once as your last action." }],
        });
        continue;
      }

      // Execute sequentially (file writes must not race) but return all results in one user turn.
      const results: ContentBlockParam[] = [];
      for (const t of toolUses) {
        const r = await host.execute(t.name, t.input);
        results.push({ type: "tool_result", tool_use_id: t.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) });
      }
      const inbox = host.drainInbox();
      if (inbox.length) results.push({ type: "text", text: formatInjected(inbox) });
      messages.push({ role: "user", content: results });

      if (host.isFinished()) return { kind: "finished", session };
    }
    return { kind: "error", error: err("stuck", `no result after ${ctx.maxTurns} turns`, true), session };
  }
}

function toApiTool(t: ToolSpec): Anthropic.Beta.BetaTool {
  return { name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Beta.BetaTool["input_schema"] };
}

function err(kind: ErrorKind, message: string, retryable: boolean) {
  return { kind, message, retryable };
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0]!.slice(0, 200);
}

function mapError(e: unknown): { kind: ErrorKind; message: string; retryable: boolean } | null {
  if (e instanceof Anthropic.AuthenticationError) {
    return err("internal", "Claude credentials missing or invalid. Set ANTHROPIC_API_KEY or run `ant auth login`.", false);
  }
  if (e instanceof Anthropic.RateLimitError) return err("transient", `rate limited: ${e.message}`, true);
  if (e instanceof Anthropic.BadRequestError) return err("internal", `bad request: ${e.message}`, false);
  if (e instanceof Anthropic.APIConnectionError) return err("transient", `connection error: ${e.message}`, true);
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    return err(status >= 500 || status === 408 || status === 409 ? "transient" : "internal", `API error ${status}: ${e.message}`, status >= 500 || status === 408 || status === 409);
  }
  if (e instanceof Error && /credential|api key|apiKey|authentication/i.test(e.message)) {
    return err("internal", "Claude credentials not found. Set ANTHROPIC_API_KEY or run `ant auth login`.", false);
  }
  return null;
}

/** One-shot, tool-less call used by the Lead. */
export async function askClaude(model: string, effort: Effort, system: string, question: string): Promise<{ text: string; cost: number }> {
  const client = new Anthropic();
  try {
    const msg = await client.beta.messages
      .stream({
        model,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort },
        system,
        messages: [{ role: "user", content: question }],
      })
      .finalMessage();
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    const u = msg.usage;
    const cost = costUsd(model, { input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0 });
    if (msg.stop_reason === "refusal") return { text: "(the model declined to answer)", cost };
    return { text: text || "(no answer)", cost };
  } catch (e) {
    const m = mapError(e);
    throw new Error(m ? m.message : String(e));
  }
}
