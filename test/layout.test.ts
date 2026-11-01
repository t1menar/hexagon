import { describe, expect, it } from "vitest";
import { computeLayout, overlaps, type Region } from "../src/tui/layout.js";

const sizes: [number, number][] = [[200, 60], [160, 45], [124, 30], [123, 30], [120, 24], [100, 28], [90, 22], [89, 22], [80, 24], [60, 20], [50, 16], [40, 16]];

describe("responsive layout", () => {
  it.each(sizes)("%ix%i: regions fit the screen and never overlap", (W, H) => {
    for (const inspector of [true, false]) {
      const l = computeLayout(W, H, { inspector });
      const regions = [l.header, l.agents, l.strip, l.network, l.inspector, l.activity, l.chat, l.input].filter(Boolean) as Region[];
      for (const r of regions) {
        expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(W); expect(r.y + r.h).toBeLessThanOrEqual(H);
        expect(r.w).toBeGreaterThan(0); expect(r.h).toBeGreaterThan(0);
      }
      for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) expect(overlaps(regions[i]!, regions[j]!), `${i}/${j}`).toBe(false);
    }
  });
  it("selects the mode from the terminal size", () => {
    expect(computeLayout(160, 45).mode).toBe("large");
    expect(computeLayout(100, 28).mode).toBe("medium");
    expect(computeLayout(60, 20).mode).toBe("small");
    expect(computeLayout(60, 20).agents).toBeNull();
    expect(computeLayout(60, 20).strip).not.toBeNull();
    expect(computeLayout(160, 45, { inspector: false }).inspector).toBeNull();
  });
});
