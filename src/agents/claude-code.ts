import { spawn } from "node:child_process";
import { probe } from "./contracts/adapter.js";
import { AdapterBase } from "./contracts/base.js";
import { capabilities } from "./contracts/capabilities.js";
import { classifyProviderError } from "./contracts/errors.js";
import { selectionFrom, type ModelSelection } from "./contracts/model-selection.js";
import type { AdapterOutcome, AgentAdapter, AgentRunContext } from "./types.js";
import { formatInjected, MESSAGE_ID_RE } from "./types.js";
import { registerAdapter } from "./adapter-registry.js";
import type { AgentConfig } from "../core/config.js";

export interface CliAgentConfig {
  /** Executable + fixed leading args, e.g. ["claude"]. */
  command: string[];
  /** Optional user override passed as `--model`. null = the CLI's own configuration decides. */
  model: string | null;
  /** Extra args appended verbatim. */
  args: string[];
  /** Overrides `model` when set. */
  selection?: ModelSelection;
}

const MAX_NUDGES = 2;

/**
 * Wraps the Claude Code CLI (`claude -p --input-format stream-json --output-format stream-json`).
 * Claude Code runs its own agent loop and tools in the task's worktree; Hexagon only
 * feeds it user messages on stdin and folds its event stream into the status contract.
 * The agent talks back by running `hexagon report|ask|note|done|review` (see protocol.ts).
 */
/** Reading dotenv files is refused by default; the user lifts it by editing the adapter command args. */
const SECRET_FILES = ["Read(**/.env)", "Read(**/.env.*)", "Bash(cat .env:*)", "Bash(cat ./.env:*)"];

export class ClaudeCodeAdapter extends AdapterBase implements AgentAdapter {
  readonly adapterId = "claude-code";
  readonly provider = "anthropic";
  readonly displayName = "Claude Code";
  readonly capabilities = capabilities({
    supportsStreaming: true, supportsSessionResume: true, supportsLiveInput: true, supportsInteractiveTakeover: true,
    supportsModelDiscovery: false, // `claude` has no model-listing command (verified with `claude --help`)
    supportsRuntimeModelReporting: true, // stream-json `system/init` carries the serving model
    supportsUsageMetrics: true, supportsStructuredOutput: true, supportsNativePermissions: true,
    supportsNativeCompaction: false, // `/compact` did not complete in stream-json mode when probed (CLI 2.1.316): Hexagon compacts
    resumeAcrossCwd: true, // verified: `claude --resume <id>` from another directory continues the session (CLI 2.1.316)
  });

  override readonly security = { readOnlyEnforced: true, commandAllowList: true };
  protected override readonly authEnv = ["ANTHROPIC_*", "CLAUDE_*"];

  constructor(id: string, private conf: CliAgentConfig) {
    super(id, conf.command, conf.selection ?? selectionFrom(conf.model));
  }

