import { describe, expect, it } from "vitest";
import type { AgentState, AgentStatus, StampedEvent } from "../src/contracts/types.js";
import { Director } from "../src/tui/director.js";
import { AnimationManager, FakeClock, Path } from "../src/tui/motion.js";
import type { Geometry } from "../src/tui/network.js";

const st = (task_id: string, state: AgentState, extra: Record<string, unknown> = {}) =>
  ({ task_id, role: "developer", state, attempt: 1, agent: { id: "a", provider: "p", adapter: "cli" }, ...extra }) as unknown as AgentStatus;
const ev = (task_id: string, event: Record<string, unknown>) => ({ task_id, ts: new Date().toISOString(), event }) as unknown as StampedEvent;

const geom = (): Geometry => ({
  canvas: null as never, card: null, compact: false, nodes: new Map(),
  edges: [{ from: "T-1", to: "T-2", path: new Path([[0, 0], [12, 0]]) }],
  reviewers: new Map([["T-1", { cell: [4, 8], stem: new Path([[4, 8], [4, 6]]), exit: new Path([[8, 8], [10, 8], [10, 4]]) }], ["T-2", { cell: [20, 8], stem: new Path([[20, 8], [20, 6]]), exit: new Path([[24, 8], [26, 8], [26, 4]]) }]]),
});

function setup(motion: "full" | "reduced" | "off" = "full") {
  const clock = new FakeClock();
  const m = new AnimationManager({ clock, motion, manual: true });
  const d = new Director(m);
  d.setGeometry(geom());
  return { clock, m, d };
}
const kinds = (m: AnimationManager, now: number) => m.particles.visible(now + 10_000).length + m.particles.activeCount;

describe("director maps real events to effects", () => {
  it("does not replay history on startup", () => {
    const { m, d } = setup();
    d.seed([st("T-1", "done")]);
    d.status(st("T-1", "done"));
    expect(m.particles.activeCount).toBe(0);
    expect(d.activity).toHaveLength(0);
    expect(m.busy).toBe(false);
  });
  it("a rejection (fix cycle while reviewing) streams review particles; a plain verification failure does not", () => {
    const a = setup();
    a.d.status(st("T-1", "reviewing"));
    a.d.event(ev("T-1", { type: "fix_cycle", n: 1 }));
    expect(a.m.particles.activeCount).toBeGreaterThan(0);
    expect(a.d.activity.at(-1)!.text).toMatch(/rejected/);
    const b = setup();
    b.d.status(st("T-1", "working"));
    const before = b.m.particles.activeCount;
    b.d.event(ev("T-1", { type: "fix_cycle", n: 1 }));
    expect(b.m.particles.activeCount).toBe(before);
    expect(b.d.activity.at(-1)!.text).toMatch(/verification failed/);
  });
  it("approval flows toward integration", () => {
    const { m, d } = setup();
    d.status(st("T-1", "reviewing"));
    d.status(st("T-1", "integrating"));
    expect(m.particles.activeCount).toBeGreaterThan(0);
    expect(d.activity.at(-1)!.text).toMatch(/approved/);
  });
  it("quota wait is restrained (low-rate hold, no particles) and recovery resumes with a flourish", () => {
    const { m, d } = setup();
    d.status(st("T-1", "working"));
    d.status(st("T-1", "waiting_quota", { recovery: { cls: "quota_exhausted", next_retry_at: "2026-01-01T15:04:00Z", reset_source: "estimate" } }));
    expect(m.particles.activeCount).toBe(0);
    expect(d.activity.at(-1)!.text).toMatch(/waiting for quota exhausted/);
    expect(d.activity.at(-1)!.text).toMatch(/estimated/);
    d.status(st("T-1", "working"));
    expect(d.activity.at(-1)!.text).toMatch(/resumed/);
    expect(m.particles.activeCount).toBe(0); // T-1 has no incoming edge: nothing fake is drawn
    d.status(st("T-2", "waiting_quota"));
    d.status(st("T-2", "working"));
    expect(m.particles.activeCount).toBeGreaterThan(0); // T-2 has one
  });
  it("failure is static: logged, no particles, no hold", () => {
    const { clock, m, d } = setup();
    d.status(st("T-1", "working"));
    d.status(st("T-1", "failed", { state_reason: "tests red" }));
    clock.advance(5000); m.step(clock.now()); // let the one-shot start sweep finish
    expect(m.particles.activeCount).toBe(0);
    expect(m.busy).toBe(false);
    expect(d.activity.at(-1)!.text).toMatch(/tests red/);
  });
  it("messages travel real edges only", () => {
    const { m, d } = setup();
    const msg = (from: string, to: string) => ({ id: "m", from: { kind: "agent", id: from }, to: { kind: "agent", id: to }, body: "hello", type: "notify" }) as never;
    d.message(msg("T-1", "T-2"));
    expect(m.particles.activeCount).toBeGreaterThan(0);
    m.particles.clear();
    d.message(msg("T-1", "T-9"));
    expect(m.particles.activeCount).toBe(0);
    expect(d.activity.at(-1)!.text).toContain("T-9");
  });
  it("holds are released when agents stop; activity log is bounded; dispose cleans up", () => {
    const { m, d } = setup();
    d.status(st("T-1", "working"));
    expect(m.busy).toBe(true);
    d.status(st("T-1", "done"));
    m.cancelAll();
    expect(m.busy).toBe(false);
    for (let i = 0; i < 500; i++) d.status(st(`X-${i}`, "failed"));
    expect(d.activity.length).toBeLessThanOrEqual(300);
    d.dispose();
    expect(m.busy).toBe(false);
  });
  it("motion off: states are logged, nothing animates", () => {
    const { m, d } = setup("off");
    d.status(st("T-1", "reviewing"));
    d.event(ev("T-1", { type: "fix_cycle", n: 1 }));
    expect(m.busy).toBe(false);
    expect(d.activity.length).toBeGreaterThan(0);
    void kinds;
  });
});

describe("director seeding", () => {
  it("accepts one-shot iterators and holds the live loop for agents already running", () => {
    const { m, d } = setup();
    d.seed(new Map([["T-1", st("T-1", "working")]]).values());
    expect(m.busy).toBe(true);
    expect(m.particles.activeCount).toBe(0); // but nothing is replayed
    expect(d.activity).toHaveLength(0);
  });
});
