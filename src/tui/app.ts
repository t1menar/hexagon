import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { HexClient } from "../client/client.js";
import type { AgentState, AgentStatus, Message, Plan, RunStatus, StampedEvent } from "../contracts/types.js";
import { TERMINAL_STATES } from "../contracts/types.js";
import type { SessionStatus } from "../core/solo.js";
import type { Draft, PermissionRequest, Push, Snapshot } from "../daemon/orchestrator.js";
import { hexagonCommand, openTerminal } from "../shell/open.js";
import { Canvas, clip, padTo, S, st, wrap } from "./canvas.js";
import type { AgentInfo } from "../daemon/orchestrator.js";
import { formatAgent } from "../shell/agents.js";
import { agentIdentity, modelLine, quotaLabel, recoveryLine } from "./identity.js";
import { ACTIVE, bar, glyph, progressOf, renderDag, spinner, STATE_COLOR, type DagNode } from "./dag.js";
import { takeoverInTerminal } from "./takeover.js";
import { projectStack, taskStack, toolsUsed } from "./stack.js";
import { fmtTokens } from "../util/term.js";
import { chatLines, itemsFromEvents, itemsFromSession, type ChatItem } from "./chat.js";

interface FeedLine { ts: string; text: string; style: string }

const COMMANDS: [string, string][] = [
  ["/sdd <goal>", "spec-driven development: spec + task graph → parallel agents (optional)"],
  ["/run [-j N] [--agent X]", "approve the draft plan and start the agents"],
  ["/discard", "throw away the draft plan"],
  ["/spec", "open the spec in $EDITOR"],
  ["/plan", "edit the draft plan.json in $EDITOR"],
  ["/init [description]", "let an agent study the repo and write HEXAGON.md"],
  ["/answer <Q-n> <text>", "answer an agent's question"],
  ["/tell <T-n|@role|@all> <text>", "message agents"],
  ["/lead <question>", "ask Claude in the chat (same as typing on the claude tab)"],
  ["/pause [T-n]", "pause the selected agent (or the whole run)"],
  ["/resume [T-n]", "resume"],
  ["/cancel [T-n]", "cancel an agent"],
  ["/retry [T-n] [--agent X] [--effort E]", "start a new attempt"],
  ["/takeover [T-n]", "work in the agent's session yourself (Ctrl-T)"],
  ["/open [T-n]", "open the agent in a new terminal window (Ctrl-O)"],
  ["/diff [T-n]", "show the agent's changes (Ctrl-D)"],
  ["/merge", "merge the finished run into your branch"],
  ["/abort", "stop the run"],
  ["/clean", "remove worktrees of finished runs (and close the run)"],
  ["/close", "hide the finished run from the dashboard (without merging)"],
  ["/model [role] [model]", "show or set a model override per role (default = the CLI's own) · /agents lists agents, versions and discovered models"],
  ["/animate [on|off]", "turn the molecule animations (orbiting electrons, flowing bonds) on or off"],
  ["/agents", "agents, providers, CLI versions, auth and what each CLI reports about models"],
  ["/allow <cmd…> | all", "let agents run these commands (e.g. /allow brew curl), or everything"],
  ["/install <tool>", "install go, node, java or maven for agents (official release, no Homebrew)"],
  ["/stop", "stop the daemon and every agent, then quit"],
  ["/quit", "leave — agents keep running in the background"],
  ["/help", "show this list"],
];

const HEX = "claude";
const CONTINUABLE = new Set(["blocked", "failed", "cancelled"]);
/** Readable names for the run-less sessions: [name, what it does]. */
const SESSION_NAMES: Record<string, [string, string]> = {
  planner: ["Planner", "writes the spec + task graph"],
  init: ["Project setup", "writes HEXAGON.md"],
};
const TASK_RE = /^t-?\d+$/i;
const normTask = (s: string) => s.toUpperCase().replace(/^T(\d)/, "T-$1");

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

const time = (ts: string) => new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
const tok = (n: number) => fmtTokens(n);
const spent = (u: { input_tokens: number; cache_read_tokens: number; output_tokens: number }) => u.input_tokens + u.cache_read_tokens + u.output_tokens;
const sessTok = (s: SessionStatus) => (s.tokens ? s.tokens.input + s.tokens.cache_read + s.tokens.output : 0);
const blankSession = (id: string, role: SessionStatus["role"]): SessionStatus => ({
  id, role, agent: "", state: "running", activity: "starting", question: null, cost_usd: 0,
  tokens: { input: 0, cache_read: 0, output: 0, steps: 0 }, result_status: null, summary: null, error: null, feed: [], session_id: "",
});
const dur = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

/** Canvas line for an agent event (null = not shown). */
export function eventLine(e: StampedEvent): FeedLine | null {
  const ev = e.event;
  const L = (text: string, style = ""): FeedLine => ({ ts: e.ts, text, style });
  switch (ev.type) {
    case "state":
      if (ev.state === "queued" && ev.reason?.startsWith("waiting")) return null;
      return L(`${glyph(ev.state, 0)} ${ev.state.replace("_", " ")}${ev.reason ? ` — ${ev.reason}` : ""}`, st(STATE_COLOR[ev.state], S.bold));
    case "progress": return L(ev.text);
    case "status_report": return ev.activity ? L(`${ev.phase ? `[${ev.phase}] ` : ""}${ev.activity}`, S.cyan) : null;
    case "tool_call": return L(`▸ ${ev.summary}`, S.blue);
    case "tool_result": return ev.ok ? null : L(`  ✖ ${ev.summary}`, st(S.red, S.dim));
    case "question": return L(`? ${ev.question.question_id} ${ev.question.prompt}`, st(S.orange, S.bold));
    case "answered": return L(`↳ answered ${ev.question_id}: ${ev.answer}`, S.orange);
    case "message_delivered": return L(`↳ ${ev.message_id} sent to the agent`, S.gray);
    case "message_acked": return L(`✔ agent received ${ev.message_id}`, S.gray);
    case "error": return L(`⚠ ${ev.kind}: ${ev.message}`, S.orange);
    case "files": return L(`files: ${ev.files.join(", ")}`, S.gray);
    case "controller": return L(ev.controller === "user" ? "you took over" : "agent is back in control", S.magenta);
    default: return null;
  }
}

/** Full-screen dashboard: task graph, active agents, the selected agent's feed, and an input line. */
export class App {
  private snap!: Snapshot;
  private full = new Map<string, AgentStatus>();
  private lastProgress = new Map<string, number>();
  private sessions = new Map<string, SessionStatus>();
  private feeds = new Map<string, FeedLine[]>();
  private events = new Map<string, StampedEvent[]>();
  private menuIdx = 0;
  private menuHidden = false;
  private loaded = new Set<string>();
  private selected = HEX;
  private input = "";
  private cursor = 0;
  private history: string[] = [];
  private histIdx = -1;
  private scroll = 0;
  private frame = 0;
  private notice: { text: string; level: string; at: number } | null = null;
  private prev: string[] = [];
  private dirty = true;
  private suspended = false;
  private pasting = false;
  private timer: NodeJS.Timeout | undefined;
  private quitArmed = 0;
  private done!: () => void;

  constructor(private client: HexClient, private root: string, private initial?: string) {}

  // ───────────── lifecycle ─────────────

  async start(): Promise<void> {
    this.snap = await this.client.call<Snapshot>("ui.snapshot");
    for (const a of this.snap.agents) this.setFull(a);
    for (const s of this.snap.sessions) this.sessions.set(s.id, s);
    try { this.history = fs.readFileSync(path.join(this.root, ".hexagon", "shell_history"), "utf8").split("\n").filter(Boolean).slice(-200); } catch { /* none */ }
    await this.client.subscribe();
    this.client.on("push", (p: Push) => this.onPush(p));
    this.client.on("close", () => this.exit("daemon connection closed"));
    if (this.initial) this.select(normTask(this.initial));
    else if (this.snap.sessions.some((s) => s.state === "running" || s.state === "waiting_input")) this.select(this.snap.sessions.find((s) => s.state === "running" || s.state === "waiting_input")!.id);
    this.log(this.welcome(), S.gray);

    this.enter();
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", (s: string | undefined, k: readline.Key | undefined) => this.onKey(s, k));
    process.stdout.on("resize", () => { this.prev = []; this.render(); });
    this.timer = setInterval(() => {
      this.frame++;
      if (this.notice && Date.now() - this.notice.at > 10_000) { this.notice = null; this.dirty = true; }
      if (this.dirty || this.anyActive() || this.frame % 10 === 0) this.render();
    }, 100);
    await new Promise<void>((r) => (this.done = r));
  }

