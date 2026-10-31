import { spawn } from "node:child_process";
import type { AdapterOutcome, AgentAdapter, AgentRunContext } from "./types.js";
import { formatInjected, MESSAGE_ID_RE } from "./types.js";

export interface CliAgentConfig {
  /** Executable + fixed leading args, e.g. ["claude"]. */
  command: string[];
  model: string | null;
  /** Extra args appended verbatim. */
  args: string[];
}

const MAX_NUDGES = 2;

/**
 * Wraps the Claude Code CLI (`claude -p --input-format stream-json --output-format stream-json`).
 * Claude Code runs its own agent loop and tools in the task's worktree; Hexagon only
 * feeds it user messages on stdin and folds its event stream into the status contract.
 * The agent talks back by running `hexagon report|ask|note|done|review` (see protocol.ts).
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly provider = "claude-code";
  readonly supportsLiveInput = true;

  constructor(readonly id: string, private conf: CliAgentConfig) {}

  get model(): string | null {
    return this.conf.model;
  }

  takeoverCommand(sessionId: string): string[] {
    return [...this.conf.command, "--resume", sessionId];
  }

  args(ctx: AgentRunContext): string[] {
    const a = [
      ...this.conf.command.slice(1),
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
      ctx.resume ? "--resume" : "--session-id", ctx.sessionId,
      "--append-system-prompt", ctx.system,
      "--effort", ctx.effort,
    ];
    if (this.conf.model) a.push("--model", this.conf.model);
    a.push(...this.conf.args);
    const hex = ["Bash(hexagon:*)", ...(ctx.env.HEXAGON_BIN ? [`Bash(${ctx.env.HEXAGON_BIN}:*)`] : [])];
    if (ctx.readOnly) {
      a.push("--permission-mode", "default", "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit");
      a.push("--allowedTools", "Read", "Glob", "Grep", ...hex, ...ctx.allowCommands.filter((c) => c !== "*").map(bashRule));
    } else if (ctx.allowCommands.includes("*")) {
      a.push("--permission-mode", "bypassPermissions");
    } else {
      a.push("--permission-mode", "acceptEdits");
      a.push("--allowedTools", "Read", "Glob", "Grep", "Edit", "Write", "MultiEdit", "TodoWrite", ...hex, ...ctx.allowCommands.map(bashRule));
    }
    return a;
  }

  run(ctx: AgentRunContext): Promise<AdapterOutcome> {
    const [bin] = this.conf.command;
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(bin!, this.args(ctx), {
        cwd: ctx.cwd,
        env: { ...process.env, ...ctx.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      let stderr = "";
      let buf = "";
      let sent = 0;
      let replayed = 0;
      let nudges = 0;
      let lastCost = 0;
      let lastError: AdapterOutcome["error"];
      // Usage arrives on every assistant event of a model call; report each call once.
      let step: { id: string; usage: Record<string, number> } | null = null;
      const flushStep = () => {
        if (!step) return;
        const u = step.usage;
        host.emit({
          type: "usage", step: true,
          input: Number(u.input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
          output: Number(u.output_tokens ?? 0),
          cache_read: Number(u.cache_read_input_tokens ?? 0),
          cache_write: Number(u.cache_creation_input_tokens ?? 0),
          cost_usd: 0,
        });
        step = null;
      };
      let stdinOpen = true;
      const host = ctx.host;

      const write = (text: string) => {
        if (!stdinOpen) return;
        child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
        sent++;
      };
      const close = () => {
        if (stdinOpen) { stdinOpen = false; child.stdin.end(); }
      };
      const kill = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } };
      const deliverInbox = (): boolean => {
        const msgs = host.drainInbox();
        if (!msgs.length) return false;
        write(formatInjected(msgs));
        return true;
      };

      const unsubscribe = host.onInbox(() => {
        // Live input: Claude Code picks queued messages up at its next safe point.
        if (stdinOpen && !host.isFinished()) deliverInbox();
      });
      const onAbort = () => kill();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const idle = () => {
        // The CLI finished a turn and has no queued input left.
        if (host.isFinished()) return close();
        if (deliverInbox()) return;
        if (host.hasBlockingQuestion()) return; // wait; the answer arrives through the inbox
        if (ctx.conversational) return host.emit({ type: "progress", text: "ready" }); // chat: wait for the next message
        if (nudges++ < MAX_NUDGES) {
          write("You ended your turn without reporting a result. If you are finished, run `hexagon done ...` (see the Hexagon protocol); otherwise continue the task.");
          return;
        }
        close();
      };

      const onEvent = (e: Record<string, any>) => {
        switch (e.type) {
          case "system":
            if (e.subtype === "init") host.emit({ type: "progress", text: `session started (${e.model ?? "claude"})` });
            break;
          case "user": {
            if (e.isReplay) {
              replayed++;
              const text = typeof e.message?.content === "string" ? e.message.content : JSON.stringify(e.message?.content ?? "");
              for (const m of text.matchAll(MESSAGE_ID_RE)) host.received(m[1]!);
              break;
            }
            for (const c of asArray(e.message?.content)) {
              if (c.type === "tool_result" && c.is_error) {
                host.emit({ type: "tool_result", name: "tool", ok: false, summary: firstLine(contentText(c.content), 160) });
              }
            }
            break;
          }
          case "assistant": {
            const id = String(e.message?.id ?? "");
            if (step && step.id !== id) flushStep();
            if (e.message?.usage) step = { id, usage: e.message.usage };
            for (const c of asArray(e.message?.content)) {
              if (c.type === "tool_use") {
                const summary = toolSummary(c.name, c.input ?? {});
                if (summary) host.emit({ type: "tool_call", name: c.name, summary });
              } else if (c.type === "text" && c.text?.trim()) {
                host.emit({ type: "chat", from: "agent", text: c.text.trim().slice(0, 8000) });
              }
            }
            break;
          }
          case "result": {
            flushStep();
            const total = Number(e.total_cost_usd ?? 0);
            // Tokens were counted per step; keep the CLI's cost estimate for local records only.
            host.emit({ type: "usage", input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: Math.max(0, total - lastCost) });
            lastCost = Math.max(lastCost, total);
            if (e.is_error) {
              const msg = String(e.result ?? e.subtype ?? "error");
              lastError = { kind: /rate|overload|5\d\d|timeout/i.test(msg) ? "transient" : "internal", message: msg, retryable: true };
              close();
              break;
            }
            if (replayed >= sent) idle();
            break;
          }
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try { onEvent(JSON.parse(line)); } catch { /* not JSON: ignore */ }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => { stderr = (stderr + d).slice(-4000); });
      child.stdin.on("error", () => { stdinOpen = false; });

      const finish = (o: AdapterOutcome) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        ctx.signal.removeEventListener("abort", onAbort);
        resolve(o);
      };
      child.on("error", (err) => finish({
        kind: "error",
        error: { kind: "internal", message: `cannot start ${bin}: ${err.message} — is it installed and on PATH?`, retryable: false },
      }));
      child.on("close", (code) => {
        if (ctx.signal.aborted) return finish({ kind: "interrupted" });
        if (lastError) return finish({ kind: "error", error: lastError });
        if (code !== 0 && !host.isFinished()) {
          return finish({ kind: "error", error: { kind: "transient", message: `${bin} exited ${code}: ${firstLine(stderr, 300) || "no output"}`, retryable: true } });
        }
        finish({ kind: "finished" });
      });

      write(ctx.resume && ctx.followUp ? ctx.followUp : ctx.prompt);
      // Messages queued before start go right after the first prompt.
      deliverInbox();
    });
  }
}

