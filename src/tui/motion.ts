/**
 * Hexagon motion engine. One scheduler for every animation: tweens, timelines and a bounded particle system, all
 * driven by elapsed time (never by frame counts) and by demand (no work → no timer → no redraws).
 */
import { Canvas, st } from "./canvas.js";
import { mix, sgr, TOKENS, type ColorDepth, type MotionMode, type Rgb, type Token } from "./theme.js";

// ───────────── clock & easing ─────────────

export interface Clock { now(): number }
export const systemClock: Clock = { now: () => performance.now() };
/** Deterministic clock for tests and reproducible demos. */
export class FakeClock implements Clock {
  t = 0;
  now() { return this.t; }
  advance(ms: number) { this.t += ms; }
}

export type Easing = (t: number) => number;
export const ease = {
  linear: ((t) => t) as Easing,
  inCubic: ((t) => t * t * t) as Easing,
  outCubic: ((t) => 1 - (1 - t) ** 3) as Easing,
  inOutCubic: ((t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)) as Easing,
  inOutSine: ((t) => -(Math.cos(Math.PI * t) - 1) / 2) as Easing,
  /** 0 → 1 → 0 over t∈[0,1] (for pulses). */
  pulse: ((t) => Math.sin(Math.PI * Math.min(1, Math.max(0, t)))) as Easing,
};
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

// ───────────── paths ─────────────

export type Pt = readonly [number, number];
/** A polyline in terminal-cell coordinates with precomputed cumulative length. */
export class Path {
  readonly cum: number[] = [0];
  constructor(readonly pts: Pt[]) {
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  }
  get length() { return this.cum[this.cum.length - 1] ?? 0; }
  /** Cell at fraction u∈[0,1] along the path. */
  at(u: number): Pt {
    if (!this.pts.length) return [0, 0];
    const d = clamp01(u) * this.length;
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i]! < d) i++;
    const a = this.pts[i - 1] ?? this.pts[0]!;
    const b = this.pts[i] ?? a;
    const seg = (this.cum[i] ?? 0) - (this.cum[i - 1] ?? 0);
    const k = seg > 0 ? (d - (this.cum[i - 1] ?? 0)) / seg : 0;
    return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k)];
  }
  reversed(): Path { return new Path([...this.pts].reverse()); }
  concat(o: Path): Path { return new Path([...this.pts, ...o.pts]); }
}

// ───────────── particles ─────────────

export type ParticleKind = "information" | "execution" | "review" | "completion" | "ambient" | "recovery";

interface KindLook { token: Token; glyph: [string, string]; ascii: string; priority: number; size: 1 | 2 }
const KIND: Record<ParticleKind, KindLook> = {
  information: { token: "info", glyph: ["■", "▪"], ascii: "#", priority: 3, size: 2 },
  execution: { token: "active", glyph: ["■", "▪"], ascii: "#", priority: 2, size: 1 },
  review: { token: "warning", glyph: ["■", "▪"], ascii: "#", priority: 4, size: 2 },
  completion: { token: "success", glyph: ["■", "▪"], ascii: "#", priority: 4, size: 2 },
  recovery: { token: "brand", glyph: ["■", "▪"], ascii: "#", priority: 4, size: 2 },
  ambient: { token: "border", glyph: ["·", "·"], ascii: ".", priority: 0, size: 1 },
};

export interface Particle {
  active: boolean;
  kind: ParticleKind;
  path: Path;
  /** Start time and duration (ms); `delay` already folded into start. */
  start: number;
  duration: number;
  easing: Easing;
  /** Opaque tag so effects can be cancelled together. */
  tag: string;
  onArrive?: () => void;
}

export interface SpawnOpts { duration?: number; delay?: number; easing?: Easing; tag?: string; onArrive?: () => void }

