import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { HexClient } from "../client/client.js";
import type { AgentState, AgentStatus, Message, Plan, RunStatus, StampedEvent } from "../contracts/types.js";
import { TERMINAL_STATES } from "../contracts/types.js";
import type { SessionStatus } from "../core/solo.js";
import type { Draft, PermissionRequest, Push, RunChanges, Snapshot } from "../daemon/orchestrator.js";
import { hexagonCommand, openTerminal } from "../shell/open.js";
import { Canvas, clip, padTo, S, st, wrap } from "./canvas.js";
import { AnimationManager } from "./motion.js";
import { AmbientField } from "./ambient.js";
import { Director } from "./director.js";
import { computeLayout, type Region } from "./layout.js";
import { renderNetwork, type NetNode } from "./network.js";
import { renderMolecule } from "./molecule.js";
import { renderStartup, startupProgress, STARTUP_MS } from "./startup.js";
import { asciiFold, detectCaps, GROUPS, groupOfRole, STATE_LOOK, TOKENS, sgr, type Caps, type Group, type Token } from "./theme.js";
import { cellAspect } from "./hex.js";
import { loadConfig } from "../core/config.js";
import type { AgentInfo } from "../daemon/orchestrator.js";
import { formatAgent } from "../shell/agents.js";
import { modelLine, quotaLabel, recoveryLine } from "./identity.js";
import { ACTIVE, bar, glyph, progressOf, spinner, STATE_COLOR } from "./dag.js";
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
  ["/changes", "where the work lives: branches, folders, files changed, what is not in your branch yet"],
  ["/merge", "merge the finished run into your branch"],
  ["/abort", "stop the run"],
  ["/clean", "remove worktrees of finished runs (and close the run)"],
  ["/close", "hide the finished run from the dashboard (without merging)"],
  ["/model [role] [model]", "show or set a model override per role (default = the CLI's own) · /agents lists agents, versions and discovered models"],
  ["/animate [full|reduced|off]", "set the motion level (F3 toggles); reduced = fewer frames, off = static"],
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