  protected override async authStatus() {
    const r = await probe(this.command.slice(0, 1), ["auth", "status"]);
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string };
      if (j.loggedIn === true) return { auth: "ok" as const, authDetail: j.authMethod ? `logged in (${j.authMethod})` : "logged in" };
      if (j.loggedIn === false) return { auth: "unauthenticated" as const, authDetail: "Claude Code is not logged in — run `claude auth login`" };
    } catch { /* fall through */ }
    return { auth: "unknown" as const, authDetail: "could not read `claude auth status`" };
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
    a.push(...this.modelArgs());
    a.push(...this.conf.args);
    const hex = ["Bash(hexagon:*)", ...(ctx.env.HEXAGON_BIN ? [`Bash(${ctx.env.HEXAGON_BIN}:*)`] : [])];
    if (ctx.readOnly) {
      a.push("--permission-mode", "default", "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit", ...SECRET_FILES);
      a.push("--allowedTools", "Read", "Glob", "Grep", ...hex, ...ctx.allowCommands.filter((c) => c !== "*").map(bashRule));
    } else if (ctx.allowCommands.includes("*")) {
      a.push("--permission-mode", "bypassPermissions");
    } else {
      a.push("--permission-mode", "acceptEdits", "--disallowedTools", ...SECRET_FILES);
      a.push("--allowedTools", "Read", "Glob", "Grep", "Edit", "Write", "MultiEdit", "TodoWrite", ...hex, ...ctx.allowCommands.map(bashRule));
    }
    return a;
  }

  run(ctx: AgentRunContext): Promise<AdapterOutcome> {
    const [bin] = this.conf.command;
    // Tests set this so that a role nobody pointed at the mock agent fails loudly instead of spending real tokens.
    if (process.env.HEXAGON_NO_REAL_CLI === "1" && bin === "claude") {
      return Promise.resolve({ kind: "error", error: { kind: "internal", message: "the real CLI is disabled (HEXAGON_NO_REAL_CLI=1)", retryable: false } });
    }
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(bin!, this.args(ctx), {
        cwd: ctx.cwd,
        env: this.processEnv(ctx.env),
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
      const toolUses = new Map<string, { name: string; input: Record<string, unknown> }>();
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
            if (e.subtype === "init") {
              // The runtime model is whatever the process reports; never substituted with a guess.
              if (typeof e.model === "string" && e.model) host.emit({ type: "model", model: e.model });
              host.emit({ type: "progress", text: "session started" });
            }
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
                const text = contentText(c.content);
                host.emit({ type: "tool_result", name: "tool", ok: false, summary: firstLine(text, 160) });
                const missing = /command not found:\s*([\w.+-]+)|([\w.+-]+): command not found|([\w.+-]+): not found/.exec(text);
                if (missing) host.emit({ type: "tool_missing", command: missing[1] ?? missing[2] ?? missing[3]! });
                const use = toolUses.get(String(c.tool_use_id ?? ""));
                if (use && /requires approval|permission to use|haven't granted|not allowed|was blocked/i.test(text)) {
                  // For compound commands Claude Code names the part it refused: approve just that part.
                  const part = /following part requires approval:\s*(.+)/i.exec(text)?.[1]?.trim();
                  const command = use.name === "Bash" ? part ?? String(use.input.command ?? "") : use.name;
                  // "ls in '/usr/local/go/bin' was blocked": a folder outside the project, which no prefix rule lifts.
                  host.emit({ type: "permission_denied", tool: /was blocked/i.test(text) ? "path" : use.name, command });
                }
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
                toolUses.set(String(c.id ?? ""), { name: String(c.name), input: c.input ?? {} });
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
            // The CLI reports the real context window of the model it used: prefer it to any assumed size.
            const mu = Object.values((e.modelUsage ?? {}) as Record<string, { contextWindow?: number }>);
            const window = Math.max(0, ...mu.map((m) => Number(m.contextWindow ?? 0)));
            host.emit({ type: "usage", input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: Math.max(0, total - lastCost), ...(window > 0 ? { window } : {}) });
            lastCost = Math.max(lastCost, total);
            if (e.is_error) {
              const msg = String(e.result ?? e.subtype ?? "error");
              lastError = { kind: classifyProviderError(msg).cls === "unknown" ? "internal" : "transient", message: msg, retryable: true, raw: msg };
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
          return finish({ kind: "error", error: { kind: "transient", message: `${bin} exited ${code}: ${firstLine(stderr, 300) || "no output"}`, retryable: true, raw: stderr } });
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

const cmd = (c: AgentConfig, dflt: string) => (c.command?.length ? c.command : [dflt]);

registerAdapter("claude-code", (id, c, o) => new ClaudeCodeAdapter(id, { command: cmd(c, "claude"), model: null, selection: selectionFrom(o || c.model), args: c.args ?? [] }), {
  agentId: "claude",
  primary: true,
  defaultAgent: { adapter: "claude-code", provider: "anthropic", command: ["claude"] },
  // v0.1 configs used an API adapter called "claude" with a full model id; it maps onto this CLI wrapper.
  aliases: ["claude"],
  migrate(a) {
    a.command ??= ["claude"];
    if (a.model?.startsWith("claude-")) delete a.model; // a full model id is not portable to the CLI: its own default applies
  },
});
