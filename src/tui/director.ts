/**
 * The motion director maps real Hexagon events to visual effects. It owns no timers (the AnimationManager does) and
 * invents nothing: if an event carries too little information for a meaningful visual, it only lands in the activity
 * timeline.
 */
import type { AgentState, AgentStatus, Message, StampedEvent } from "../contracts/types.js";
import { TERMINAL_STATES } from "../contracts/types.js";
import type { BusActivity } from "../core/bus.js";
import type { Geometry, NodeFx } from "./network.js";
import { AnimationManager, ease, Path } from "./motion.js";
import { STATE_LOOK, TOKENS, type Token } from "./theme.js";

export interface ActivityItem {
  ts: string;
  task: string;
  kind: "state" | "comm" | "review" | "quota" | "done" | "error" | "recovery" | "info";
  text: string;
  token: Token;
}

/** Frame rate of the continuous 'agent is working' effect. */
const LIVE_FPS = 8;
const ACTIVE_STATES = new Set<AgentState>(["preparing", "working", "fixing", "verifying", "reviewing", "integrating"]);

export class Director {
  readonly fx = new Map<string, NodeFx>();
  readonly activity: ActivityItem[] = [];
  private last = new Map<string, AgentState>();
  private lastTool = new Map<string, number>();
  private geometry: Geometry | null = null;
  private seeded = false;
  private activeSet = new Set<string>();
  private waitingSet = new Set<string>();
  private seenMsg = new Set<string>();
  private seenBus = new Set<string>();

  constructor(private m: AnimationManager, private clockIso: () => string = () => new Date().toISOString()) {}

  setGeometry(g: Geometry | null) { this.geometry = g; }

  /**
   * A path for a message between two cards: the dependency edge when there is one, otherwise a direct route in the
   * space between them (horizontal out of the sender, vertical in the gutter, horizontal into the receiver). Particles
   * only show over empty cells and line cells, so the route disappears behind any card it crosses.
   */
  routeBetween(a: string, b: string): Path | null {
    const geo = this.geometry;
    if (!geo) return null;
    const edge = geo.edges.find((e) => e.from === a && e.to === b) ?? null;
    if (edge) return edge.path;
    const back = geo.edges.find((e) => e.from === b && e.to === a);
    if (back) return back.path.reversed();
    const na = geo.nodes.get(a), nb = geo.nodes.get(b);
    if (!na || !nb) return null;
    const ltr = na.cx <= nb.cx;
    const x0 = ltr ? na.x + na.w : na.x - 1, x1 = ltr ? nb.x - 1 : nb.x + nb.w;
    const midX = Math.round((x0 + x1) / 2);
    const pts: [number, number][] = [];
    const push = (x: number, y: number) => { const l = pts[pts.length - 1]; if (!l || l[0] !== x || l[1] !== y) pts.push([x, y]); };
    const walk = (xa: number, ya: number, xb: number, yb: number) => {
      const dx = Math.sign(xb - xa), dy = Math.sign(yb - ya);
      let x = xa, y = ya;
      push(x, y);
      while (x !== xb) { x += dx; push(x, y); }
      while (y !== yb) { y += dy; push(x, y); }
    };
    walk(x0, na.cy, midX, na.cy);
    walk(midX, na.cy, midX, nb.cy);
    walk(midX, nb.cy, x1, nb.cy);
    return pts.length > 1 ? new Path(pts) : null;
  }

  /** Load the initial state without playing effects (so a restart does not replay old completions). */
  seed(statuses: Iterable<AgentStatus>): void {
    const list = [...statuses]; // may be a one-shot iterator: it is read twice
    for (const s of list) this.last.set(s.task_id, s.state);
    this.seeded = true;
    this.syncHolds(list);
  }

  private log(task: string, kind: ActivityItem["kind"], text: string, token: Token) {
    this.activity.push({ ts: this.clockIso(), task, kind, text, token });
    if (this.activity.length > 300) this.activity.splice(0, this.activity.length - 300);
  }

  private fxOf(id: string): NodeFx {
    let f = this.fx.get(id);
    if (!f) this.fx.set(id, (f = {}));
    return f;
  }