  private welcome(): string {
    const lines = ["Welcome to Hexagon."];
    if (!this.snap.has_context) lines.push("Tip: /init lets an agent study this repository and write HEXAGON.md — the brief every agent reads first.");
    lines.push("Describe what you want built and press Enter: a planner agent writes the spec and a task graph for you to approve.");
    return lines.join(" ");
  }

  private enter() {
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J");
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    this.prev = [];
    this.suspended = false;
    this.render();
  }

  private leave() {
    this.suspended = true;
    process.stdout.write("\x1b[?2004l\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }

  private exit(msg?: string) {
    if (this.timer) clearInterval(this.timer);
    this.leave();
    try { fs.writeFileSync(path.join(this.root, ".hexagon", "shell_history"), this.history.slice(-200).join("\n") + "\n"); } catch { /* ignore */ }
    if (msg) console.log(msg);
    const active = this.runAgents().filter((a) => !TERMINAL_STATES.has(a.state) && a.state !== "queued").length;
    if (active) console.log(`${active} agent(s) keep working in the background. Run \`hexagon\` to come back.`);
    this.client.close();
    this.done();
    process.stdin.pause();
  }

  /** Leave the full-screen UI to run something interactive in this terminal. */
  private async suspend(fn: () => Promise<unknown>): Promise<void> {
    this.leave();
    process.stdin.removeAllListeners("keypress");
    try {
      await fn();
    } catch (e) {
      this.flash(e instanceof Error ? e.message : String(e), "error");
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", (s: string | undefined, k: readline.Key | undefined) => this.onKey(s, k));
    this.enter();
  }

  // ───────────── data ─────────────

  private setFull(a: AgentStatus) {
    const cur = this.full.get(a.task_id);
    if (!cur || a.attempt >= cur.attempt) this.full.set(a.task_id, a);
  }

  private onPush(p: Push) {
    this.dirty = true;
    switch (p.event) {
      case "status": {
        const prevAttempt = this.full.get(p.data.task_id)?.attempt;
        this.setFull(p.data);
        if (prevAttempt !== undefined && p.data.attempt > prevAttempt) this.loaded.delete(p.data.task_id);
        break;
      }
      case "run":
        if (!p.data) {
          // The run was merged/cleaned/closed: back to a clean dashboard.
          this.full.clear();
          this.loaded.clear();
          this.events.clear();
          if (TASK_RE.test(this.selected)) this.selected = HEX;
          void this.client.call<Snapshot>("ui.snapshot").then((s) => { this.snap = s; this.dirty = true; });
          break;
        }
        if (this.snap.run?.run_id !== p.data.run_id) {
          this.full.clear();
          this.loaded.clear();
          void this.client.call<Snapshot>("ui.snapshot").then((s) => { this.snap = s; for (const a of s.agents) this.setFull(a); this.dirty = true; });
        }
        this.snap.run = p.data;
        break;
      case "agent_event": {
        const list = this.events.get(p.data.task_id) ?? [];
        list.push(p.data);
        if (list.length > 3000) list.splice(0, list.length - 3000);
        this.events.set(p.data.task_id, list);
        break;
      }
      case "message": this.onMessage(p.data); break;
      case "notice": this.log(p.data.text, p.data.level === "info" ? S.cyan : S.orange); this.flash(p.data.text, p.data.level); break;
      case "session": this.sessions.set(p.data.id, p.data); break;
      case "permissions": this.snap.permissions = p.data; break;
      case "draft":
        this.snap.draft = p.data;
        if (p.data) {
          this.log(`Plan ready: ${p.data.plan.tasks.length} task(s). ${p.data.summary}`, S.cyan);
          this.flash("Plan ready — press Enter to run it, or type what to change", "attention");
          if (this.selected === "planner") this.selected = HEX;
        }
        break;
    }
  }

  private seenMsgs = new Set<string>();
  private onMessage(m: Message) {
    if (this.seenMsgs.has(m.id)) return;
    this.seenMsgs.add(m.id);
    if (m.from.kind === "user" && m.to.kind !== "agent") this.log(`› you → ${m.to.id ?? m.to.kind}: ${m.body}`, st(S.white, S.bold));
    if (m.to.kind === "user") {
      if (m.type === "question") this.log(`? ${m.from.id} asks ${m.question?.question_id}: ${m.body}`, S.orange);
      else if (m.type === "notify" || m.type === "request") this.log(m.body, m.body.includes("failed") || m.body.includes("blocked") ? S.orange : S.cyan);
    }
    if (m.to.kind === "blackboard") this.log(`note from ${m.from.id}: ${m.body}`, S.gray);
  }

  private push(key: string, line: FeedLine) {
    const f = this.feeds.get(key) ?? [];
    f.push(line);
    if (f.length > 2000) f.splice(0, f.length - 2000);
    this.feeds.set(key, f);
  }

  private log(text: string, style = "") {
    this.push(HEX, { ts: new Date().toISOString(), text, style });
    this.dirty = true;
  }

  private flash(text: string, level = "info") {
    this.notice = { text, level, at: Date.now() };
    this.dirty = true;
  }

  private runAgents(): RunStatus["agents"] {
    return this.snap.run?.agents ?? [];
  }

  private activeRun(): boolean {
    const r = this.snap.run;
    return Boolean(r && (r.state === "running" || r.state === "paused"));
  }

  /** A draft is shown instead of the last run once that run is over. */
  private showingDraft(): boolean {
    return Boolean(this.snap.draft) && !this.activeRun();
  }

  private plan(): Plan | null {
    if (this.showingDraft()) return this.snap.draft!.plan;
    return this.snap.run ? this.snap.plan : null;
  }

  /** Animations off (HEXAGON_ANIMATION=off, NO_MOTION, or /animate off): static glyphs, no particles. */
  still = process.env.HEXAGON_ANIMATION === "off" || Boolean(process.env.NO_MOTION);

  private anyActive(): boolean {
    return this.runAgents().some((a) => ACTIVE.has(a.state)) || [...this.sessions.values()].some((s) => s.state === "running");
  }

  /** Selectable entries: hexagon log, live sessions, tasks. */
  private entries(): string[] {
    const out = [HEX];
    for (const s of this.sessions.values()) {
      if (s.id === HEX) continue;
      if (["running", "waiting_input", "idle"].includes(s.state) || !this.snap.run || s.id === this.selected || (s.id === "planner" && this.snap.draft)) out.push(s.id);
    }
    const plan = this.plan();
    if (this.snap.run && !this.showingDraft()) for (const t of plan?.tasks ?? this.runAgents().map((a) => ({ id: a.task_id }))) out.push(t.id);
    return out;
  }

  private select(id: string) {
    this.selected = id;
    this.scroll = 0;
    this.dirty = true;
    if (TASK_RE.test(id) && !this.loaded.has(id) && this.snap.run) {
      this.loaded.add(id);
      void this.client.call<StampedEvent[]>("agent.events", { task: id, limit: 400 })
        .then((evs) => { this.events.set(id, evs); this.dirty = true; })
        .catch(() => this.loaded.delete(id));
    }
  }

  private cycle(d: number) {
    const e = this.entries();
    const i = e.indexOf(this.selected);
    this.select(e[(i + d + e.length) % e.length]!);
  }

  private permFor(agent: string): PermissionRequest | undefined {
    return (this.snap.permissions ?? []).find((p) => p.agent === agent);
  }

  private permissionQuestion(p: PermissionRequest) {
    return {
      id: p.id, from: p.agent, prompt: `${p.agent} wants to run \`${p.command}\`. Allow it?`,
      options: [{ id: "1", label: p.prefix ? `allow \`${p.prefix}\` commands` : "allow it (all commands)" }, { id: "2", label: "allow all commands" }, { id: "3", label: "deny" }],
    };
  }

  private openQuestion(): { id: string; from: string; prompt: string; options: { id: string; label: string }[] } | null {
    const sel = this.selected;
    const perms = this.snap.permissions ?? [];
    const mine = perms.find((p) => p.agent === sel);
    if (mine) return this.permissionQuestion(mine);
    const s = this.sessions.get(sel);
    if (s?.question) return { id: s.question.question_id, from: s.id, prompt: s.question.prompt, options: s.question.options ?? [] };
    const a = this.full.get(sel);
    if (a?.needs_input && !TERMINAL_STATES.has(a.state)) return { id: a.needs_input.question_id, from: sel, prompt: a.needs_input.prompt, options: a.needs_input.options ?? [] };
    for (const ss of this.sessions.values()) if (ss.question) return { id: ss.question.question_id, from: ss.id, prompt: ss.question.prompt, options: ss.question.options ?? [] };
    for (const x of this.full.values()) if (x.needs_input && !TERMINAL_STATES.has(x.state)) return { id: x.needs_input.question_id, from: x.task_id, prompt: x.needs_input.prompt, options: x.needs_input.options ?? [] };
    if (perms[0]) return this.permissionQuestion(perms[0]);
    return null;
  }

  private plannerBusy(): boolean {
    const p = this.sessions.get("planner");
    return Boolean(p && (p.state === "running" || p.state === "waiting_input"));
  }

  private placeholder(): string {
    const q = this.openQuestion();
    const sel = this.selected;
    if (q && q.from === sel) return `answer ${q.id}…`;
    if (this.snap.draft && !this.plannerBusy() && (sel === HEX || sel === "planner")) return sel === "planner" ? "Enter = run this plan · or type what to change" : "Enter = run the plan · or chat with Claude…";
    if (sel === "planner" && this.plannerBusy()) return "tell the planner something…";
    const a = this.full.get(sel);
    if (a && !TERMINAL_STATES.has(a.state)) return `message ${a.task_id}…`;
    if (a && CONTINUABLE.has(a.state)) return `${a.task_id} is ${a.state}: reply to continue its session (e.g. "mvn is installed now, try again") · /retry for a fresh attempt`;
    if (this.sessions.get(sel)?.state === "running") return `message the ${sel} agent…`;
    return "chat with Claude — it works directly in this repo · /sdd <goal> for spec-driven parallel agents";
  }

  // ───────────── input ─────────────

  private onKey(s: string | undefined, k: readline.Key | undefined) {
    if (this.suspended) return;
    this.dirty = true;
    const name = k?.name;
    if (name === "paste-start") { this.pasting = true; return; }
    if (name === "paste-end") { this.pasting = false; return; }
    if (k?.ctrl && name === "c") {
      if (this.input) { this.input = ""; this.cursor = 0; return; }
      if (Date.now() - this.quitArmed < 2000) return this.exit();
      this.quitArmed = Date.now();
      return this.flash("Press Ctrl-C again to quit (agents keep running in the background)");
    }
    if (this.pasting && (name === "return" || name === "enter")) return this.insert("\n");
    if (k?.ctrl) {
      switch (name) {
        case "t": return void this.command(`/takeover`);
        case "o": return void this.command(`/open`);
        case "d": return void this.command(`/diff`);
        case "u": this.input = this.input.slice(this.cursor); this.cursor = 0; return;
        case "a": this.cursor = 0; return;
        case "e": this.cursor = this.input.length; return;
        case "w": {
          const before = this.input.slice(0, this.cursor).replace(/\S+\s*$/, "");
          this.input = before + this.input.slice(this.cursor);
          this.cursor = before.length;
          return;
        }
        case "l": this.prev = []; return;
        case "p": case "n": {
          if (!this.history.length) return;
          const n = this.histIdx < 0 ? this.history.length : this.histIdx;
          this.histIdx = Math.max(0, Math.min(this.history.length, n + (name === "p" ? -1 : 1)));
          this.input = this.history[this.histIdx] ?? "";
          if (this.histIdx >= this.history.length) this.histIdx = -1;
          this.cursor = this.input.length;
          return;
        }
      }
      return;
    }
    switch (name) {
      case "return": case "enter": {
        if (this.menuOpen()) {
          const c = this.completions();
          if (!c.items.some((i) => i.value.toLowerCase() === c.token.toLowerCase())) return void this.accept(true);
        }
        const text = this.input;
        this.input = "";
        this.cursor = 0;
        this.histIdx = -1;
        this.scroll = 0;
        if (text.trim()) this.history.push(text);
        void this.submit(text);
        return;
      }
      case "escape":
        if (this.menuOpen()) { this.menuHidden = true; return; }
        this.input = ""; this.cursor = 0; return;
      case "tab":
        if (this.menuOpen() && !k?.shift) return void this.accept();
        return this.cycle(k?.shift ? -1 : 1);
      case "up":
        if (this.menuOpen()) { const n = this.completions().items.length; this.menuIdx = (this.menuIdx - 1 + n) % n; return; }
        if (!this.input) return this.cycle(-1);
        return;
      case "down":
        if (this.menuOpen()) { const n = this.completions().items.length; this.menuIdx = (this.menuIdx + 1) % n; return; }
        if (!this.input) return this.cycle(1);
        return;
      case "pageup": this.scroll += 10; return;
      case "pagedown": this.scroll = Math.max(0, this.scroll - 10); return;
      case "left": this.cursor = Math.max(0, this.cursor - 1); return;
      case "right":
        if (this.cursor === this.input.length && this.menuOpen()) return void this.accept();
        this.cursor = Math.min(this.input.length, this.cursor + 1); return;
      case "home": this.cursor = 0; return;
      case "end": this.cursor = this.input.length; return;
      case "backspace":
        if (this.cursor > 0) { this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor); this.cursor--; }
        this.menuIdx = 0;
        this.menuHidden = false;
        return;
      case "delete": this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1); return;
    }
    if (s && !k?.meta && s >= " ") this.insert(s);
  }

  private insert(s: string) {
    this.input = this.input.slice(0, this.cursor) + s + this.input.slice(this.cursor);
    this.cursor += s.length;
    this.menuIdx = 0;
    this.menuHidden = false;
  }

  // ───────────── autocomplete ─────────────

  private completions(): { token: string; items: { value: string; desc: string }[] } {
    const none = { token: "", items: [] };
    if (this.cursor !== this.input.length || !this.input) return none;
    const before = this.input;
    const tokStart = before.search(/\S*$/);
    const token = before.slice(tokStart);
    const first = !before.slice(0, tokStart).trim();
    const words = before.trim().split(/\s+/);
    const cmd = words[0]!.toLowerCase();
    const tasks = (this.plan()?.tasks ?? []).map((t) => ({ id: t.id, title: t.title, state: this.full.get(t.id)?.state }));
    const match = (v: string) => v.toLowerCase().startsWith(token.toLowerCase());
    let items: { value: string; desc: string }[] = [];
    if (first && token.startsWith("/")) {
      items = COMMANDS.map(([u, d]) => ({ value: u.split(" ")[0]!, desc: `${u.split(" ").slice(1).join(" ")}  ${d}`.trim() })).filter((i) => match(i.value));
    } else if (token.startsWith("@")) {
      items = [
        ...tasks.filter((t) => !t.state || !TERMINAL_STATES.has(t.state)).map((t) => ({ value: `@${t.id}`, desc: t.title })),
        { value: "@all", desc: "every active agent" },
        { value: "@implementers", desc: "all implementer agents" },
        { value: "@testers", desc: "all tester agents" },
        { value: "@claude", desc: "chat with Claude" },
        ...(this.snap.draft ? [{ value: "@planner", desc: "ask the planner to change the draft plan" }] : []),
      ].filter((i) => match(i.value));
    } else if (!first && cmd.startsWith("/")) {
      const argIdx = words.length - (token ? 1 : 0);
      if (token.startsWith("-")) {
        const flags: Record<string, string[]> = { "/run": ["-j", "--agent"], "/retry": ["--agent", "--effort"] };
        items = (flags[cmd] ?? []).map((f) => ({ value: f, desc: f === "-j" ? "max agents in parallel" : f === "--effort" ? "low|medium|high|xhigh|max" : "agent from config.toml" })).filter((i) => match(i.value));
      } else if (words[words.length - (token ? 2 : 1)] === "--effort") {
        items = ["low", "medium", "high", "xhigh", "max"].map((e) => ({ value: e, desc: "" })).filter((i) => match(i.value));
      } else if (cmd === "/model" && argIdx === 1) {
        items = ["planner", "implementer", "tester", "reviewer", "lead", "init"].map((r) => ({ value: r, desc: r === "lead" ? "the Claude chat" : "" })).filter((i) => match(i.value));
      } else if (cmd === "/model" && argIdx === 2) {
        // No built-in model list: "default" keeps the CLI's own choice; `/models <agent>` shows what the CLI reports.
        items = [{ value: "default", desc: "the CLI's own default (no override)" }].filter((i) => match(i.value));
      } else if (cmd === "/install" && argIdx === 1) {
        items = [["go", "Go toolchain"], ["node", "Node.js LTS"], ["java", "Temurin JDK 21"], ["maven", "Apache Maven"]].map(([v, d]) => ({ value: v!, desc: d! })).filter((i) => match(i.value));
      } else if (cmd === "/answer" && argIdx === 1) {
        const qs: { value: string; desc: string }[] = [];
        for (const a of this.full.values()) if (a.needs_input && !TERMINAL_STATES.has(a.state)) qs.push({ value: a.needs_input.question_id, desc: `${a.task_id}: ${a.needs_input.prompt}` });
        for (const ss of this.sessions.values()) if (ss.question) qs.push({ value: ss.question.question_id, desc: `${ss.id}: ${ss.question.prompt}` });
        items = qs.filter((i) => match(i.value));
      } else if (["/pause", "/resume", "/cancel", "/retry", "/takeover", "/open", "/diff", "/tell"].includes(cmd) && argIdx === 1) {
        items = tasks.map((t) => ({ value: t.id, desc: `${t.state ? t.state.replace("_", " ") + " · " : ""}${t.title}` }))
          .filter((i) => match(i.value) || i.value.replace("-", "").toLowerCase().startsWith(token.toLowerCase()));
        if (cmd === "/tell") items.push(...["@all", "@implementers", "@testers"].filter(match).map((v) => ({ value: v, desc: "" })));
      }
    }
    return { token, items: items.slice(0, 8) };
  }

  private menuOpen(): boolean {
    return !this.menuHidden && this.completions().items.length > 0;
  }

  /** Replace the current token with the selected completion. */
  private accept(submitIfComplete = false) {
    const c = this.completions();
    const item = c.items[Math.min(this.menuIdx, c.items.length - 1)];
    if (!item) return;
    this.input = this.input.slice(0, this.input.length - c.token.length) + item.value + " ";
    this.cursor = this.input.length;
    this.menuIdx = 0;
    const noArgs = ["/help", "/quit", "/stop", "/run", "/discard", "/spec", "/plan", "/merge", "/abort", "/clean", "/close", "/init", "/model"];
    if (submitIfComplete && noArgs.includes(item.value) && this.input.trim() === item.value) {
      const text = this.input;
      this.input = "";
      this.cursor = 0;
      this.history.push(text.trim());
      void this.submit(text);
    }
  }

  /** Where Enter sends the current input — shown as a chip before the input. */
  private recipient(): { label: string; style: string } {
    const t = this.input.trim();
    if (t.startsWith("/")) return { label: "command", style: S.gray };
    const m = /^@(\S+)/.exec(t);
    if (m) return { label: /^(lead|claude)$/i.test(m[1]!) ? "chat" : `to ${m[1]}`, style: S.cyan };
    const route = this.route(t);
    return { label: route.label, style: route.style };
  }

  private async submit(raw: string): Promise<void> {
    const text = raw.trim();
    try {
      if (text.startsWith("/")) return await this.command(text);
      if (text.startsWith("@")) {
        const [to, ...rest] = text.split(/\s+/);
        const body = rest.join(" ");
        if (!body) return this.flash("usage: @T-2 <message> · @all <message> · @lead <question>");
        return await this.tell(to!.slice(1), body);
      }
      const route = this.route(text);
      switch (route.kind) {
        case "none": return;
        case "run": return await this.command("/run");
        case "answer":
          await this.client.call("question.answer", { question_id: route.id, answer: text });
          return;
        case "session": await this.client.call("session.say", { id: route.id, text }); return;
        case "revise":
          await this.client.call("draft.revise", { feedback: text });
          this.select("planner");
          return;
        case "agent": return await this.tell(route.id, text);
        case "chat": return await this.chat(text);
      }
    } catch (e) {
      this.flash(e instanceof Error ? e.message : String(e), "error");
      this.log(`✖ ${e instanceof Error ? e.message : String(e)}`, S.orange);
    }
  }

  /** Where plain text goes, given the selection and state. */
  private route(text: string): { kind: "none" | "run" | "answer" | "session" | "revise" | "agent" | "chat"; id: string; label: string; style: string } {
    const sel = this.selected;
    const q = this.openQuestion();
    if (!text && this.snap.draft && !this.plannerBusy() && (sel === HEX || sel === "planner")) return { kind: "run", id: "", label: "Enter = run plan", style: S.orange };
    if (q && q.from === sel) return { kind: "answer", id: q.id, label: `answer ${q.id}`, style: S.orange };
    if (sel !== HEX) {
      const sess = this.sessions.get(sel);
      if (sess && ["running", "waiting_input", "idle"].includes(sess.state)) return { kind: "session", id: sel, label: `to ${sel}`, style: S.blue };
      if (sel === "planner" && this.snap.draft) return { kind: "revise", id: "planner", label: "revise plan", style: S.orange };
      const a = this.full.get(sel);
      if (a && !TERMINAL_STATES.has(a.state) && this.activeRun()) return { kind: "agent", id: sel, label: `to ${sel}`, style: S.blue };
      if (a && CONTINUABLE.has(a.state)) return { kind: "agent", id: sel, label: `continue ${sel}`, style: S.orange };
    }
    if (!text) return { kind: "none", id: "", label: "chat", style: S.green };
    return { kind: "chat", id: HEX, label: sel === HEX ? "chat" : "chat (agent idle)", style: S.green };
  }

  private async chat(text: string) {
    this.select(HEX);
    const cur = this.sessions.get(HEX);
    this.sessions.set(HEX, { ...(cur ?? blankSession(HEX, "lead")), state: "running", activity: "thinking…" });
    await this.client.call("chat.send", { text });
  }

  private async newGoal(goal: string) {
    await this.client.call("goal.new", { goal });
    this.log(`› goal: ${goal}`, st(S.white, S.bold));
    this.sessions.set("planner", blankSession("planner", "planner"));
    this.select("planner");
  }

  private async tell(to: string, body: string) {
    if (/^(lead|claude)$/i.test(to)) return await this.chat(body);
    if (/^planner$/i.test(to)) { await this.client.call("draft.revise", { feedback: body }); this.select("planner"); return; }
    const target = TASK_RE.test(to) ? normTask(to) : `@${to}`;
    await this.client.call("message.send", { to: target, body });
    if (!TASK_RE.test(to)) this.log(`› you → ${target}: ${body}`, st(S.white, S.bold));
  }

  private target(args: string[]): string {
    const t = args.find((a) => TASK_RE.test(a));
    if (t) { args.splice(args.indexOf(t), 1); return normTask(t); }
    if (TASK_RE.test(this.selected)) return this.selected;
    throw new Error("select an agent first (Tab) or name it, e.g. T-2");
  }

  private async command(line: string): Promise<void> {
    const [cmd, ...args] = tokenize(line);
    const c = this.client;
    try {
      switch (cmd!.toLowerCase()) {
        case "/help": case "/?":
          this.log(COMMANDS.map(([u, d]) => `${padTo(u, 38)} ${d}`).join("\n"), S.white);
          this.log("Keys: Enter send · Tab/↑↓ switch agent · PgUp/PgDn scroll · Ctrl-T takeover · Ctrl-O new window · Ctrl-D diff · Esc clear · Ctrl-C quit", S.gray);
          this.select(HEX);
          return;
        case "/quit": case "/exit": case "/q": return this.exit();
        case "/stop":
          await c.call("shutdown").catch(() => undefined);
          return this.exit("daemon stopped");
        case "/sdd": case "/new": case "/goal": return await this.newGoal(args.join(" "));
        case "/init": {
          const r = await c.call<{ skipped?: boolean }>("init.start", { description: args.join(" ") || null });
          if (r.skipped) return;
          this.sessions.set("init", blankSession("init", "init"));
          this.select("init");
          return;
        }
        case "/run": case "/approve": {
          const j = flag(args, "-j");
          const agent = flag(args, "--agent");
          if (!this.snap.draft) {
            if (args[0] && !/\.json$/.test(args[0])) return await this.newGoal(args.join(" ")); // `/run build a todo API`
            if (args[0]) {
              const r = await c.call<{ run_id: string }>("run.start", { plan_path: args[0], agent: agent || null, max_parallel: j ? Number(j) : undefined });
              this.log(`run ${r.run_id} started`, S.cyan);
              return;
            }
            throw new Error("no plan to run — /sdd <goal> first (or just ask Claude in the chat)");
          }
          await c.call<{ run_id: string }>("draft.approve", { agent: agent || null, max_parallel: j ? Number(j) : undefined });
          this.select(this.snap.draft?.plan.tasks[0]?.id ?? HEX);
          return;
        }
        case "/close": await c.call("run.close"); this.log("run closed", S.gray); return;
        case "/model": case "/models": {
          type M = { role: string; agent: string; model: string; effort: string }[];
          const list = args.length >= 2
            ? await c.call<M>("models.set", { role: args[0]!.toLowerCase(), model: args[1] === "default" ? null : args[1] })
            : await c.call<M>("models.list");
          this.log(list.map((m) => `${padTo(m.role, 12)} ${padTo(m.model, 10)} effort ${m.effort}${m.agent !== "claude" ? `  (agent ${m.agent})` : ""}`).join("\n"), S.white);
          if (args.length < 2) this.log("Change with /model <role> <identifier|default>. `default` keeps the CLI's own model; /agents shows what each CLI reports.", S.gray);
          this.select(HEX);
          return;
        }
        case "/animate":
          this.still = args[0] ? args[0] === "off" : !this.still;
          this.prev = [];
          this.flash(`animations ${this.still ? "off" : "on"}`);
          return;
        case "/agents": {
          const list = await c.call<AgentInfo[]>("agents.list");
          this.log(list.map((a) => formatAgent(a, true)).join("\n\n"), S.white);
          this.select(HEX);
          return;
        }
        case "/allow": {
          const r = await c.call<{ text: string }>("allow", { rules: args.length ? args : [] });
          this.flash(r.text);
          return;
        }
        case "/install": {
          if (!args[0]) {
            const l = await c.call<{ name: string; installed: string | null; on_path: boolean }[]>("toolchain.list");
            this.log(l.map((t) => `${padTo(t.name, 8)} ${t.installed ? `installed by Hexagon (${t.installed})` : t.on_path ? "on your PATH" : "not installed"}`).join("\n"), S.white);
            this.select(HEX);
            return;
          }
          this.flash(`installing ${args[0]}…`);
          const r = await c.call<{ text: string }>("toolchain.install", { name: args[0] });
          this.flash(r.text);
          return;
        }
        case "/discard": await c.call("draft.discard"); this.log("draft discarded", S.gray); return;
        case "/spec": {
          const d = this.snap.draft;
          const file = d?.spec_path ?? (this.snap.plan?.specs[0] ? path.join(this.root, this.snap.plan.specs[0]) : null);
          if (!file) throw new Error("no spec yet");
          await this.suspend(() => edit(file));
          if (d) await c.call("draft.reload");
          return;
        }
        case "/plan": {
          const d = this.snap.draft;
          if (!d) throw new Error("no draft plan to edit");
          await this.suspend(() => edit(d.plan_path));
          await c.call("draft.reload");
          return;
        }
        case "/answer": {
          const [qid, ...rest] = args;
          if (!qid || !rest.length) throw new Error("usage: /answer Q-n <text>");
          const r = await c.call<{ task_id: string }>("question.answer", { question_id: qid, answer: rest.join(" ") });
          this.log(`↳ answered ${qid} (${r.task_id}): ${rest.join(" ")}`, S.orange);
          return;
        }
        case "/tell": {
          const [to, ...rest] = args;
          if (!to || !rest.length) throw new Error("usage: /tell <T-n|@role|@all> <text>");
          return await this.tell(to.replace(/^@/, ""), rest.join(" "));
        }
        case "/lead": return await this.tell("lead", args.join(" "));
        case "/pause": case "/resume": {
          const verb = cmd!.slice(1);
          const t = args.find((a) => TASK_RE.test(a)) ?? (TASK_RE.test(this.selected) && args[0] !== "all" ? this.selected : null);
          if (t) await c.call(`agent.${verb}`, { task: normTask(t) });
          else await c.call(`run.${verb}`);
          this.flash(`${verb}d ${t ? normTask(t) : "the run"}`);
          return;
        }
        case "/cancel": { const t = this.target(args); await c.call("agent.cancel", { task: t }); this.flash(`${t} cancelled`); return; }
        case "/retry": {
          const agent = flag(args, "--agent");
          const effort = flag(args, "--effort");
          const t = this.target(args);
          await c.call("agent.retry", { task: t, agent: agent || undefined, effort: effort || undefined });
          this.loaded.delete(t);
          this.flash(`${t}: new attempt queued`);
          return;
        }
        case "/takeover": {
          const t = this.target(args);
          let msg = "";
          await this.suspend(async () => { msg = await takeoverInTerminal(c, t); });
          this.log(msg, S.magenta);
          return;
        }
        case "/open": {
          const t = this.target(args);
          this.flash(await openTerminal(t, hexagonCommand(this.root, ["attach", t])));
          return;
        }
        case "/diff": {
          const t = this.target(args);
          const r = await c.call<{ diff: string }>("agent.diff", { task: t });
          await this.suspend(() => page(r.diff));
          return;
        }
        case "/merge": { const r = await c.call<{ text: string }>("merge.base"); this.log(r.text, S.green); return; }
        case "/abort": await c.call("run.abort"); this.log("run aborted", S.orange); return;
        case "/clean": { const r = await c.call<{ removed: string[] }>("worktrees.clean"); this.log(`removed ${r.removed.length} worktree(s)`, S.gray); return; }
        default: throw new Error(`unknown command ${cmd} — /help`);
      }
    } catch (e) {
      this.flash(e instanceof Error ? e.message : String(e), "error");
      this.log(`✖ ${e instanceof Error ? e.message : String(e)}`, S.orange);
    }
  }

  // ───────────── rendering ─────────────

  private render() {
    if (this.suspended) return;
    this.dirty = false;
    const W = Math.max(40, process.stdout.columns || 100);
    const H = Math.max(16, process.stdout.rows || 30);
    const cv = new Canvas(W, H);
    this.header(cv, W);

    const bottomH = 3;
    const bodyH = H - 1 - bottomH;
    const plan = this.plan();
    const dagNodes = this.dagNodes(plan);
    let planH: number;
    if (dagNodes.length) {
      const probe = renderDag(dagNodes, { maxW: W - 4, maxH: Math.floor(bodyH * 0.5) - 2, frame: this.frame, selected: this.selected, still: this.still });
      planH = Math.min(Math.floor(bodyH * 0.5), probe.h + 2 + (this.showingDraft() ? 1 : 0));
      this.planPanel(cv, 1, W, planH, probe);
    } else {
      planH = Math.min(7, Math.floor(bodyH * 0.4));
      this.placeholderPanel(cv, 1, W, planH);
    }
    const midY = 1 + planH;
    const midH = bodyH - planH;
    const listW = Math.min(64, Math.max(34, Math.floor(W * 0.42)));
    this.agentList(cv, 0, midY, listW, midH);
    this.feedPanel(cv, listW, midY, W - listW, midH);
    this.bottom(cv, H - bottomH, W);

    const lines = cv.lines(true);
    let out = "\x1b[?2026h";
    for (let i = 0; i < lines.length; i++) if (this.prev[i] !== lines[i]) out += `\x1b[${i + 1};1H${lines[i]}`;
    out += "\x1b[?2026l";
    this.prev = lines;
    process.stdout.write(out);
  }

  private header(cv: Canvas, W: number) {
    cv.fill(0, 0, W, 1, S.bgBar);
    // The logo "breathes" (⬡ ⬢) while agents work.
    const logo = this.anyActive() ? ["⬡", "⬢"][Math.floor(this.frame / 5) % 2]! : "⬡";
    let x = cv.text(1, 0, `${logo} HEXAGON`, st(S.bold, S.cyan, S.bgBar));
    x = cv.text(x + 2, 0, path.basename(this.root), st(S.white, S.bgBar));
    const r = this.snap.run;
    const parts: [string, string][] = [];
    if (r) {
      const done = r.counts.done ?? 0;
      const need = r.attention.filter((a) => a.kind === "question").length;
      const failed = (r.counts.failed ?? 0) + (r.counts.blocked ?? 0);
      parts.push([`${r.state === "running" ? spinner(this.frame) : r.state === "done" ? "✔" : r.state === "paused" ? "‖" : "−"} ${r.state}`, r.state === "running" ? S.blue : r.state === "done" ? S.green : S.magenta]);
      parts.push([`${done}/${r.agents.length} done`, S.white]);
      if (need) parts.push([`${need} need${need === 1 ? "s" : ""} you`, st(S.orange, S.bold)]);
      if (failed) parts.push([`${failed} failed`, S.red]);
      const total = spent(r.totals);
      const ctx = r.totals.input_tokens + r.totals.cache_read_tokens;
      parts.push([`${tok(total)}${r.budget_tokens ? ` / ${tok(r.budget_tokens)}` : ""} tokens`, S.white]);
      parts.push([`${tok(r.totals.output_tokens)} out${ctx ? ` · ${Math.round((100 * r.totals.cache_read_tokens) / ctx)}% cached` : ""}`, S.gray]);
      const start = Date.parse(r.started_at ?? "") || 0;
      const end = r.state === "done" || r.state === "aborted" ? Date.parse(r.updated_at) : Date.now();
      parts.push([`⏱ ${dur(start ? end - start : r.totals.wall_ms)}`, S.gray]);
    } else if (this.snap.draft) parts.push(["plan awaiting approval", S.orange]);
    else if (this.plannerBusy()) parts.push([`${spinner(this.frame)} planning`, S.blue]);
    for (const [t, s] of parts) {
      x = cv.text(x + 1, 0, " │ ", st(S.gray, S.bgBar));
      x = cv.text(x, 0, t, st(s, S.bgBar));
    }
    cv.text(W - 10, 0, "/help  ", st(S.gray, S.bgBar));
  }

  private dagNodes(plan: Plan | null): DagNode[] {
    if (!plan) return [];
    const brief = new Map(this.runAgents().map((a) => [a.task_id, a]));
    return plan.tasks.map((t) => {
      const a = this.full.get(t.id);
      return {
      provider: a?.agent.provider ?? null, cli: a ? `${a.agent.adapter ?? a.agent.id}${a.agent.cli_version ? ` ${a.agent.cli_version}` : ""}` : null,
      runtimeModel: a?.agent.runtime_model ?? null, fixCycle: a?.fix_cycle ?? null,
      quota: a?.state === "waiting_quota" ? quotaLabel(a).replace("resumes ", "") : null,
      id: t.id, title: t.title, role: t.role, deps: t.depends_on,
      state: (this.snap.run && !this.showingDraft() ? this.full.get(t.id)?.state ?? brief.get(t.id)?.state ?? "queued" : "queued") as AgentState,
      progress: this.snap.run && !this.showingDraft() ? this.progress(t.id) : null,
    }; });
  }

  /** Pipeline progress of a task's agent (never goes backwards while it runs). */
  private progress(id: string): number | null {
    const a = this.full.get(id);
    const b = this.runAgents().find((x) => x.task_id === id);
    const state = (a?.state ?? b?.state ?? "queued") as AgentState;
    const p = progressOf(state, a?.phase, a?.progress ?? b?.progress, this.lastProgress.get(`${this.snap.run?.run_id}/${id}`) ?? 0);
    if (p != null) this.lastProgress.set(`${this.snap.run?.run_id}/${id}`, p);
    return p;
  }

  private planPanel(cv: Canvas, y: number, W: number, h: number, dag: Canvas) {
    const d = this.snap.draft;
    const draft = this.showingDraft();
    const title = draft && d ? `Draft plan · ${clip(d.goal, 50)}` : this.snap.run ? `Task graph · ${this.snap.run.run_id}` : "Plan";
    const color = draft ? S.orange : S.gray;
    cv.box(0, y, W, h, color, title, st(S.bold, draft ? S.orange : S.white));
    const ox = Math.max(2, Math.floor((W - dag.w) / 2));
    cv.blit(dag, ox, y + 1, 0, 0, Math.min(dag.w, W - 4), Math.min(dag.h, h - 2));
    if (d && draft) {
      const c = d.check;
      const msg = c.errors.length ? `✖ ${c.errors[0]}` : c.warnings.length ? `! ${c.warnings.length} warning(s): ${c.warnings[0]}` : `✔ ${d.plan.tasks.length} tasks · spec ${path.relative(this.root, d.spec_path)}`;
      cv.text(2, y + h - 2, clip(msg, W - 4), c.errors.length ? S.red : c.warnings.length ? S.orange : S.green);
      cv.text(2, y + h - 1, " Enter run · type to revise · /spec · /plan · /discard ", st(S.orange, S.bold), W - 2);
    }
  }

  private placeholderPanel(cv: Canvas, y: number, W: number, h: number) {
    const p = this.sessions.get("planner");
    cv.box(0, y, W, h, S.gray, "Plan", st(S.bold, S.white));
    const lines: [string, string][] = [];
    if (p && (p.state === "running" || p.state === "waiting_input")) {
      lines.push([`${p.state === "running" ? spinner(this.frame) : "?"} The planner is writing a spec and task graph…`, st(S.blue, S.bold)]);
      lines.push([p.question ? `It asks: ${p.question.prompt}` : p.activity ?? "", p.question ? S.orange : S.gray]);
    } else if (p?.state === "failed") {
      lines.push([`✖ Planning failed: ${p.error ?? ""}`, S.red], ["Describe the goal again, or adjust it.", S.gray]);
    } else {
      lines.push(["Chat with Claude below: it answers questions and makes changes directly in this repo.", st(S.white, S.bold)]);
      lines.push(["For bigger work, /sdd <goal>: a planner writes a spec and a task graph, you approve it, agents build it in parallel.", S.gray]);
      if (!this.snap.has_context) lines.push(["Tip: /init lets an agent study this repo and write HEXAGON.md first.", S.cyan]);
    }
    lines.slice(0, h - 2).forEach(([t, s], i) => cv.text(3, y + 1 + i, clip(t, W - 6), s));
  }

  private agentList(cv: Canvas, x: number, y: number, w: number, h: number) {
    cv.box(x, y, w, h, S.gray, "Agents", st(S.bold, S.white));
    type Seg = [string, string];
    // A card: a title line (glyph, readable name, progress bar) and detail lines below it.
    const cards: { id: string; title: Seg[]; bar?: number | null; barStyle?: string; lines: Seg[][] }[] = [];
    const project = this.projectStackCached();
    for (const id of this.entries()) {
      const perm = this.permFor(id);
      if (id === HEX) {
        const cs = this.sessions.get(HEX);
        const busy = cs?.state === "running";
        cards.push({
          id,
          title: [[busy ? spinner(this.frame) : "◆", S.cyan], [" Claude", S.bold], ["  chat", S.gray]],
          lines: [
            [["works directly in this repo", S.gray], [cs ? ` · ${tok(sessTok(cs))} tokens` : "", S.gray]],
            [[perm ? `⚠ approve: ${perm.command}` : busy ? cs?.activity ?? "thinking…" : this.notice?.text ?? "ask anything · /sdd <goal> for agents", perm ? S.orange : S.gray]],
            ...(project.length ? [[[project.join(" · "), S.cyan] as Seg]] : []),
          ],
        });
        continue;
      }
      const s = this.sessions.get(id);
      if (s) {
        const g = s.state === "running" ? spinner(this.frame) : s.state === "waiting_input" ? "?" : s.state === "done" ? "✔" : s.state === "failed" ? "✖" : "−";
        const col = s.state === "running" ? S.blue : s.state === "waiting_input" ? S.orange : s.state === "done" ? S.green : S.red;
        const name = SESSION_NAMES[id] ?? [id, ""];
        cards.push({
          id,
          title: [[g, col], [` ${name[0]}`, S.bold]],
          lines: [
            [[`${name[1]} · ${s.agent} · ${tok(sessTok(s))} tokens`, S.gray]],
            [[perm ? `⚠ approve: ${perm.command}` : s.question ? `asks: ${s.question.prompt}` : s.error ?? s.activity ?? s.state, s.question || perm ? S.orange : s.error ? S.red : S.gray]],
          ],
        });
        continue;
      }
      const a = this.full.get(id);
      const b = this.runAgents().find((x) => x.task_id === id);
      const t = this.plan()?.tasks.find((x) => x.id === id);
      const state = (a?.state ?? b?.state ?? "queued") as AgentState;
      const flags: Seg[] = [];
      if (a?.needs_input) flags.push([" ?", st(S.orange, S.bold)]);
      if (perm) flags.push([" ⚠", st(S.orange, S.bold)]);
      if (a?.inbox.pending) flags.push([` ✉${a.inbox.pending}`, S.cyan]);
      if (a?.controller === "user") flags.push([" you", S.magenta]);
      const ac = a?.progress && a.progress.total ? ` · ${a.progress.done}/${a.progress.total} AC` : "";
      const model = a ? agentIdentity(a) : "";
      const now = perm ? `⚠ approve: ${perm.command}`
        : state === "queued" || TERMINAL_STATES.has(state) ? `${state.replace("_", " ")}${a?.state_reason ? ` — ${a.state_reason}` : ""}`
        : a?.activity ?? b?.activity ?? state;
      const stack = t ? taskStack(t, project) : [];
      const tools = toolsUsed(this.events.get(id) ?? []).slice(0, 4);
      cards.push({
        id,
        bar: this.progress(id),
        barStyle: STATE_COLOR[state],
        title: [[glyph(state, this.frame), STATE_COLOR[state]], [` ${t?.title ?? id}`, S.bold], ...flags],
        lines: [
          [[`${id} · ${a?.role ?? b?.role ?? t?.role ?? ""} · ${tok(a ? spent(a.usage) : b?.tokens ?? 0)} tokens${ac}${model ? ` · ${model}` : ""}`, S.gray]],
          ...wrap(now, Math.max(10, w - 7)).slice(0, state === "failed" || state === "blocked" ? 3 : 1).map((l) => [[l, perm || state === "failed" || state === "blocked" ? S.orange : S.white]] as Seg[]),
          ...(a ? [[[modelLine(a), S.gray] as Seg]] : []),
          ...(a?.state === "waiting_quota" || a?.recovery ? [[[recoveryLine(a), a.state === "waiting_quota" ? S.orange : S.gray] as Seg]] : []),
          [[stack.join(" · "), S.cyan], [tools.length ? `${stack.length ? "  " : ""}⚒ ${tools.map((u) => `${u.name}${u.n > 1 ? `×${u.n}` : ""}`).join(" ")}` : "", S.gray]],
        ],
      });
    }
    // Big cards when they fit; otherwise title + current activity only.
    const inner = h - 2;
    const full = cards.reduce((n, c) => n + 1 + c.lines.length + 1, 0) - 1 <= inner;
    const sizeOf = (c: (typeof cards)[number]) => (full ? 1 + c.lines.length + 1 : 2);
    const selIdx = Math.max(0, cards.findIndex((c) => c.id === this.selected));
    let start = 0;
    while (start < selIdx && cards.slice(start, selIdx + 1).reduce((n, c) => n + sizeOf(c), 0) > inner) start++;
    let yy = y + 1;
    for (const card of cards.slice(start)) {
      const lines = full ? card.lines : [card.lines[1] ?? []];
      const hgt = 1 + lines.length;
      if (yy + hgt > y + h - 1) break;
      const sel = card.id === this.selected;
      const bg = sel ? S.bgSel : "";
      if (sel) { cv.fill(x + 1, yy, w - 2, hgt, S.bgSel); for (let i = 0; i < hgt; i++) cv.set(x + 1, yy + i, "▌", st(S.cyan, bg)); }
      const barW = card.bar != null && w >= 34 ? Math.min(18, Math.floor(w / 3)) : 0;
      let cx = x + 3;
      for (const [t, sty] of card.title) cx = cv.text(cx, yy, t, st(sty, bg), x + w - 3 - barW);
      if (barW) {
        const b = bar(card.bar!, barW);
        let bx = cv.text(x + w - 1 - barW, yy, b.fill, st(card.barStyle ?? S.blue, bg));
        bx = cv.text(bx, yy, b.rest, st(S.gray, S.dim, bg));
        cv.text(bx, yy, b.label, st(card.bar === 1 ? S.green : S.gray, bg));
      }
      lines.forEach((segs, i) => {
        let lx = x + 5;
        for (const [t, sty] of segs) if (t) lx = cv.text(lx, yy + 1 + i, clip(t, Math.max(0, x + w - 2 - lx)), st(sty, bg), x + w - 1);
      });
      yy += hgt + (full ? 1 : 0);
    }
  }

  private taskTitle(id: string): string {
    return this.plan()?.tasks.find((t) => t.id === id)?.title ?? id;
  }

  private stackCache: { at: number; v: string[] } = { at: 0, v: [] };
  private projectStackCached(): string[] {
    if (Date.now() - this.stackCache.at > 5000) this.stackCache = { at: Date.now(), v: projectStack(this.snap.root || process.cwd()) };
    return this.stackCache.v;
  }

  private feedPanel(cv: Canvas, x: number, y: number, w: number, h: number) {
    const sel = this.selected;
    const inner = w - 4;
    const head: [string, string][] = [];
    let feed: FeedLine[] = [];
    let chat: { text: string; style: string }[] | null = null;
    let title = sel;
    const s = this.sessions.get(sel);
    const a = this.full.get(sel);
    if (sel === HEX) {
      const cs = this.sessions.get(HEX);
      title = "Chat · Claude";
      const notes: ChatItem[] = (this.feeds.get(HEX) ?? []).map((f) => ({ ts: f.ts, kind: "info", text: f.text, style: f.style || S.gray }));
      const items = [...(cs ? itemsFromSession(cs) : []), ...notes].sort((x, y) => x.ts.localeCompare(y.ts));
      chat = chatLines(items, inner, "Claude");
      const r = this.snap.run;
      head.push([cs ? `${cs.state === "running" ? `${spinner(this.frame)} thinking` : cs.state} · ${tokLine(cs.tokens)}` : "Ask Claude anything or ask for a change: it works directly in this repo. /sdd <goal> runs the spec-driven flow.", S.gray]);
      if (r) head.push([`run ${r.run_id} · ${r.state} · ${r.integration_branch} → ${r.base_branch}`, S.gray]);
    } else if (s) {
      title = `Chat · ${(SESSION_NAMES[s.id] ?? [s.id])[0]} · ${s.agent}`;
      chat = chatLines(itemsFromSession(s), inner, (SESSION_NAMES[s.id] ?? [s.id])[0]);
      head.push([`${s.state.replace("_", " ")} · ${tokLine(s.tokens)}${s.summary ? ` · ${s.summary}` : ""}`, s.state === "failed" ? S.red : S.gray]);
      if (s.question) head.push([`? ${s.question.question_id} ${s.question.prompt}${s.question.options?.length ? "  " + s.question.options.map((o) => `${o.id}) ${o.label}`).join("  ") : ""}`, st(S.orange, S.bold)]);
    } else if (a) {
      title = `Chat · ${this.taskTitle(a.task_id)} (${a.task_id}) · ${a.role} · ${a.agent.id}${a.agent.model ? ` (${a.agent.model}${a.agent.effort ? `, ${a.agent.effort}` : ""})` : ""} · attempt ${a.attempt}`;
      const conv = itemsFromEvents(this.events.get(sel) ?? []);
      chat = chatLines(conv.items, inner, `${a.task_id} ${clip(this.taskTitle(a.task_id), 28)}`, conv.acked, TERMINAL_STATES.has(a.state));
      const since = Date.now() - Date.parse(a.state_since);
      head.push([`${glyph(a.state, this.frame)} ${a.state.replace("_", " ")} ${dur(since)}${a.state_reason ? ` — ${a.state_reason}` : ""} · ${a.usage.turns} step(s)`, STATE_COLOR[a.state]]);
      head.push([tokLine({ input: a.usage.input_tokens, cache_read: a.usage.cache_read_tokens, output: a.usage.output_tokens, steps: a.usage.turns }), S.gray]);
      if (a.checklist?.length) head.push([a.checklist.map((i) => `${i.status === "done" ? "✔" : i.status === "failed" ? "✖" : "○"} ${i.id}`).join("  "), S.green]);
      if (a.needs_input) head.push([`? ${a.needs_input.question_id} ${a.needs_input.prompt}${a.needs_input.options?.length ? "  " + a.needs_input.options.map((o) => `${o.id}) ${o.label}`).join("  ") : ""}`, st(S.orange, S.bold)]);
      if (a.workspace?.worktree) head.push([`${a.workspace.worktree}  (${a.workspace.branch})`, S.gray]);
    } else {
      const t = this.plan()?.tasks.find((t) => t.id === sel);
      if (t) {
        title = `${t.id} · ${t.role}`;
        head.push([t.title, st(S.white, S.bold)], [`writes ${t.files.write.join(", ")}`, S.gray], [`verify: ${t.verify.join(" && ") || "—"}`, S.gray]);
      }
    }
    const perm = (this.snap.permissions ?? []).find((p) => p.agent === sel);
    if (perm) {
      const q = this.permissionQuestion(perm);
      head.push([`⚠ ${perm.id} ${q.prompt}`, st(S.orange, S.bold)], [`   ${q.options.map((o) => `${o.id}) ${o.label}`).join("   ")}`, S.orange]);
    }
    cv.box(x, y, w, h, S.gray, clip(title, w - 6), st(S.bold, S.white));
    let yy = y + 1;
    for (const [t, sty] of head) {
      if (yy >= y + h - 1) break;
      cv.text(x + 2, yy++, clip(t, inner), sty);
    }
    if (head.length) { for (let i = x + 1; i < x + w - 1; i++) cv.set(i, yy, "─", S.gray); yy++; }
    const avail = y + h - 1 - yy;
    if (avail <= 0) return;
    const lines: { text: string; style: string }[] = chat ?? [];
    const stamped = chat === null;
    for (const f of chat ? [] : feed) {
      const prefix = `${time(f.ts)} `;
      const wrapped = wrap(f.text, Math.max(10, inner - prefix.length));
      wrapped.forEach((wl, i) => lines.push({ text: (i === 0 ? prefix : " ".repeat(prefix.length)) + wl, style: f.style }));
    }
    const maxScroll = Math.max(0, lines.length - avail);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const view = lines.slice(Math.max(0, lines.length - avail - this.scroll), lines.length - this.scroll);
    view.forEach((l, i) => {
      if (!stamped) return void cv.text(x + 2, yy + i, l.text, l.style, x + w - 2);
      const end = cv.text(x + 2, yy + i, l.text.slice(0, 9), S.gray, x + w - 2);
      cv.text(end, yy + i, l.text.slice(9), l.style, x + w - 2);
    });
    if (this.scroll) cv.text(x + w - 14, y + h - 1, ` ↑ ${this.scroll} more `, S.gray);
    if (!lines.length) cv.text(x + 2, yy, sel === HEX ? "" : a && a.state === "queued" ? "waiting to start — messages you send now are delivered when it starts" : "no messages yet", S.gray);
  }

  private bottom(cv: Canvas, y: number, W: number) {
    // Line 1: question / notice / command completion.
    const q = this.openQuestion();
    if (this.input.startsWith("/") && !this.menuOpen()) {
      const word = this.input.split(/\s/)[0]!;
      const m = COMMANDS.find(([u]) => u.split(" ")[0] === word);
      cv.text(1, y, clip(m ? `${m[0]} — ${m[1]}` : "unknown command — /help", W - 2), S.gray);
    } else if (this.notice) {
      cv.text(1, y, clip(this.notice.text, W - 2), this.notice.level === "error" ? S.red : this.notice.level === "attention" ? S.orange : S.cyan);
    } else if (q) {
      cv.text(1, y, clip(`? ${q.from} asks (${q.id}): ${q.prompt}${q.options.length ? "  " + q.options.map((o) => `${o.id}) ${o.label}`).join("  ") : ""}`, W - 2), st(S.orange, S.bold));
    }
    // Line 2: input.
    const iy = y + 1;
    cv.fill(0, iy, W, 1, S.bgBar);
    const chip = this.recipient();
    let ix = cv.text(1, iy, ` ${chip.label} `, st(chip.style, S.inverse, S.bold));
    ix = cv.text(ix + 1, iy, "›", st(S.cyan, S.bold, S.bgBar)) + 1;
    const shown = this.input.replace(/\n/g, "↵");
    const maxW = W - ix - 1;
    const startAt = Math.max(0, this.cursor - maxW + 1);
    if (!this.input) {
      cv.set(ix, iy, " ", st(S.inverse, S.bgBar));
      cv.text(ix + 1, iy, clip(this.placeholder(), maxW - 1), st(S.gray, S.bgBar));
    } else {
      const vis = [...shown].slice(startAt, startAt + maxW);
      vis.forEach((ch, i) => cv.set(ix + i, iy, ch, st(S.white, S.bgBar)));
      const cx = ix + this.cursor - startAt;
      // Ghost text: the rest of the selected completion.
      const comp = this.menuOpen() ? this.completions() : null;
      const pick = comp?.items[Math.min(this.menuIdx, comp.items.length - 1)];
      if (pick && pick.value.toLowerCase().startsWith(comp!.token.toLowerCase())) cv.text(cx, iy, pick.value.slice(comp!.token.length), st(S.gray, S.bgBar), W - 1);
      cv.set(cx, iy, [...shown][this.cursor] ?? pick?.value.slice(comp!.token.length)[0] ?? " ", st(S.inverse, S.bgBar));
    }
    // Line 3: keys.
    const keys = this.menuOpen()
      ? "Tab/→ complete · ↑↓ choose · Enter accept · Esc close"
      : "Enter send · Tab/↑↓ switch agent · PgUp/PgDn scroll · ^T takeover · ^O window · ^D diff · / commands · @ mention · ^C quit";
    cv.text(1, y + 2, clip(keys, W - 2), S.gray);
    if (this.menuOpen()) this.menu(cv, y, W);
  }

  /** Suggestion list just above the input line. */
  private menu(cv: Canvas, bottomY: number, W: number) {
    const { items } = this.completions();
    const w = Math.min(W - 4, 84);
    const h = items.length + 2;
    const y0 = bottomY - h + 1;
    const sel = Math.min(this.menuIdx, items.length - 1);
    cv.fill(2, y0, w, h, "");
    cv.box(2, y0, w, h, S.cyan, "suggestions", S.cyan);
    items.forEach((it, i) => {
      const bg = i === sel ? S.bgSel : "";
      cv.fill(3, y0 + 1 + i, w - 2, 1, bg);
      const x = cv.text(4, y0 + 1 + i, padTo(it.value, 16), st(i === sel ? S.white : S.cyan, S.bold, bg), 2 + w - 1);
      cv.text(x + 1, y0 + 1 + i, clip(it.desc, w - 22), st(S.gray, bg), 2 + w - 1);
    });
  }
}

/** "52.1k tokens · 48.0k in (91% cached) · 4.1k out · 12 steps" */
function tokLine(t: SessionStatus["tokens"] | undefined): string {
  if (!t) return "0 tokens";
  const ctx = t.input + t.cache_read;
  return `${tok(ctx + t.output)} tokens · ${tok(ctx)} in${ctx ? ` (${Math.round((100 * t.cache_read) / ctx)}% cached)` : ""} · ${tok(t.output)} out · ${t.steps} step(s)`;
}

function edit(file: string): Promise<void> {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

function page(text: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.env.PAGER || "less", ["-R"], { stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(colorDiff(text));
    child.on("exit", () => resolve());
    child.on("error", () => { console.log(text); resolve(); });
  });
}

function colorDiff(d: string): string {
  return d.split("\n").map((l) =>
    l.startsWith("+") && !l.startsWith("+++") ? `\x1b[32m${l}\x1b[0m`
      : l.startsWith("-") && !l.startsWith("---") ? `\x1b[31m${l}\x1b[0m`
        : l.startsWith("@@") ? `\x1b[36m${l}\x1b[0m` : l).join("\n");
}

export type { Draft };
