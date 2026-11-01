import { describe, expect, it } from "vitest";
import { feedAfter, mergeSession, sessionPush, type SessionStatus } from "../src/core/solo.js";

const mk = (seqs: number[], total = seqs.length): SessionStatus => ({
  id: "control", role: "control", agent: "x", state: "running", activity: null, question: null, cost_usd: 0, tokens: { input: 0, cache_read: 0, output: 0, steps: 0 },
  result_status: null, summary: null, error: null, session_id: "s", feed_seq: total,
  feed: seqs.map((n) => ({ ts: "", kind: "text" as const, text: `line ${n}` })),
});

describe("session push deltas", () => {
  it("first push is whole; later pushes carry only new lines, and a reader rebuilds the same feed", () => {
    const full = mk([1, 2, 3]);
    expect(sessionPush(full, undefined)).toBe(full);
    const later = mk([1, 2, 3, 4, 5]);
    const d = sessionPush(later, 3);
    expect(d.feed.map((f) => f.text)).toEqual(["line 4", "line 5"]);
    expect(d.feed_delta).toBe(true);
    const m = mergeSession(full, d);
    expect(m.gap).toBe(false);
    expect(m.status.feed.map((f) => f.text)).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5"]);
    expect(m.status.feed_seq).toBe(5);
  });
  it("overlap (a snapshot newer than the push) does not duplicate lines", () => {
    const snap = mk([1, 2, 3, 4]);
    const m = mergeSession(snap, { ...mk([3, 4, 5]), feed_delta: true, feed_seq: 5 });
    expect(m.status.feed.map((f) => f.text)).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5"]);
  });
  it("a gap or a restarted session asks for the whole status", () => {
    expect(mergeSession(mk([1, 2]), { ...mk([9]), feed_delta: true, feed_seq: 9 }).gap).toBe(true);
    expect(mergeSession(mk([1, 2, 3, 4, 5]), { ...mk([1]), feed_delta: true, feed_seq: 1 }).gap).toBe(true);
    expect(mergeSession(undefined, { ...mk([1]), feed_delta: true }).gap).toBe(true);
  });
  it("a delta is much smaller than the whole status", () => {
    const big = mk(Array.from({ length: 400 }, (_, i) => i + 1));
    const full = JSON.stringify(big).length;
    const delta = JSON.stringify(sessionPush({ ...big, feed_seq: 401 }, 400)).length;
    expect(delta).toBeLessThan(full / 20);
  });
  it("feedAfter returns the unseen tail", () => {
    expect(feedAfter(mk([1, 2, 3, 4]), 2).map((f) => f.text)).toEqual(["line 3", "line 4"]);
    expect(feedAfter(mk([1, 2]), 2)).toEqual([]);
  });
});