/** Fixed-size pool: spawning never allocates beyond `capacity`; when full, a lower-priority particle is replaced or the spawn is refused. */
export class ParticleSystem {
  private pool: Particle[];
  constructor(readonly capacity = 48) {
    this.pool = Array.from({ length: capacity }, () => ({ active: false, kind: "ambient", path: new Path([]), start: 0, duration: 1, easing: ease.linear, tag: "" }));
  }
  get activeCount() { let n = 0; for (const p of this.pool) if (p.active) n++; return n; }
  get size() { return this.pool.length; }
  spawn(kind: ParticleKind, path: Path, now: number, o: SpawnOpts = {}): boolean {
    if (path.length <= 0 && path.pts.length < 1) return false;
    let slot = this.pool.find((p) => !p.active);
    if (!slot) {
      const worst = this.pool.reduce((a, b) => (KIND[b.kind].priority < KIND[a.kind].priority ? b : a));
      if (KIND[worst.kind].priority >= KIND[kind].priority) return false;
      slot = worst;
    }
    // Speed: ~14 cells/s unless a duration is given; always at least 350 ms so it is visible.
    const duration = o.duration ?? Math.max(350, (path.length / 14) * 1000);
    Object.assign(slot, { active: true, kind, path, start: now + (o.delay ?? 0), duration, easing: o.easing ?? ease.inOutSine, tag: o.tag ?? "", onArrive: o.onArrive });
    return true;
  }
  /** Retire finished particles; returns true while any remain. */
  update(now: number): boolean {
    let live = false;
    for (const p of this.pool) {
      if (!p.active) continue;
      if (now - p.start >= p.duration) { p.active = false; const cb = p.onArrive; p.onArrive = undefined; cb?.(); continue; }
      live = true;
    }
    return live;
  }
  cancel(tag: string) { for (const p of this.pool) if (p.active && p.tag === tag) p.active = false; }
  clear() { for (const p of this.pool) p.active = false; }

  /** Current cell of every visible particle (for tests and drawing). */
  visible(now: number): { x: number; y: number; kind: ParticleKind; alpha: number; u: number }[] {
    const out: { x: number; y: number; kind: ParticleKind; alpha: number; u: number }[] = [];
    for (const p of this.pool) {
      if (!p.active || now < p.start) continue;
      const t = clamp01((now - p.start) / p.duration);
      const u = p.easing(t);
      const [x, y] = p.path.at(u);
      // Fade in over the first 12 %, out over the last 18 %: opacity simulated through colour.
      const alpha = Math.min(1, t / 0.12, (1 - t) / 0.18);
      out.push({ x, y, kind: p.kind, alpha: clamp01(alpha), u });
    }
    return out;
  }

  /**
   * Draw onto a canvas without ever hiding information: a particle may only land on blank cells or on connection
   * line characters, never on text, node outlines or other widgets.
   */
  draw(c: Canvas, now: number, o: { depth: ColorDepth; unicode: boolean; bg?: Rgb; reduced?: boolean }): void {
    const bg = o.bg ?? TOKENS.surface2;
    for (const v of this.visible(now)) {
      const look = KIND[v.kind];
      const under = c.chars[v.y]?.[v.x];
      if (under === undefined || !(under === " " || LINE_CELLS.has(under))) continue;
      const col = mix(bg, TOKENS[look.token], 0.35 + 0.65 * v.alpha);
      const glyph = !o.unicode ? look.ascii : look.glyph[v.alpha > 0.55 ? 0 : 1];
      c.set(v.x, v.y, glyph, st(sgr(col, o.depth), v.alpha > 0.7 && v.kind !== "ambient" ? "1" : ""));
    }
  }
}
const LINE_CELLS = new Set("╎─│╭╮╰╯├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▸·•-|+>".split(""));

// ───────────── tweens, timelines, scheduler ─────────────

interface Anim {
  id: number;
  tag: string;
  /** Called every frame with elapsed ms since start; returns false when finished. */
  tick(now: number): boolean;
  finish?(): void;
}

export interface ManagerOptions {
  clock?: Clock;
  motion?: MotionMode;
  fps?: number;
  /** Called after each frame in which something changed. */
  onFrame?: () => void;
  /** Disable the real timer: tests drive `step()` manually. */
  manual?: boolean;
}

export class AnimationManager {
  readonly clock: Clock;
  readonly particles = new ParticleSystem();
  motion: MotionMode;
  fps: number;
  /** Counters for tests and the performance report. */
  stats = { ticks: 0, frames: 0 };
  private anims = new Map<number, Anim>();
  private nextId = 1;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private pending = false;
  /** Continuous effects (e.g. a perimeter highlight on a working agent): keep the loop alive at their own frame rate. */
  private holds = new Map<string, number>();

  constructor(private o: ManagerOptions = {}) {
    this.clock = o.clock ?? systemClock;
    this.motion = o.motion ?? "full";
    this.fps = o.fps ?? (this.motion === "full" ? 24 : this.motion === "reduced" ? 8 : 0);
  }

  get enabled() { return this.motion !== "off" && !this.disposed; }
  /** True while a timer is armed. */
  get running() { return this.timer !== undefined; }
  get busy() { return this.anims.size > 0 || this.particles.activeCount > 0 || this.holds.size > 0; }
  /** Keep frames coming at ~`fps` while a continuous effect is visible; release when it is not. No-op when motion is off. */
  hold(tag: string, fps = this.fps): void {
    if (!this.enabled) return;
    this.holds.set(tag, Math.min(fps, this.fps || fps));
    this.wake();
  }
  release(tag: string): void { this.holds.delete(tag); }
  /** Delay to the next frame: the fastest requirement among tweens/particles (full fps) and holds. */
  private delay(): number {
    const fast = this.anims.size > 0 || this.particles.activeCount > 0 || this.pending;
    const fps = fast ? this.fps || 8 : Math.max(1, ...this.holds.values());
    return 1000 / fps;
  }
  get count() { return this.anims.size; }

