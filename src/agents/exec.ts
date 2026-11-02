import { spawn } from "node:child_process";
import { AdapterBase } from "./contracts/base.js";
import { capabilities } from "./contracts/capabilities.js";
import type { AdapterOutcome, AgentAdapter, AgentRunContext } from "./types.js";
import { formatInjected } from "./types.js";
import { registerAdapter } from "./adapter-registry.js";

/**
 * Generic wrapper for any non-interactive coding CLI (anything that takes the prompt as an argument).
 * The prompt (system + task) is passed as an argument: `{prompt}` in the command is replaced, otherwise
 * it is appended. No live input: messages that arrive while it runs are delivered on the next run.
 * The agent reports back through the same `hexagon …` shell commands as every other agent.
 */
export class ExecAdapter extends AdapterBase implements AgentAdapter {
  readonly adapterId = "exec";
  readonly provider: string;
  readonly displayName = "Generic CLI";
  // A generic wrapper claims nothing it cannot do: no discovery, no usage, no runtime model.
  readonly capabilities = capabilities({ supportsStreaming: false, supportsSessionResume: false });

  constructor(id: string, command: string[], private interactive: string[] | null, provider = "unknown") {
    super(id, command);
    this.provider = provider;
  }

  takeoverCommand(): string[] | null {
    return this.interactive;
  }

  run(ctx: AgentRunContext): Promise<AdapterOutcome> {
    const inbox = ctx.host.drainInbox();
    const body = [ctx.resume && ctx.followUp ? ctx.followUp : ctx.prompt, inbox.length ? formatInjected(inbox) : ""].filter(Boolean).join("\n\n");
    const prompt = `${ctx.system}\n\n---\n\n${body}`;
    const hasSlot = this.command.some((a) => a.includes("{prompt}"));
    const argv = hasSlot ? this.command.map((a) => a.replace("{prompt}", prompt)) : [...this.command, prompt];
    for (const m of inbox) ctx.host.received(m.id);
    return new Promise((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: ctx.cwd, env: this.processEnv(ctx.env), stdio: ["ignore", "pipe", "pipe"], detached: true });
      let tail = "";
      const onLine = (d: Buffer) => {
        tail = (tail + d.toString()).slice(-4000);
        const line = d.toString().trim().split("\n").filter(Boolean).at(-1);
        if (line) ctx.host.emit({ type: "progress", text: line.slice(0, 200) });
      };
      child.stdout.on("data", onLine);
      child.stderr.on("data", onLine);
      const onAbort = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (e) => resolve({ kind: "error", error: { kind: "internal", message: `cannot start ${argv[0]}: ${e.message}`, retryable: false } }));
      child.on("close", (code) => {
        ctx.signal.removeEventListener("abort", onAbort);
        if (ctx.signal.aborted) return resolve({ kind: "interrupted" });
        if (code !== 0 && !ctx.host.isFinished()) {
          return resolve({ kind: "error", error: { kind: "transient", message: `${argv[0]} exited ${code}: ${tail.slice(-300)}`, retryable: true, raw: tail } });
        }
        resolve({ kind: "finished" });
      });
    });
  }
}

registerAdapter("exec", (id, c) => {
  if (!c.command?.length) throw new Error(`[agents.${id}] needs command = ["…"]`);
  return new ExecAdapter(id, c.command, c.interactive ?? null, c.provider ?? "unknown");
});