function gitBranch(root: string): string {
  try {
    const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 7);
  } catch { return ""; }
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
  private frames = 0;
  private moleculeShown = false;
  private modalHidden: string | null = null;
  private changes: RunChanges | null = null;
  private changesAt = 0;
  private ambient = new AmbientField();
  private ambientOn = true;
  private lastInput = Date.now();
  private ambientLevelShown = -1;
  private netTopo = "";
  private netScreen = new Map<string, { x: number; y: number }>();
  private netEdges = new Set<string>();
  private morph: { from: Map<string, { x: number; y: number }>; k: number; prevEdges: Set<string> } | null = null;
  private lastMinute = Math.floor(Date.now() / 60_000);
  private caps: Caps = detectCaps();
  private mgr!: AnimationManager;
  private director!: Director;
  private startup: { t0: number } | null = null;
  private inspectorOn = true;
  private activityFilter = "";
  private layoutMode = "large";
  private branch = "";
  private agentInfo: AgentInfo[] = [];
  private agentInfoAt = 0;
  private housekeeping: NodeJS.Timeout | undefined;
  private keyHandler = (s: string | undefined, k: readline.Key | undefined) => this.onKey(s, k);
  private resizeHandler = () => { this.prev = []; this.invalidate(); };
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
    let ui = { animation: "auto", startup_animation: true, inspector: true, ambient: true };
    try { ui = { ...ui, ...loadConfig(path.join(this.root, ".hexagon", "config.toml")).ui }; } catch { /* defaults */ }
    this.caps = detectCaps(process.env, Boolean(process.stdout.isTTY), { animation: ui.animation, startup: ui.startup_animation });
    this.inspectorOn = ui.inspector;
    this.ambientOn = ui.ambient && process.env.HEXAGON_AMBIENT !== "off";
    this.mgr = new AnimationManager({ motion: this.caps.motion, fps: this.caps.fps || undefined, onFrame: () => this.render() });
    this.director = new Director(this.mgr);
    for (const a of this.snap.agents) this.setFull(a);
    this.director.seed(this.full.values());
    this.branch = gitBranch(this.root);
    if (this.caps.startupAnimation && this.caps.motion !== "off" && process.stdout.isTTY) {
      this.startup = { t0: this.mgr.clock.now() };
      this.mgr.hold("startup", this.caps.fps || 8);
      this.mgr.tween("startup-end", STARTUP_MS, () => {}, { onDone: () => { this.startup = null; this.mgr.release("startup"); this.invalidate(); } });
    }
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
    process.stdin.on("keypress", this.keyHandler);
    process.stdout.on("resize", this.resizeHandler);
    // One scheduler for every animation; idle means no timer is armed. A slow housekeeping tick refreshes the clock and expires notices.
    this.housekeeping = setInterval(() => {
      // Redraw only when something visible changed: the minute on the clock, an expiring notice, or a live run's elapsed time.
      let changed = false;
      if (this.notice && Date.now() - this.notice.at > 10_000) { this.notice = null; changed = true; }
      const minute = Math.floor(Date.now() / 60_000);
      if (minute !== this.lastMinute) { this.lastMinute = minute; changed = true; }
      if (this.snap?.run?.state === "running") changed = true;
      void this.refreshAgentInfo();
      void this.refreshChanges();
      if (this.syncAmbient()) changed = true;
      if (changed) this.invalidate();
    }, 1000);
    this.housekeeping.unref();
    void this.refreshAgentInfo();
    void this.refreshChanges(true);
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
    if (this.housekeeping) clearInterval(this.housekeeping);
    process.stdin.off("keypress", this.keyHandler);
    process.stdout.off("resize", this.resizeHandler);
    this.director?.dispose();
    this.mgr?.dispose();
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
    process.stdin.on("keypress", this.keyHandler);
    this.enter();
  }

  // ───────────── data ─────────────

  private setFull(a: AgentStatus) {
    const cur = this.full.get(a.task_id);
    if (!cur || a.attempt >= cur.attempt) this.full.set(a.task_id, a);
  }

  private onPush(p: Push) {
    this.invalidate();
    if (p.event === "run" || (p.event === "agent_event" && ["state", "files"].includes(p.data.event.type))) void this.refreshChanges();
    switch (p.event) {
      case "status": {
        const prevAttempt = this.full.get(p.data.task_id)?.attempt;
        this.setFull(p.data);
        this.director.status(p.data);
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
          void this.client.call<Snapshot>("ui.snapshot").then((s) => { this.snap = s; this.invalidate(); });
          break;
        }
        if (this.snap.run?.run_id !== p.data.run_id) {
          this.full.clear();
          this.loaded.clear();
          void this.client.call<Snapshot>("ui.snapshot").then((s) => { this.snap = s; for (const a of s.agents) this.setFull(a); this.invalidate(); });
        }
        this.snap.run = p.data;
        break;
      case "agent_event": {
        const list = this.events.get(p.data.task_id) ?? [];
        list.push(p.data);
        if (list.length > 3000) list.splice(0, list.length - 3000);
        this.events.set(p.data.task_id, list);
        this.director.event(p.data);
        break;
      }
      case "message": this.onMessage(p.data); this.director.message(p.data); break;
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
    this.invalidate();
  }

  private flash(text: string, level = "info") {
    this.notice = { text, level, at: Date.now() };
    this.invalidate();
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
  get still(): boolean { return !this.mgr?.enabled; }

  /** Ambient hexagons: on in full motion only, dimmed after 60 s without input, gone after 5 min (nothing redraws then). */
  private ambientLevel(): number {
    if (!this.ambientOn || this.caps.motion !== "full" || !this.mgr.enabled) return 0;
    const idle = Date.now() - this.lastInput;
    return idle > 300_000 ? 0 : idle > 60_000 ? 0.35 : 1;
  }

  /** Keeps the low-rate ambient hold in step with the level. Returns true when the picture needs a redraw. */
  private syncAmbient(): boolean {
    const lvl = this.ambientLevel();
    if (lvl > 0) this.mgr.hold("ambient", lvl < 1 ? 2 : 4); else this.mgr.release("ambient");
    const changed = lvl !== this.ambientLevelShown;
    this.ambientLevelShown = lvl;
    return changed;
  }

  /** Where the work lives (branches, worktrees, size of the change). Throttled; only redraws when it changed. */
  private async refreshChanges(force = false): Promise<void> {
    if (!this.snap?.run) { if (this.changes) { this.changes = null; this.invalidate(); } return; }
    if (!force && Date.now() - this.changesAt < 3000) return;
    this.changesAt = Date.now();
    try {
      const c = await this.client.call<RunChanges | null>("run.changes");
      if (JSON.stringify(c) !== JSON.stringify(this.changes)) { this.changes = c; this.invalidate(); }
    } catch { /* daemon busy: keep the last picture */ }
  }

  private setMotion(arg: string) {
    const mode = arg === "on" ? "full" : arg;
    if (!["full", "reduced", "off"].includes(mode)) return this.flash("usage: /animate [full|reduced|off]");
    this.mgr.motion = mode as "full" | "reduced" | "off";
    this.mgr.fps = mode === "full" ? 24 : mode === "reduced" ? 8 : 0;
    if (mode === "off") this.mgr.cancelAll();
    this.caps = { ...this.caps, motion: mode as Caps["motion"] };
    this.prev = [];
    this.flash(`motion: ${mode}`);
  }

  private async refreshAgentInfo() {
    if (Date.now() - this.agentInfoAt < 90_000) return;
    this.agentInfoAt = Date.now();
    try { this.agentInfo = await this.client.call<AgentInfo[]>("agents.list"); this.invalidate(); } catch { /* daemon busy */ }
  }

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
    // Same order as the grouped navigator, so Tab/arrows move visually down the list.
    const rank = (id: string) => GROUPS.findIndex((g) => g.id === this.groupOf(id));
    return out.map((id, i) => ({ id, i })).sort((x, y) => rank(x.id) - rank(y.id) || x.i - y.i).map((x) => x.id);
  }

  private select(id: string) {
    this.selected = id;
    this.scroll = 0;
    this.invalidate();
    if (TASK_RE.test(id) && !this.loaded.has(id) && this.snap.run) {
      this.loaded.add(id);
      void this.client.call<StampedEvent[]>("agent.events", { task: id, limit: 400 })
        .then((evs) => { this.events.set(id, evs); this.invalidate(); })
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
    this.invalidate();
    const name = k?.name;
    this.lastInput = Date.now();
    this.syncAmbient();
    if (this.startup) { this.startup = null; this.mgr.cancel("startup-end"); this.mgr.release("startup"); }
    const modal = this.approvalModal();
    if (modal && !k?.ctrl) { if (this.approvalKey(modal, s, k)) return; }
    if (name === "f5") { this.modalHidden = null; return; }
    if (name === "f1") return void this.command("/help");
    if (name === "f2") { this.inspectorOn = !this.inspectorOn; this.prev = []; return; }
    if (name === "f3") return this.setMotion(this.still ? "full" : "off");
    if (name === "f4") return void this.command("/agents");
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
          this.setMotion(args[0] ?? (this.still ? "full" : "off"));
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
        case "/changes": {
          const ch = await c.call<RunChanges | null>("run.changes");
          this.changes = ch;
          if (!ch) { this.log("There is no run yet, so there are no changes.", S.gray); this.select(HEX); return; }
          const lines = [
            `Where the work is (run ${ch.run_id}):`,
            `  your branch   ${ch.base_branch}: untouched until /merge`,
            `  integration   ${ch.integration_branch}`,
            `  folder        ${ch.integration_worktree}  (cd there to look around)`,
            `  size          ${ch.files} file(s), +${ch.insertions} −${ch.deletions}, ${ch.commits} commit(s)${ch.merged ? " — already in your branch" : ch.files ? " — not in your branch yet" : ""}`,
            ...ch.file_list.slice(0, 40).map((f) => `    +${String(f.added).padEnd(4)} −${String(f.deleted).padEnd(4)} ${f.path}`),
            ...(ch.file_list.length > 40 ? [`    … ${ch.file_list.length - 40} more`] : []),
            "  agents:",
            ...ch.agents.map((a) => `    ${a.task_id.padEnd(5)} ${a.state.padEnd(14)} ${a.worktree ?? "(no worktree yet)"}${a.branch ? `  [${a.branch}]` : ""}`),
            "/diff T-n shows one agent's change · /merge applies the integration branch to your branch.",
          ];
          this.log(lines.join("\n"), S.white);
          this.select(HEX);
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

  // ───────────── dashboard (design system: see theme.ts / docs/TUI.md) ─────────────

  private get now(): number { return this.mgr.clock.now(); }
  private spin(): number { return this.mgr.enabled ? Math.floor(this.now / 90) : 0; }
  /** Building a long conversation (thousands of events, wrapped) costs tens of ms: redo it only when its inputs changed. */
  private chatCache: { key: string; lines: { text: string; style: string }[] } | null = null;
  private chatMemo(key: string, build: () => { text: string; style: string }[]): { text: string; style: string }[] {
    if (this.chatCache?.key === key) return this.chatCache.lines;
    const lines = build();
    this.chatCache = { key, lines };
    return lines;
  }

  private invalidate() { this.dirty = true; this.mgr?.invalidate(); }
  private tk(t: Token, ...extra: string[]): string { return st(sgr(TOKENS[t], this.caps.color), ...extra); }
  private look(state: AgentState) { const l = STATE_LOOK[state]; return { sym: this.caps.unicode ? l.symbol : l.ascii, label: l.label, style: this.tk(l.token) }; }

  // ── approvals: a real dialog, not a line of chat ──

  private approvalModal(): PermissionRequest | null {
    const list = this.snap?.permissions ?? [];
    if (this.modalHidden && !list.some((p) => p.id === this.modalHidden)) this.modalHidden = null;
    return list.find((p) => p.id !== this.modalHidden) ?? null;
  }

  private choicesOf(p: PermissionRequest): { id: string; label: string; key: string }[] {
    return p.choices ?? [
      { id: "1", label: p.prefix ? `allow \`${p.prefix}\` commands` : "allow it", key: "a" },
      { id: "2", label: "allow every command", key: "*" },
      { id: "3", label: "deny", key: "n" },
    ];
  }

  /** Returns true when the key was used by the dialog. */
  private approvalKey(p: PermissionRequest, s: string | undefined, k: readline.Key | undefined): boolean {
    const choices = this.choicesOf(p);
    if (k?.name === "escape") { this.modalHidden = p.id; this.flash("Approval postponed — press F5 to answer it", "attention"); return true; }
    let pick = choices.find((c) => c.key === s);
    if (!pick && (k?.name === "return" || k?.name === "enter")) pick = choices[0];
    if (!pick && s === "y") pick = choices.find((c) => c.id === "once" || c.id === "1" || c.id === "terminal");
    if (!pick && s && /^[1-9]$/.test(s)) pick = choices[Number(s) - 1];
    if (!pick) return true; // modal: swallow everything else
    this.snap.permissions = (this.snap.permissions ?? []).filter((x) => x.id !== p.id);
    void this.client.call("question.answer", { question_id: p.id, answer: pick.id }).catch((e) => this.flash(String(e.message ?? e), "error"));
    this.invalidate();
    return true;
  }

  private drawApproval(cv: Canvas, W: number, H: number, p: PermissionRequest) {
    const w = Math.min(W - 2, 78);
    const inner = w - 4;
    const a = this.full.get(p.agent);
    const who = a ? `${p.agent} · ${a.role} · ${a.agent.provider} ${a.agent.adapter ?? ""}`.trim() : p.agent === HEX ? "Claude chat" : p.agent;
    const what = p.action === "install" ? "install a tool" : p.action === "sudo" ? "run as ROOT (sudo)" : "run a command";
    const rows: { k: string; v: string; style: string }[] = [
      { k: "Agent", v: who, style: this.tk("text") },
      { k: "Wants to", v: what, style: this.tk("warning", S.bold) },
      { k: "Command", v: p.command, style: this.tk("text", S.bold) },
    ];
    if (p.reason) rows.push({ k: "Why", v: p.reason, style: this.tk("text") });
    const wt = a?.workspace?.worktree;
    rows.push({ k: "Where", v: wt ?? "project root", style: this.tk("muted") });
    if (p.action === "sudo") rows.push({ k: "How", v: "you type the password in a terminal; Hexagon never sees it", style: this.tk("muted") });
    else if (p.action === "install") rows.push({ k: "How", v: "official release into ~/.hexagon/toolchains, no sudo", style: this.tk("muted") });
    else rows.push({ k: "Runs", v: "in the agent's directory, output goes back to the agent", style: this.tk("muted") });
    const lines: { k: string; v: string; style: string }[] = [];
    for (const r of rows) wrap(r.v, inner - 10).slice(0, r.k === "Command" ? 4 : 2).forEach((l, i) => lines.push({ k: i ? "" : r.k, v: l, style: r.style }));
    const choices = this.choicesOf(p);
    const more = (this.snap.permissions ?? []).length - 1;
    const h = lines.length + 6 + (more > 0 ? 1 : 0);
    const x = Math.max(0, Math.floor((W - w) / 2)), y = Math.max(1, Math.floor((H - h) / 2) - 1);
    cv.fill(x, y, w, h, S.bgSel);
    cv.box(x, y, w, h, this.tk(p.action === "sudo" ? "error" : "warning"), " APPROVAL NEEDED ", this.tk("warning", S.bold));
    lines.forEach((l, i) => { cv.text(x + 2, y + 1 + i, l.k.padEnd(9), st(this.tk("muted"), S.bgSel)); cv.text(x + 12, y + 1 + i, clip(l.v, inner - 10), st(l.style, S.bgSel)); });
    let cy = y + lines.length + 2;
    let cx = x + 2;
    for (const c of choices) {
      const label = `[${c.key}] ${c.label}`;
      if (cx + label.length > x + w - 2) { cx = x + 2; cy++; }
      const deny = c.id === "deny" || c.id === "3";
      cx = cv.text(cx, cy, label, st(this.tk(deny ? "error" : "success", S.bold), S.bgSel), x + w - 2) + 2;
    }
    cv.text(x + 2, y + h - 2 - (more > 0 ? 1 : 0), "Enter = first choice · Esc = decide later (F5 reopens)", st(this.tk("muted"), S.bgSel));
    if (more > 0) cv.text(x + 2, y + h - 2, `${more} more waiting`, st(this.tk("warning"), S.bgSel));
  }

  private render() {
    this.dirty = false;
    this.moleculeShown = false;
    const W = Math.max(40, process.stdout.columns || 100);
    const H = Math.max(16, process.stdout.rows || 30);
    let cv = new Canvas(W, H);
    const su = this.startup ? startupProgress(this.now - this.startup.t0) : null;
    if (su?.done) { this.startup = null; this.mgr.release("startup"); }
    if (su && !su.done && su.reveal === 0) cv = renderStartup(W, H, this.now - this.startup!.t0, this.caps, cellAspect());
    else {
      this.dashboard(cv, W, H);
      const modal = this.approvalModal();
      if (modal) this.drawApproval(cv, W, H, modal);
      if (su && !su.done) {
        // Panels reveal top-down while the molecule dissolves below them.
        const sc = renderStartup(W, H, this.now - this.startup!.t0, this.caps, cellAspect());
        for (let y = Math.floor(su.reveal * H); y < H; y++) for (let x = 0; x < W; x++) { cv.chars[y]![x] = sc.chars[y]![x]!; cv.styles[y]![x] = sc.styles[y]![x]!; }
      }
    }
    if (!this.caps.unicode) for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) cv.chars[y]![x] = asciiFold(cv.chars[y]![x]!);
    const lines = cv.lines(true);
    let out = "\x1b[?2026h";
    for (let i = 0; i < lines.length; i++) if (this.prev[i] !== lines[i]) out += `\x1b[${i + 1};1H${lines[i]}`;
    out += "\x1b[?2026l";
    this.prev = lines;
    this.frames++;
    if (this.moleculeShown && !this.startup) this.mgr.hold("molecule", 12); else this.mgr.release("molecule");
    process.stdout.write(out);
  }

  private dashboard(cv: Canvas, W: number, H: number) {
    const L = computeLayout(W, H, { inspector: this.inspectorOn });
    this.layoutMode = L.mode;
    this.header(cv, W);
    if (L.agents) this.agentNavigator(cv, L.agents.x, L.agents.y, L.agents.w, L.agents.h);
    if (L.strip) this.stripRow(cv, L.strip);
    this.networkPanel(cv, L.network);
    if (L.inspector) this.inspectorPanel(cv, L.inspector);
    if (L.activity) this.activityPanel(cv, L.activity);
    this.feedPanel(cv, L.chat.x, L.chat.y, L.chat.w, L.chat.h);
    this.bottom(cv, L.input.y, W);
  }

  private header(cv: Canvas, W: number) {
    cv.fill(0, 0, W, 1, S.bgBar);
    const bar = (s: string) => st(s, S.bgBar);
    const logo = this.caps.unicode ? (this.anyActive() && this.mgr.enabled && Math.floor(this.now / 700) % 2 ? "⬢" : "⬡") : "H";
    let x = cv.text(1, 0, `${logo} HEXAGON`, bar(this.tk("brand", S.bold)));
    x = cv.text(x + 2, 0, path.basename(this.root), bar(this.tk("text")));
    if (this.branch) x = cv.text(x + 1, 0, ` ⎇ ${this.branch}`.replace("⎇", this.caps.unicode ? "⎇" : "@"), bar(this.tk("muted")));
    const r = this.snap.run;
    const parts: [string, string][] = [];
    if (r) {
      const done = r.counts.done ?? 0;
      const running = r.agents.filter((a) => ["starting", "running", "verifying", "reviewing", "merging"].includes(a.state)).length;
      const waiting = r.agents.filter((a) => a.state === "waiting_quota").length;
      const need = r.attention.filter((a) => a.kind === "question").length;
      const failed = (r.counts.failed ?? 0) + (r.counts.blocked ?? 0);
      const rs = r.state === "running" ? this.look("running") : r.state === "done" ? this.look("done") : r.state === "paused" ? this.look("paused") : this.look("cancelled");
      parts.push([`${rs.sym} ${r.state.toUpperCase()}`, rs.style]);
      parts.push([`${running} running`, running ? this.tk("active") : this.tk("muted")]);
      parts.push([`${done}/${r.agents.length} done`, this.tk("text")]);
      if (waiting) parts.push([`${this.look("waiting_quota").sym} ${waiting} waiting`, this.tk("waiting")]);
      if (need) parts.push([`${need} need${need === 1 ? "s" : ""} you`, this.tk("warning", S.bold)]);
      if (failed) parts.push([`${failed} failed`, this.tk("error")]);
      parts.push([`${tok(spent(r.totals))}${r.budget_tokens ? ` / ${tok(r.budget_tokens)}` : ""} tok`, this.tk("muted")]);
      const start = Date.parse(r.started_at ?? "") || 0;
      const end = r.state === "done" || r.state === "aborted" ? Date.parse(r.updated_at) : Date.now();
      parts.push([`${this.caps.unicode ? "⏱" : "t"} ${dur(start ? end - start : r.totals.wall_ms)}`, this.tk("muted")]);
    } else if (this.snap.draft) parts.push(["plan awaiting approval", this.tk("warning")]);
    else if (this.plannerBusy()) parts.push([`${this.look("running").sym} planning`, this.tk("active")]);
    else parts.push(["idle", this.tk("muted")]);
    if (this.agentInfo.length) {
      const seen = new Set<string>();
      const prov = this.agentInfo.filter((a) => a.adapter !== "mock" && !seen.has(a.provider) && seen.add(a.provider));
      if (prov.length) parts.push([prov.map((a) => `${a.provider} ${a.diagnostics?.installed && a.diagnostics.auth !== "unauthenticated" ? (this.caps.unicode ? "✔" : "+") : (this.caps.unicode ? "✖" : "x")}`).join("  "), this.tk("muted")]);
    }
    if (this.changes && this.changes.files > 0 && !this.changes.merged) {
      const c = this.changes;
      parts.push([`${this.caps.unicode ? "Δ" : "~"} ${c.files} file${c.files === 1 ? "" : "s"} +${c.insertions} ${this.caps.unicode ? "−" : "-"}${c.deletions} · not in ${c.base_branch} yet`, this.tk("info")]);
    }
    const nApprovals = (this.snap.permissions ?? []).length;
    if (nApprovals) parts.unshift([`${this.caps.unicode ? "⚠" : "!"} ${nApprovals} approval${nApprovals === 1 ? "" : "s"} waiting${this.approvalModal() ? "" : " (F5)"}`, this.tk("warning", S.bold)]);
    for (const [t, s] of parts) {
      if (x + t.length + 4 >= W - 8) break;
      x = cv.text(x + 1, 0, " │ ", bar(this.tk("border")));
      x = cv.text(x, 0, t, bar(s));
    }
    const clock = new Date().toLocaleTimeString("en-GB", { hour12: false }).slice(0, 5);
    cv.text(W - clock.length - 2, 0, clock, bar(this.tk("muted")));
  }

  private dagNodes(plan: Plan | null): NetNode[] {
    if (!plan) return [];
    const brief = new Map(this.runAgents().map((a) => [a.task_id, a]));
    const live = Boolean(this.snap.run) && !this.showingDraft();
    return plan.tasks.map((t) => {
      const a = this.full.get(t.id);
      const state = (live ? a?.state ?? brief.get(t.id)?.state ?? "queued" : "queued") as AgentState;
      return {
        provider: a?.agent.provider ?? null, cli: a ? `${a.agent.adapter ?? a.agent.id}${a.agent.cli_version ? ` ${a.agent.cli_version}` : ""}` : null,
        runtimeModel: a?.agent.runtime_model ?? null, fixCycle: a?.fix_cycle ?? null, reviewOpen: a?.fix_cycle ?? null,
        quota: a?.state === "waiting_quota" ? quotaLabel(a).replace("resumes ", "") : null,
        id: t.id, title: t.title, role: t.role, deps: t.depends_on, state,
        progress: live ? this.progress(t.id) : null,
      };
    });
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

  private panelBox(cv: Canvas, r: Region, title: string, right = "", focus = false) {
    cv.box(r.x, r.y, r.w, r.h, focus ? this.tk("brand") : this.tk("border"), title, this.tk("text", S.bold));
    if (right) cv.text(r.x + r.w - 2 - [...right].length, r.y, right, this.tk("muted"), r.x + r.w - 1);
  }

  private networkPanel(cv: Canvas, r: Region) {
    const d = this.snap.draft;
    const draft = this.showingDraft();
    const title = draft && d ? `DRAFT PLAN · ${clip(d.goal, 40)}` : this.snap.run ? "AGENT NETWORK" : "AGENT NETWORK";
    this.panelBox(cv, r, title, this.snap.run ? this.snap.run.run_id : "", false);
    const nodes = this.dagNodes(this.plan());
    if (!nodes.length) { this.director.setGeometry(null); this.placeholder2(cv, r); return; }
    const reserve = d && draft ? 3 : 0;
    const opts = { maxW: r.w - 2, maxH: r.h - 2 - reserve, caps: this.caps, now: this.now, selected: this.selected, still: !this.mgr.enabled, fx: this.director.fx };
    const geom = renderNetwork(nodes, opts); // the true geometry: particles, effects and the next morph start from it
    this.director.setGeometry(geom);
    const ox = r.x + 1 + Math.max(0, Math.floor((r.w - 2 - geom.canvas.w) / 2));
    const oy = r.y + 1 + Math.max(0, Math.floor((r.h - 2 - reserve - geom.canvas.h) / 2));
    // Restructuring: when the graph itself changed (tasks or dependencies), glide nodes to their new places.
    const topo = nodes.map((n) => `${n.id}<${n.deps.join(",")}`).join("|");
    if (this.netTopo && topo !== this.netTopo && this.mgr.enabled && this.netScreen.size) {
      const from = new Map<string, { x: number; y: number }>();
      for (const [id, q] of this.netScreen) from.set(id, { x: q.x - ox, y: q.y - oy });
      const m = { from, k: 0, prevEdges: new Set(this.netEdges) };
      this.morph = m;
      this.mgr.tween("morph", 480, (v) => { m.k = v; }, { onDone: () => { if (this.morph === m) this.morph = null; this.invalidate(); } });
    }
    this.netTopo = topo;
    this.netScreen = new Map([...geom.nodes].map(([id, q]) => [id, { x: q.x + ox, y: q.y + oy }]));
    this.netEdges = new Set(geom.edges.map((e) => `${e.from}>${e.to}`));
    const shown = this.morph && this.morph.k < 1 ? renderNetwork(nodes, { ...opts, morph: this.morph }) : geom;
    if (this.mgr.enabled) this.mgr.particles.draw(shown.canvas, this.now, { depth: this.caps.color, unicode: this.caps.unicode });
    cv.blit(shown.canvas, ox, oy, 0, 0, Math.min(shown.canvas.w, r.w - 2), Math.min(shown.canvas.h, r.h - 2 - reserve));
    // Ambient hexagons only in the empty area around the graph (never over it, never over the draft hint).
    const lvl = this.ambientLevel();
    if (lvl > 0) {
      this.ambient.draw(cv, r.x + 1, r.y + 1, r.w - 2, r.h - 2 - reserve, this.now, {
        depth: this.caps.color, unicode: this.caps.unicode, level: lvl,
        blocked: (x, y) => x >= ox - 3 && x < ox + shown.canvas.w + 3 && y >= oy - 1 && y < oy + shown.canvas.h + 1,
      });
    }
    if (d && draft) {
      const c = d.check;
      const msg = c.errors.length ? `✖ ${c.errors[0]}` : c.warnings.length ? `! ${c.warnings.length} warning(s): ${c.warnings[0]}` : `✔ ${d.plan.tasks.length} tasks · spec ${path.relative(this.root, d.spec_path)}`;
      cv.text(r.x + 2, r.y + r.h - 3, clip(msg, r.w - 4), c.errors.length ? this.tk("error") : c.warnings.length ? this.tk("warning") : this.tk("success"));
      cv.text(r.x + 2, r.y + r.h - 2, clip("Enter run · type to revise · /spec · /plan · /discard", r.w - 4), this.tk("warning", S.bold));
    }
  }

  private placeholder2(cv: Canvas, r: Region) {
    const p = this.sessions.get("planner");
    const lines: [string, string][] = [];
    if (p && (p.state === "running" || p.state === "waiting_input")) {
      lines.push([`${p.state === "running" ? this.look("running").sym : "?"} The planner is writing a spec and task graph…`, this.tk("active", S.bold)]);
      lines.push([p.question ? `It asks: ${p.question.prompt}` : p.activity ?? "", p.question ? this.tk("warning") : this.tk("muted")]);
    } else if (p?.state === "failed") {
      lines.push([`${this.look("failed").sym} Planning failed: ${p.error ?? ""}`, this.tk("error")], ["Describe the goal again, or adjust it.", this.tk("muted")]);
    } else {
      lines.push(["No agent network yet.", this.tk("text", S.bold)]);
      lines.push(["Chat with Claude below: it answers questions and edits this repo directly.", this.tk("muted")]);
      lines.push(["For bigger work, /sdd <goal>: a planner writes a spec and task graph, you approve it, agents build it in parallel.", this.tk("muted")]);
      if (!this.snap.has_context) lines.push(["Tip: /init lets an agent study this repo and write HEXAGON.md first.", this.tk("info")]);
    }
    lines.slice(0, r.h - 2).forEach(([t, s], i) => cv.text(r.x + 3, r.y + 2 + i, clip(t, r.w - 6), s));
    // A live 3D atom while the empty state is on screen (12 fps); a still frame when motion is off.
    if (r.h >= 12 && r.w >= 40) {
      this.moleculeShown = true;
      const sc = renderMolecule(r.w - 2, r.h - 8, this.caps.motion === "off" ? 0 : this.now, this.caps, cellAspect());
      cv.blit(sc, r.x + 1, r.y + 7, 0, 0, r.w - 2, r.h - 8);
    }
  }

  // ── agent navigator ──

  private meta(agentId: string): AgentInfo | undefined { return this.agentInfo.find((a) => a.id === agentId); }

  private groupOf(id: string): Group {
    if (id === HEX || this.sessions.has(id)) return "analysis";
    const role = this.full.get(id)?.role ?? this.runAgents().find((a) => a.task_id === id)?.role ?? this.plan()?.tasks.find((t) => t.id === id)?.role ?? "implementer";
    return groupOfRole(role);
  }

  private card(id: string): { sym: string; symStyle: string; title: string; l2: string; l2b: string; l3: [string, string][]; detail: [string, string][]; pct: number | null } {
    const perm = this.permFor(id);
    const muted = this.tk("muted");
    if (id === HEX) {
      const cs = this.sessions.get(HEX);
      const busy = cs?.state === "running";
      const m = this.meta(cs?.agent ?? "claude");
      return {
        sym: busy ? this.look("running").sym : this.caps.unicode ? "◆" : "*", symStyle: busy ? this.tk("active") : this.tk("brand"), title: "Claude chat",
        l2: m ? m.provider : "works in this repo", l2b: m ? `${m.adapter}${m.diagnostics?.version ? ` ${m.diagnostics.version}` : ""}` : "",
        l3: [[perm ? `approve: ${perm.command}` : busy ? (cs?.activity ?? "THINKING").slice(0, 40) : "READY", perm ? this.tk("warning") : busy ? this.tk("active") : muted], [cs ? `  ${tok(sessTok(cs))} tok` : "", muted]],
        detail: [[`model: ${m?.selection?.mode === "cli-default" || !m ? "CLI-managed" : (m.selection as { identifier?: string }).identifier ?? "CLI-managed"}`, muted]], pct: null,
      };
    }
    const s = this.sessions.get(id);
    if (s) {
      const name = SESSION_NAMES[id] ?? [id, ""];
      const st2: AgentState = s.state === "running" ? "running" : s.state === "waiting_input" ? "waiting_input" : s.state === "done" ? "done" : s.state === "failed" ? "failed" : "cancelled";
      const lk = this.look(st2);
      const m = this.meta(s.agent);
      return {
        sym: lk.sym, symStyle: lk.style, title: name[0],
        l2: m ? m.provider : s.agent, l2b: m ? `${m.adapter}${m.diagnostics?.version ? ` ${m.diagnostics.version}` : ""}` : "",
        l3: [[perm ? `approve: ${perm.command}` : s.question ? `asks: ${s.question.prompt}` : s.error ?? lk.label, perm || s.question ? this.tk("warning") : s.error ? this.tk("error") : lk.style]],
        detail: [[`${name[1]} · ${tok(sessTok(s))} tok`, muted]], pct: null,
      };
    }
    const a = this.full.get(id);
    const b = this.runAgents().find((x) => x.task_id === id);
    const t = this.plan()?.tasks.find((x) => x.id === id);
    const state = (a?.state ?? b?.state ?? "queued") as AgentState;
    const lk = this.look(state);
    const flags = `${a?.needs_input ? " ?" : ""}${perm ? " !" : ""}${a?.inbox.pending ? ` ✉${a.inbox.pending}` : ""}${a?.controller === "user" ? " you" : ""}`;
    const role = a?.role ?? b?.role ?? t?.role ?? "";
    const detail: [string, string][] = [];
    if (a) {
      detail.push([modelLine(a), muted]);
      if (a.state === "waiting_quota" || a.recovery) detail.push([recoveryLine(a), a.state === "waiting_quota" ? this.tk("waiting") : muted]);
      if (a.state_reason && (state === "failed" || state === "blocked")) detail.push([a.state_reason, this.tk(state === "failed" ? "error" : "warning")]);
    } else if (state === "queued") detail.push([a ? "" : "waiting for an agent to be assigned", muted]);
    return {
      sym: lk.sym, symStyle: lk.style, title: `${t?.title ?? id}${flags}`,
      l2: a ? `${role} · ${a.agent.provider}` : role,
      l2b: a ? `${a.agent.adapter ?? a.agent.id}${a.agent.cli_version ? ` ${a.agent.cli_version}` : ""} · ${a.agent.runtime_model ?? "CLI-managed"}` : "",
      l3: [[perm ? `approve: ${perm.command}` : lk.label, perm ? this.tk("warning") : lk.style], [`  ${id}`, muted]],
      detail, pct: this.progress(id),
    };
  }

  private agentNavigator(cv: Canvas, x: number, y: number, w: number, h: number) {
    const ids = this.entries();
    this.panelBox(cv, { x, y, w, h }, "AGENTS", String(ids.length).padStart(2, "0"), true);
    const inner = h - 2;
    type Row = { kind: "group"; text: string } | { kind: "line"; id: string; idx: number; segs: [string, string][]; pct?: number | null; title?: boolean };
    const build = (level: 0 | 1 | 2): { rows: Row[]; first: Map<string, number> } => {
      const rows: Row[] = [];
      const first = new Map<string, number>();
      for (const g of GROUPS) {
        const members = ids.filter((id) => this.groupOf(id) === g.id);
        if (!members.length) continue;
        rows.push({ kind: "group", text: g.title });
        for (const id of members) {
          const c = this.card(id);
          const sel = id === this.selected;
          first.set(id, rows.length);
          rows.push({ kind: "line", id, idx: 0, title: true, segs: [[c.sym, c.symStyle], [` ${c.title}`, sel ? this.tk("text", S.bold) : this.tk("text")]], pct: c.pct });
          if (level < 2) rows.push({ kind: "line", id, idx: 1, segs: [[`  ${c.l2}`, this.tk("muted")]] });
          if (level < 1 && c.l2b) rows.push({ kind: "line", id, idx: 1, segs: [[`  ${c.l2b}`, this.tk("muted")]] });
          rows.push({ kind: "line", id, idx: 2, segs: [["  ", ""], ...c.l3] });
          if (sel && level < 2) for (const d of c.detail.filter(([t]) => t)) for (const wl of wrap(d[0], Math.max(8, w - 8)).slice(0, 2)) rows.push({ kind: "line", id, idx: 3, segs: [[`  ${wl}`, d[1]]] });
        }
      }
      return { rows, first };
    };
    let { rows, first } = build(0);
    if (rows.length > inner) ({ rows, first } = build(1));
    if (rows.length > inner) ({ rows, first } = build(2));
    const selRow = first.get(this.selected) ?? 0;
    let start = 0;
    while (start < selRow - 1 && rows.length - start > inner && selRow - start >= inner - 3) start++;
    rows.slice(start, start + inner).forEach((row, i) => {
      const yy = y + 1 + i;
      if (row.kind === "group") { cv.text(x + 2, yy, row.text, this.tk("muted", S.bold)); return; }
      const sel = row.id === this.selected;
      const bg = sel ? S.bgSel : "";
      if (sel) { cv.fill(x + 1, yy, w - 2, 1, S.bgSel); cv.set(x + 1, yy, this.caps.unicode ? "▌" : "|", st(sgr(TOKENS.brand, this.caps.color), bg)); }
      let cx = x + 3;
      const pctW = row.title && row.pct != null ? 5 : 0;
      for (const [t, sty] of row.segs) if (t) cx = cv.text(cx, yy, clip(t, Math.max(0, x + w - 2 - pctW - cx)), st(sty, bg), x + w - 2 - pctW);
      if (pctW) cv.text(x + w - 2 - pctW, yy, `${Math.round(row.pct! * 100)}%`.padStart(pctW - 1), st(row.pct === 1 ? sgr(TOKENS.success, this.caps.color) : sgr(TOKENS.muted, this.caps.color), bg));
    });
    if (start > 0) cv.text(x + w - 4, y, "↑", this.tk("muted"));
    if (start + inner < rows.length) cv.text(x + w - 4, y + h - 1, "↓", this.tk("muted"));
  }

  private stripRow(cv: Canvas, r: Region) {
    cv.fill(r.x, r.y, r.w, 1, S.bgSel);
    const c = this.card(this.selected);
    const t = `${c.title}  ${c.l2}  ${c.l3.map(([s]) => s).join("")}${c.pct != null ? `  ${Math.round(c.pct * 100)}%` : ""}`;
    let x = cv.text(r.x + 1, r.y, c.sym, st(c.symStyle, S.bgSel));
    cv.text(x + 1, r.y, clip(t, r.w - 4), st(sgr(TOKENS.text, this.caps.color), S.bgSel));
  }

  // ── inspector ──

  private kv(cv: Canvas, x: number, y: number, w: number, k: string, v: string, style = this.tk("text")): number {
    const kw = Math.max(11, k.length + 1);
    cv.text(x, y, k.padEnd(kw), this.tk("muted"));
    const lines = wrap(v, Math.max(6, w - kw));
    lines.slice(0, 2).forEach((l, i) => cv.text(x + kw, y + i, clip(l, w - kw), style));
    return Math.min(2, lines.length);
  }

  private inspectorPanel(cv: Canvas, r: Region) {
    const id = this.selected;
    this.panelBox(cv, r, `INSPECTOR`, id === HEX ? "chat" : id);
    const x = r.x + 2, w = r.w - 4;
    let y = r.y + 1;
    const end = r.y + r.h - 1;
    const sec = (t: string) => { if (y < end) cv.text(x, y++, t, this.tk("muted", S.bold)); };
    const row = (k: string, v: string, style?: string) => { if (y < end) y += this.kv(cv, x, y, w, k, v, style); };
    const a = this.full.get(id);
    const s = this.sessions.get(id);
    if (!a) {
      const m = this.meta(s?.agent ?? "claude");
      sec("IDENTITY");
      row("Agent", s?.agent ?? "claude");
      row("Provider", m?.provider ?? "unknown");
      row("CLI", m ? `${m.adapter}${m.diagnostics?.version ? ` ${m.diagnostics.version}` : ""}` : "unknown");
      row("Model", m?.selection?.mode === "cli-default" ? "CLI default (selection)" : m?.selection ? `override ${(m.selection as { identifier?: string }).identifier}` : "CLI-managed");
      row("Discovery", m?.capabilities?.supportsModelDiscovery ? "supported" : "unsupported");
      if (s) { y++; sec("SESSION"); row("State", s.state); row("Tokens", `${tok(sessTok(s))} (${s.tokens?.steps ?? 0} steps)`); }
      if (this.changes) {
        const c = this.changes;
        y++; sec("WHERE THE WORK IS");
        row("Your branch", `${c.base_branch}, untouched until /merge`);
        row("Integration", c.integration_branch);
        row("Folder", c.integration_worktree);
        row("Changes", `${c.files} file${c.files === 1 ? "" : "s"}, +${c.insertions} −${c.deletions}${c.merged ? " (already in your branch)" : ""}`, c.files ? this.tk("info") : this.tk("muted"));
        row("Next", "/changes lists files · /diff T-n · /merge");
      }
      return;
    }
    const m = this.meta(a.agent.id);
    const lk = this.look(a.state);
    sec("IDENTITY");
    row("Role", a.role);
    row("Agent", a.agent.id);
    row("Provider", a.agent.provider);
    row("CLI", `${a.agent.adapter ?? a.agent.id}${a.agent.cli_version ? ` ${a.agent.cli_version}` : " (version unknown)"}`);
    row("Selection", a.agent.model_mode === "cli-default" || !a.agent.model ? "native CLI default" : `${a.agent.model_mode}: ${a.agent.model}`);
    row("Runtime", a.agent.runtime_model ?? "unknown (CLI-managed)", a.agent.runtime_model ? this.tk("text") : this.tk("muted"));
    row("Discovery", m?.capabilities?.supportsModelDiscovery ? "supported" : m ? "unsupported" : "unknown");
    if (a.workspace?.worktree) {
      y++; sec("WORKSPACE");
      row("Folder", a.workspace.worktree);
      row("Branch", a.workspace.branch ?? "");
      row("Changed", `${a.files_touched?.length ?? 0} file${(a.files_touched?.length ?? 0) === 1 ? "" : "s"} (/diff ${a.task_id})`);
    }
    y++; sec("EXECUTION");
    row("State", `${lk.sym} ${lk.label}${a.state_reason ? ` — ${a.state_reason}` : ""}`, lk.style);
    row("Task", `${a.task_id} ${this.taskTitle(a.task_id)}`);
    const p = this.progress(id);
    if (y < end) { cv.text(x, y, "Progress".padEnd(11), this.tk("muted")); if (p != null) { const b = bar(p, Math.max(8, w - 12)); const bx = cv.text(x + 11, y, b.fill, st(lk.style)); const bx2 = cv.text(bx, y, b.rest, this.tk("border")); cv.text(bx2, y, b.label, this.tk("muted")); } else cv.text(x + 11, y, "n/a", this.tk("muted")); y++; }
    if (a.progress && a.progress.total) row("Criteria", `${a.progress.done}/${a.progress.total} done`);
    row("Attempt", `${a.attempt}${a.fix_cycle ? ` · fix cycle ${a.fix_cycle}` : ""}`);
    row("Tokens", a.usage.turns ? `${tok(spent(a.usage))} (${tok(a.usage.output_tokens)} out) · ${a.usage.turns} steps` : "unavailable");
    row("Elapsed", dur(Date.now() - Date.parse(a.state_since)) + " in state");
    if (a.recovery) { y++; sec("RECOVERY"); row("Reason", a.recovery.cls.replace(/_/g, " ")); row("Resumes", a.recovery.next_retry_at ? `${a.recovery.next_retry_at.slice(11, 16)}Z (${a.recovery.reset_source === "provider" ? "provider-reported" : "estimated"})` : a.recovery.status === "blocked" ? "needs you" : "—"); row("Auto", a.state === "waiting_quota" ? "automatic, work preserved" : a.recovery.status); }
    // history
    y++; sec("HISTORY");
    const hist = (this.events.get(id) ?? []).filter((e) => ["state", "recovery", "fix_cycle", "error"].includes(e.event.type));
    const items: [string, string, string][] = hist.map((e) => {
      const ev = e.event;
      const t = time(e.ts);
      if (ev.type === "state") return [t, `${this.look(ev.state).sym} ${ev.state.replace(/_/g, " ")}${ev.reason ? ` — ${ev.reason}` : ""}`, this.look(ev.state).style] as [string, string, string];
      if (ev.type === "fix_cycle") return [t, `↻ fix cycle ${ev.n}`, this.tk("warning")] as [string, string, string];
      if (ev.type === "recovery") return [t, `◷ ${ev.phase}: ${ev.message}`, this.tk("waiting")] as [string, string, string];
      return [t, `${this.look("failed").sym} ${(ev as { message: string }).message}`, this.tk("error")] as [string, string, string];
    });
    const room = Math.max(0, end - y);
    items.slice(-room).forEach(([t, text, sty], i) => { cv.text(x, y + i, t, this.tk("muted")); cv.text(x + 9, y + i, clip(text, w - 9), sty); });
  }

  // ── activity timeline ──

  private activityPanel(cv: Canvas, r: Region) {
    this.panelBox(cv, r, "ACTIVITY", this.activityFilter ? `filter: ${this.activityFilter}` : "");
    const items = this.director.activity.filter((a) => !this.activityFilter || `${a.task} ${a.text} ${a.kind}`.toLowerCase().includes(this.activityFilter.toLowerCase()));
    const inner = r.h - 2;
    const w = r.w - 4;
    const lines: { t: string; task: string; text: string; token: Token }[] = [];
    for (const it of items) for (const [i, wl] of wrap(it.text, Math.max(10, w - 18)).entries()) lines.push({ t: i === 0 ? time(it.ts) : "", task: i === 0 ? it.task : "", text: wl, token: it.token });
    if (!lines.length) { cv.text(r.x + 2, r.y + 1, "Waiting for agent events…", this.tk("muted")); return; }
    lines.slice(-inner).forEach((l, i) => {
      const yy = r.y + 1 + i;
      cv.text(r.x + 2, yy, l.t, this.tk("muted"));
      cv.text(r.x + 11, yy, l.task, this.tk("text", S.bold));
      cv.text(r.x + 17, yy, clip(l.text, w - 15), this.tk(l.token));
    });
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
      chat = this.chatMemo(`${sel}|${inner}|${cs?.feed.length ?? 0}|${cs?.feed.at(-1)?.ts ?? ""}|${cs?.feed.at(-1)?.text.length ?? 0}|${notes.length}|${notes.at(-1)?.ts ?? ""}`, () => {
        const items = [...(cs ? itemsFromSession(cs) : []), ...notes].sort((x, y) => x.ts.localeCompare(y.ts));
        return chatLines(items, inner, "Claude");
      });
      const r = this.snap.run;
      head.push([cs ? `${cs.state === "running" ? `${spinner(this.spin())} thinking` : cs.state} · ${tokLine(cs.tokens)}` : "Ask Claude anything or ask for a change: it works directly in this repo. /sdd <goal> runs the spec-driven flow.", S.gray]);
      if (r) head.push([`run ${r.run_id} · ${r.state} · ${r.integration_branch} → ${r.base_branch}`, S.gray]);
    } else if (s) {
      title = `Chat · ${(SESSION_NAMES[s.id] ?? [s.id])[0]} · ${s.agent}`;
      chat = this.chatMemo(`${sel}|${inner}|${s.feed.length}|${s.feed.at(-1)?.ts ?? ""}|${s.feed.at(-1)?.text.length ?? 0}`, () => chatLines(itemsFromSession(s), inner, (SESSION_NAMES[s.id] ?? [s.id])[0]));
      head.push([`${s.state.replace("_", " ")} · ${tokLine(s.tokens)}${s.summary ? ` · ${s.summary}` : ""}`, s.state === "failed" ? S.red : S.gray]);
      if (s.question) head.push([`? ${s.question.question_id} ${s.question.prompt}${s.question.options?.length ? "  " + s.question.options.map((o) => `${o.id}) ${o.label}`).join("  ") : ""}`, st(S.orange, S.bold)]);
    } else if (a) {
      title = `Chat · ${this.taskTitle(a.task_id)} (${a.task_id}) · ${a.role} · ${a.agent.id}${a.agent.model ? ` (${a.agent.model}${a.agent.effort ? `, ${a.agent.effort}` : ""})` : ""} · attempt ${a.attempt}`;
      const evs = this.events.get(sel) ?? [];
      chat = this.chatMemo(`${sel}|${inner}|${evs.length}|${evs.at(-1)?.ts ?? ""}|${TERMINAL_STATES.has(a.state)}|${a.attempt}`, () => {
        const conv = itemsFromEvents(evs);
        return chatLines(conv.items, inner, `${a.task_id} ${clip(this.taskTitle(a.task_id), 28)}`, conv.acked, TERMINAL_STATES.has(a.state));
      });
      const since = Date.now() - Date.parse(a.state_since);
      head.push([`${glyph(a.state, this.spin())} ${a.state.replace("_", " ")} ${dur(since)}${a.state_reason ? ` — ${a.state_reason}` : ""} · ${a.usage.turns} step(s)`, STATE_COLOR[a.state]]);
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
      : "Tab/↑↓ agent · Enter send · F1 help · F2 inspector · F3 motion · F4 agents · PgUp/Dn scroll · ^T take over · ^O window · ^D diff · / cmds · ^C quit";
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