  /** Tween a value 0→1 over `ms`. In "off" mode the end state is applied immediately. */
  tween(tag: string, ms: number, fn: (v: number) => void, o: { delay?: number; easing?: Easing; onDone?: () => void } = {}): number {
    if (!this.enabled) { fn(1); o.onDone?.(); return 0; }
    const start = this.clock.now() + (o.delay ?? 0);
    const easing = o.easing ?? ease.inOutCubic;
    const id = this.nextId++;
    this.anims.set(id, {
      id, tag,
      tick: (now) => {
        if (now < start) return true;
        const t = clamp01((now - start) / Math.max(1, ms));
        fn(easing(t));
        return t < 1;
      },
      finish: () => { fn(1); o.onDone?.(); },
    });
    this.wake();
    return id;
  }

  /** A sequence of timed steps: `at(ms, fn)` runs once when elapsed time passes `ms`. */
  timeline(tag: string): Timeline {
    return new Timeline(this, tag);
  }

  /** @internal used by Timeline */
  _addTick(tag: string, tick: (now: number) => boolean, finish?: () => void): void {
    if (!this.enabled) { finish?.(); return; }
    this.anims.set(this.nextId++, { id: 0, tag, tick, finish });
    this.wake();
  }

  spawn(kind: ParticleKind, path: Path, o: SpawnOpts = {}): boolean {
    if (!this.enabled) return false;
    if (kind === "ambient" && this.motion !== "full") return false;
    const ok = this.particles.spawn(kind, path, this.clock.now(), o);
    if (ok) this.wake();
    return ok;
  }

  cancel(tag: string): void {
    for (const [id, a] of this.anims) if (a.tag === tag) this.anims.delete(id);
    this.particles.cancel(tag);
  }

  cancelAll(): void {
    this.anims.clear();
    this.particles.clear();
    this.holds.clear();
    this.stop();
  }

  /** Ask for a redraw at the next frame without any animation (demand-driven rendering). */
  invalidate(): void {
    this.pending = true;
    this.wake();
  }

  /** Advance everything to `now` (or the clock). Returns true when a redraw is needed. */
  step(now = this.clock.now()): boolean {
    this.stats.ticks++;
    let changed = this.pending;
    this.pending = false;
    for (const [id, a] of this.anims) {
      changed = true;
      if (!a.tick(now)) { this.anims.delete(id); a.finish?.(); }
    }
    if (this.particles.activeCount || this.holds.size) changed = true;
    this.particles.update(now);
    if (changed) { this.stats.frames++; this.o.onFrame?.(); }
    return changed;
  }

  private wake(): void {
    if (this.o.manual || this.timer || this.disposed) return;
    const loop = () => {
      this.timer = undefined;
      if (this.disposed) return;
      this.step();
      if (this.busy || this.pending) { this.timer = setTimeout(loop, this.delay()); this.timer.unref?.(); }
    };
    this.timer = setTimeout(loop, 0);
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.holds.clear();
    this.anims.clear();
    this.particles.clear();
    this.stop();
  }
}

export class Timeline {
  private steps: { at: number; fn: () => void; done: boolean }[] = [];
  private started = false;
  constructor(private m: AnimationManager, private tag: string) {}
  at(ms: number, fn: () => void): this { this.steps.push({ at: ms, fn, done: false }); return this; }
  play(): void {
    if (this.started) return;
    this.started = true;
    const t0 = this.m.clock.now();
    this.m._addTick(this.tag, (now) => {
      for (const s of this.steps) if (!s.done && now - t0 >= s.at) { s.done = true; s.fn(); }
      return this.steps.some((s) => !s.done);
    }, () => { for (const s of this.steps) if (!s.done) { s.done = true; s.fn(); } });
  }
}

// ───────────── colour transitions ─────────────

/** Smooth colour change toward a token, advanced by the manager. `get()` is the current colour. */
export class ColorTransition {
  private from: Rgb;
  private to: Rgb;
  private k = 1;
  constructor(private m: AnimationManager, private tag: string, initial: Rgb) { this.from = initial; this.to = initial; }
  set(target: Rgb, ms = 320): void {
    this.from = this.get();
    this.to = target;
    this.k = 0;
    this.m.cancel(this.tag);
    this.m.tween(this.tag, ms, (v) => { this.k = v; }, { easing: ease.inOutSine });
  }
  get(): Rgb { return mix(this.from, this.to, this.k); }
}
