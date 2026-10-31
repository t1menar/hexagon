import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { AgentStatus, Effort, Message, Plan, RunStatus, StampedEvent } from "../contracts/types.js";
import type { HexClient } from "../client/client.js";
import { loadConfig } from "../core/config.js";
import { planTree } from "../core/plan.js";
import { ProjectPaths } from "../core/project.js";
import { findSpecs, lintSpec, listProjectFiles, parseSpec } from "../core/spec.js";
import type { Push } from "../daemon/orchestrator.js";
import type { PlanCheck } from "../core/plan.js";
import { c, plainMode } from "../util/term.js";
import { agentDetail, formatEvent, formatMessage, formatQuestion, runHeader, runTable } from "./render.js";
import { hexagonCommand, openTerminal, type OpenWith } from "./open.js";

interface Command {
  name: string;
  args: string;
  help: string;
  run: (args: string[], raw: string) => Promise<void> | void;
}

/** Split a command line, honoring "double" and 'single' quotes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v !== undefined && !v.startsWith("-") ? 2 : 1);
  return v !== undefined && !v.startsWith("-") ? v : "";
}

const TASK_RE = /^t-?\d+$/i;
const normTask = (s: string) => s.toUpperCase().replace(/^T(\d)/, "T-$1");

export class Shell {
  focus = "lead";
  attached: string | null = null;
  quiet = false;
  private rl: readline.Interface | undefined;
  private run: RunStatus | null = null;
  private commands = new Map<string, Command>();
  private lastCtrlC = 0;
  private promptTimer: NodeJS.Timeout | undefined;
  readonly paths: ProjectPaths;

  constructor(private client: HexClient, readonly root: string, private interactive: boolean) {
    this.paths = new ProjectPaths(root);
    this.register();
  }

  // ───────────────────────── output ─────────────────────────

  print(text = ""): void {
    if (this.rl && this.interactive && process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(text + "\n");
      this.rl.prompt(true);
    } else {
      process.stdout.write(text + "\n");
    }
  }

  private err(text: string): void {
    this.print(c.orange(`✖ ${text}`));
    if (!this.interactive) process.exitCode = 1;
  }

  private promptText(): string {
    const target = this.attached ?? this.focus;
    let summary = "";
    if (this.run && this.run.state !== "done") {
      const r = this.run;
      const active = (r.counts.running ?? 0) + (r.counts.verifying ?? 0) + (r.counts.reviewing ?? 0) + (r.counts.merging ?? 0) + (r.counts.starting ?? 0);
      const q = r.attention.filter((a) => a.kind === "question").length;
      summary = ` ${c.blue(`${active}●`)}${q ? " " + c.orange(`${q}?`) : ""} ${c.dim(`$${r.totals.cost_usd.toFixed(2)}`)}`;
    }
    const label = this.attached ? c.magenta(`attached ${target}`) : target === "lead" ? c.cyan("lead") : c.blue(target);
    return `hexagon [${label}]${summary} › `;
  }

  private refreshPrompt(): void {
    if (!this.rl || !process.stdout.isTTY) return;
    clearTimeout(this.promptTimer);
    this.promptTimer = setTimeout(() => {
      this.rl?.setPrompt(this.promptText());
      this.rl?.prompt(true);
    }, 200);
  }

  // ───────────────────────── lifecycle ─────────────────────────

  async start(attach?: string): Promise<void> {
    this.client.on("push", (p: Push) => this.onPush(p));
    this.client.on("close", () => {
      this.print(c.orange("daemon connection closed"));
      process.exit(1);
    });
    await this.client.subscribe();
    this.run = await this.client.call<RunStatus | null>("run.status");

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line: string) => this.complete(line),
      history: this.loadHistory(),
      historySize: 500,
      terminal: !plainMode() || process.stdin.isTTY,
    });
    this.rl.on("history", (h: string[]) => this.saveHistory(h));
    readline.emitKeypressEvents(process.stdin, this.rl);
    process.stdin.on("keypress", (_s, key: readline.Key | undefined) => this.onKey(key));
    this.rl.on("SIGINT", () => this.onCtrlC());
    // Lines run strictly one after another (matters for piped/scripted input).
    let queue = Promise.resolve();
    const tty = Boolean(process.stdout.isTTY);
    this.rl.on("line", (line) => {
      queue = queue.then(() => this.exec(line)).finally(() => {
        if (!tty) return;
        this.rl?.setPrompt(this.promptText());
        this.rl?.prompt();
      });
    });
    this.rl.on("close", () => void queue.finally(() => this.quit()));

    if (attach) await this.attach(normTask(attach));
    else {
      this.print(`${c.bold("Hexagon")} — type ${c.cyan("/help")} for commands, plain text to message the focused agent, ${c.cyan("@T-3 …")} to message one directly.`);
      if (this.run) this.print(runTable(this.run, null));
      else this.print(c.dim("No run yet. Write a spec in specs/, then /plan and /run. Try /spec lint first."));
      await this.showQuestions(true);
    }
    if (process.stdout.isTTY) {
      this.rl.setPrompt(this.promptText());
      this.rl.prompt();
    }
  }

  private quit(): void {
    this.print(c.dim("Bye — agents keep running in the daemon. `hexagon` reconnects; `hexagon down` stops it."));
    this.client.close();
    process.exit(0);
  }

  private onCtrlC(): void {
    if (this.rl && this.rl.line.length) {
      this.rl.write(null, { ctrl: true, name: "u" });
      return;
    }
    const now = Date.now();
    if (now - this.lastCtrlC < 1500) return this.quit();
    this.lastCtrlC = now;
    this.print(c.dim("Press Ctrl-C again to leave (agents keep running). /pause pauses the whole run."));
  }

  private onKey(key: readline.Key | undefined): void {
    if (!key) return;
    if (key.name === "escape" && this.attached) {
      this.attached = null;
      this.print(c.dim("detached — back to overview"));
      this.refreshPrompt();
    } else if (key.ctrl && (key.name === "n" || key.name === "p")) {
      this.cycle(key.name === "n" ? 1 : -1);
    } else if (key.ctrl && key.name === "t" && TASK_RE.test(this.attached ?? this.focus)) {
      void this.takeover(this.attached ?? this.focus);
    }
  }

  private loadHistory(): string[] {
    try {
      return fs.readFileSync(this.paths.history, "utf8").split("\n").filter(Boolean).reverse();
    } catch {
      return [];
    }
  }

  private saveHistory(h: string[]): void {
    try {
      fs.writeFileSync(this.paths.history, h.slice(0, 500).reverse().join("\n") + "\n");
    } catch { /* not critical */ }
  }

  // ───────────────────────── pushes ─────────────────────────

  private onPush(p: Push): void {
    switch (p.event) {
      case "run":
        this.run = p.data;
        this.refreshPrompt();
        break;
      case "agent_event": {
        const e = p.data as StampedEvent;
        const mine = this.attached === e.task_id;
        if (this.attached && !mine && !["question", "error"].includes(e.event.type)) return;
        if (this.quiet && !mine && !(e.event.type === "state" && ["failed", "blocked", "done", "waiting_input"].includes(e.event.state)) && e.event.type !== "error") return;
        if (e.event.type === "question") return; // shown via the message push
        const line = formatEvent(e, mine || (!this.attached && this.focus === e.task_id && !this.quiet));
        if (line) this.print(line);
        break;
      }
      case "message": {
        const m = p.data as Message;
        if (m.delivery.state === "rejected" && m.from.kind === "user") this.print(c.orange(`✖ ${m.id} not delivered: ${m.delivery.reason}`));
        if (m.delivery.state !== "delivered" && m.type !== "question") return;
        if (m.type === "notify" && this.attached && !m.body.startsWith(this.attached)) return;
        const line = formatMessage(m);
        if (line) {
          if (m.type === "question") process.stdout.write("\x07");
          this.print(line);
        }
        break;
      }
      case "notice":
        this.print(`${p.data.level === "error" ? c.orange("✖") : p.data.level === "attention" ? c.orange("◆") : c.cyan("◆")} ${p.data.text}`);
        break;
      case "planner": {
        const e = p.data;
        if (e.type === "status_report" && e.activity) this.print(c.dim(`planner · ${e.activity}`));
        if (e.type === "tool_call") this.print(c.dim(`planner ▸ ${e.summary}`));
        if (e.type === "progress") this.print(c.dim(`planner · ${e.text}`));
        break;
      }
      default:
        break;
    }
  }

  // ───────────────────────── input ─────────────────────────

  async exec(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) return;
    try {
      if (line.startsWith("/")) {
        const [name, ...args] = tokenize(line.slice(1));
        const cmd = this.commands.get((name ?? "").toLowerCase());
        if (!cmd) return this.err(`unknown command /${name} — /help lists commands`);
        await cmd.run(args, line.slice(1 + (name?.length ?? 0)).trim());
        return;
      }
      if (line.startsWith("@")) {
        const sp = line.indexOf(" ");
        if (sp < 0) return this.err("usage: @T-3 <message> · @implementers <message> · @lead <question> · @all <message>");
        return await this.message(line.slice(1, sp), line.slice(sp + 1).trim());
      }
      await this.message(this.attached ?? this.focus, line);
    } catch (e) {
      this.err(e instanceof Error ? e.message : String(e));
    }
  }

  private async message(target: string, body: string): Promise<void> {
    if (!body) return this.err("empty message");
    const to = TASK_RE.test(target) ? normTask(target) : target.startsWith("@") ? target : /^(lead|all|everyone|blackboard)$/i.test(target) ? target : `@${target}`;
    if (/^@?lead$/i.test(to)) this.print(c.dim("lead is thinking…"));
    const res = await this.client.call<{ messages: Message[]; answer?: string }>("message.send", { to, body });
    if (res.answer !== undefined) {
      this.print(`${c.cyan("lead")} ${res.answer}`);
      return;
    }
    for (const m of res.messages) {
      if (m.delivery.state === "rejected") this.err(`${m.id} rejected: ${m.delivery.reason}`);
      else this.print(c.dim(`↳ ${m.id} → ${m.to.id ?? m.to.kind} · ${m.delivery.state === "queued" ? "delivers at the next safe point" : m.delivery.state}`));
    }
  }

  private complete(line: string): [string[], string] {
    const ids = (this.run?.agents ?? []).map((a) => a.task_id);
    const qids = (this.run?.attention ?? []).filter((a) => a.kind === "question" && a.ref).map((a) => a.ref!);
    if (/^\/\S*$/.test(line)) {
      const hits = [...this.commands.keys()].map((k) => `/${k}`).filter((k) => k.startsWith(line));
      return [hits.length ? hits.map((h) => h + " ") : [], line];
    }
    if (/^@\S*$/.test(line)) {
      const opts = ["@lead", "@all", "@implementers", "@testers", ...ids.map((i) => `@${i}`)];
      return [opts.filter((o) => o.toLowerCase().startsWith(line.toLowerCase())).map((o) => o + " "), line];
    }
    const last = line.split(/\s+/).at(-1) ?? "";
    const pool = line.startsWith("/answer") ? qids : line.startsWith("/retry") && last.startsWith("--") ? ["--agent", "--effort"] : [...ids, "lead"];
    const hits = pool.filter((p) => p.toLowerCase().startsWith(last.toLowerCase()));
    return [hits.map((h) => h + " "), last];
  }

  private cycle(dir: 1 | -1): void {
    const agents = this.run?.agents ?? [];
    if (!agents.length) return;
    // attention first, then active, then the rest
    const rank = (a: RunStatus["agents"][number]) => (a.needs_input ? 0 : ["running", "verifying", "reviewing", "merging", "starting", "paused"].includes(a.state) ? 1 : 2);
    const order = [...agents].sort((a, b) => rank(a) - rank(b)).map((a) => a.task_id);
    const ring = ["lead", ...order];
    const cur = ring.indexOf(this.attached ?? this.focus);
    const next = ring[(cur + dir + ring.length) % ring.length]!;
    if (this.attached) this.attached = next === "lead" ? null : next;
    this.focus = next;
    this.print(c.dim(`focus → ${next}`));
    this.refreshPrompt();
  }

  // ───────────────────────── commands ─────────────────────────

  private target(args: string[]): string {
    const t = args.find((a) => TASK_RE.test(a));
    if (t) return normTask(t);
    const cur = this.attached ?? this.focus;
    if (TASK_RE.test(cur)) return cur;
    throw new Error("which task? pass an id (e.g. T-3) or /focus one first");
  }

  private async showQuestions(onlyIfAny = false): Promise<void> {
    if (!this.run) { if (!onlyIfAny) this.print("inbox empty"); return; }
    let inbox: { questions: (NonNullable<AgentStatus["needs_input"]> & { task_id: string })[]; attention: RunStatus["attention"]; notices: Message[] };
    try {
      inbox = await this.client.call("inbox.list");
    } catch {
      return;
    }
    if (!inbox.questions.length && !inbox.attention.length) {
      if (!onlyIfAny) this.print(c.dim("inbox empty — nothing needs you"));
      return;
    }
    for (const q of inbox.questions) this.print(c.orange(formatQuestion(q.task_id, q)));
    for (const a of inbox.attention) this.print(c.orange(`! ${a.task_id ?? "run"} ${a.kind}: ${a.text}`));
  }

  private async attach(task: string): Promise<void> {
    const s = await this.client.call<AgentStatus>("agent.status", { task });
    this.attached = s.task_id;
    this.focus = s.task_id;
    this.print(agentDetail(s));
    const events = await this.client.call<StampedEvent[]>("agent.events", { task, limit: 40 });
    if (events.length) this.print(c.dim("── recent ──"));
    for (const e of events) {
      const l = formatEvent(e, true);
      if (l) this.print(l);
    }
    this.print(c.dim(`── attached to ${s.task_id}: plain text goes to the agent · Ctrl-T take over · Esc or /detach to leave ──`));
    this.refreshPrompt();
  }

  private async takeover(task: string, here = false): Promise<void> {
    const t = normTask(task);
    if (here || !this.interactive) {
      this.print(`run: ${hexagonCommand(this.root, ["takeover-shell", t])}`);
      return;
    }
    const mode = loadConfig(this.paths.config).ui.open_with as OpenWith;
    const out = await openTerminal(`${t} takeover`, hexagonCommand(this.root, ["takeover-shell", t]), mode);
    this.print(c.magenta(`${t}: ${out}`));
  }

  private register(): void {
    const add = (name: string, args: string, help: string, run: Command["run"], aliases: string[] = []) => {
      const cmd = { name, args, help, run };
      this.commands.set(name, cmd);
      for (const a of aliases) this.commands.set(a, cmd);
    };

    add("help", "[command]", "List commands or show one", (args) => {
      if (args[0]) {
        const cmd = this.commands.get(args[0].replace(/^\//, ""));
        return cmd ? this.print(`/${cmd.name} ${cmd.args}\n  ${cmd.help}`) : this.err(`no command ${args[0]}`);
      }
      const seen = new Set<Command>();
      const rows: string[] = [];
      for (const cmd of this.commands.values()) {
        if (seen.has(cmd)) continue;
        seen.add(cmd);
        rows.push(`  ${c.cyan(`/${cmd.name}`)} ${c.dim(cmd.args)}`.padEnd(46) + cmd.help);
      }
      this.print(
        rows.join("\n") +
          `\n\n  Plain text → message to the focused agent (or the lead). ${c.cyan("@T-3 …")} / ${c.cyan("@implementers …")} / ${c.cyan("@all …")} / ${c.cyan("@lead …")}` +
          `\n  Keys: Tab complete · ↑/↓ history · Ctrl-N/Ctrl-P cycle focus · Ctrl-T take over focused agent · Esc detach · Ctrl-C twice quit`,
      );
    }, ["?"]);

    add("status", "[T-n]", "Run overview, or one agent in detail", async (args) => {
      const t = args.find((a) => TASK_RE.test(a));
      if (t) return this.print(agentDetail(await this.client.call<AgentStatus>("agent.status", { task: normTask(t) })));
      this.run = await this.client.call<RunStatus | null>("run.status");
      this.print(this.run ? runTable(this.run, this.attached ?? this.focus) : "no run yet");
    }, ["s", "st"]);

    add("agents", "", "Configured agents and which role uses which", () => {
      const cfg = loadConfig(this.paths.config);
      const lines = Object.values(cfg.agents).map((a) => `  ${c.bold(a.id)}  adapter=${a.adapter}${a.model ? ` model=${a.model}` : ""}`);
      lines.push("", ...Object.entries(cfg.roles).map(([r, v]) => `  ${r.padEnd(12)} → ${v.agent} (${v.effort})`));
      this.print(lines.join("\n"));
    });

    add("spec", "lint [files…]", "Validate specs (defaults to specs/*.md)", (args) => {
      if (args[0] && args[0] !== "lint") return this.err("usage: /spec lint [files…]");
      this.print(lintReport(this.root, args.slice(1)));
    });

    add("plan", "[spec files…] [--agent X]", "Have the planner turn specs into a task DAG", async (args) => {
      const agent = flag(args, "--agent");
      this.print(c.dim("planning…"));
      const res = await this.client.call<{ path: string; plan: Plan; check: PlanCheck }>("plan.create", { specs: args.map((a) => path.resolve(this.root, a)), agent: agent || null });
      this.print(planTree(res.plan));
      for (const w of res.check.warnings) this.print(c.orange(`! ${w}`));
      for (const i of res.plan.spec_issues) this.print(c.orange(`! spec issue: ${i}`));
      this.print(`${c.blue("✔")} plan saved to ${path.relative(this.root, res.path)} — start it with ${c.cyan("/run")}`);
    });

    add("run", "[plan.json] [-j N] [--only T-1,T-2] [--agent X] [--budget N]", "Start a run from a plan (default: newest plan)", async (args) => {
      const j = flag(args, "-j");
      const only = flag(args, "--only");
      const agent = flag(args, "--agent");
      const budget = flag(args, "--budget");
      const planPath = args[0] ?? latestPlan(this.paths);
      if (!planPath) return this.err("no plan found — /plan first, or pass a plan file");
      const res = await this.client.call<{ run_id: string }>("run.start", {
        plan_path: planPath,
        only: only ? only.split(",").map(normTask) : undefined,
        agent: agent || null,
        max_parallel: j ? Number(j) : undefined,
        budget_usd: budget !== undefined ? Number(budget) : undefined,
      });
      this.run = await this.client.call<RunStatus | null>("run.status");
      if (!this.interactive) this.print(`started ${res.run_id}`);
    });

    add("focus", "<T-n|lead>", "Set where plain text goes", (args) => {
      const t = args[0];
      if (!t) return this.print(`focus: ${this.focus}`);
      this.focus = TASK_RE.test(t) ? normTask(t) : "lead";
      this.attached = null;
      this.refreshPrompt();
    }, ["f"]);
    add("next", "", "Focus the next agent (attention first)", () => this.cycle(1), ["n"]);
    add("prev", "", "Focus the previous agent", () => this.cycle(-1), ["p"]);

    add("tell", "<T-n|@role|@all> <text>", "Send an instruction without changing focus", async (args, raw) => {
      const to = args[0];
      if (!to) return this.err("usage: /tell T-3 <text>");
      await this.message(to, raw.slice(raw.indexOf(to) + to.length).trim());
    }, ["t"]);

    add("ask", "<question>", "Ask the lead about the run", async (_a, raw) => this.message("lead", raw));

    add("inbox", "", "Open questions and things that need you", () => this.showQuestions(), ["i"]);

    add("answer", "<Q-n> <option|text>", "Answer an agent's question", async (args, raw) => {
      const q = args[0];
      if (!q) return this.err("usage: /answer Q-3 1");
      const text = raw.slice(raw.indexOf(q) + q.length).trim();
      if (!text) return this.err("answer text missing");
      const res = await this.client.call<{ task_id: string }>("question.answer", { question_id: q, answer: text });
      this.print(`${c.blue("✔")} answered ${q.toUpperCase()} → ${res.task_id} resumes`);
    }, ["a"]);

    add("attach", "[T-n]", "Live view of one agent in this terminal (Esc to leave)", (args) => this.attach(this.target(args)));
    add("detach", "", "Leave the attached view", () => { this.attached = null; this.refreshPrompt(); });

    add("open", "[T-n]", "Open a new terminal attached to an agent", async (args) => {
      const t = this.target(args);
      const mode = loadConfig(this.paths.config).ui.open_with as OpenWith;
      this.print(c.dim(await openTerminal(t, hexagonCommand(this.root, ["attach", t]), mode)));
    }, ["o"]);

    add("takeover", "[T-n] [--here]", "Pause the agent and open a shell in its worktree", async (args) => {
      const here = flag(args, "--here") !== undefined;
      await this.takeover(this.target(args), here);
    });

    add("pause", "[T-n]", "Pause one agent at its next safe point, or the whole run", async (args) => {
      if (args.some((a) => TASK_RE.test(a)) || (TASK_RE.test(this.attached ?? this.focus) && !args.includes("--run"))) {
        const t = this.target(args);
        const r = await this.client.call<{ ok: boolean }>("agent.pause", { task: t });
        return this.print(r.ok ? `${t} pausing at the next safe point` : `${t} is not pausable right now`);
      }
      await this.client.call("run.pause");
      this.print("run paused — no new tasks start; active agents pause at their next safe point. /resume to continue.");
    });

    add("resume", "[T-n]", "Resume a paused agent or the run", async (args) => {
      if (args.some((a) => TASK_RE.test(a)) || (TASK_RE.test(this.attached ?? this.focus) && !args.includes("--run"))) {
        const t = this.target(args);
        const r = await this.client.call<{ ok: boolean }>("agent.resume", { task: t });
        return this.print(r.ok ? `${t} resumed` : `${t} was not paused`);
      }
      await this.client.call("run.resume");
      this.print("run resumed");
    });

    add("cancel", "[T-n]", "Cancel an agent's current attempt", async (args) => {
      const t = this.target(args);
      await this.client.call("agent.cancel", { task: t });
      this.print(`${t} cancelling`);
    });

    add("retry", "<T-n> [--agent X] [--effort low|medium|high|xhigh|max]", "Start a new attempt", async (args) => {
      const agent = flag(args, "--agent");
      const effort = flag(args, "--effort") as Effort | undefined;
      const t = this.target(args);
      await this.client.call("agent.retry", { task: t, agent: agent || undefined, effort: effort || undefined });
      this.print(`${t} queued for a new attempt`);
    }, ["r"]);

    add("diff", "[T-n] [--stat]", "Show an agent's changes vs. the integration branch", async (args) => {
      const stat = flag(args, "--stat") !== undefined;
      const res = await this.client.call<{ diff: string }>("agent.diff", { task: this.target(args), stat });
      this.print(res.diff);
    }, ["d"]);

    add("logs", "[T-n] [N]", "Recent events of an agent", async (args) => {
      const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 60);
      const events = await this.client.call<StampedEvent[]>("agent.events", { task: this.target(args), limit: n });
      for (const e of events) {
        const l = formatEvent(e, true);
        if (l) this.print(l);
      }
    }, ["l"]);

    add("notes", "", "Shared blackboard", async () => {
      const r = await this.client.call<{ notes: string }>("notes.get");
      this.print(r.notes.trim() || c.dim("blackboard is empty"));
    });

    add("merge", "", "Merge the run's integration branch into your base branch", async () => {
      const r = await this.client.call<{ text: string }>("merge.base");
      this.print(`${c.blue("✔")} ${r.text}`);
    });

    add("abort", "", "Cancel all agents and stop the run", async () => {
      await this.client.call("run.abort");
      this.print("run aborted");
    });

    add("clean", "", "Remove worktrees of finished runs", async () => {
      const r = await this.client.call<{ removed: string[] }>("worktrees.clean");
      this.print(r.removed.length ? `removed ${r.removed.length} worktree(s)` : "nothing to clean");
    });

    add("stats", "", "Cost and usage of the current run by agent", async () => {
      const rs = await this.client.call<RunStatus | null>("run.status");
      if (!rs) return this.print("no run yet");
      this.print(runHeader(rs));
      const t = rs.totals;
      this.print(`tokens: ${t.input_tokens} in · ${t.output_tokens} out · ${t.cache_read_tokens} cache-read · ${t.turns} turns`);
      const by = new Map<string, { n: number; cost: number; done: number }>();
      for (const a of rs.agents) {
        const x = by.get(a.agent) ?? { n: 0, cost: 0, done: 0 };
        x.n++; x.cost += a.cost_usd; if (a.state === "done") x.done++;
        by.set(a.agent, x);
      }
      for (const [agent, x] of by) this.print(`  ${agent.padEnd(10)} ${x.done}/${x.n} done · $${x.cost.toFixed(2)} · $${x.done ? (x.cost / x.done).toFixed(2) : "–"}/merged task`);
    });

    add("quiet", "", "Only show things that need attention", () => { this.quiet = true; this.print("quiet feed"); });
    add("verbose", "", "Show all state changes", () => { this.quiet = false; this.print("verbose feed"); });
    add("clear", "", "Clear the screen", () => { process.stdout.write("\x1b[2J\x1b[H"); });
    add("quit", "", "Leave the shell (agents keep running)", () => this.quit(), ["exit", "q"]);
  }
}