function bashRule(prefix: string): string {
  return `Bash(${prefix}:*)`;
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  return asArray(c).map((x) => (typeof x?.text === "string" ? x.text : "")).join(" ");
}

function firstLine(s: string, n: number): string {
  const line = s.trim().split("\n").find((l) => l.trim()) ?? "";
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
}

/** One-line summary of a Claude Code tool call for the activity feed (null = don't show). */
export function toolSummary(name: string, input: Record<string, any>): string | null {
  const rel = (p: unknown) => String(p ?? "").replace(/^.*\/\.hexagon\/worktrees\/[^/]+\/[^/]+\//, "");
  switch (name) {
    case "Bash": {
      const cmd = String(input.command ?? "");
      if (/^\S*hexagon (report|note)\b/.test(cmd)) return null; // shown as status instead
      return `$ ${firstLine(cmd, 140)}`;
    }
    case "Read": return `read ${rel(input.file_path)}`;
    case "Edit": case "MultiEdit": return `edit ${rel(input.file_path)}`;
    case "Write": return `write ${rel(input.file_path)}`;
    case "Glob": return `glob ${input.pattern ?? ""}`;
    case "Grep": return `grep ${input.pattern ?? ""}`;
    case "TodoWrite": {
      const todos = asArray(input.todos);
      const cur = todos.find((t) => t.status === "in_progress");
      return cur ? `todo: ${firstLine(String(cur.content ?? cur.activeForm ?? ""), 120)}` : `todo list (${todos.length})`;
    }
    case "Task": case "Agent": return `subagent: ${firstLine(String(input.description ?? ""), 100)}`;
    case "WebFetch": return `fetch ${input.url ?? ""}`;
    case "WebSearch": return `search ${input.query ?? ""}`;
    default: return name;
  }
}

/** Ask Claude Code a one-off question (no tools). */
export function askOnce(command: string[], model: string | null, system: string, question: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [...command.slice(1), "-p", "--output-format", "json", "--append-system-prompt", system, "--tools", "", ...(model ? ["--model", model] : [])];
    const child = spawn(command[0]!, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const j = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (j.is_error) return reject(new Error(j.result ?? "error"));
        resolve(j.result ?? "");
      } catch {
        reject(new Error(`claude exited ${code}: ${err.slice(0, 300) || out.slice(0, 300)}`));
      }
    });
    child.stdin.end(question);
  });
}