  private flash(id: string, color: readonly [number, number, number], ms: number, target: "node" | "reviewer" = "node") {
    const f = this.fxOf(id);
    const key = target === "node" ? "flash" : "reviewer";
    const tag = `flash:${target}:${id}`;
    this.m.cancel(tag);
    this.m.tween(tag, ms, (v) => { f[key] = v >= 1 ? null : { color, k: ease.pulse(v) }; }, { easing: ease.linear });
  }

  /** Spell the verdict out on the card's review footer while the particles carry it. */
  private note(id: string, kind: "rejected" | "approved", ms: number) {
    const f = this.fxOf(id);
    const tag = `note:${id}`;
    this.m.cancel(tag);
    f.review = kind;
    this.m.tween(tag, ms, (v) => { if (v >= 1) f.review = null; }, { easing: ease.linear });
  }

  private sweep(id: string, ms = 700) {
    const f = this.fxOf(id);
    const tag = `sweep:${id}`;
    this.m.cancel(tag);
    this.m.tween(tag, ms, (v) => { f.sweep = v >= 1 ? null : v; }, { easing: ease.inOutCubic });
  }

  private incoming(id: string): Path[] { return (this.geometry?.edges ?? []).filter((e) => e.to === id).map((e) => e.path); }
  private outgoing(id: string): Path[] { return (this.geometry?.edges ?? []).filter((e) => e.from === id).map((e) => e.path); }

  /** A state change reported by the daemon. */
  status(next: AgentStatus): void {
    const id = next.task_id;
    const prev = this.last.get(id);
    this.last.set(id, next.state);
    if (this.seeded && prev === undefined && TERMINAL_STATES.has(next.state)) { this.syncHolds([next]); return; } // history, not news
    if (prev === next.state) return;
    const look = STATE_LOOK[next.state];
    const name = `${id}`;
    switch (next.state) {
      case "preparing":
        this.log(name, "state", `${next.role} preparing (${next.agent.provider} · ${next.agent.adapter ?? next.agent.id})`, "info");
        this.sweep(id);
        for (const p of this.incoming(id).slice(0, 2)) this.m.spawn("execution", p, { tag: `run:${id}` });
        break;
      case "working":
        if (prev === "waiting_quota") {
          this.log(name, "recovery", "provider limit cleared — execution resumed", "success");
          this.sweep(id, 900);
          this.flash(id, TOKENS.brand, 900);
          for (const p of this.incoming(id).slice(0, 2)) this.m.spawn("recovery", p, { tag: `run:${id}` });
        } else if (prev === "queued" || prev === undefined) {
          this.log(name, "state", `${next.role} running`, "active" as Token);
          this.sweep(id);
        }
        break;
      case "waiting_quota": {
        this.m.cancel(`run:${id}`);
        const when = next.recovery?.next_retry_at ? ` until ~${next.recovery.next_retry_at.slice(11, 16)}Z (${next.recovery.reset_source === "provider" ? "provider-reported" : "estimated"})` : " (reset time unknown)";
        this.log(name, "quota", `waiting for ${next.recovery?.cls.replace(/_/g, " ") ?? "provider limit"}${when}; resumes automatically`, "waiting");
        this.flash(id, TOKENS.waiting, 600);
        break;
      }
      case "reviewing":
        this.log(name, "review", "independent review started", "brand2");
        this.flash(id, TOKENS.brand2, 700, "reviewer");
        break;
      case "integrating": {
        if (prev === "reviewing") {
          this.log(name, "review", "review approved — integrating", "success");
          this.flash(id, TOKENS.success, 900, "reviewer");
          this.note(id, "approved", 1800);
          const r = this.geometry?.reviewers.get(id);
          const outs = this.outgoing(id);
          if (r && outs.length) for (const [i, p] of outs.slice(0, 2).entries()) for (let k = 0; k < 3; k++) this.m.spawn("completion", r.exit.concat(p), { delay: k * 140 + i * 60, tag: `done:${id}` });
          else if (r) for (let k = 0; k < 3; k++) this.m.spawn("completion", r.exit, { delay: k * 140, tag: `done:${id}` });
        }
        break;
      }
      case "done":
        this.log(name, "done", `${next.role} complete and merged`, "success");
        this.flash(id, TOKENS.success, 900);
        this.sweep(id, 600);
        break;
      case "failed": case "blocked":
        this.log(name, "error", `${look.label.toLowerCase()}${next.state_reason ? `: ${next.state_reason}` : ""}`, next.state === "failed" ? "error" : "warning");
        break;
      case "waiting_input":
        this.log(name, "info", "needs your input", "warning");
        break;
      case "cancelled":
        this.log(name, "state", "cancelled", "muted");
        break;
    }
    this.syncHolds([next]);
  }