export function latestPlan(paths: ProjectPaths): string | null {
  if (!fs.existsSync(paths.plans)) return null;
  const files = fs.readdirSync(paths.plans).filter((f) => f.endsWith(".json")).sort();
  return files.length ? path.join(paths.plans, files.at(-1)!) : null;
}

export function lintReport(root: string, files: string[]): string {
  const specs = findSpecs(root, files.map((f) => path.resolve(root, f)));
  if (!specs.length) return c.orange("no spec files found (put *.md files in specs/)");
  const projectFiles = listProjectFiles(root);
  const lines: string[] = [];
  let errors = 0;
  let warnings = 0;
  for (const f of specs) {
    const spec = parseSpec(f);
    const issues = lintSpec(spec, projectFiles);
    const acs = spec.requirements.reduce((n, r) => n + r.acceptance.length, 0);
    lines.push(`${c.bold(path.relative(root, f))}: ${spec.requirements.length} requirement(s), ${acs} acceptance criteria`);
    for (const i of issues) {
      if (i.level === "error") errors++; else warnings++;
      lines.push(`  ${i.level === "error" ? c.orange("✖ error") : c.magenta("! warn ")} ${path.relative(root, i.file)}:${i.line} ${c.dim(`[${i.rule}]`)} ${i.message}`);
    }
  }
  lines.push(errors ? c.orange(`${errors} error(s), ${warnings} warning(s)`) : `${c.blue("✔")} no errors${warnings ? `, ${warnings} warning(s)` : ""}`);
  if (errors) process.exitCode = 1;
  return lines.join("\n");
}
