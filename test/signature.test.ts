import { describe, expect, it } from "vitest";
import { failureSignature, reviewSignature } from "../src/core/signature.js";

describe("loop signatures are stable across rewording", () => {
  it("the same failing tests with different timings and counts match", () => {
    const a = " FAIL  test/a.test.ts > adds (12ms)\n AssertionError: expected 3 to be 4\nTests 1 failed | 4 passed (1.2s)";
    const b = " FAIL  test/a.test.ts > adds (31ms)\n AssertionError: expected 5 to be 6\nTests 1 failed | 4 passed (2.9s)";
    expect(failureSignature("npm test", 1, a)).toBe(failureSignature("npm test", 1, b));
  });
  it("a different failing test is a different signature", () => {
    expect(failureSignature("npm test", 1, " FAIL  test/a.test.ts > adds")).not.toBe(failureSignature("npm test", 1, " FAIL  test/a.test.ts > subtracts"));
    expect(failureSignature("npm test", 1, "FAIL x")).not.toBe(failureSignature("npm run lint", 1, "FAIL x"));
  });
  it("reviews match on file:severity, not on the reviewer's words", () => {
    const f = (file: string, severity: "high" | "medium" | "low", issue: string) => ({ severity, file, issue });
    const one = { findings: [f("src/a.ts", "high", "null deref when empty"), f("src/b.ts", "low", "naming")] };
    const two = { findings: [f("src/a.ts", "high", "crashes on empty input, please guard")] };
    expect(reviewSignature(one as never)).toBe(reviewSignature(two as never));
    expect(reviewSignature({ findings: [f("src/c.ts", "high", "x")] } as never)).not.toBe(reviewSignature(one as never));
  });
});