  private syncHolds(changed: Iterable<AgentStatus>): void {
    for (const s of changed) {
      if (ACTIVE_STATES.has(s.state)) { this.activeSet.add(s.task_id); this.waitingSet.delete(s.task_id); }
      else if (s.state === "waiting_quota") { this.waitingSet.add(s.task_id); this.activeSet.delete(s.task_id); }
      else { this.activeSet.delete(s.task_id); this.waitingSet.delete(s.task_id); }
    }
    this.applyHolds();
  }

  private quiet = false;
  /** While the user types, continuous effects release their frame timers; they come back when typing stops. */
  setQuiet(q: boolean): void {
    if (q === this.quiet) return;
    this.quiet = q;
    this.applyHolds();
  }

  private applyHolds(): void {
    if (this.activeSet.size && !this.quiet) this.m.hold("live", LIVE_FPS); else this.m.release("live");
    if (this.waitingSet.size && !this.activeSet.size && !this.quiet) this.m.hold("wait", 4); else this.m.release("wait");
  }

  /** An agent event from the event stream. */
  event(e: StampedEvent): void {
    const id = e.task_id;
    const ev = e.event;
    switch (ev.type) {
      case "tool_call": {
        const now = this.m.clock.now();
        if (now - (this.lastTool.get(id) ?? -1e9) < 450) return; // one small pulse at a time
        this.lastTool.set(id, now);
        const p = this.incoming(id)[0];
        if (p) this.m.spawn("execution", p, { tag: `run:${id}`, duration: 700 });
        break;
      }
      case "fix_cycle":
        if (this.last.get(id) === "reviewing") {
          this.log(id, "review", `review rejected — returned to the developer (fix cycle ${ev.n})`, "warning");
          this.flash(id, TOKENS.warning, 900, "reviewer");
          this.note(id, "rejected", 2400);
          const r = this.geometry?.reviewers.get(id);
          if (r) for (let k = 0; k < 4; k++) this.m.spawn("review", r.stem, { delay: k * 130, tag: `rej:${id}` });
        } else this.log(id, "error", `verification failed — fix cycle ${ev.n}`, "warning");
        break;
      case "recovery":
        if (ev.phase === "compacted") this.log(id, "recovery", ev.message, "info");
        else if (ev.phase === "failover") this.log(id, "recovery", `provider failover: ${ev.message}`, "warning");
        else if (ev.phase === "blocked") this.log(id, "quota", `blocked: ${ev.message}`, "warning");
        break;
      case "error":
        if (ev.kind === "stuck") this.log(id, "error", ev.message, "error");
        break;
    }
  }

  /**
   * A router message between agents. The router emits one on every delivery-state change, so only the first (`queued`)
   * counts, and a message that carries a bus envelope is left to `bus()`, which animates it once per envelope.
   */
  message(msg: Message): void {
    if (msg.delivery.state !== "queued" || this.seenMsg.has(msg.id)) return;
    this.seenMsg.add(msg.id);
    if (this.seenMsg.size > 2000) this.seenMsg = new Set([...this.seenMsg].slice(-1000));
    if (msg.bus_id) return;
    if (msg.from.kind !== "agent" || msg.to.kind !== "agent" || !msg.from.id || !msg.to.id) return;
    const a = msg.from.id, b = msg.to.id;
    this.log(a, "comm", `→ ${b}: ${msg.body.split("\n")[0]!.slice(0, 60)}`, "info");
    this.flash(a, TOKENS.info, 500);
    const path = this.routeBetween(a, b);
    if (!path) return;
    for (let k = 0; k < 2; k++) this.m.spawn("information", path, { delay: k * 160, tag: `msg:${a}`, onArrive: k === 1 ? () => this.flash(b, TOKENS.info, 600) : undefined });
  }

