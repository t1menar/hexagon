import { describe, expect, it } from "vitest";
import { shouldCompact } from "../src/core/compaction.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";

describe("the context window the CLI reports beats the assumed one", () => {
  const cx = { ...DEFAULT_CONFIG.context, assumed_window_tokens: 200_000 };
  const rec = { contextTokens: 300_000, turns: 10, lastCompactionTurn: 0 };
  it("a 1M-token model at 300k tokens is not compacted (the assumed 200k would have compacted it twice over)", () => {
    expect(shouldCompact(cx, rec, false).compact).toBe(true); // assumed window
    expect(shouldCompact(cx, { ...rec, windowTokens: 1_000_000 }, false).compact).toBe(false);
  });
  it("a smaller reported window compacts earlier than the assumption", () => {
    expect(shouldCompact(cx, { contextTokens: 80_000, turns: 10, lastCompactionTurn: 0, windowTokens: 100_000 }, false).compact).toBe(true);
  });
});
