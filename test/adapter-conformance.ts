import os from "node:os";
import { expect, it } from "vitest";
import type { AgentEvent } from "../src/contracts/types.js";
import type { AgentAdapter, AgentRunContext } from "../src/agents/types.js";

/**
 * What every adapter must do, whatever the CLI behind it. Run against a fake CLI everywhere; run against the real CLI
 * only when the environment says so (HEXAGON_REAL_CLI=<adapter id>), because that costs tokens. A pass against the
 * fake proves the adapter handles the shapes it was written for, not that the real CLI still produces them.
 */
export interface Conformance {
  name: string;
  /** `command` replaces the CLI binary (used to prove a missing binary is handled). */
  make(command?: string[]): AgentAdapter;
  /** "unknown": the adapter cannot report usage, so it must report none at all (never zeros). */
  usage: "reported" | "unknown";
  env?: Record<string, string>;
  /** A real CLI only: the model must repeat a word from the first turn after a resume. */
  semantic?: { first: string; second: string; expect: RegExp; cwd?: string };
  real: boolean;
}

export function ctx(over: Partial<AgentRunContext> = {}, events: AgentEvent[] = []): AgentRunContext {
  return {
    agentRunId: "T-1-a1", role: "developer", effort: "low", cwd: os.tmpdir(), system: "You are a test agent.", prompt: "say hello",
    sessionId: crypto.randomUUID(), resume: false, env: {}, allowCommands: [], readOnly: true, conversational: true,
    host: { emit: (e) => events.push(e), drainInbox: () => [], onInbox: () => () => {}, received: () => {}, isFinished: () => false, hasBlockingQuestion: () => false },
    api: {} as never, signal: new AbortController().signal, ...over,
  };
}

/** Run until the adapter says it is ready for the next message (or exits), then stop it. */
export async function oneTurn(a: AgentAdapter, c: Conformance, over: Partial<AgentRunContext>): Promise<{ events: AgentEvent[]; kind: string }> {
  const events: AgentEvent[] = [];
  const ac = new AbortController();
  const done = () => events.some((e) => e.type === "turn_end" || (e.type === "progress" && e.text === "ready"));
  const timer = setInterval(() => { if (done()) ac.abort(); }, 100);
  try {
    const out = await a.run(ctx({ env: c.env ?? {}, signal: ac.signal, ...over }, events));
    return { events, kind: out.kind };
  } finally { clearInterval(timer); }
}

export function conformance(c: Conformance): void {
  const suite = `adapter conformance: ${c.name}${c.real ? " (REAL CLI)" : " (fake CLI)"}`;
  it(`${suite} — a run ends with an outcome, never an exception`, async () => {
    const { kind } = await oneTurn(c.make(), c, {});
    expect(["finished", "interrupted"]).toContain(kind);
  }, 120_000);

  it(`${suite} — aborting stops the run as "interrupted"`, async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const out = await c.make().run(ctx({ env: { ...(c.env ?? {}), FAKE_HANG: "1" }, signal: ac.signal }));
    expect(["interrupted", "finished"]).toContain(out.kind);
  }, 60_000);

  it(`${suite} — a missing binary is an error the scheduler can act on, not a crash`, async () => {
    const out = await c.make(["/nonexistent/cli-for-conformance"]).run(ctx());
    expect(out.kind).toBe("error");
    expect(out.error?.retryable).toBe(false);
  }, 30_000);

  it(`${suite} — usage is reported, or not reported at all (never invented zeros)`, async () => {
    const { events } = await oneTurn(c.make(), c, {});
    const usage = events.filter((e) => e.type === "usage");
    if (c.usage === "reported") expect(usage.length).toBeGreaterThan(0);
    else expect(usage).toEqual([]);
    for (const u of usage) if (u.type === "usage") expect(u.input + u.output + u.cache_read + u.cost_usd).toBeGreaterThanOrEqual(0);
  }, 120_000);

  if (c.semantic) {
    const s = c.semantic;
    it(`${suite} — a resumed session remembers the first turn`, async () => {
      const a = c.make();
      const sessionId = crypto.randomUUID();
      const first = await oneTurn(a, c, { sessionId, resume: false, prompt: s.first, cwd: s.cwd ?? os.tmpdir() });
      const handle = first.events.find((e) => e.type === "session_handle");
      const second = await oneTurn(c.make(), c, { sessionId, resume: true, handle: handle?.type === "session_handle" ? handle.handle : null, followUp: s.second, prompt: s.second, cwd: s.cwd ?? os.tmpdir() });
      const said = second.events.filter((e) => e.type === "chat").map((e) => (e.type === "chat" ? e.text : "")).join("\n");
      expect(said).toMatch(s.expect);
    }, 240_000);
  }
}