  /**
   * Something travelled on the agent bus. A message between two tasks that share a dependency edge sends particles
   * along it (more for a bigger payload); one without such an edge, or to a role/topic, leaves the sender fanning out
   * downstream. Model calls only pulse the card. Everything lands in the activity timeline.
   */
  bus(a: BusActivity): void {
    const task = (x: string) => /^T-\d+$/.test(x);
    if (a.kind === "model_call" || a.kind === "model_response") {
      const id = task(a.from) ? a.from : a.to;
      if (!task(id)) return;
      const now = this.m.clock.now();
      const key = `${a.kind}:${id}`;
      if (now - (this.lastTool.get(key) ?? -1e9) < 450) return;
      this.lastTool.set(key, now);
      this.flash(id, a.kind === "model_call" ? TOKENS.active : TOKENS.brand, 300);
      return;
    }
    // Each envelope is animated once, however many times its delivery state changes.
    if (a.id) {
      if (this.seenBus.has(a.id)) return;
      this.seenBus.add(a.id);
      if (this.seenBus.size > 2000) this.seenBus = new Set([...this.seenBus].slice(-1000));
    }
    const color = a.kind === "handoff" ? TOKENS.success : a.kind === "finding" ? TOKENS.warning : a.kind === "decision" ? TOKENS.brand2 : TOKENS.info;
    const kind = a.kind === "finding" ? "review" : a.kind === "handoff" ? "completion" : "information";
    const n = a.size < 400 ? 1 : a.size < 2000 ? 2 : 3;
    const size = a.size < 1024 ? `${a.size} B` : `${(a.size / 1024).toFixed(1)} KB`;
    // Who really received it: the router's recipients for a role/topic/broadcast, else the named task.
    const targets = (a.recipients?.length ? a.recipients : task(a.to) ? [a.to] : []).filter((t) => task(t) && t !== a.from);
    if (a.from === "reviewer") {
      // The reviewer's findings come out of the review footer of the card they are about.
      const t = targets[0] ?? (task(a.to) ? a.to : "");
      this.log(t || "reviewer", "review", `reviewer finding → ${t || a.to}: ${size}`, "warning");
      if (!t) return;
      this.flash(t, TOKENS.warning, 700, "reviewer");
      this.note(t, "rejected", 2000);
      const lane = this.geometry?.reviewers.get(t);
      if (lane) for (let k = 0; k < n + 1; k++) this.m.spawn("review", lane.stem, { delay: k * 130, tag: `bus:reviewer:${t}` });
      return;
    }
    if (!task(a.from)) {
      this.log(targets[0] ?? a.to, "comm", `${a.kind} from ${a.from}`, "info");
      for (const t of targets.slice(0, 4)) this.flash(t, color, 600);
      return;
    }
    const where = targets.length > 1 || !task(a.to) ? `${a.to}${targets.length ? ` (${targets.join(", ")})` : ""}` : a.to;
    this.log(a.from, "comm", `${a.kind} → ${where} (${size})`, a.kind === "finding" ? "warning" : "info");
    this.flash(a.from, color, 500);
    const routes: Path[] = [];
    for (const t of targets.slice(0, 4)) {
      this.flash(t, color, 700);
      const p = this.routeBetween(a.from, t);
      if (p) routes.push(p);
    }
    // A role/topic/broadcast with no known recipient fans out along the outgoing edges; nothing is invented otherwise.
    if (!targets.length && !task(a.to)) routes.push(...this.outgoing(a.from).slice(0, 2));
    for (const [i, p] of routes.entries()) for (let k = 0; k < n; k++) this.m.spawn(kind, p, { delay: k * 140 + i * 60, tag: `bus:${a.from}` });
  }

  dispose(): void { this.m.cancelAll(); this.fx.clear(); this.activity.length = 0; this.activeSet.clear(); this.waitingSet.clear(); }
}
