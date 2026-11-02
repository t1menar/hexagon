import { spawn } from "node:child_process";
import { AdapterBase } from "./contracts/base.js";
import type { AdapterOutcome, AgentRunContext } from "./types.js";
import { formatInjected } from "./types.js";

/** Splits arbitrary stdout chunks into complete lines; the partial tail waits for the next chunk (or flush). */
export class LineBuffer {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    return parts.map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
  }
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }
}

export interface OneShotSpec {
  argv: string[];
  /** Prompt written to stdin (never interpolated into a shell). null = it is already in argv. */
  stdin: string | null;
  /** Called once when the process has ended (temp files). */
  cleanup?: () => void;
}

/**
 * Base for non-interactive CLIs that run once per invocation and print results. Spawns with an argument array and
 * shell:false, kills the whole process group on abort, parses stdout line by line (chunk-boundary safe),
 * keeps stderr, and hands the raw output to the error classifier on failure.
 */
export abstract class OneShotAdapter extends AdapterBase {
  protected abstract build(ctx: AgentRunContext, prompt: string): OneShotSpec;
  /** Turn one stdout line into events; unknown/malformed lines must never throw. */
  protected abstract onLine(line: string, ctx: AgentRunContext): void;
  takeoverCommand(_sessionId?: string): string[] | null { return null; }

  /** Does this run continue a conversation the CLI already holds? Adapters that can lose the handle override it. */
  protected continues(ctx: AgentRunContext): boolean { return ctx.resume; }

  /** A continued conversation already has the system text and the card: only the new message is sent. */
  protected promptFor(ctx: AgentRunContext): string {
    const inbox = ctx.host.drainInbox();
    for (const m of inbox) ctx.host.received(m.id);
    const cont = this.continues(ctx);
    const body = [cont && ctx.followUp ? ctx.followUp : ctx.prompt, inbox.length ? formatInjected(inbox) : ""].filter(Boolean).join("\n\n");
    return cont ? body : `${ctx.system}\n\n---\n\n${body}`;
  }

  run(ctx: AgentRunContext): Promise<AdapterOutcome> {
    const spec = this.build(ctx, this.promptFor(ctx));
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: ctx.cwd, env: this.processEnv(ctx.env), stdio: ["pipe", "pipe", "pipe"], detached: true, shell: false });
      } catch (e) {
        return resolve({ kind: "error", error: { kind: "internal", message: `cannot start ${spec.argv[0]}: ${(e as Error).message}`, retryable: false } });
      }
      const lines = new LineBuffer();
      let tail = "";
      let stderr = "";
      const handle = (ls: string[]) => { for (const l of ls) { tail = (tail + l + "\n").slice(-4000); try { this.onLine(l, ctx); } catch { /* malformed line */ } } };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => handle(lines.push(d)));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => { stderr = (stderr + d).slice(-4000); });
      child.stdin.on("error", () => { /* process exited early */ });
      child.stdin.end(spec.stdin ?? "");
      const kill = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } };
      ctx.signal.addEventListener("abort", kill, { once: true });
      child.on("error", (e) => { try { spec.cleanup?.(); } catch { /* best effort */ } resolve({ kind: "error", error: { kind: "internal", message: `cannot start ${spec.argv[0]}: ${e.message} — is it installed and on PATH?`, retryable: false } }); });
      child.on("close", (code, sig) => {
        try { spec.cleanup?.(); } catch { /* best effort */ }
        handle(lines.flush());
        ctx.signal.removeEventListener("abort", kill);
        if (ctx.signal.aborted) return resolve({ kind: "interrupted" });
        if ((code !== 0 || sig) && !ctx.host.isFinished()) {
          const raw = `${stderr}\n${tail}`;
          return resolve({ kind: "error", error: { kind: "transient", message: `${spec.argv[0]} exited ${code ?? sig}: ${(stderr || tail).trim().split("\n").at(-1)?.slice(0, 300) ?? "no output"}`, retryable: true, raw } });
        }
        resolve({ kind: "finished" });
      });
    });
  }
}

export function safeJson(line: string): Record<string, any> | null {
  try { const v = JSON.parse(line); return v && typeof v === "object" ? v : null; } catch { return null; }
}
